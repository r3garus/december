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
const aiMinQualityScore = aiSdkConfig.minQualityScore ?? 88;
const aiMaxCriticRounds = aiSdkConfig.maxCriticRounds ?? 3;
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || "150000");

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

interface BuildProgress {
  stage:
    | "scan"
    | "plan"
    | "draft"
    | "review"
    | "repair"
    | "apply"
    | "refresh";
  title: string;
  description: string;
  percent: number;
  files?: string[];
}

type ProgressReporter = (progress: BuildProgress) => void | Promise<void>;

interface BuildOptions {
  planMode?: boolean;
  forceBuild?: boolean;
}

const chatSessions = new Map<string, ChatSession>();

const BUILD_INTENT_PATTERN =
  /\b(yap|yapal[ıi]m|olu[sş]tur|haz[ıi]rla|kur|geli[sş]tir|ekle|de[gğ]i[sş]tir|d[üu]zelt|kald[ıi]r|sil|tasarla|kodla|g[üu]ncelle|ayarla|[çc][ıi]kar|koy|olsun|build|create|make|add|change|update|fix|remove|delete|design|implement|generate)\b/i;
const BUILD_WANT_PATTERN =
  /\b(istiyorum|laz[ıi]m|ihtiyac[ıi]m|need|want)\b/i;
const BUILD_SUBJECT_PATTERN =
  /\b(site|website|web\s*sitesi|landing|landing\s*page|sayfa|dashboard|panel|app|uygulama|component|komponent|[öo]zellik|feature|tasar[ıi]m|design|page|route|form|login|register|blog|pricing|faq|sss|store|shop|api|backend|database|auth)\b/i;
const TURKISH_HINT_PATTERN =
  /[çğıöşü]/i;
const TURKISH_WORD_PATTERN =
  /\b(merhaba|selam|naber|nas[ıi]ls[ıi]n|tesekkur|te[sş]ekk[üu]r|sagol|sa[gğ] ol|eyvallah|kanka)\b/i;
const QUESTION_PATTERN =
  /[?？]|^(ne|nasil|nas[ıi]l|neden|niye|hangi|kim|nerede|nereyi|sence|bana anlat|aciklar|a[çc][ıi]klar|what|why|how|which|who|where|can|could|should|would|is|are|do|does|did)\b/i;
const VERY_VAGUE_BUILD_PATTERN =
  /^(bir\s+)?(site|website|web sitesi|landing|landing page|sayfa|dashboard|panel|app|uygulama)\s*(yap|olu[sş]tur|tasarla|build|create|make|design)?$/i;
const RUNTIME_REPAIR_PATTERN =
  /\b(runtime|referenceerror|server-side exception|application error|hata|hatasi|hatası|bozuk|calismiyor|çalışmıyor|duzelt|düzelt|onar|repair|fix|çalışır hale getir|calisir hale getir)\b/i;
const BUILD_DETAIL_PATTERN =
  /\b(premium|minimal|kurumsal|corporate|luxury|editorial|brutal|bold|modern|renk|color|style|tarz|hedef|audience|kitle|cta|sat[ıi][sş]|sales|randevu|booking|demo|portfolio|portfolyo|fiyat|pricing|sss|faq|dashboard|auth|login|register|blog|about|hakk[ıi]nda|contact|iletisim|ileti[sş]im|sayfa|pages|routes|route|section|b[öo]l[üu]m)\b/i;
const GENERIC_BUILD_WORDS = new Set([
  "bir",
  "bana",
  "benim",
  "icin",
  "ile",
  "site",
  "website",
  "web",
  "sayfa",
  "landing",
  "page",
  "dashboard",
  "panel",
  "app",
  "uygulama",
  "yap",
  "yapalim",
  "olustur",
  "tasarla",
  "hazirla",
  "kur",
  "istiyorum",
  "lazim",
  "build",
  "create",
  "make",
  "design",
  "generate",
  "need",
  "want",
  "merhaba",
  "selam",
  "hello",
  "hi",
  "hey",
  "naber",
  "soru",
  "sormak",
  "sorabilir",
  "yardim",
  "help",
]);

function isLikelyTurkish(message: string): boolean {
  return TURKISH_HINT_PATTERN.test(message) || TURKISH_WORD_PATTERN.test(message);
}

function isBuildRequest(message: string): boolean {
  return (
    BUILD_INTENT_PATTERN.test(message) ||
    (BUILD_WANT_PATTERN.test(message) && BUILD_SUBJECT_PATTERN.test(message))
  );
}

function hasBuildIntent(message: string, options: BuildOptions = {}): boolean {
  return options.forceBuild === true || isBuildRequest(message);
}

function isRuntimeRepairRequest(message: string): boolean {
  return RUNTIME_REPAIR_PATTERN.test(message);
}

function isQuestion(message: string): boolean {
  return QUESTION_PATTERN.test(message.trim());
}

function isVagueBuildRequest(message: string): boolean {
  const text = message.trim();
  if (!isBuildRequest(text)) return false;
  if (text.length > 80) return false;
  if (hasSpecificBuildSubject(text)) return false;
  return VERY_VAGUE_BUILD_PATTERN.test(text) || text.split(/\s+/).length <= 3;
}

function isUnderspecifiedPlanBuildRequest(message: string): boolean {
  const text = message.trim();
  if (!isBuildRequest(text)) return false;
  if (text.length > 280) return false;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 5) return true;

  return words.length <= 18 && !BUILD_DETAIL_PATTERN.test(text);
}

function hasSpecificBuildSubject(message: string): boolean {
  const words = normalizePromptText(message)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2);

  return words.some((word) => !GENERIC_BUILD_WORDS.has(word));
}

function getBuildProgressCopy(
  userMessage: string,
  stage: BuildProgress["stage"],
  percent: number,
  files?: string[]
): BuildProgress {
  const turkish = isLikelyTurkish(userMessage);
  const copy: Record<
    BuildProgress["stage"],
    { tr: [string, string]; en: [string, string] }
  > = {
    scan: {
      tr: ["Proje analiz ediliyor", "Mevcut dosyalar ve çalışma alanı okunuyor."],
      en: ["Analyzing project", "Reading the current files and workspace state."],
    },
    plan: {
      tr: ["Brief netleştiriliyor", "İstek sektöre, hedefe ve sayfa akışına çevriliyor."],
      en: ["Shaping the brief", "Translating the prompt into product, audience, and page flow."],
    },
    draft: {
      tr: ["Kod yazılıyor", "Klawpen Core sayfa yapısını ve arayüz detaylarını üretiyor."],
      en: ["Writing code", "Klawpen Core is generating the page structure and UI details."],
    },
    review: {
      tr: ["Kalite kontrol yapılıyor", "Kod, tasarım hiyerarşisi ve uygulanabilirlik kontrol ediliyor."],
      en: ["Reviewing quality", "Checking code, design hierarchy, and applicability."],
    },
    repair: {
      tr: ["Eksikler onarılıyor", "Eksik edit komutları veya bozuk çıktı düzeltiliyor."],
      en: ["Repairing output", "Fixing missing edit operations or invalid output."],
    },
    apply: {
      tr: ["Dosyalar güncelleniyor", "Üretilen değişiklikler proje dosyalarına uygulanıyor."],
      en: ["Updating files", "Applying generated changes to the project files."],
    },
    refresh: {
      tr: ["Preview yenileniyor", "Çalışma alanı yeni değişiklikleri göstermek üzere hazırlanıyor."],
      en: ["Refreshing preview", "Preparing the workspace to show the latest changes."],
    },
  };
  const [title, description] = turkish ? copy[stage].tr : copy[stage].en;

  return {
    stage,
    title,
    description,
    percent,
    files,
  };
}

export function shouldUseConversationOnlyMode(
  userMessage: string,
  attachmentCount: number = 0,
  options: BuildOptions = {}
): boolean {
  if (options.forceBuild) return false;
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

export function getBuildClarificationReply(
  userMessage: string,
  options: BuildOptions = {}
): string | null {
  const wordCount = userMessage.trim().split(/\s+/).filter(Boolean).length;
  const needsClarification =
    isVagueBuildRequest(userMessage) ||
    (options.planMode &&
      (isUnderspecifiedPlanBuildRequest(userMessage) ||
        (options.forceBuild && wordCount <= 10))) ||
    (options.forceBuild && !hasSpecificBuildSubject(userMessage));

  if (!needsClarification) return null;

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
4) Information Architecture
5) Required Routes and Sections
6) Technical Plan
7) Acceptance Checklist
8) Design Differentiators

Only produce an implementation brief when the user clearly asks to build,
change, update, remove, design, or implement something.

If the request is a greeting, thanks, status check, question, or ambiguous
conversation, explicitly say no implementation is required and recommend a
plain conversational answer without code-edit tags.

