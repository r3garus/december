import OpenAI from "openai";
import { config } from "../../config";
import prompt from "../utils/prompt.txt";
import {
  recordProviderRequest,
  selectAiProvider,
  type AiProviderConfig,
  type AiWorkloadEstimate,
} from "./aiProvider";
import * as dockerService from "./docker";
import * as fileService from "./file";
import * as packageService from "./package";

const clientCache = new Map<string, OpenAI>();

const aiSdkConfig = config.aiSdk as typeof config.aiSdk & {
  temperature?: number;
  maxRetries?: number;
  minQualityScore?: number;
  maxCriticRounds?: number;
};
const aiTemperature = aiSdkConfig.temperature ?? 0.15;
const aiMaxRetries = aiSdkConfig.maxRetries ?? 2;
const aiMinQualityScore = aiSdkConfig.minQualityScore ?? 80;
const aiMaxCriticRounds = aiSdkConfig.maxCriticRounds ?? 2;
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || "20000");

function getAiClient(provider: AiProviderConfig) {
  const cacheKey = `${provider.key}:${provider.baseUrl}`;
  const cachedClient = clientCache.get(cacheKey);

  if (cachedClient) return cachedClient;

  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl || "https://api.openai.com/v1",
  });

  clientCache.set(cacheKey, client);
  return client;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: Attachment[];
  edits?: {
    applied: number;
    failed: Array<{ label: string; error: string }>;
  };
}

export interface Attachment {
  type: "image" | "document";
  data: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ChatSession {
  id: string;
  containerId: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

interface CriticResult {
  score: number;
  verdict: "PASS" | "FAIL";
  feedback: string;
}

interface CodeOperation {
  type: "write" | "rename" | "delete" | "dependency";
  index: number;
  path?: string;
  content?: string;
  from?: string;
  to?: string;
  packageName?: string;
  version?: string;
}

const chatSessions = new Map<string, ChatSession>();

const BUILD_INTENT_PATTERN =
  /\b(yap|yapal[ıi]m|olu[sş]tur|ekle|de[gğ]i[sş]tir|d[üu]zelt|kald[ıi]r|sil|tasarla|kodla|g[üu]ncelle|ayarla|[çc][ıi]kar|koy|olsun|build|create|make|add|change|update|fix|remove|delete|design|implement)\b/i;
const TURKISH_HINT_PATTERN =
  /[çğıöşü]/i;
const TURKISH_WORD_PATTERN =
  /\b(merhaba|selam|naber|nas[ıi]ls[ıi]n|tesekkur|te[sş]ekk[üu]r|sagol|sa[gğ] ol|eyvallah|kanka)\b/i;
const QUESTION_PATTERN =
  /[?？]|^(ne|nasil|nas[ıi]l|neden|niye|hangi|kim|nerede|nereyi|sence|bana anlat|aciklar|a[çc][ıi]klar|what|why|how|which|who|where|can|could|should|would|is|are|do|does|did)\b/i;
const VERY_VAGUE_BUILD_PATTERN =
  /^(bir\s+)?(site|website|web sitesi|landing|landing page|sayfa|dashboard|panel|app|uygulama)\s*(yap|olu[sş]tur|tasarla|build|create|make|design)?$/i;

function isLikelyTurkish(message: string): boolean {
  return TURKISH_HINT_PATTERN.test(message) || TURKISH_WORD_PATTERN.test(message);
}

function isBuildRequest(message: string): boolean {
  return BUILD_INTENT_PATTERN.test(message);
}

function isQuestion(message: string): boolean {
  return QUESTION_PATTERN.test(message.trim());
}

function isVagueBuildRequest(message: string): boolean {
  const text = message.trim();
  if (!isBuildRequest(text)) return false;
  if (text.length > 80) return false;
  return VERY_VAGUE_BUILD_PATTERN.test(text) || text.split(/\s+/).length <= 3;
}

export function shouldUseConversationOnlyMode(
  userMessage: string,
  attachmentCount: number = 0
): boolean {
  if (attachmentCount > 0) return false;
  const text = userMessage.trim();
  if (!text || text.length > 1_000) return false;
  if (isBuildRequest(text)) return false;
  return isQuestion(text) || text.split(/\s+/).length <= 20;
}

export function getConversationalShortcutReply(
  userMessage: string,
  attachmentCount: number = 0
): string | null {
  if (attachmentCount > 0) return null;

  const text = userMessage.trim();
  if (!text || text.length > 160 || isBuildRequest(text)) return null;

  const normalized = text
    .toLocaleLowerCase("tr-TR")
    .replace(/[!?.]+$/g, "")
    .trim();
  const compact = normalized.replace(/\s+/g, " ");
  const turkish = isLikelyTurkish(text);

  if (
    /^(kanka\s+)?(merhaba|selam|slm|sa|hello|hi|hey|naber|nas[ıi]ls[ıi]n|nas[ıi]l gidiyor)(\s+kanka)?$/.test(
      compact
    )
  ) {
    return turkish
      ? "Merhaba! Buradayım. İstersen bir soru sorabilir, istersen de ne oluşturmak veya değiştirmek istediğini yazabilirsin."
      : "Hey! I am here. You can ask a question, or tell me what you want to build or change.";
  }

  if (
    /^(te[sş]ekk[üu]rler|te[sş]ekk[üu]r ederim|tesekkurler|tesekkur ederim|sa[gğ] ol|sagol|eyvallah|thanks|thank you)$/.test(
      compact
    )
  ) {
    return turkish
      ? "Rica ederim! Bir sonraki değişikliği yazman yeterli."
      : "You're welcome! Send the next change whenever you're ready.";
  }

  if (
    /^(ne yapabilirsin|neler yapabilirsin|yard[ıi]m|help|what can you do)$/.test(
      compact
    )
  ) {
    return turkish
      ? "Bu projede sayfa, component, stil, içerik, paket ve dosya düzenlemeleri yapabilirim. Net bir değişiklik yazarsan doğrudan uygularım."
      : "I can edit pages, components, styles, copy, packages, and project files. Describe the change clearly and I will apply it.";
  }

  if (
    /^(bir [sş]ey sorabilir miyim|soru sorabilir miyim|sana bir [sş]ey soraca[gğ][ıi]m|can i ask|can i ask a question)$/.test(
      compact
    )
  ) {
    return turkish
      ? "Tabii, sorabilirsin. İstersen teknik, tasarım, iş modeli veya proje akışıyla ilgili sorunu yaz; net cevap vereyim."
      : "Of course. Ask anything about the project, design, backend, security, or workflow and I will answer clearly.";
  }

  return null;
}

export function getBuildClarificationReply(userMessage: string): string | null {
  if (!isVagueBuildRequest(userMessage)) return null;

  const turkish = isLikelyTurkish(userMessage);

  return turkish
    ? [
        "Bunu kaliteli yapabilmem için önce birkaç noktayı netleştirelim:",
        "1. Hangi sektör veya ürün için olacak?",
        "2. Hedef kullanıcı kim ve ana amaç ne: satış, kayıt, randevu, demo veya portfolyo?",
        "3. Görsel tarz nasıl olsun: premium, minimal, kurumsal, yaratıcı veya daha cesur?",
        "",
        "İstersen cevap vermeden \"varsayılanlarla devam et\" yaz; ben profesyonel bir brief oluşturup ilerlerim.",
      ].join("\n")
    : [
        "To make this properly, let me clarify a few things first:",
        "1. What industry or product is this for?",
        "2. Who is the target user and main goal: sales, signup, booking, demo, or portfolio?",
        "3. What visual direction should it follow: premium, minimal, corporate, creative, or bold?",
        "",
        "If you prefer, reply \"continue with defaults\" and I will create a professional brief before building.",
      ].join("\n");
}

const PLANNER_SYSTEM_PROMPT = `
You are a senior product strategist for a coding agent.
Given a user's request, produce an implementation brief in concise plain text with:
1) Goal
2) Audience
3) UI/UX Direction
4) Required Pages/Sections
5) Technical Plan
6) Acceptance Checklist

Only produce an implementation brief when the user clearly asks to build,
change, update, remove, design, or implement something.

If the request is a greeting, thanks, status check, question, or ambiguous
conversation, explicitly say no implementation is required and recommend a
plain conversational answer without code-edit tags.

If a short request has clear build intent, infer missing details professionally.
`;

const BUILDER_SYSTEM_PROMPT = `
You are a senior full-stack engineer and frontend architect.
Deliver production-minded quality:
- responsive layout
- semantic and accessible structure
- maintainable code
- strong visual hierarchy
- avoid generic repetitive template output
- when implementing, output executable edit tags only; plain markdown code is not applied
- for any new website or landing page, rewrite src/app/page.tsx at minimum
`;

const CRITIC_SYSTEM_PROMPT = `
You are a strict software + design quality reviewer.
Evaluate the assistant output and return EXACTLY this format:

SCORE: <0-100>
VERDICT: <PASS or FAIL>
FEEDBACK:
- <short actionable point 1>
- <short actionable point 2>
- <short actionable point 3>

Scoring criteria:
- Implementation completeness
- UI/UX quality and hierarchy
- Responsiveness expectations
- Code quality / maintainability
- Avoidance of generic template output

Rules:
- PASS only if score >= required minimum and quality is clearly strong.
- Keep feedback specific and actionable.
`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < retries) {
        await sleep(500 * (i + 1));
      }
    }
  }
  throw lastError;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function supportsResponsesApi(provider: AiProviderConfig): boolean {
  const baseUrl = provider.baseUrl.toLowerCase();
  return (
    baseUrl.includes("api.openai.com") ||
    process.env.AI_FORCE_RESPONSES_API === "true"
  );
}

