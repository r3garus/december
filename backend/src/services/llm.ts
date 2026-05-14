import OpenAI from "openai";
import { config } from "../../config";
import prompt from "../utils/prompt.txt";
import * as dockerService from "./docker";
import * as fileService from "./file";

const openai = new OpenAI({
  apiKey: config.aiSdk.apiKey,
  baseURL: config.aiSdk.baseUrl || "https://api.openai.com/v1",
});

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: Attachment[];
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

const chatSessions = new Map<string, ChatSession>();

const PLANNER_SYSTEM_PROMPT = `
You are a senior product strategist for a coding agent.
Given a user's request, produce an implementation brief in concise plain text with:
1) Goal
2) Audience
3) UI/UX Direction
4) Required Pages/Sections
5) Technical Plan
6) Acceptance Checklist

If request is short, infer missing details professionally.
`;

const BUILDER_SYSTEM_PROMPT = `
You are a senior full-stack engineer and frontend architect.
Deliver production-minded quality:
- responsive layout
- semantic and accessible structure
- maintainable code
- strong visual hierarchy
- avoid generic repetitive template output
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
  const verdictRaw = verdictMatch ? verdictMatch[1].toUpperCase() : "FAIL";
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

async function createPlannerBrief(
  userMessage: string,
  recentConversation: string
): Promise<string> {
  const plannerInput = `
SYSTEM:
${PLANNER_SYSTEM_PROMPT}

RECENT CONVERSATION:
${recentConversation || "No prior conversation."}

USER REQUEST:
${userMessage}
`;

  const plannerResponse = await withRetries(
    () =>
      openai.responses.create({
        model: config.aiSdk.model,
        input: plannerInput,
        // @ts-ignore
        temperature: Math.min(config.aiSdk.temperature, 0.2),
      }),
    config.aiSdk.maxRetries
  );

  return extractResponseText(plannerResponse);
}

async function createBuilderResponse(input: string): Promise<string> {
  const response = await withRetries(
    () =>
      openai.responses.create({
        model: config.aiSdk.model,
        input,
        // @ts-ignore
        temperature: config.aiSdk.temperature,
      }),
    config.aiSdk.maxRetries
  );

  return extractResponseText(response);
}

async function createCriticReview(input: string): Promise<CriticResult> {
  const response = await withRetries(
    () =>
      openai.responses.create({
        model: config.aiSdk.model,
        input,
        // @ts-ignore
        temperature: 0.1,
      }),
    config.aiSdk.maxRetries
  );

  const text = extractResponseText(response);
  return parseCriticResult(text);
}

async function improveWithCriticLoop(params: {
  userMessage: string;
  plannerBrief: string;
  codeContext: string;
  recentMessages: string;
  draft: string;
}): Promise<string> {
  let currentDraft = params.draft;

  for (let round = 1; round <= config.aiSdk.maxCriticRounds; round++) {
    const criticInput = `
SYSTEM:
${CRITIC_SYSTEM_PROMPT}

MINIMUM_SCORE:
${config.aiSdk.minQualityScore}

USER_REQUEST:
${params.userMessage}

PLANNER_BRIEF:
${params.plannerBrief}

RECENT_CONVERSATION:
${params.recentMessages || "No recent conversation."}

ASSISTANT_OUTPUT_TO_REVIEW:
${currentDraft}
`;

    const critic = await createCriticReview(criticInput);

    const passes =
      critic.verdict === "PASS" && critic.score >= config.aiSdk.minQualityScore;

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

    currentDraft = await createBuilderResponse(revisionInput);
  }

  return currentDraft;
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

export async function sendMessage(
  containerId: string,
  userMessage: string,
  attachments: Attachment[] = []
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  const session = getOrCreateChatSession(containerId);

  const userMsg: Message = {
    id: `user-${Date.now()}`,
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  session.messages.push(userMsg);

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

  const plannerBrief = await createPlannerBrief(userMessage, recentMessages);

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
  let assistantContent = await createBuilderResponse(flattenedInput);

  assistantContent = await improveWithCriticLoop({
    userMessage,
    plannerBrief,
    codeContext: clipText(codeContext, 80_000),
    recentMessages: clipText(recentMessages, 10_000),
    draft: assistantContent,
  });

  const assistantMsg: Message = {
    id: `assistant-${Date.now()}`,
    role: "assistant",
    content: assistantContent,
    timestamp: new Date().toISOString(),
  };

  session.messages.push(assistantMsg);
  session.updatedAt = new Date().toISOString();

  return {
    userMessage: userMsg,
    assistantMessage: assistantMsg,
  };
}

export async function* sendMessageStream(
  containerId: string,
  userMessage: string,
  attachments: Attachment[] = []
): AsyncGenerator<{ type: "user" | "assistant" | "done"; data: any }> {
  const { userMessage: userMsg, assistantMessage } = await sendMessage(
    containerId,
    userMessage,
    attachments
  );

  yield { type: "user", data: userMsg };
  yield { type: "assistant", data: assistantMessage };
  yield { type: "done", data: assistantMessage };
}