If a short request has clear build intent, infer missing details professionally.
Do not create a generic SaaS/agency brief unless the user's domain is actually SaaS/agency.
If the user names a sector, make the brief sector-specific: page order, proof points,
CTA logic, objections, copy tone, and visual direction must match that sector.
For broad website/app requests, plan a real multi-route project by default:
- Home route plus 2-4 supporting routes such as about, services/features, pricing/menu/treatments, FAQ, contact, dashboard, or blog when sensible.
- Shared content/config data, reusable components, responsive navigation, and meaningful page transitions.
- Use a modern animated visual system unless the user explicitly asks for static/minimal.
`;

const BUILDER_SYSTEM_PROMPT = `
You are Klawpen Core, a senior full-stack product engineer, frontend architect, UX director, and implementation lead.
Deliver production-minded quality:
- responsive layout
- semantic and accessible structure
- maintainable code
- strong visual hierarchy
- modern motion/animation by default unless the user explicitly asks for static/minimal
- avoid generic repetitive template output
- never produce the same landing page with only the logo/title changed
- infer the industry, audience, product promise, trust objections, and CTA from the prompt
- make every generated page visibly prompt-specific through copy, layout, proof, section order, and visual language
- choose a distinct design direction per request: editorial, luxury service, operational dashboard, boutique studio, local business, or clean SaaS when appropriate
- when implementing, output executable edit tags only; plain markdown code is not applied
- for any new website/application, rewrite src/app/page.tsx at minimum
- for broad website/application builds, create a real multi-page App Router project by default: home plus 2-4 supporting routes such as src/app/about/page.tsx, src/app/services/page.tsx, src/app/pricing/page.tsx, src/app/faq/page.tsx, src/app/contact/page.tsx, src/app/dashboard/page.tsx, or domain-specific equivalents
- only keep a broad build as one page when the user explicitly asks for a single-page/one-page/landing-only result
- split the implementation into real files instead of dumping everything into one page: page routes, at least one shared component file, and at least one content/config/data file
- prefer a complete, polished implementation over shallow file count, but never use a tiny one-file toy page for a broad build
- do not use placeholder copy, fake generic stats, lorem ipsum, or repeated card names
- when the request implies a website, create a coherent site experience, not only a decorative hero section
- if multiple pages are explicitly requested, create real App Router pages and navigation
- if pages are not specified, infer the strongest sensible information architecture and implement several real routes
- make the result feel closer to a polished Replit/Lovable-quality prototype than a simple landing-page template
- include thoughtful empty states, microcopy, responsive behavior, conversion logic, hover states, and page/section transitions where relevant
- ask focused questions only when missing information would materially change the product; otherwise make professional defaults and build
- for full website requests, build at least 7 meaningful sections across multiple routes unless the requested scope is smaller
- generated sites must have a clear visual concept: color system, spacing rhythm, typography scale, card geometry, and section transitions
- do not generate a centered hero followed by identical cards unless the user explicitly asks for a minimal template
- when the user asks for pages such as pricing, FAQ, contact, dashboard, login, register, blog, or about, create those routes/files instead of only naming them in nav
- keep copy in the user's language and make it specific enough that it cannot be reused for an unrelated sector
- Klawpen is the builder brand, not the default brand for the generated customer website; do not name the generated project "Klawpen", "Klawpen Cloud", or "Klawpen Studio" unless the user explicitly asks for it
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
- Multi-route information architecture for broad website/app requests
- UI/UX quality and hierarchy
- Responsiveness expectations
- Code quality / maintainability
- Avoidance of generic template output
- Product-specific information architecture, not just a hero and generic cards
- Professional visual craft: typography, spacing, palette, sections, motion, states, and conversion flow

Rules:
- PASS only if score >= required minimum and quality is clearly strong.
- FAIL generic/simple landing pages that could fit any industry after only changing the logo.
- FAIL outputs that ignore requested pages or do not create routes for explicitly requested pages.
- FAIL broad website/application builds that create only one page unless the user explicitly requested a one-page/landing-only result.
- FAIL broad website/application builds with fewer than 3 real App Router page files.
- FAIL outputs with fewer than 7 meaningful sections across the project for broad website/app requests unless the user asked for something intentionally small.
- FAIL when the visual system is basic, repeated, or looks like a logo/title swap.
- FAIL broad website/application builds that lack shared components/content/config structure.
- FAIL broad website/application builds that have no purposeful animation, transition, hover state, or motion system unless the user requested static/minimal.
- FAIL outputs that use Klawpen, Klawpen Cloud, or Klawpen Studio as the generated customer brand unless the user explicitly requested Klawpen itself.
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