function clipText(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}\n\n[TRUNCATED_FOR_CONTEXT]`;
}

function buildMessageContent(message: string, attachments: Attachment[] = []): any[] {
  const content: any[] = [{ type: "text", text: message }];

  for (const attachment of attachments) {
    if (attachment.type === "image") {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${attachment.mimeType};base64,${attachment.data}`,
        },
      });
    } else if (attachment.type === "document") {
      const decodedText = Buffer.from(attachment.data, "base64").toString("utf-8");
      content.push({
        type: "text",
        text: `\n\nDocument "${attachment.name}" content:\n${decodedText}`,
      });
    }
  }

  return content;
}

function extractResponseText(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text;
  }

  const parts: string[] = [];
  for (const item of resp?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === "string") parts.push(c.text);
      if (typeof c?.output_text === "string") parts.push(c.output_text);
      if (typeof c?.value === "string") parts.push(c.value);
    }
  }

  const out = parts.join("").trim();
  return out || "Sorry, I could not generate a response.";
}

function extractChatCompletionText(resp: any): string {
  const text = resp?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim()
    ? text.trim()
    : "Sorry, I could not generate a response.";
}

async function createAiText(params: {
  provider: AiProviderConfig;
  input: string;
  temperature?: number;
  retries?: number;
}): Promise<string> {
  const client = getAiClient(params.provider);
  const temperature = params.temperature ?? aiTemperature;
  const retries = params.retries ?? aiMaxRetries;

  const createChatCompletion = async () => {
    const response = await withRetries(
      () =>
        withTimeout(
          client.chat.completions.create({
            model: params.provider.model,
            messages: [{ role: "user", content: params.input }],
            // @ts-ignore
            temperature,
          }),
          AI_REQUEST_TIMEOUT_MS,
          `${params.provider.key} chat completion`
        ),
      retries
    );

    recordProviderRequest(params.provider.key);
    return extractChatCompletionText(response);
  };

  if (!supportsResponsesApi(params.provider)) {
    return createChatCompletion();
  }

  try {
    const response = await withRetries(
      () =>
        withTimeout(
          client.responses.create({
            model: params.provider.model,
            input: params.input,
            // @ts-ignore
            temperature,
          }),
          AI_REQUEST_TIMEOUT_MS,
          `${params.provider.key} responses request`
        ),
      retries
    );

    recordProviderRequest(params.provider.key);
    return extractResponseText(response);
  } catch (responsesError) {
    console.warn(
      "Responses API failed; falling back to chat completions:",
      responsesError instanceof Error ? responsesError.message : responsesError
    );

    return createChatCompletion();
  }
}

function buildFlattenedInput(messages: Array<{ role: string; content: any }>): string {
  return messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${m.role.toUpperCase()}:\n${c}`;
    })
    .join("\n\n");
}

function parseCriticResult(text: string): CriticResult {
  const scoreMatch = text.match(/SCORE:\s*(\d{1,3})/i);
  const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL)/i);

  const score = scoreMatch ? Number(scoreMatch[1]) : 0;
  const verdictRaw = verdictMatch?.[1]?.toUpperCase() ?? "FAIL";
  const verdict: "PASS" | "FAIL" = verdictRaw === "PASS" ? "PASS" : "FAIL";

  let feedback = text;
  const feedbackStart = text.search(/FEEDBACK:/i);
  if (feedbackStart >= 0) {
    feedback = text.slice(feedbackStart + "FEEDBACK:".length).trim();
  }

  return {
    score: Number.isFinite(score) ? Math.min(Math.max(score, 0), 100) : 0,
    verdict,
    feedback: feedback || "- Improve overall quality and completeness.",
  };
}

function normalizeProjectPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\/app\/my-nextjs-app\/?/, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function getFileName(filePath: string): string {
  const normalized = normalizeProjectPath(filePath);
  return normalized.split("/").filter(Boolean).pop() || normalized || filePath;
}

function getDirectoryName(filePath: string): string {
  const normalized = normalizeProjectPath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || "root";
}

function splitCodeLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmedTrailingNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  return trimmedTrailingNewline ? trimmedTrailingNewline.split("\n") : [];
}

function countLineDelta(
  beforeContent: string | undefined,
  afterContent: string
): { additions: number; deletions: number } {
  const beforeLines = splitCodeLines(beforeContent || "");
  const afterLines = splitCodeLines(afterContent || "");

  if (beforeContent === undefined) {
    return { additions: afterLines.length, deletions: 0 };
  }

  if (beforeLines.length === 0) {
    return { additions: afterLines.length, deletions: 0 };
  }

  if (afterLines.length === 0) {
    return { additions: 0, deletions: beforeLines.length };
  }

  if (beforeLines.length * afterLines.length > 900_000) {
    return {
      additions: Math.max(0, afterLines.length - beforeLines.length),
      deletions: Math.max(0, beforeLines.length - afterLines.length),
    };
  }

  let previous = new Array(afterLines.length + 1).fill(0);
  let current = new Array(afterLines.length + 1).fill(0);

  for (let i = 1; i <= beforeLines.length; i++) {
    for (let j = 1; j <= afterLines.length; j++) {
      current[j] =
        beforeLines[i - 1] === afterLines[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous.fill(0)];
  }

  const unchanged = previous[afterLines.length] || 0;
  return {
    additions: Math.max(0, afterLines.length - unchanged),
    deletions: Math.max(0, beforeLines.length - unchanged),
  };
}

function flattenFileContentTree(
  items: fileService.FileContentItem[],
  files = new Map<string, string>()
): Map<string, string> {
  for (const item of items) {
    if (item.type === "file" && typeof item.content === "string") {
      files.set(normalizeProjectPath(item.path), item.content);
    }

    if (item.children?.length) {
      flattenFileContentTree(item.children, files);
    }
  }

  return files;
}

function appendChangeSummaryTag(
  assistantContent: string,
  fileContentTree: fileService.FileContentItem[]
): string {
  const snapshotFiles = flattenFileContentTree(fileContentTree);
  const changedFiles: Array<{
    path: string;
    name: string;
    directory: string;
    operation: "created" | "updated" | "deleted" | "renamed";
    additions: number;
    deletions: number;
    fromPath?: string;
  }> = [];
  const dependencies: string[] = [];

  const writePattern =
    /<dec-write\s+(?:path|file_path)="([^"]+)">([\s\S]*?)<\/dec-write>/g;
  const renamePattern =
    /<dec-rename\s+from="([^"]+)"\s+to="([^"]+)"\s*\/>/g;
  const deletePattern =
    /<dec-delete\s+(?:path|file_path)="([^"]+)"\s*\/>/g;
  const dependencyPattern =
    /<dec-add-dependency(?:\s+name="([^"]+)"(?:\s+version="([^"]+)")?)?>(.*?)<\/dec-add-dependency>/g;

  const operations: Array<{
    type: "write" | "rename" | "delete" | "dependency";
    index: number;
    match: RegExpExecArray;
  }> = [];

  let match: RegExpExecArray | null;

  while ((match = writePattern.exec(assistantContent)) !== null) {
    operations.push({ type: "write", index: match.index, match });
  }

  while ((match = renamePattern.exec(assistantContent)) !== null) {
    operations.push({ type: "rename", index: match.index, match });
  }

  while ((match = deletePattern.exec(assistantContent)) !== null) {
    operations.push({ type: "delete", index: match.index, match });
  }

  while ((match = dependencyPattern.exec(assistantContent)) !== null) {
    operations.push({ type: "dependency", index: match.index, match });
  }

  operations.sort((left, right) => left.index - right.index);

  for (const operation of operations) {
    if (operation.type === "dependency") {
      const packageName = (
        operation.match[1] ||
        operation.match[3] ||
        ""
      ).trim();
      if (packageName) dependencies.push(packageName);
      continue;
    }

    if (operation.type === "rename") {
      const fromPathRaw = operation.match[1];
      const toPathRaw = operation.match[2];
      if (!fromPathRaw || !toPathRaw) continue;

      const fromPath = normalizeProjectPath(fromPathRaw);
      const toPath = normalizeProjectPath(toPathRaw);
      const previousContent = snapshotFiles.get(fromPath);

      changedFiles.push({
        path: toPath,
        name: getFileName(toPath),
        directory: getDirectoryName(toPath),
        operation: "renamed",
        additions: 0,
        deletions: 0,
        fromPath,
      });

      snapshotFiles.delete(fromPath);
      if (previousContent !== undefined) {
        snapshotFiles.set(toPath, previousContent);
      }
      continue;
    }

    const filePathRaw = operation.match[1];
    if (!filePathRaw) continue;

    const filePath = normalizeProjectPath(filePathRaw);
    const previousContent = snapshotFiles.get(filePath);

    if (operation.type === "delete") {
      const removedLines = splitCodeLines(previousContent || "").length;
      changedFiles.push({
        path: filePath,
        name: getFileName(filePath),
        directory: getDirectoryName(filePath),
        operation: "deleted",
        additions: 0,
        deletions: removedLines,
      });
      snapshotFiles.delete(filePath);
      continue;
    }

    const nextContentRaw = operation.match[2];
    if (nextContentRaw === undefined) continue;

    const nextContent = nextContentRaw.trim();
    const delta = countLineDelta(previousContent, nextContent);

    changedFiles.push({
      path: filePath,
      name: getFileName(filePath),
      directory: getDirectoryName(filePath),
      operation: previousContent === undefined ? "created" : "updated",
      additions: delta.additions,
      deletions: delta.deletions,
    });
    snapshotFiles.set(filePath, nextContent);
  }

  if (!changedFiles.length && !dependencies.length) {
    return assistantContent.replace(
      /<dec-change-summary>[\s\S]*?<\/dec-change-summary>/g,
      ""
    );
  }

  const folders = Array.from(
    changedFiles.reduce((folderMap, file) => {
      folderMap.set(file.directory, (folderMap.get(file.directory) || 0) + 1);
      return folderMap;
    }, new Map<string, number>())
  ).map(([path, count]) => ({ path, count }));

  const summary = {
    files: changedFiles,
    folders,
    dependencies,
    totals: {
      files: changedFiles.length,
      folders: folders.length,
      additions: changedFiles.reduce((total, file) => total + file.additions, 0),
      deletions: changedFiles.reduce((total, file) => total + file.deletions, 0),
      dependencies: dependencies.length,
    },
  };

  const cleanedContent = assistantContent.replace(
    /<dec-change-summary>[\s\S]*?<\/dec-change-summary>/g,
    ""
  );

  return `${cleanedContent}\n<dec-change-summary>${JSON.stringify(
    summary
  )}</dec-change-summary>`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractAttribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}=(["'])([\\s\\S]*?)\\1`, "i");
  const match = tag.match(pattern);
  return match?.[2] ? decodeHtmlEntities(match[2]) : null;
}