async function createAiChatText(params: {
  provider: AiProviderConfig;
  system: string;
  user: string | any[];
  temperature?: number;
  retries?: number;
}): Promise<string> {
  const client = getAiClient(params.provider);
  const temperature = params.temperature ?? aiTemperature;
  const retries = params.retries ?? aiMaxRetries;

  const response = await withRetries(
    () =>
      withTimeout(
        client.chat.completions.create({
          model: params.provider.model,
          messages: [
            { role: "system", content: params.system },
            { role: "user", content: params.user },
          ],
          // @ts-ignore
          temperature,
        }),
        AI_REQUEST_TIMEOUT_MS,
        `${params.provider.key} structured chat completion`
      ),
    retries
  );

  recordProviderRequest(params.provider.key);
  return extractChatCompletionText(response);
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

function shouldForceFallbackPage(
  userMessage: string,
  assistantContent: string,
  options: BuildOptions = {}
) {
  if (!hasBuildIntent(userMessage, options)) return false;
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

function getExecutableCodeOperations(assistantContent: string): CodeOperation[] {
  const taggedOperations = extractCodeOperations(assistantContent);
  return taggedOperations.length > 0
    ? taggedOperations
    : extractMarkdownCodeOperations(assistantContent);
}

function isBroadBuildRequest(message: string, options: BuildOptions = {}) {
  if (!hasBuildIntent(message, options)) return false;

  const normalized = normalizePromptText(message);
  const hasCreationIntent =
    /\b(yap|yapalim|olustur|hazirla|kur|tasarla|kodla|build|create|make|design|generate)\b/.test(
      normalized
    ) ||
    (/\b(istiyorum|lazim|ihtiyacim|need|want)\b/.test(normalized) &&
      /\b(site|website|web sitesi|landing|landing page|sayfa|dashboard|panel|app|uygulama|platform|product|urun|proje)\b/.test(
        normalized
      ));

  if (!hasCreationIntent && options.forceBuild !== true) return false;

  return (
    /\b(site|website|web sitesi|landing|landing page|sayfa|dashboard|panel|app|uygulama|platform|product|urun|proje)\b/.test(
      normalized
    ) || options.forceBuild === true
  );
}

function getWriteOperations(assistantContent: string) {
  return getExecutableCodeOperations(assistantContent).filter(
    (operation) => operation.type === "write" && operation.path
  );
}

function isExplicitSinglePageRequest(message: string) {
  const normalized = normalizePromptText(message);

  return /\b(tek sayfa|one page|single page|landing only|landing-only|sadece landing|yalniz landing|yalnizca landing|only landing)\b/.test(
    normalized
  );
}

function getRouteWriteCount(writes: CodeOperation[]) {
  return writes.filter((operation) =>
    /^src\/app\/(?:page|[^/]+\/page)\.tsx$/.test(
      normalizeProjectPath(operation.path || "")
    )
  ).length;
}

function getSupportingRouteWriteCount(writes: CodeOperation[]) {
  return writes.filter((operation) =>
    /^src\/app\/[^/]+\/page\.tsx$/.test(
      normalizeProjectPath(operation.path || "")
    )
  ).length;
}

function hasContentStructure(writes: CodeOperation[]) {
  return writes.some((operation) =>
    /^src\/(lib|data|config)\//.test(normalizeProjectPath(operation.path || ""))
  );
}

function hasComponentStructure(writes: CodeOperation[]) {
  return writes.some((operation) =>
    /^src\/components\//.test(normalizeProjectPath(operation.path || ""))
  );
}

function hasMotionSystem(writes: CodeOperation[]) {
  const combined = writes.map((operation) => operation.content || "").join("\n");

  return /\b(animate-|transition-|duration-|ease-|hover:|group-hover:|motion-safe|@keyframes|animation:|framer-motion|whileHover|initial=|animate=)\b/.test(
    combined
  );
}

function hasOnlySmallSinglePageBuild(assistantContent: string) {
  const writes = getWriteOperations(assistantContent);

  if (writes.length !== 1) return false;

  const onlyWrite = writes[0];
  if (!onlyWrite) return false;
  const normalizedPath = normalizeProjectPath(onlyWrite.path || "");
  const content = onlyWrite.content || "";

  return (
    normalizedPath === "src/app/page.tsx" &&
    (content.length < 12_000 || splitCodeLines(content).length < 240)
  );
}

function hasShallowBroadBuildStructure(assistantContent: string) {
  const writes = getWriteOperations(assistantContent);
  if (!writes.length) return false;

  const hasPageWrite = writes.some(
    (operation) => normalizeProjectPath(operation.path || "") === "src/app/page.tsx"
  );
  const hasSupportingStructure = writes.some((operation) =>
    /^src\/(components|lib|data|config)\//.test(
      normalizeProjectPath(operation.path || "")
    )
  );
  const totalWrittenBytes = writes.reduce(
    (total, operation) => total + (operation.content || "").length,
    0
  );
  const routeWriteCount = getRouteWriteCount(writes);
  const supportingRouteWriteCount = getSupportingRouteWriteCount(writes);

  return (
    !hasPageWrite ||
    routeWriteCount < 3 ||
    supportingRouteWriteCount < 2 ||
    writes.length < 3 ||
    !hasSupportingStructure ||
    !hasComponentStructure(writes) ||
    !hasContentStructure(writes) ||
    !hasMotionSystem(writes) ||
    totalWrittenBytes < 20_000 ||
    hasOnlySmallSinglePageBuild(assistantContent)
  );
}

function shouldRepairBuildDepth(
  userMessage: string,
  assistantContent: string,
  options: BuildOptions = {}
) {
  return (
    isBroadBuildRequest(userMessage, options) &&
    !isExplicitSinglePageRequest(userMessage) &&
    hasShallowBroadBuildStructure(assistantContent)
  );
}

function shouldRepairGeneratedBrandReuse(
  userMessage: string,
  assistantContent: string
) {
  if (/\bklawpen\b/i.test(userMessage)) return false;

  return getWriteOperations(assistantContent).some((operation) =>
    /\bKlawpen\s+(Cloud|Studio|Dashboard|App|AI|Core)\b/i.test(
      operation.content || ""
    )
  );
}

function normalizePromptText(userMessage: string) {
  return userMessage
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

function inferBusinessTitle(userMessage: string) {
  const normalized = userMessage.replace(/\s+/g, " ").replace(/[.!?]+$/g, "").trim();
  const plain = normalizePromptText(userMessage);

  if (/dis|dent|ortodont|klinik|implant/.test(plain)) return "DentaNova Clinic";
  if (/tesisat|plumb|su kacagi|komb|petek/.test(plain)) return "Vurkany Tesisat";
  if (/avukat|hukuk|law|legal/.test(plain)) return "Lexora Hukuk";
  if (/restoran|restaurant|cafe|kahve|menu/.test(plain)) return "Mira Table";
  if (/fitness|gym|spor|pilates/.test(plain)) return "Pulse Studio";
  if (/saas|software|dashboard|crm|app/.test(plain)) return "OrbitOps";

  const stopWords = new Set(["bana", "bir", "icin", "ile", "modern", "site", "website", "landing", "page", "yap", "olustur", "tasarla"]);
  const firstWords = normalizePromptText(normalized)
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .slice(0, 2)
    .map((word) => word.charAt(0).toLocaleUpperCase("tr-TR") + word.slice(1))
    .join(" ");

  return firstWords ? `${firstWords} Studio` : "Nova Studio";
}

type FallbackProfile = {
  sector: "dental" | "plumbing" | "legal" | "restaurant" | "fitness" | "saas" | "studio";
  layout: "split" | "editorial" | "cards" | "magazine";
  palette: {
    bg: string;
    text: string;
    muted: string;
    primary: string;
    primaryText: string;
    panel: string;
    panelText: string;
    accent: string;
    soft: string;
    border: string;
  };
  badge: string;
  headline: string;
  intro: string;
  primary: string;
  secondary: string;
  trust: string[];
  servicesTitle: string;
  services: Array<[string, string]>;
  processTitle: string;
  steps: string[];
  testimonial: string;
  faq: Array<[string, string]>;
  ctaTitle: string;
  ctaText: string;
};

function chooseFallbackProfile(userMessage: string): FallbackProfile {
  const plain = normalizePromptText(userMessage);
  const isTurkish = isLikelyTurkish(userMessage);
  const palettes = {
    dental: { bg: "#f4fbfb", text: "#102023", muted: "#5a7074", primary: "#29b6b1", primaryText: "#062527", panel: "#0e3438", panelText: "#f4ffff", accent: "#ffb86b", soft: "#d9f4f2", border: "#bfe7e4" },
    plumbing: { bg: "#f5f1e8", text: "#17201a", muted: "#667168", primary: "#e08b48", primaryText: "#17201a", panel: "#17201a", panelText: "#fffaf0", accent: "#265849", soft: "#e7ddcc", border: "#ddd1bd" },
    legal: { bg: "#f6f1e9", text: "#17110d", muted: "#766a5f", primary: "#b58b4a", primaryText: "#17110d", panel: "#211a16", panelText: "#fff7ec", accent: "#6d1f1a", soft: "#eadfce", border: "#ded0bc" },
    restaurant: { bg: "#fff5ea", text: "#22120b", muted: "#7c5d4c", primary: "#ef6b3a", primaryText: "#fff8ef", panel: "#34150d", panelText: "#fff8ef", accent: "#1f7a5b", soft: "#f7dfc8", border: "#efcfb4" },
    fitness: { bg: "#f2f4ef", text: "#10140f", muted: "#616b5c", primary: "#b8ff4d", primaryText: "#11160d", panel: "#121812", panelText: "#f8ffe9", accent: "#4d70ff", soft: "#dde8d7", border: "#ccd9c4" },
    saas: { bg: "#f3f7ff", text: "#0e1729", muted: "#61708a", primary: "#4d8bff", primaryText: "#ffffff", panel: "#111c33", panelText: "#f7fbff", accent: "#6ee7d8", soft: "#dce8ff", border: "#c8d7f3" },
    studio: { bg: "#f7f1ff", text: "#1d1428", muted: "#75677f", primary: "#ff7a59", primaryText: "#1d1428", panel: "#241433", panelText: "#fff8ff", accent: "#7cc7ff", soft: "#eadcf8", border: "#dac8ee" },
  } as const;

  const layoutSeed = Array.from(plain).reduce((total, char) => total + char.charCodeAt(0), 0);
  const layouts: FallbackProfile["layout"][] = ["split", "editorial", "cards", "magazine"];
  const layout = layouts[layoutSeed % layouts.length] || "split";

  if (/dis|dent|ortodont|klinik|implant/.test(plain)) {
    return {
      sector: "dental", layout, palette: palettes.dental,
      badge: isTurkish ? "Dijital randevu ve güvenli klinik deneyimi" : "Digital booking and trusted clinic experience",
      headline: isTurkish ? "Gülüş tasarımını daha sakin, şeffaf ve premium hale getirin" : "Make dental care feel calm, transparent, and premium",
      intro: isTurkish ? "Modern diş kliniği için randevu odaklı, güven veren ve tedavi süreçlerini anlaşılır gösteren profesyonel bir landing page." : "A professional appointment-focused landing page for a modern dental clinic, built to make treatments clear and reassuring.",
      primary: isTurkish ? "Randevu al" : "Book appointment",
      secondary: isTurkish ? "Tedavileri incele" : "Explore treatments",
      trust: isTurkish ? ["Aynı gün ön görüşme", "Şeffaf tedavi planı", "Steril ve premium klinik"] : ["Same-day consult", "Transparent treatment plan", "Sterile premium clinic"],
      servicesTitle: isTurkish ? "Tedavi alanları" : "Treatment areas",
      services: isTurkish ? [["İmplant ve cerrahi", "Eksik dişler için güvenli, planlı ve uzun ömürlü çözümler."], ["Estetik diş hekimliği", "Gülüş tasarımı, beyazlatma ve porselen uygulamalar."], ["Ortodonti", "Şeffaf plak ve tel tedavileriyle ölçülü hizalama."]] : [["Implant care", "Planned long-term solutions for missing teeth."], ["Cosmetic dentistry", "Smile design, whitening, and porcelain treatments."], ["Orthodontics", "Clear aligners and braces for precise alignment."]],
      processTitle: isTurkish ? "Klinik akış" : "Clinic flow",
      steps: isTurkish ? ["Ön değerlendirme", "Kişisel tedavi planı", "Konforlu uygulama"] : ["Initial consult", "Personal treatment plan", "Comfort-led care"],
      testimonial: isTurkish ? "İlk görüşmeden itibaren süreç çok netti; kendimi güvende hissettim." : "The process was clear from the first consultation; I felt genuinely safe.",
      faq: isTurkish ? [["Randevu ne kadar sürer?", "İlk görüşme genellikle 20-30 dakika sürer."], ["Fiyat nasıl belirlenir?", "Muayene sonrası kişisel tedavi planına göre netleşir."]] : [["How long is a consult?", "Most first visits take 20-30 minutes."], ["How is pricing set?", "After examination, pricing follows the personal treatment plan."]],
      ctaTitle: isTurkish ? "Daha sağlıklı bir gülüş için ilk adımı atın" : "Take the first step toward a healthier smile",
      ctaText: isTurkish ? "Ekibimiz ihtiyacınızı dinleyip uygun randevu ve tedavi planını netleştirir." : "Our team will clarify the right appointment and treatment plan for your needs.",
    };
  }

  if (/avukat|hukuk|law|legal/.test(plain)) {
    return {
      sector: "legal", layout, palette: palettes.legal,
      badge: isTurkish ? "Kurumsal hukuki danışmanlık" : "Corporate legal advisory",
      headline: isTurkish ? "Karmaşık hukuki süreçleri sakin ve stratejik şekilde yönetin" : "Navigate complex legal matters with calm strategy",
      intro: isTurkish ? "Şirketler ve bireyler için güven veren, uzmanlık alanlarını net anlatan premium hukuk ofisi sitesi." : "A premium law office landing page that communicates expertise and trust for companies and individuals.",
      primary: isTurkish ? "Ön görüşme talep et" : "Request consultation",
      secondary: isTurkish ? "Uzmanlıkları gör" : "View expertise",
      trust: isTurkish ? ["Gizli ön değerlendirme", "Stratejik dosya analizi", "Kurumsal raporlama"] : ["Confidential review", "Strategic case analysis", "Corporate reporting"],
      servicesTitle: isTurkish ? "Uzmanlık alanları" : "Practice areas",
      services: isTurkish ? [["Ticaret hukuku", "Sözleşme, ortaklık ve uyuşmazlık süreçlerinde stratejik destek."], ["İş hukuku", "İşveren ve çalışan süreçlerinde önleyici danışmanlık."], ["Dava ve tahkim", "Dosya stratejisi, takip ve temsil hizmetleri."]] : [["Commercial law", "Strategic support for contracts and disputes."], ["Employment law", "Preventive advisory for workplace matters."], ["Litigation", "Case strategy, tracking, and representation."]],
      processTitle: isTurkish ? "Çalışma modeli" : "Engagement model",
      steps: isTurkish ? ["Ön analiz", "Strateji notu", "Uygulama ve takip"] : ["Initial analysis", "Strategy memo", "Execution and tracking"],
      testimonial: isTurkish ? "Süreç boyunca riskleri sade ve net şekilde gördük." : "We understood the risks clearly throughout the process.",
      faq: isTurkish ? [["Görüşme gizli mi?", "Evet, tüm ön görüşmeler gizlilik ilkesiyle yürütülür."], ["Online görüşme var mı?", "Uygun dosyalar için online ön görüşme yapılabilir."]] : [["Is consultation confidential?", "Yes, every consultation follows confidentiality standards."], ["Do you offer online meetings?", "Online consultations are available for suitable matters."]],
      ctaTitle: isTurkish ? "Dosyanızı net bir stratejiyle ele alalım" : "Let us approach your matter with a clear strategy",
      ctaText: isTurkish ? "Kısa bir ön bilgi gönderin; uygun yol haritasını birlikte netleştirelim." : "Send a brief summary and we will clarify the right path forward.",
    };
  }

  const isPlumbing = /tesisat|plumb|su kacagi|komb|petek/.test(plain);
  const isRestaurant = /restoran|restaurant|cafe|kahve|menu/.test(plain);
  const isFitness = /fitness|gym|spor|pilates/.test(plain);
  const isSaas = /saas|software|dashboard|crm|app/.test(plain);
  type GenericFallbackSector = "plumbing" | "restaurant" | "fitness" | "saas" | "studio";
  type GenericSectorCopy = Pick<
    FallbackProfile,
    "badge" | "headline" | "intro" | "primary" | "secondary" | "servicesTitle" | "services"
  >;
  const sector: GenericFallbackSector = isPlumbing ? "plumbing" : isRestaurant ? "restaurant" : isFitness ? "fitness" : isSaas ? "saas" : "studio";
  const palette = palettes[sector];
  const sectorCopies: Record<GenericFallbackSector, GenericSectorCopy> = {
    plumbing: {
      badge: isTurkish ? "7/24 güvenilir servis" : "Reliable service, 24/7",
      headline: isTurkish ? "Tesisat sorunlarını hızlı, temiz ve garantili şekilde çözün" : "Solve plumbing issues quickly, cleanly, and reliably",
      intro: isTurkish ? "Acil servis, bakım ve yenileme hizmetlerini güven veren modern bir akışla sunan landing page." : "A modern landing page for emergency repair, maintenance, and renovation services.",
      primary: isTurkish ? "Hemen teklif al" : "Get a quote",
      secondary: isTurkish ? "Hizmetleri incele" : "Explore services",
      servicesTitle: isTurkish ? "Öne çıkan hizmetler" : "Featured services",
      services: isTurkish ? [["Acil tesisat onarımı", "Su kaçağı, tıkanıklık ve arıza durumlarında hızlı müdahale."], ["Banyo ve mutfak yenileme", "Temiz montaj ve planlı dönüşüm işleri."], ["Kombi ve petek hattı", "Isıtma hattı kontrolü, bakım ve verimlilik iyileştirme."]] : [["Emergency repair", "Fast response for leaks and clogs."], ["Kitchen and bath upgrades", "Clean installation and planned renovation."], ["Heating lines", "Maintenance and efficiency improvements."]],
    },
    restaurant: {
      badge: isTurkish ? "Rezervasyon odaklı lezzet deneyimi" : "Reservation-led dining experience",
      headline: isTurkish ? "Mekanınızın atmosferini daha ilk ekranda hissettirin" : "Make guests feel the atmosphere before they arrive",
      intro: isTurkish ? "Menü, rezervasyon ve sosyal kanıt odaklı sıcak ama premium bir restoran sitesi." : "A warm premium restaurant site focused on menu, booking, and social proof.",
      primary: isTurkish ? "Rezervasyon yap" : "Book a table",
      secondary: isTurkish ? "Menüyü gör" : "View menu",
      servicesTitle: isTurkish ? "Deneyim alanları" : "Experience highlights",
      services: isTurkish ? [["İmza lezzetler", "Mevsimsel ürünlerle hazırlanan seçili tabaklar."], ["Özel etkinlikler", "Kutlamalar ve ekip yemekleri için özel kurgu."], ["Şef menüsü", "Dönemsel tadım akışları ve öneriler."]] : [["Signature dishes", "Selected plates with seasonal ingredients."], ["Private events", "Tailored setup for celebrations and teams."], ["Chef menu", "Seasonal tasting flows and recommendations."]],
    },
    fitness: {
      badge: isTurkish ? "Kişisel hedefe göre antrenman" : "Goal-led training",
      headline: isTurkish ? "Enerjisi yüksek, ölçülebilir ve motive eden bir stüdyo deneyimi" : "A high-energy studio experience that keeps progress visible",
      intro: isTurkish ? "Üyelik, ders programı ve eğitmen güvenini öne çıkaran dinamik fitness landing page." : "A dynamic fitness landing page built around membership, classes, and coach trust.",
      primary: isTurkish ? "Deneme dersi al" : "Book a trial",
      secondary: isTurkish ? "Programları gör" : "View programs",
      servicesTitle: isTurkish ? "Programlar" : "Programs",
      services: isTurkish ? [["Kişisel antrenman", "Hedefe göre takip edilen bire bir program."], ["Grup dersleri", "Enerjik ve ritimli sınıf deneyimi."], ["Performans takibi", "Ölçüm, rapor ve gelişim planı."]] : [["Personal training", "One-to-one programs tracked by goal."], ["Group classes", "Rhythmic high-energy classes."], ["Progress tracking", "Measurement, reporting, and planning."]],
    },
    saas: {
      badge: isTurkish ? "Ekipler için akıllı operasyon" : "Smarter operations for teams",
      headline: isTurkish ? "Dağınık iş akışlarını tek, net ve ölçeklenebilir panele taşıyın" : "Move scattered workflows into one clear scalable platform",
      intro: isTurkish ? "Ürün değerini, entegrasyonları ve dönüşümü net anlatan premium SaaS landing page." : "A premium SaaS landing page that explains value, integrations, and conversion clearly.",
      primary: isTurkish ? "Demo iste" : "Request demo",
      secondary: isTurkish ? "Özellikleri gör" : "See features",
      servicesTitle: isTurkish ? "Temel özellikler" : "Core features",
      services: isTurkish ? [["Canlı dashboard", "Metrikler ve iş akışları tek ekranda."], ["Otomasyon", "Tekrarlayan işleri güvenli şekilde hızlandırın."], ["Ekip yönetimi", "Rol, yetki ve bildirimleri merkezileştirin."]] : [["Live dashboard", "Metrics and workflows in one place."], ["Automation", "Speed up repeatable work safely."], ["Team control", "Centralize roles, permissions, and alerts."]],
    },
    studio: {
      badge: isTurkish ? "Marka odaklı dijital deneyim" : "Brand-led digital experience",
      headline: isTurkish ? "Fikrinizi güçlü bir ilk izlenime dönüştüren modern web deneyimi" : "Turn your idea into a strong first digital impression",
      intro: isTurkish ? "Hedef kitleye güven veren, mesajı net ve görsel dili tutarlı bir landing page." : "A landing page with clear messaging, trust, and cohesive visual direction.",
      primary: isTurkish ? "Projeyi başlat" : "Start project",
      secondary: isTurkish ? "Detayları gör" : "See details",
      servicesTitle: isTurkish ? "Neler sunuyoruz" : "What we deliver",
      services: isTurkish ? [["Stratejik anlatı", "Ürünün değerini hızlı anlatan sayfa akışı."], ["Görsel sistem", "Renk, tipografi ve component ritmi."], ["Dönüşüm odaklı CTA", "Kullanıcıyı doğru aksiyona taşıyan yapı."]] : [["Strategic story", "A page flow that explains value quickly."], ["Visual system", "Color, type, and component rhythm."], ["Conversion CTA", "Structure that moves users to action."]],
    },
  };
  const copyBySector = sectorCopies[sector];

  return {
    sector,
    layout,
    palette,
    badge: copyBySector.badge,
    headline: copyBySector.headline,
    intro: copyBySector.intro,
    primary: copyBySector.primary,
    secondary: copyBySector.secondary,
    trust: isTurkish ? ["Hızlı başlangıç", "Mobil uyumlu", "Güven veren akış"] : ["Fast launch", "Mobile responsive", "Trust-first flow"],
    servicesTitle: copyBySector.servicesTitle,
    services: copyBySector.services,
    processTitle: isTurkish ? "Nasıl ilerler" : "How it works",
    steps: isTurkish ? ["İhtiyacı netleştir", "Deneyimi tasarla", "Yayına hazırla"] : ["Clarify need", "Design experience", "Prepare launch"],
    testimonial: isTurkish ? "Sayfa hem güven verdi hem de hizmetleri çok daha anlaşılır anlattı." : "The page built trust and made the offer much easier to understand.",
    faq: isTurkish ? [["Mobil uyumlu mu?", "Evet, sayfa mobil, tablet ve masaüstü için responsive hazırlanır."], ["Metinler değiştirilebilir mi?", "Evet, marka tonuna göre kolayca düzenlenebilir."]] : [["Is it responsive?", "Yes, the page is built for mobile, tablet, and desktop."], ["Can copy be changed?", "Yes, copy can be adjusted to your brand tone."]],
    ctaTitle: isTurkish ? "İlk izlenimi bugün güçlendirin" : "Strengthen the first impression today",
    ctaText: isTurkish ? "Ziyaretçiyi kararsız bırakmayan net, hızlı ve güven veren bir akışla başlayın." : "Start with a clear, fast, trust-building flow that helps visitors take action.",
  };
}

function buildFallbackSiteContent(userMessage: string) {
  const businessName = inferBusinessTitle(userMessage);
  const profile = chooseFallbackProfile(userMessage);
  const isTurkish = isLikelyTurkish(userMessage);

  const stats = isTurkish
    ? [
        ["7+", "Anlamlı bölüm"],
        ["3", "Net dönüşüm adımı"],
        ["24s", "İlk değer algısı"],
      ]
    : [
        ["7+", "Meaningful sections"],
        ["3", "Clear conversion steps"],
        ["24s", "First-value clarity"],
      ];

  const nav = isTurkish
    ? [
        ["Çözüm", "#solution"],
        ["Akış", "#workflow"],
        ["Kanıt", "#proof"],
        ["SSS", "#faq"],
      ]
    : [
        ["Solution", "#solution"],
        ["Workflow", "#workflow"],
        ["Proof", "#proof"],
        ["FAQ", "#faq"],
      ];

  const signals = profile.services.map(([title, text], index) => ({
    title,
    text,
    eyebrow: isTurkish ? `Sinyal 0${index + 1}` : `Signal 0${index + 1}`,
  }));

  const workflow = profile.steps.map((step, index) => ({
    step,
    text: isTurkish
      ? [
          "İhtiyaç ve hedef netleştirilir; kullanıcıyı durduran belirsizlikler çıkarılır.",
          "Sayfa akışı, güven unsurları ve aksiyon noktaları birlikte tasarlanır.",
          "Mobil ve masaüstü deneyim yayına hazır, net bir ilk sürüm haline getirilir.",
        ][index] || "Deneyim ölçümlenebilir ve geliştirilebilir hale getirilir."
      : [
          "Need and objective are clarified; user doubts are surfaced early.",
          "Page flow, trust proof, and action points are designed together.",
          "Mobile and desktop experience becomes a launch-ready first version.",
        ][index] || "The experience becomes measurable and easy to iterate.",
  }));

  const outcomes = isTurkish
    ? [
        ["Daha net ilk izlenim", "Ziyaretçi ilk ekranda ne sunduğunuzu, neden güveneceğini ve sonraki adımı anlar."],
        ["Sektöre özel anlatım", "Metinler genel ajans kalıbı yerine hedef kitleye, itiraza ve satın alma motivasyonuna göre yazılır."],
        ["Yayına hazır yapı", "Responsive düzen, okunabilir hiyerarşi ve düzenlenebilir component yapısı birlikte gelir."],
      ]
    : [
        ["Sharper first impression", "Visitors understand the offer, trust reason, and next step from the first screen."],
        ["Sector-specific story", "Copy is shaped around audience, objections, and motivation instead of generic agency text."],
        ["Launch-ready structure", "Responsive layout, readable hierarchy, and editable component structure ship together."],
      ];

  const caseStudy = isTurkish
    ? {
        label: "Örnek kullanım senaryosu",
        title: "Kararsız ziyaretçiyi yönlendiren net bir akış",
        text: "Sayfa, önce değeri anlatır; sonra güven unsurlarını, hizmet mimarisini ve karar vermeyi kolaylaştıran SSS alanını sırayla gösterir.",
      }
    : {
        label: "Example use case",
        title: "A clear flow that guides unsure visitors",
        text: "The page explains value first, then reveals trust proof, service architecture, and FAQ content that makes decisions easier.",
      };

  const labels = isTurkish
    ? {
        primaryCta: profile.primary,
        secondaryCta: profile.secondary,
        heroMeta: "Profesyonel ilk sürüm",
        dashboardTitle: "Canlı deneyim haritası",
        dashboardSubtitle: "Mesaj, kanıt ve aksiyon noktaları tek akışta.",
        signalTitle: "Ziyaretçinin karar vermesini kolaylaştıran yapı",
        workflowTitle: profile.processTitle,
        workflowIntro: "Her bölüm bir sonraki aksiyonu daha doğal hissettirmek için kurgulanır.",
        outcomesTitle: "Bu sayfa neyi iyileştirir?",
        proofTitle: "Güven ve dönüşüm alanı",
        faqTitle: "Sık sorulan sorular",
        finalTitle: profile.ctaTitle,
        finalText: profile.ctaText,
        builtBy: "Yayına hazır ilk sürüm",
      }
    : {
        primaryCta: profile.primary,
        secondaryCta: profile.secondary,
        heroMeta: "Professional first version",
        dashboardTitle: "Live experience map",
        dashboardSubtitle: "Message, proof, and action points in one flow.",
        signalTitle: "A structure that makes decisions easier",
        workflowTitle: profile.processTitle,
        workflowIntro: "Every section is shaped to make the next action feel natural.",
        outcomesTitle: "What this page improves",
        proofTitle: "Trust and conversion area",
        faqTitle: "Frequently asked questions",
        finalTitle: profile.ctaTitle,
        finalText: profile.ctaText,
        builtBy: "Launch-ready first version",
      };

  return {
    businessName,
    profile,
    nav,
    stats,
    signals,
    workflow,
    outcomes,
    caseStudy,
    labels,
  };
}

function buildFallbackContentFile(content: ReturnType<typeof buildFallbackSiteContent>): string {
  return `export const siteContent = ${JSON.stringify(content, null, 2)} as const;\n`;
}

function buildFallbackGeneratedSiteComponent(): string {
  return `import { siteContent } from "../lib/klawpen-generated-content";

export function GeneratedLandingPage() {
  const content = siteContent;
  const profile = content.profile;

  return (
    <main
      className="min-h-screen overflow-hidden"
      style={{ background: profile.palette.bg, color: profile.palette.text }}
    >
      <section className="relative px-4 py-5 sm:px-6 lg:px-10">
        <div
          className="pointer-events-none absolute inset-0 opacity-90"
          style={{
            background:
              "radial-gradient(circle at 12% 8%, " +
              profile.palette.soft +
              ", transparent 28%), radial-gradient(circle at 86% 10%, " +
              profile.palette.accent +
              "33, transparent 24%), linear-gradient(135deg, transparent, " +
              profile.palette.border +
              "55)",
          }}
        />

        <nav
          className="relative z-10 mx-auto flex max-w-7xl items-center justify-between rounded-[1.7rem] border px-4 py-3 shadow-sm backdrop-blur-xl sm:px-5"
          style={{ borderColor: profile.palette.border, background: profile.palette.bg + "e6" }}
        >
          <a href="#top" className="text-lg font-black tracking-[-0.04em] sm:text-xl">
            {content.businessName}
          </a>
          <div className="hidden items-center gap-1 md:flex">
            {content.nav.map(([label, href]) => (
              <a
                key={href}
                href={href}
                className="rounded-full px-4 py-2 text-sm font-bold transition hover:bg-white/55"
                style={{ color: profile.palette.muted }}
              >
                {label}
              </a>
            ))}
          </div>
          <a
            href="#contact"
            className="rounded-full px-5 py-2.5 text-sm font-black shadow-[0_14px_34px_rgba(0,0,0,0.14)]"
            style={{ background: profile.palette.primary, color: profile.palette.primaryText }}
          >
            {content.labels.primaryCta}
          </a>
        </nav>

        <div id="top" className="relative z-10 mx-auto grid max-w-7xl gap-10 py-16 lg:grid-cols-[0.95fr_1.05fr] lg:items-center lg:py-24">
          <div>
            <p
              className="mb-6 inline-flex rounded-full border bg-white/65 px-4 py-2 text-xs font-black uppercase tracking-[0.22em]"
              style={{ borderColor: profile.palette.border, color: profile.palette.accent }}
            >
              {profile.badge}
            </p>
            <h1 className="max-w-4xl text-[clamp(3.2rem,8vw,6.8rem)] font-black leading-[0.86] tracking-[-0.085em]">
              {profile.headline}
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 sm:text-xl" style={{ color: profile.palette.muted }}>
              {profile.intro}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a
                href="#contact"
                className="rounded-full px-7 py-4 text-center font-black shadow-[0_18px_42px_rgba(0,0,0,0.14)]"
                style={{ background: profile.palette.primary, color: profile.palette.primaryText }}
              >
                {content.labels.primaryCta}
              </a>
              <a
                href="#solution"
                className="rounded-full border bg-white/70 px-7 py-4 text-center font-black"
                style={{ borderColor: profile.palette.border }}
              >
                {content.labels.secondaryCta}
              </a>
            </div>
            <div className="mt-10 grid max-w-2xl grid-cols-3 gap-3">
              {content.stats.map(([value, label]) => (
                <div key={label} className="rounded-3xl border bg-white/60 p-4" style={{ borderColor: profile.palette.border }}>
                  <p className="text-3xl font-black tracking-[-0.06em]">{value}</p>
                  <p className="mt-1 text-xs font-bold leading-5" style={{ color: profile.palette.muted }}>
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <aside
            className="relative overflow-hidden rounded-[2.6rem] border p-4 shadow-[0_34px_100px_rgba(0,0,0,0.2)]"
            style={{ background: profile.palette.panel, borderColor: profile.palette.border, color: profile.palette.panelText }}
          >
            <div className="absolute right-[-10%] top-[-10%] h-56 w-56 rounded-full opacity-30 blur-3xl" style={{ background: profile.palette.primary }} />
            <div className="relative rounded-[2.1rem] bg-white/10 p-5 sm:p-6">
              <div className="mb-7 flex items-center justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.3em]" style={{ color: profile.palette.primary }}>
                    {content.labels.heroMeta}
                  </p>
                  <h2 className="mt-3 text-2xl font-black tracking-[-0.04em]">{content.labels.dashboardTitle}</h2>
                  <p className="mt-1 text-sm opacity-70">{content.labels.dashboardSubtitle}</p>
                </div>
                <div className="flex gap-1.5">
                  {["", "", ""].map((_, index) => (
                    <span key={index} className="h-3 w-3 rounded-full bg-white/30" />
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {content.stats.map(([value, label]) => (
                  <div key={label} className="rounded-3xl bg-white/10 p-4">
                    <p className="text-2xl font-black">{value}</p>
                    <p className="mt-1 text-xs leading-5 opacity-70">{label}</p>
                  </div>
                ))}
              </div>

              <div className="mt-5 rounded-[1.8rem] bg-black/12 p-4">
                <div className="flex h-40 items-end gap-2">
                  {[46, 72, 54, 88, 68, 94, 82].map((height, index) => (
                    <div key={index} className="flex flex-1 items-end rounded-full bg-white/10 p-1">
                      <span
                        className="block w-full rounded-full"
                        style={{ height: height + "%", background: profile.palette.primary }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section id="solution" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-10">
        <div className="mb-10 grid gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>
              {profile.servicesTitle}
            </p>
            <h2 className="mt-4 text-4xl font-black tracking-[-0.06em] sm:text-6xl">
              {content.labels.signalTitle}
            </h2>
          </div>
          <p className="max-w-2xl text-lg leading-8 lg:justify-self-end" style={{ color: profile.palette.muted }}>
            {profile.intro}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {content.signals.map((item) => (
            <article
              key={item.title}
              className="group rounded-[2rem] border bg-white/68 p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-xl"
              style={{ borderColor: profile.palette.border }}
            >
              <p className="text-xs font-black uppercase tracking-[0.24em]" style={{ color: profile.palette.primary }}>
                {item.eyebrow}
              </p>
              <h3 className="mt-8 text-2xl font-black tracking-[-0.04em]">{item.title}</h3>
              <p className="mt-4 leading-7" style={{ color: profile.palette.muted }}>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="workflow" className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-10">
        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-[2.6rem] p-8 text-white sm:p-12" style={{ background: profile.palette.panel }}>
            <p className="text-sm font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>
              {content.labels.workflowTitle}
            </p>
            <h2 className="mt-5 text-4xl font-black tracking-[-0.06em] sm:text-6xl">
              {content.labels.outcomesTitle}
            </h2>
            <p className="mt-5 max-w-xl leading-8 opacity-72">{content.labels.workflowIntro}</p>
          </div>
          <div className="grid gap-4">
            {content.workflow.map((item, index) => (
              <article key={item.step} className="rounded-[2rem] border bg-white/72 p-6" style={{ borderColor: profile.palette.border }}>
                <div className="flex gap-5">
                  <span className="text-3xl font-black tracking-[-0.06em]" style={{ color: profile.palette.primary }}>
                    0{index + 1}
                  </span>
                  <div>
                    <h3 className="text-2xl font-black tracking-[-0.04em]">{item.step}</h3>
                    <p className="mt-2 leading-7" style={{ color: profile.palette.muted }}>{item.text}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="proof" className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-10">
        <div className="grid gap-5 lg:grid-cols-3">
          {content.outcomes.map(([title, text]) => (
            <article key={title} className="rounded-[2rem] border bg-white/72 p-7" style={{ borderColor: profile.palette.border }}>
              <h3 className="text-2xl font-black tracking-[-0.04em]">{title}</h3>
              <p className="mt-4 leading-7" style={{ color: profile.palette.muted }}>{text}</p>
            </article>
          ))}
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <article className="rounded-[2.6rem] border bg-white/72 p-8 sm:p-12" style={{ borderColor: profile.palette.border }}>
            <p className="text-sm font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>
              {content.caseStudy.label}
            </p>
            <h2 className="mt-5 text-4xl font-black tracking-[-0.06em] sm:text-6xl">
              {content.caseStudy.title}
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-8" style={{ color: profile.palette.muted }}>
              {content.caseStudy.text}
            </p>
          </article>
          <article className="rounded-[2.6rem] p-8 text-white sm:p-10" style={{ background: profile.palette.panel }}>
            <p className="text-sm font-black uppercase tracking-[0.28em]" style={{ color: profile.palette.primary }}>
              {content.labels.proofTitle}
            </p>
            <p className="mt-8 text-3xl font-black leading-tight tracking-[-0.05em]">“{profile.testimonial}”</p>
            <div className="mt-8 space-y-3">
              {profile.trust.map((item) => (
                <div key={item} className="rounded-2xl bg-white/10 px-4 py-3 text-sm font-bold">
                  {item}
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section id="faq" className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-10">
        <div className="mb-8 flex items-end justify-between gap-6">
          <h2 className="text-4xl font-black tracking-[-0.06em] sm:text-6xl">{content.labels.faqTitle}</h2>
          <p className="hidden max-w-sm leading-7 md:block" style={{ color: profile.palette.muted }}>
            {content.labels.finalText}
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {profile.faq.map(([question, answer]) => (
            <article key={question} className="rounded-[2rem] border bg-white/72 p-6" style={{ borderColor: profile.palette.border }}>
              <h3 className="text-xl font-black tracking-[-0.03em]">{question}</h3>
              <p className="mt-3 leading-7" style={{ color: profile.palette.muted }}>{answer}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="contact" className="px-4 pb-24 sm:px-6 lg:px-10">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-[2.8rem] p-8 text-center text-white sm:p-14" style={{ background: profile.palette.panel }}>
          <p className="text-xs font-black uppercase tracking-[0.3em]" style={{ color: profile.palette.primary }}>
            {content.labels.builtBy}
          </p>
          <h2 className="mx-auto mt-5 max-w-4xl text-4xl font-black tracking-[-0.07em] sm:text-7xl">
            {content.labels.finalTitle}
          </h2>
          <p className="mx-auto mt-5 max-w-2xl leading-8 opacity-75">{content.labels.finalText}</p>
          <a
            href="mailto:hello@example.com"
            className="mt-9 inline-flex rounded-full px-8 py-4 font-black"
            style={{ background: profile.palette.primary, color: profile.palette.primaryText }}
          >
            {content.labels.primaryCta}
          </a>
        </div>
      </section>
    </main>
  );
}
`;
}

function buildFallbackLandingPage(_userMessage: string): string {
  return `import type { Metadata } from "next";
import { GeneratedLandingPage } from "../components/klawpen-generated-site";
import { siteContent } from "../lib/klawpen-generated-content";

export const metadata: Metadata = {
  title: siteContent.businessName + " | Klawpen Built Website",
  description: siteContent.profile.intro,
};

export default function Home() {
  return <GeneratedLandingPage />;
}
`;
}

function buildFallbackServicesPage(_userMessage: string): string {
  return `import type { Metadata } from "next";
import { GeneratedLandingPage } from "../../components/klawpen-generated-site";
import { siteContent } from "../../lib/klawpen-generated-content";

export const metadata: Metadata = {
  title: siteContent.profile.servicesTitle + " | " + siteContent.businessName,
  description: siteContent.profile.intro,
};

export default function ServicesPage() {
  return <GeneratedLandingPage />;
}
`;
}

function buildFallbackContactPage(_userMessage: string): string {
  return `import type { Metadata } from "next";
import { GeneratedLandingPage } from "../../components/klawpen-generated-site";
import { siteContent } from "../../lib/klawpen-generated-content";

export const metadata: Metadata = {
  title: siteContent.labels.finalTitle + " | " + siteContent.businessName,
  description: siteContent.labels.finalText,
};

export default function ContactPage() {
  return <GeneratedLandingPage />;
}
`;
}

function buildFallbackOperations(userMessage: string): CodeOperation[] {
  const content = buildFallbackSiteContent(userMessage);

  return [
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER - 4,
      path: "src/lib/klawpen-generated-content.ts",
      content: buildFallbackContentFile(content),
    },
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER - 3,
      path: "src/components/klawpen-generated-site.tsx",
      content: buildFallbackGeneratedSiteComponent(),
    },
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER - 2,
      path: "src/app/page.tsx",
      content: buildFallbackLandingPage(userMessage),
    },
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER - 1,
      path: "src/app/services/page.tsx",
      content: buildFallbackServicesPage(userMessage),
    },
    {
      type: "write",
      index: Number.MAX_SAFE_INTEGER,
      path: "src/app/contact/page.tsx",
      content: buildFallbackContactPage(userMessage),
    },
  ];
}