function extractCodeOperations(assistantContent: string): CodeOperation[] {
  const operations: CodeOperation[] = [];

  const writePattern = /<dec-write\b([^>]*)>([\s\S]*?)<\/dec-write>/gi;
  const renamePattern = /<dec-rename\b([^>]*?)\/>/gi;
  const deletePattern = /<dec-delete\b([^>]*?)\/>/gi;
  const dependencyPattern = /<dec-add-dependency\b([^>]*)>([\s\S]*?)<\/dec-add-dependency>/gi;

  let match: RegExpExecArray | null;

  while ((match = writePattern.exec(assistantContent)) !== null) {
    const path = extractAttribute(match[1] || "", "path") ||
      extractAttribute(match[1] || "", "file_path");
    const content = match[2];

    if (path && content !== undefined) {
      operations.push({
        type: "write",
        index: match.index,
        path,
        content: content.trim(),
      });
    }
  }

  while ((match = renamePattern.exec(assistantContent)) !== null) {
    const from = extractAttribute(match[1] || "", "from");
    const to = extractAttribute(match[1] || "", "to");

    if (from && to) {
      operations.push({ type: "rename", index: match.index, from, to });
    }
  }

  while ((match = deletePattern.exec(assistantContent)) !== null) {
    const path = extractAttribute(match[1] || "", "path") ||
      extractAttribute(match[1] || "", "file_path");

    if (path) {
      operations.push({ type: "delete", index: match.index, path });
    }
  }

  while ((match = dependencyPattern.exec(assistantContent)) !== null) {
    const nameAttr = extractAttribute(match[1] || "", "name");
    const version = extractAttribute(match[1] || "", "version") || undefined;
    const packageName = (nameAttr || match[2] || "").trim();

    if (packageName) {
      operations.push({
        type: "dependency",
        index: match.index,
        packageName,
        version,
      });
    }
  }

  return operations.sort((left, right) => left.index - right.index);
}

function extractMarkdownCodeOperations(assistantContent: string): CodeOperation[] {
  const operations: CodeOperation[] = [];
  const fencePattern =
    /(?:^|\n)(?:file|path|filename)?\s*:?\s*`?((?:src|app|components|lib|styles|public)\/[^`\n]+\.(?:tsx|ts|jsx|js|css|json|mdx?))`?\s*\n```[a-zA-Z0-9_-]*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(assistantContent)) !== null) {
    const filePath = match[1]?.trim();
    const content = match[2];

    if (filePath && content !== undefined) {
      operations.push({
        type: "write",
        index: match.index,
        path: filePath,
        content: content.trim(),
      });
    }
  }

  return operations;
}

function shouldForceFallbackPage(userMessage: string, assistantContent: string) {
  if (!isBuildRequest(userMessage)) return false;
  if (extractCodeOperations(assistantContent).length > 0) return false;
  if (extractMarkdownCodeOperations(assistantContent).length > 0) return false;

  return true;
}

function hasExecutableCodeOperations(assistantContent: string) {
  return (
    extractCodeOperations(assistantContent).length > 0 ||
    extractMarkdownCodeOperations(assistantContent).length > 0
  );
}

function inferBusinessTitle(userMessage: string) {
  const normalized = userMessage
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();

  const tesisatMatch = normalized.match(/tesisat|plumb|su ka[cç]a[gğ][iı]|komb/i);
  if (tesisatMatch) return "Vurkany Tesisat";

  const firstWords = normalized
    .split(" ")
    .filter((word) => word.length > 2)
    .slice(0, 3)
    .join(" ");

  return firstWords ? `${firstWords} Studio` : "Klawpen Studio";
}

function buildFallbackLandingPage(userMessage: string): string {
  const title = inferBusinessTitle(userMessage);
  const isTurkish = isLikelyTurkish(userMessage);

  const copy = isTurkish
    ? {
        badge: "7/24 güvenilir servis",
        headline: "Eviniz ve iş yeriniz için hızlı, temiz ve garantili tesisat çözümleri",
        intro:
          "Klawpen tarafından oluşturulan bu başlangıç sayfası; acil servis, bakım, onarım ve yenileme hizmetlerini güven veren modern bir akışla sunar.",
        primary: "Hemen teklif al",
        secondary: "Hizmetleri incele",
        trust: "Aynı gün keşif, şeffaf fiyatlandırma ve temiz teslimat",
        servicesTitle: "Öne çıkan hizmetler",
        processTitle: "Nasıl çalışıyoruz?",
        ctaTitle: "Tesisat problemini bugün çözelim",
        ctaText:
          "İhtiyacınızı yazın; ekip yönlendirme, maliyet ve süre planını hızlıca netleştirelim.",
      }
    : {
        badge: "Reliable service, 24/7",
        headline: "Fast, clean, guaranteed plumbing solutions for homes and businesses",
        intro:
          "This Klawpen-generated starter page presents emergency repair, maintenance, and renovation services with a trustworthy modern flow.",
        primary: "Get a quote",
        secondary: "Explore services",
        trust: "Same-day inspection, transparent pricing, clean delivery",
        servicesTitle: "Featured services",
        processTitle: "How it works",
        ctaTitle: "Let us solve the plumbing issue today",
        ctaText:
          "Share the need and we will clarify team dispatch, cost, and timing quickly.",
      };

  return `import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "${title} | Modern Service Landing Page",
  description: "${copy.intro}",
};

const services = ${
    isTurkish
      ? JSON.stringify([
          ["Acil tesisat onarımı", "Su kaçağı, tıkanıklık ve arıza durumlarında hızlı müdahale."],
          ["Banyo ve mutfak yenileme", "Kırmadan dökmeden planlanan temiz montaj ve dönüşüm işleri."],
          ["Kombi ve petek hattı", "Isıtma hattı kontrolü, bakım ve verimlilik odaklı iyileştirme."],
        ])
      : JSON.stringify([
          ["Emergency plumbing repair", "Fast response for leaks, clogs, and urgent failures."],
          ["Bathroom and kitchen upgrades", "Clean installation and renovation work with minimal disruption."],
          ["Boiler and radiator lines", "Heating line checks, maintenance, and efficiency-focused improvements."],
        ])
  };

const steps = ${
    isTurkish
      ? JSON.stringify([
          "İhtiyacı dinleriz",
          "Net keşif ve fiyat veririz",
          "Temiz işçilikle teslim ederiz",
        ])
      : JSON.stringify([
          "We understand the need",
          "We provide clear scope and pricing",
          "We deliver clean, reliable work",
        ])
  };

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f5f1e8] text-[#17201a]">
      <section className="relative overflow-hidden px-6 py-8 sm:px-10 lg:px-16">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(38,88,73,0.22),transparent_28%),radial-gradient(circle_at_80%_0%,rgba(224,139,72,0.28),transparent_30%)]" />
        <nav className="relative z-10 mx-auto flex max-w-7xl items-center justify-between rounded-full border border-[#17201a]/10 bg-white/55 px-5 py-3 backdrop-blur">
          <div className="text-lg font-black tracking-[-0.04em]">{title}</div>
          <a href="#contact" className="rounded-full bg-[#17201a] px-5 py-2 text-sm font-bold text-white">
            ${copy.primary}
          </a>
        </nav>

        <div className="relative z-10 mx-auto grid max-w-7xl gap-12 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-28">
          <div>
            <p className="mb-5 inline-flex rounded-full border border-[#265849]/20 bg-white/60 px-4 py-2 text-sm font-bold text-[#265849]">
              ${copy.badge}
            </p>
            <h1 className="max-w-4xl text-5xl font-black leading-[0.92] tracking-[-0.075em] sm:text-7xl lg:text-8xl">
              ${copy.headline}
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-[#17201a]/70">
              ${copy.intro}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a href="#contact" className="rounded-full bg-[#e08b48] px-7 py-4 text-center font-black text-[#17201a] shadow-[0_18px_40px_rgba(224,139,72,0.35)]">
                ${copy.primary}
              </a>
              <a href="#services" className="rounded-full border border-[#17201a]/15 bg-white/70 px-7 py-4 text-center font-black">
                ${copy.secondary}
              </a>
            </div>
          </div>

          <div className="rounded-[2.5rem] border border-[#17201a]/10 bg-[#17201a] p-5 text-white shadow-[0_28px_90px_rgba(23,32,26,0.28)]">
            <div className="rounded-[2rem] bg-[#22382f] p-7">
              <p className="text-sm font-bold uppercase tracking-[0.24em] text-[#e08b48]">Service board</p>
              <div className="mt-8 space-y-4">
                {services.map(([name, text]) => (
                  <div key={name} className="rounded-3xl bg-white/8 p-5">
                    <h3 className="text-xl font-black">{name}</h3>
                    <p className="mt-2 text-sm leading-6 text-white/70">{text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-[#17201a]/10 bg-white/55 px-6 py-6 sm:px-10 lg:px-16">
        <div className="mx-auto grid max-w-7xl gap-4 text-center text-sm font-bold text-[#17201a]/65 sm:grid-cols-3">
          <span>${copy.trust}</span>
          <span>Premium responsive design</span>
          <span>Klawpen Core generated</span>
        </div>
      </section>

      <section id="services" className="mx-auto max-w-7xl px-6 py-20 sm:px-10 lg:px-16">
        <div className="mb-10 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <h2 className="max-w-2xl text-4xl font-black tracking-[-0.055em] sm:text-6xl">${copy.servicesTitle}</h2>
          <p className="max-w-md text-[#17201a]/65">${copy.trust}</p>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {services.map(([name, text], index) => (
            <article key={name} className="rounded-[2rem] border border-[#17201a]/10 bg-white p-7 shadow-sm">
              <span className="text-sm font-black text-[#e08b48]">0{index + 1}</span>
              <h3 className="mt-6 text-2xl font-black tracking-[-0.035em]">{name}</h3>
              <p className="mt-4 leading-7 text-[#17201a]/65">{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 pb-20 sm:px-10 lg:px-16">
        <div className="rounded-[2.5rem] bg-[#265849] p-8 text-white sm:p-12">
          <h2 className="text-4xl font-black tracking-[-0.05em]">${copy.processTitle}</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {steps.map((step, index) => (
              <div key={step} className="rounded-3xl bg-white/10 p-6">
                <span className="text-[#e08b48]">Step {index + 1}</span>
                <p className="mt-3 text-xl font-black">{step}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="contact" className="px-6 pb-24 sm:px-10 lg:px-16">
        <div className="mx-auto max-w-5xl rounded-[2.5rem] bg-[#17201a] p-10 text-center text-white sm:p-16">
          <h2 className="text-4xl font-black tracking-[-0.06em] sm:text-6xl">${copy.ctaTitle}</h2>
          <p className="mx-auto mt-5 max-w-2xl text-white/70">${copy.ctaText}</p>
          <a href="mailto:hello@example.com" className="mt-9 inline-flex rounded-full bg-[#e08b48] px-8 py-4 font-black text-[#17201a]">
            ${copy.primary}
          </a>
        </div>
      </section>
    </main>
  );
}
`;
}