function buildFallbackAssistantContent(userMessage: string, reason: string): string {
  const writes = buildFallbackOperations(userMessage).map(
    (operation) =>
      `<dec-write path="${operation.path}">${operation.content || ""}</dec-write>`
  );

  return [
    "<dec-code>",
    "Plan:",
    "- " + reason,
    "- Apply a structured Klawpen fallback with content, component, and page files.",
    ...writes,
    "</dec-code>",
    isLikelyTurkish(userMessage)
      ? "Klawpen Core güvenli ama çok bölümlü bir ilk sürüm uyguladı."
      : "Klawpen Core applied a safe but multi-section first version.",
  ].join("\n");
}

function getOperationFilePaths(assistantContent: string): string[] {
  const paths = new Set<string>();

  for (const operation of [
    ...extractCodeOperations(assistantContent),
    ...extractMarkdownCodeOperations(assistantContent),
  ]) {
    if (operation.path) paths.add(normalizeProjectPath(operation.path));
    if (operation.to) paths.add(normalizeProjectPath(operation.to));
    if (operation.from) paths.add(normalizeProjectPath(operation.from));
  }

  return Array.from(paths).slice(0, 8);
}

async function applyCodeOperations(
  containerId: string,
  assistantContent: string,
  userMessage: string,
  progress?: ProgressReporter,
  options: BuildOptions = {}
): Promise<{ applied: number; failed: Array<{ label: string; error: string }> }> {
  let operations = extractCodeOperations(assistantContent);

  if (!operations.length) {
    operations = extractMarkdownCodeOperations(assistantContent);
  }

  if (
    !operations.length &&
    shouldForceFallbackPage(userMessage, assistantContent, options)
  ) {
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
    const reportAppliedProgress = async () => {
      await progress?.(
        getBuildProgressCopy(
          userMessage,
          "apply",
          Math.min(94, 84 + Math.round((result.applied / operations.length) * 10)),
          [
            operation.path,
            operation.to,
            operation.from,
            operation.packageName,
          ].filter(Boolean) as string[]
        )
      );
    };

    try {
      if (operation.type === "write" && operation.path !== undefined) {
        await fileService.writeFile(
          containerId,
          operation.path,
          operation.content || ""
        );
        result.applied += 1;
        await reportAppliedProgress();
        continue;
      }

      if (
        operation.type === "rename" &&
        operation.from !== undefined &&
        operation.to !== undefined
      ) {
        await fileService.renameFile(containerId, operation.from, operation.to);
        result.applied += 1;
        await reportAppliedProgress();
        continue;
      }

      if (operation.type === "delete" && operation.path !== undefined) {
        await fileService.removeFile(containerId, operation.path);
        result.applied += 1;
        await reportAppliedProgress();
        continue;
      }

      if (operation.type === "dependency" && operation.packageName) {
        const packageSpec = operation.version
          ? `${operation.packageName}@${operation.version}`
          : operation.packageName;

        await packageService.addDependency(containerId, packageSpec, false);
        result.applied += 1;
        await reportAppliedProgress();
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
  provider: AiProviderConfig,
  options: BuildOptions = {}
): Promise<string> {
  const plannerInput = `
SYSTEM:
${PLANNER_SYSTEM_PROMPT}

PLAN_MODE:
${options.planMode ? "Enabled. Produce a stronger product plan and identify only the questions that materially affect the result." : "Disabled. Infer sensible defaults unless the request is materially underspecified."}

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

function createLocalPlannerBrief(
  userMessage: string,
  options: BuildOptions = {}
): string {
  const turkish = isLikelyTurkish(userMessage);
  const inferredTitle = inferBusinessTitle(userMessage);
  const inferredProfile = chooseFallbackProfile(userMessage);
  const planningLine = options.planMode
    ? turkish
      ? "Planning Mode: Önce bilgi mimarisi, sayfa yapısı, tasarım yönü ve kritik belirsizlikleri netleştir; eksik ama kritik bilgi varsa en fazla 3 soru sor."
      : "Planning Mode: First clarify information architecture, page structure, visual direction, and critical unknowns; ask up to 3 questions only when they materially affect the result."
    : turkish
      ? "Planning Mode: Kapalı; eksik kalan küçük detaylarda profesyonel varsayımlar yap ve üret."
      : "Planning Mode: Off; make professional assumptions for minor gaps and build.";

  if (turkish) {
    return [
      `Goal: ${inferredTitle} için üretime hazır, modern, mobil uyumlu ve çok sayfalı bir web projesi oluştur.`,
      `Inferred Context: Sektör=${inferredProfile.sector}, tasarım yönü=${inferredProfile.layout}, ana CTA=${inferredProfile.primary}.`,
      planningLine,
      "Audience: Hizmet veya ürün arayan son kullanıcılar.",
      "UI/UX Direction: Prompt'a özel, güven veren, net hiyerarşili, premium, modern ve animasyonlu bir ürün/site deneyimi.",
      "Information Architecture: Ana sayfa + 2-4 destek sayfası oluştur; örnek route'lar: hizmetler/özellikler, fiyatlar/menü/tedaviler, hakkımızda, SSS, iletişim veya sektöre uygun eşdeğerleri.",
      "Required Pages/Sections: Her route kendi amacına sahip olsun; hero, kanıt, hizmet mimarisi, süreç, sosyal kanıt, SSS, iletişim/dönüşüm CTA ve sektöre özel ek bölümler projeye yayılsın.",
      "Technical Plan: Next.js App Router içinde src/app/page.tsx yanında gerçek route dosyaları, shared component dosyası, content/config dosyası ve modern transition/hover animasyonları oluştur.",
      "Acceptance Checklist: En az 3 gerçek page route, shared component/content yapısı, responsive tasarım, anlamlı sektörel metinler, erişilebilir HTML, bozuk import yok, tek sayfa/template hissi yok.",
    ].join("\n");
  }

  return [
    `Goal: Build a production-ready, modern, mobile-responsive multi-page web project for ${inferredTitle}.`,
    `Inferred Context: Sector=${inferredProfile.sector}, design direction=${inferredProfile.layout}, primary CTA=${inferredProfile.primary}.`,
    planningLine,
    "Audience: End users evaluating the service or product.",
    "UI/UX Direction: Prompt-specific, trustworthy, premium, modern, animated product/site experience with clear hierarchy.",
    "Information Architecture: Build a homepage plus 2-4 supporting pages; sensible routes include services/features, pricing/menu/treatments, about, FAQ, contact, dashboard, blog, or domain-specific equivalents.",
    "Required Pages/Sections: Each route should have a clear job; distribute hero, proof, service architecture, process, social proof, FAQ, contact/conversion CTA, and sector-specific sections across the project.",
    "Technical Plan: Use Next.js App Router with src/app/page.tsx plus real route files, shared component files, content/config data, and modern transition/hover animation patterns.",
    "Acceptance Checklist: At least 3 real page routes, shared component/content structure, responsive layout, meaningful sector-specific copy, accessible HTML, no broken imports, no one-page/template feel.",
  ].join("\n");
}
async function createBuilderResponse(
  input: string,
  provider: AiProviderConfig,
  userMessage?: string,
  options: BuildOptions = {}
): Promise<string> {
  if (userMessage && hasBuildIntent(userMessage, options)) {
    return createAiChatText({
      provider,
      system: input,
      user: [
        "USER BUILD REQUEST:",
        userMessage,
        "",
        "Return exactly one <dec-code> block.",
        "Use executable edit tags only.",
        "Rewrite src/app/page.tsx completely.",
        isBroadBuildRequest(userMessage, options) &&
        !isExplicitSinglePageRequest(userMessage)
          ? [
              "This is a broad website/app build: create a multi-page project, not a one-page landing.",
              "Create at least 3 real App Router page files: src/app/page.tsx plus 2+ supporting routes that fit the domain.",
              "Create shared components for navigation/layout/sections and a content/config/data file to avoid hardcoded repetition.",
              "Navigation links must point to real routes or real anchors; do not fake pages with navbar labels only.",
              "Include purposeful modern motion: page/section reveal classes, hover transitions, animated visual details, or CSS keyframes.",
            ].join("\n")
          : "If the user explicitly requested a single-page result, keep it one route but still make it polished and componentized.",
        "Do not name the generated customer-facing brand Klawpen unless the user asks for Klawpen itself.",
        "The result must be specific to this prompt, not a reused generic template.",
        options.planMode
          ? "Plan mode is enabled and the clarification gate has already passed: include a concise implementation plan inside the <dec-code> block, then implement decisively."
          : "Plan mode is disabled: infer professional defaults for missing minor details and implement directly.",
        "Raise the UI quality bar: build polished navigation, rich routes, responsive behavior, strong typography, deliberate color, animations, states, and product-specific copy. Avoid simple toy layouts.",
      ].join("\n"),
      temperature: Math.max(aiTemperature, 0.22),
    });
  }

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
  options?: BuildOptions;
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

    let critic: CriticResult;
    try {
      critic = await createCriticReview(criticInput, params.provider);
    } catch (error) {
      console.warn(
        "AI critic review failed; keeping the current executable draft:",
        error instanceof Error ? error.message : error
      );
      return currentDraft;
    }

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

    let revised: string;
    try {
      revised = await createBuilderResponse(
        revisionInput,
        params.provider,
        params.userMessage,
        params.options
      );
    } catch (error) {
      console.warn(
        "AI critic revision failed; keeping the current executable draft:",
        error instanceof Error ? error.message : error
      );
      return currentDraft;
    }

    if (hasExecutableCodeOperations(revised)) {
      currentDraft = revised;
      continue;
    }

    if (!hasExecutableCodeOperations(currentDraft)) {
      currentDraft = revised;
      continue;
    }

    console.warn(
      "AI critic revision had no executable edit tags; keeping previous executable draft."
    );
    return currentDraft;
  }

  return currentDraft;
}

async function repairMissingExecutableEdits(params: {
  userMessage: string;
  plannerBrief: string;
  codeContext: string;
  draft: string;
  provider: AiProviderConfig;
  options?: BuildOptions;
}): Promise<string> {
  const missingExecutableEdits = shouldForceFallbackPage(
    params.userMessage,
    params.draft,
    params.options
  );
  const shallowBroadBuild = shouldRepairBuildDepth(
    params.userMessage,
    params.draft,
    params.options
  );
  const reusedBuilderBrand = shouldRepairGeneratedBrandReuse(
    params.userMessage,
    params.draft
  );

  if (!missingExecutableEdits && !shallowBroadBuild && !reusedBuilderBrand) {
    return params.draft;
  }

  console.warn(
    "AI build response needs repair before apply:",
    {
      missingExecutableEdits,
      shallowBroadBuild,
      reusedBuilderBrand,
    }
  );

  const repairReason = missingExecutableEdits
    ? "The previous assistant output is invalid because it did not contain executable edit operations."
    : shallowBroadBuild
      ? "The previous assistant output was too shallow for a broad build: it did not create enough real routes, shared structure, motion, or implementation depth."
      : "The previous assistant output reused Klawpen as the customer-facing generated brand without user intent.";

  const repairInput = `
SYSTEM:
${prompt}

${BUILDER_SYSTEM_PROMPT}

${repairReason}
Return exactly one <dec-code> block with executable edit tags.
For this build request, rewrite src/app/page.tsx and create a real multi-page App Router project:
- at least 3 page files total, including src/app/page.tsx plus 2+ supporting routes that fit the user's domain
- shared component files for navigation, layout, cards/sections, and reusable visual primitives
- a content/config/data file so copy and page metadata are organized instead of hardcoded repeatedly
- real links between pages and meaningful CTAs
- purposeful modern motion: transitions, hover states, reveal animations, or CSS keyframes
The implementation must feel prompt-specific, visually polished, responsive, and complete enough to preview as a professional first version.
Do not use Klawpen, Klawpen Cloud, or Klawpen Studio as the customer-facing site name unless the user explicitly asks for Klawpen.
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
    const repaired = await createBuilderResponse(
      repairInput,
      params.provider,
      params.userMessage,
      params.options
    );
    if (hasExecutableCodeOperations(repaired)) {
      if (
        !shouldRepairBuildDepth(params.userMessage, repaired, params.options) &&
        !shouldRepairGeneratedBrandReuse(params.userMessage, repaired)
      ) {
        return repaired;
      }

      console.warn(
        "AI repair response was executable but still too shallow or reused builder branding; falling back to structured local build."
      );
    }

    console.warn(
      "AI repair response still did not meet executable/depth/branding requirements; falling back to generated landing page."
    );
    return buildFallbackAssistantContent(
      params.userMessage,
      "AI repair response still had no executable edit tags."
    );
  } catch (error) {
    console.warn(
      "AI repair pass failed; falling back to generated landing page:",
      error instanceof Error ? error.message : error
    );
    return buildFallbackAssistantContent(
      params.userMessage,
      "AI repair pass failed before returning executable edit tags."
    );
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
  workloadEstimate?: AiWorkloadEstimate,
  progress?: ProgressReporter,
  options: BuildOptions = {}
): Promise<{ assistantMessage: Message }> {
  await progress?.(getBuildProgressCopy(userMessage, "scan", 8));
  const fileContentTree = await fileService.getFileContentTree(
    dockerService.docker,
    containerId
  );

  const rawContext = JSON.stringify(fileContentTree, null, 2);
  const codeContext = clipText(rawContext, 120_000);
  let assistantContent: string;

  if (isRuntimeRepairRequest(userMessage)) {
    await progress?.(getBuildProgressCopy(userMessage, "repair", 28, [
      "src/app/page.tsx",
    ]));
    console.warn(
      "Runtime repair request detected; applying deterministic fallback page without waiting for AI."
    );
    assistantContent = buildFallbackAssistantContent(
      userMessage,
      "Replace the broken runtime page with a known-good structured Klawpen build."
    );
  } else {
    const provider = selectAiProvider(workloadEstimate);

    const recentMessages = session.messages
      .slice(-8)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n");

    let plannerBrief = createLocalPlannerBrief(userMessage, options);
    await progress?.(getBuildProgressCopy(userMessage, "plan", 18));
    try {
      plannerBrief = await createPlannerBrief(
        userMessage,
        recentMessages,
        provider,
        options
      );
    } catch (error) {
      console.warn(
        "AI planner failed; continuing with local planner brief:",
        error instanceof Error ? error.message : error
      );
    }

    await progress?.(getBuildProgressCopy(userMessage, "draft", 36, [
      "src/app/page.tsx",
    ]));
    const systemPrompt = `${prompt}

${BUILDER_SYSTEM_PROMPT}

BUILD OPTIONS:
- Plan mode: ${options.planMode ? "enabled" : "disabled"}
- Quality target: polished Klawpen/Replit-style product prototype, not a basic template

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

    try {
      assistantContent = await createBuilderResponse(
        flattenedInput,
        provider,
        userMessage,
        options
      );

      await progress?.(getBuildProgressCopy(userMessage, "review", 62));
      assistantContent = await improveWithCriticLoop({
        userMessage,
        plannerBrief,
        codeContext: clipText(codeContext, 80_000),
        recentMessages: clipText(recentMessages, 10_000),
        draft: assistantContent,
        provider,
        options,
      });

      await progress?.(getBuildProgressCopy(userMessage, "repair", 72));
      assistantContent = await repairMissingExecutableEdits({
        userMessage,
        plannerBrief,
        codeContext,
        draft: assistantContent,
        provider,
        options,
      });
    } catch (error) {
      console.error(
        "AI builder generation failed; applying local fallback landing page:",
        error instanceof Error ? error.message : error
      );
      assistantContent = buildFallbackAssistantContent(
        userMessage,
        "AI provider failed or timed out before returning a valid executable build."
      );
    }
  }

  assistantContent = appendChangeSummaryTag(assistantContent, fileContentTree);
  await progress?.(
    getBuildProgressCopy(
      userMessage,
      "apply",
      86,
      getOperationFilePaths(assistantContent)
    )
  );
  const applyResult = await applyCodeOperations(
    containerId,
    assistantContent,
    userMessage,
    progress,
    options
  );

  if (applyResult.failed.length > 0) {
    const failedItems = applyResult.failed
      .slice(0, 4)
      .map((item) => `- ${item.label}: ${item.error}`)
      .join("\n");

    assistantContent += `\n<dec-error>Some generated edits could not be applied automatically. The backend logged the details:\n${failedItems}</dec-error>`;
  }

  await progress?.(
    getBuildProgressCopy(
      userMessage,
      "refresh",
      96,
      getOperationFilePaths(assistantContent)
    )
  );

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
  workloadEstimate?: AiWorkloadEstimate,
  options: BuildOptions = {}
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
    workloadEstimate,
    undefined,
    options
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
  workloadEstimate?: AiWorkloadEstimate,
  options: BuildOptions = {}
): AsyncGenerator<{ type: "user" | "assistant" | "progress" | "done"; data: any }> {
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

  const progressQueue: BuildProgress[] = [];
  let wakeProgressReader: (() => void) | null = null;
  let buildFinished = false;

  const buildPromise = buildAssistantMessageFromSession(
    session,
    containerId,
    userMessage,
    workloadEstimate,
    (progress) => {
      progressQueue.push(progress);
      wakeProgressReader?.();
      wakeProgressReader = null;
    },
    options
  ).finally(() => {
    buildFinished = true;
    wakeProgressReader?.();
    wakeProgressReader = null;
  });

  while (!buildFinished || progressQueue.length > 0) {
    while (progressQueue.length > 0) {
      const progress = progressQueue.shift();
      if (progress) yield { type: "progress", data: progress };
    }

    if (buildFinished) break;

    await Promise.race([
      buildPromise.then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => {
        wakeProgressReader = resolve;
      }),
    ]);
  }

  const { assistantMessage } = await buildPromise;

  yield { type: "assistant", data: assistantMessage };
  yield { type: "done", data: assistantMessage };
}