function buildFallbackOperations(userMessage: string): CodeOperation[] {
  return [
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER,
      path: "src/app/page.tsx",
      content: buildFallbackLandingPage(userMessage),
    },
  ];
}

async function applyCodeOperations(
  containerId: string,
  assistantContent: string,
  userMessage: string
): Promise<{ applied: number; failed: Array<{ label: string; error: string }> }> {
  let operations = extractCodeOperations(assistantContent);

  if (!operations.length) {
    operations = extractMarkdownCodeOperations(assistantContent);
  }

  if (!operations.length && shouldForceFallbackPage(userMessage, assistantContent)) {
    operations = buildFallbackOperations(userMessage);
    console.warn(
      "AI response did not include executable edit tags; applying fallback landing page."
    );
  }

  const result: {
    applied: number;
    failed: Array<{ label: string; error: string }>;
  } = { applied: 0, failed: [] };

  if (!operations.length) return result;

  console.log(
    `Applying ${operations.length} AI code operation(s) to ${containerId}`
  );

  for (const operation of operations) {
    const operationLabel =
      operation.path ||
      operation.to ||
      operation.from ||
      operation.packageName ||
      operation.type;

    try {
      if (operation.type === "write" && operation.path !== undefined) {
        await fileService.writeFile(
          containerId,
          operation.path,
          operation.content || ""
        );
        result.applied += 1;
        continue;
      }

      if (
        operation.type === "rename" &&
        operation.from !== undefined &&
        operation.to !== undefined
      ) {
        await fileService.renameFile(containerId, operation.from, operation.to);
        result.applied += 1;
        continue;
      }

      if (operation.type === "delete" && operation.path !== undefined) {
        await fileService.removeFile(containerId, operation.path);
        result.applied += 1;
        continue;
      }

      if (operation.type === "dependency" && operation.packageName) {
        const packageSpec = operation.version
          ? `${operation.packageName}@${operation.version}`
          : operation.packageName;

        await packageService.addDependency(containerId, packageSpec, false);
        result.applied += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `AI code operation failed (${operation.type}: ${operationLabel}):`,
        message
      );
      result.failed.push({
        label: `${operation.type}: ${operationLabel}`,
        error: message,
      });
    }
  }

  console.log(
    `AI code operations finished for ${containerId}: ${result.applied} applied, ${result.failed.length} failed`
  );

  return result;
}

async function createPlannerBrief(
  userMessage: string,
  recentConversation: string,
  provider: AiProviderConfig
): Promise<string> {
  const plannerInput = `
SYSTEM:
${PLANNER_SYSTEM_PROMPT}

RECENT CONVERSATION:
${recentConversation || "No prior conversation."}

USER REQUEST:
${userMessage}
`;

  return createAiText({
    provider,
    input: plannerInput,
    temperature: Math.min(aiTemperature, 0.2),
  });
}

function createLocalPlannerBrief(userMessage: string): string {
  const turkish = isLikelyTurkish(userMessage);

  if (turkish) {
    return [
      "Goal: Kullanıcı isteğine göre üretime hazır, modern ve mobil uyumlu bir web sayfası oluştur.",
      "Audience: Hizmet veya ürün arayan son kullanıcılar.",
      "UI/UX Direction: Güven veren, net hiyerarşili, premium ve dönüşüm odaklı bir landing page.",
      "Required Pages/Sections: Hero, güven unsurları, hizmetler/özellikler, süreç, sosyal kanıt, SSS ve iletişim CTA.",
      "Technical Plan: Next.js App Router içinde src/app/page.tsx dosyasını tam ve çalışır şekilde yeniden yaz.",
      "Acceptance Checklist: Responsive tasarım, anlamlı metinler, erişilebilir HTML, bozuk import yok, placeholder hissi yok.",
    ].join("\n");
  }

  return [
    "Goal: Build a production-ready, modern, mobile-responsive web page from the user request.",
    "Audience: End users evaluating the service or product.",
    "UI/UX Direction: Trustworthy, premium, conversion-focused landing page with clear hierarchy.",
    "Required Pages/Sections: Hero, trust strip, services/features, process, social proof, FAQ, and contact CTA.",
    "Technical Plan: Rewrite src/app/page.tsx completely using the Next.js App Router structure.",
    "Acceptance Checklist: Responsive layout, meaningful copy, accessible HTML, no broken imports, no placeholder feel.",
  ].join("\n");
}

async function createBuilderResponse(
  input: string,
  provider: AiProviderConfig
): Promise<string> {
  return createAiText({
    provider,
    input,
    temperature: aiTemperature,
  });
}

async function createCriticReview(
  input: string,
  provider: AiProviderConfig
): Promise<CriticResult> {
  const text = await createAiText({
    provider,
    input,
    temperature: 0.1,
  });
  return parseCriticResult(text);
}

async function createConversationalAnswer(
  userMessage: string,
  recentConversation: string,
  provider: AiProviderConfig
): Promise<string> {
  const turkish = isLikelyTurkish(userMessage);
  const input = `
SYSTEM:
You are Klawpen Agent, a concise and professional product-building assistant.
Answer the user's question directly in the same language as the user.
Do not emit code-edit tags. Do not modify files. Do not claim that you changed code.
If the user seems to want a build but has not provided enough detail, ask up to 3 focused clarification questions.
End with a short invitation to share what they want next.

LANGUAGE:
${turkish ? "Turkish" : "English"}

RECENT CONVERSATION:
${recentConversation || "No prior conversation."}

USER:
${userMessage}
`;

  return createAiText({
    provider,
    input,
    temperature: Math.min(aiTemperature, 0.25),
    retries: Math.min(aiMaxRetries, 1),
  });
}

async function improveWithCriticLoop(params: {
  userMessage: string;
  plannerBrief: string;
  codeContext: string;
  recentMessages: string;
  draft: string;
  provider: AiProviderConfig;
}): Promise<string> {
  let currentDraft = params.draft;

  for (let round = 1; round <= aiMaxCriticRounds; round++) {
    const criticInput = `
SYSTEM:
${CRITIC_SYSTEM_PROMPT}

MINIMUM_SCORE:
${aiMinQualityScore}

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

RECENT_CONVERSATION:
${params.recentMessages || "No recent conversation."}

ASSISTANT_OUTPUT_TO_REVIEW:
${currentDraft}
`;

    const critic = await createCriticReview(criticInput, params.provider);

    const passes =
      critic.verdict === "PASS" && critic.score >= aiMinQualityScore;

    if (passes) {
      return currentDraft;
    }

    const revisionInput = `
SYSTEM:
${prompt}

${BUILDER_SYSTEM_PROMPT}

You are revising a previous assistant response after strict quality review.
Improve the response quality based on feedback while preserving user intent.

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

QUALITY_FEEDBACK:
${critic.feedback}

PREVIOUS_ASSISTANT_OUTPUT:
${currentDraft}

CURRENT_CODEBASE_SNAPSHOT:
${params.codeContext}
`;

    currentDraft = await createBuilderResponse(revisionInput, params.provider);
  }

  return currentDraft;
}

async function repairMissingExecutableEdits(params: {
  userMessage: string;
  plannerBrief: string;
  codeContext: string;
  draft: string;
  provider: AiProviderConfig;
}): Promise<string> {
  if (!shouldForceFallbackPage(params.userMessage, params.draft)) {
    return params.draft;
  }

  console.warn(
    "AI build response had no executable edit tags; requesting one repair pass before fallback."
  );

  const repairInput = `
SYSTEM:
${prompt}

${BUILDER_SYSTEM_PROMPT}

The previous assistant output is invalid because it did not contain executable edit operations.
Return exactly one <dec-code> block with executable edit tags.
For this build request, rewrite at least src/app/page.tsx using a full <dec-write path="src/app/page.tsx">...</dec-write> operation.
Do not use markdown code fences. Do not only explain. Do not repeat the previous invalid response.

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

PREVIOUS_INVALID_OUTPUT:
${params.draft}

CURRENT_CODEBASE_SNAPSHOT:
${clipText(params.codeContext, 80_000)}
`;

  try {
    const repaired = await createBuilderResponse(repairInput, params.provider);
    if (hasExecutableCodeOperations(repaired)) {
      return repaired;
    }

    console.warn(
      "AI repair response still had no executable edit tags; falling back to generated landing page."
    );
    return repaired;
  } catch (error) {
    console.warn(
      "AI repair pass failed; falling back to generated landing page:",
      error instanceof Error ? error.message : error
    );
    return params.draft;
  }
}

export async function createChatSession(containerId: string): Promise<ChatSession> {
  const sessionId = `${containerId}-${Date.now()}`;
  const session: ChatSession = {
    id: sessionId,
    containerId,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  chatSessions.set(sessionId, session);
  return session;
}

export function getChatSession(sessionId: string): ChatSession | undefined {
  return chatSessions.get(sessionId);
}

export function getOrCreateChatSession(containerId: string): ChatSession {
  const existingSession = Array.from(chatSessions.values()).find(
    (session) => session.containerId === containerId
  );

  if (existingSession) {
    return existingSession;
  }

  const sessionId = `${containerId}-${Date.now()}`;
  const session: ChatSession = {
    id: sessionId,
    containerId,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  chatSessions.set(sessionId, session);
  return session;
}

function removeTrailingUnansweredUserMessage(
  session: ChatSession,
  userMessage: string
) {
  const lastMessage = session.messages[session.messages.length - 1];
  if (lastMessage?.role !== "user") return;
  if (lastMessage.content.trim() !== userMessage.trim()) return;

  session.messages.pop();
  session.updatedAt = new Date().toISOString();
}

export function addConversationalMessage(
  containerId: string,
  userMessage: string,
  assistantReply: string
): { userMessage: Message; assistantMessage: Message } {
  const session = getOrCreateChatSession(containerId);
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const userMsg: Message = {
    id: `user-${now}`,
    role: "user",
    content: userMessage,
    timestamp,
  };
  const assistantMsg: Message = {
    id: `assistant-${now + 1}`,
    role: "assistant",
    content: assistantReply,
    timestamp: new Date(now + 1).toISOString(),
  };

  session.messages.push(userMsg, assistantMsg);
  session.updatedAt = assistantMsg.timestamp;

  return { userMessage: userMsg, assistantMessage: assistantMsg };
}

export async function answerConversationOnlyMessage(
  containerId: string,
  userMessage: string,
  workloadEstimate?: AiWorkloadEstimate
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const session = getOrCreateChatSession(containerId);
  const recentConversation = session.messages
    .slice(-8)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");

  const provider = selectAiProvider(workloadEstimate);
  const assistantReply = await createConversationalAnswer(
    userMessage,
    recentConversation,
    provider
  );

  return addConversationalMessage(containerId, userMessage, assistantReply);
}

async function buildAssistantMessageFromSession(
  session: ChatSession,
  containerId: string,
  userMessage: string,
  workloadEstimate?: AiWorkloadEstimate
): Promise<{ assistantMessage: Message }> {
  const provider = selectAiProvider(workloadEstimate);

  const fileContentTree = await fileService.getFileContentTree(
    dockerService.docker,
    containerId
  );

  const rawContext = JSON.stringify(fileContentTree, null, 2);
  const codeContext = clipText(rawContext, 120_000);

  const recentMessages = session.messages
    .slice(-8)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  let plannerBrief = createLocalPlannerBrief(userMessage);
  try {
    plannerBrief = await createPlannerBrief(
      userMessage,
      recentMessages,
      provider
    );
  } catch (error) {
    console.warn(
      "AI planner failed; continuing with local planner brief:",
      error instanceof Error ? error.message : error
    );
  }

  const systemPrompt = `${prompt}

${BUILDER_SYSTEM_PROMPT}

PLANNER BRIEF:
${plannerBrief}

CURRENT CODEBASE SNAPSHOT:
${codeContext}`;

  const openaiMessages = [
    { role: "system" as const, content: systemPrompt },
    ...session.messages.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content:
        msg.role === "user" && msg.attachments
          ? buildMessageContent(msg.content, msg.attachments)
          : msg.content,
    })),
  ];

  const flattenedInput = buildFlattenedInput(openaiMessages);
  let assistantContent: string;

  try {
    assistantContent = await createBuilderResponse(flattenedInput, provider);

    assistantContent = await improveWithCriticLoop({
      userMessage,
      plannerBrief,
      codeContext: clipText(codeContext, 80_000),
      recentMessages: clipText(recentMessages, 10_000),
      draft: assistantContent,
      provider,
    });
    assistantContent = await repairMissingExecutableEdits({
      userMessage,
      plannerBrief,
      codeContext,
      draft: assistantContent,
      provider,
    });
  } catch (error) {
    console.error(
      "AI builder generation failed; applying local fallback landing page:",
      error instanceof Error ? error.message : error
    );
    assistantContent = [
      "<dec-code>",
      "Plan:",
      "- AI provider did not return in time.",
      "- Apply a generated landing page fallback so the preview updates.",
      `<dec-write path="src/app/page.tsx">${buildFallbackLandingPage(userMessage)}</dec-write>`,
      "</dec-code>",
      "AI provider timed out, so I applied a safe generated starting page that you can continue editing.",
    ].join("\n");
  }

  assistantContent = appendChangeSummaryTag(assistantContent, fileContentTree);
  const applyResult = await applyCodeOperations(
    containerId,
    assistantContent,
    userMessage
  );

  if (applyResult.failed.length > 0) {
    const failedItems = applyResult.failed
      .slice(0, 4)
      .map((item) => `- ${item.label}: ${item.error}`)
      .join("\n");

    assistantContent += `\n<dec-error>Some generated edits could not be applied automatically. The backend logged the details:\n${failedItems}</dec-error>`;
  }

  const assistantMsg: Message = {
    id: `assistant-${Date.now()}`,
    role: "assistant",
    content: assistantContent,
    timestamp: new Date().toISOString(),
    edits: applyResult,
  };

  session.messages.push(assistantMsg);
  session.updatedAt = new Date().toISOString();

  return {
    assistantMessage: assistantMsg,
  };
}

export async function sendMessage(
  containerId: string,
  userMessage: string,
  attachments: Attachment[] = [],
  workloadEstimate?: AiWorkloadEstimate
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const session = getOrCreateChatSession(containerId);
  removeTrailingUnansweredUserMessage(session, userMessage);

  const userMsg: Message = {
    id: `user-${Date.now()}`,
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  session.messages.push(userMsg);

  const { assistantMessage } = await buildAssistantMessageFromSession(
    session,
    containerId,
    userMessage,
    workloadEstimate
  );

  return {
    userMessage: userMsg,
    assistantMessage,
  };
}

export async function* sendMessageStream(
  containerId: string,
  userMessage: string,
  attachments: Attachment[] = [],
  workloadEstimate?: AiWorkloadEstimate
): AsyncGenerator<{ type: "user" | "assistant" | "done"; data: any }> {
  const session = getOrCreateChatSession(containerId);
  removeTrailingUnansweredUserMessage(session, userMessage);

  const userMsg: Message = {
    id: `user-${Date.now()}`,
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  session.messages.push(userMsg);
  yield { type: "user", data: userMsg };

  const { assistantMessage } = await buildAssistantMessageFromSession(
    session,
    containerId,
    userMessage,
    workloadEstimate
  );

  yield { type: "assistant", data: assistantMessage };
  yield { type: "done", data: assistantMessage };
}
