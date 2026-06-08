export type AiProviderKey = string;

export interface AiProviderConfig {
  key: AiProviderKey;
  displayName: "Klawpen Core";
  envPrefix: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dailyRequestLimit: number;
  priority: number;
}

export interface AiWorkloadEstimate {
  tier: "light" | "normal" | "medium" | "heavy" | "extreme";
  coreCredits: number;
  inputScore: number;
  attachmentCount: number;
  providerHint: AiProviderKey;
}

const DEFAULT_BASE_URL = "https://api.gptclubapi.xyz/openai/v1";
const DEFAULT_CR_MODEL = "gpt-5.3-codex";
const DEFAULT_SK_MODEL = "anthropic/claude-haiku-4.5";

function readInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readProviderHint(...values: Array<string | undefined>): AiProviderKey | "" {
  const raw = values.find((value) => value?.trim())?.trim().toLowerCase() || "";
  return /^[a-z0-9_.:-]+$/i.test(raw) ? raw : "";
}

const BUILD_PROVIDER_HINT = readProviderHint(
  process.env.KLAWPEN_BUILD_PROVIDER,
  process.env.AI_BUILD_PROVIDER
);
const CHAT_PROVIDER_HINT = readProviderHint(
  process.env.KLAWPEN_CHAT_PROVIDER,
  process.env.AI_CHAT_PROVIDER
);

function readProviderConfig(
  key: "cr" | "sk",
  envPrefix: "CR" | "SK",
  fallbackModel: string,
  fallbackDailyLimit: number,
  priority: number
): AiProviderConfig | null {
  const apiKey =
    process.env[`${envPrefix}_AI_API_KEY`] ||
    process.env[`${envPrefix}_API_KEY`] ||
    "";

  if (!apiKey) return null;

  return {
    key,
    displayName: "Klawpen Core",
    envPrefix,
    baseUrl:
      process.env[`${envPrefix}_AI_BASE_URL`] ||
      process.env[`${envPrefix}_BASE_URL`] ||
      process.env.AI_BASE_URL ||
      DEFAULT_BASE_URL,
    apiKey,
    model:
      process.env[`${envPrefix}_AI_MODEL`] ||
      process.env[`${envPrefix}_MODEL`] ||
      fallbackModel,
    dailyRequestLimit: readInt(
      process.env[`${envPrefix}_DAILY_REQUEST_LIMIT`],
      fallbackDailyLimit
    ),
    priority,
  };
}

function readJsonProviderPool(): AiProviderConfig[] {
  const rawPool =
    process.env.KLAWPEN_CORE_PROVIDERS_JSON ||
    process.env.AI_PROVIDER_POOL_JSON ||
    "";

  if (!rawPool.trim()) return [];

  try {
    const parsed = JSON.parse(rawPool) as unknown;

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item, index): AiProviderConfig | null => {
        if (!item || typeof item !== "object") return null;

        const value = item as Record<string, unknown>;
        const apiKey = typeof value.apiKey === "string" ? value.apiKey : "";
        const key =
          typeof value.key === "string" && value.key.trim()
            ? value.key.trim()
            : `pool-${index + 1}`;

        if (!apiKey || !/^[a-z0-9_.:-]+$/i.test(key)) return null;

        return {
          key,
          displayName: "Klawpen Core",
          envPrefix: key.toUpperCase(),
          baseUrl:
            (typeof value.baseUrl === "string" && value.baseUrl) ||
            (typeof value.baseURL === "string" && value.baseURL) ||
            DEFAULT_BASE_URL,
          apiKey,
          model:
            (typeof value.model === "string" && value.model) ||
            DEFAULT_CR_MODEL,
          dailyRequestLimit: readInt(
            typeof value.dailyRequestLimit === "string"
              ? value.dailyRequestLimit
              : typeof value.dailyRequestLimit === "number"
                ? String(value.dailyRequestLimit)
                : undefined,
            750
          ),
          priority: readInt(
            typeof value.priority === "string"
              ? value.priority
              : typeof value.priority === "number"
                ? String(value.priority)
                : undefined,
            index + 10
          ),
        };
      })
      .filter(Boolean) as AiProviderConfig[];
  } catch {
    return [];
  }
}

export function getAiProviders(): AiProviderConfig[] {
  const providers = [
    readProviderConfig("cr", "CR", DEFAULT_CR_MODEL, 1000, 1),
    readProviderConfig("sk", "SK", DEFAULT_SK_MODEL, 750, 2),
    ...readJsonProviderPool(),
  ].filter(Boolean) as AiProviderConfig[];

  if (providers.length > 0) return providers;

  const legacyApiKey =
    process.env.AI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "";

  if (!legacyApiKey) return [];

  return [
    {
      key: "cr",
      displayName: "Klawpen Core",
      envPrefix: "CR",
      baseUrl: process.env.AI_BASE_URL || DEFAULT_BASE_URL,
      apiKey: legacyApiKey,
      model: process.env.AI_MODEL || DEFAULT_CR_MODEL,
      dailyRequestLimit: readInt(process.env.AI_DAILY_REQUEST_LIMIT, 1000),
      priority: 1,
    },
  ];
}

export function estimateAiWorkload({
  message,
  attachmentCount = 0,
  totalAttachmentBytes = 0,
}: {
  message: string;
  attachmentCount?: number;
  totalAttachmentBytes?: number;
}): AiWorkloadEstimate {
  const lengthScore = Math.ceil(Math.max(message.length, 1) / 900);
  const attachmentScore = attachmentCount * 2 + Math.ceil(totalAttachmentBytes / 1_500_000);
  const intentScore = [
    /\b(full|complete|entire|whole|all|production|deploy|dashboard|backend|database|auth|payment|subscription|refactor|rewrite|generate|build)\b/i,
    /\b(tamam[ıi]n[ıi]|hepsini|b[üu]t[üu]n|s[ıi]f[ıi]rdan|dashboard|backend|veritaban[ıi]|abonelik|[öo]deme|refactor|yeniden|olu[sş]tur)\b/i,
  ].reduce((score, pattern) => score + (pattern.test(message) ? 3 : 0), 0);

  const inputScore = lengthScore + attachmentScore + intentScore;

  const buildIntent = /\b(yap|olu[sş]tur|tasarla|kodla|geli[sş]tir|landing|website|site|uygulama|dashboard|build|create|make|design|implement|generate)\b/i.test(message);
  const buildProvider: AiProviderKey = BUILD_PROVIDER_HINT || "cr";
  const chatProvider: AiProviderKey = CHAT_PROVIDER_HINT || "sk";
  const preferredProvider: AiProviderKey = buildIntent
    ? buildProvider
    : chatProvider;

  if (inputScore <= 3) {
    return { tier: "light", coreCredits: 1, inputScore, attachmentCount, providerHint: preferredProvider };
  }
  if (inputScore <= 7) {
    return { tier: "normal", coreCredits: 2, inputScore, attachmentCount, providerHint: preferredProvider };
  }
  if (inputScore <= 13) {
    return { tier: "medium", coreCredits: 5, inputScore, attachmentCount, providerHint: preferredProvider };
  }
  if (inputScore <= 24) {
    return { tier: "heavy", coreCredits: 15, inputScore, attachmentCount, providerHint: buildProvider };
  }

  return { tier: "extreme", coreCredits: 35, inputScore, attachmentCount, providerHint: buildProvider };
}

const usageByProvider = new Map<string, { day: string; count: number }>();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyCount(providerKey: AiProviderKey) {
  const day = todayKey();
  const current = usageByProvider.get(providerKey);
  if (!current || current.day !== day) {
    usageByProvider.set(providerKey, { day, count: 0 });
    return 0;
  }

  return current.count;
}

export function recordProviderRequest(providerKey: AiProviderKey) {
  const day = todayKey();
  const current = usageByProvider.get(providerKey);
  if (!current || current.day !== day) {
    usageByProvider.set(providerKey, { day, count: 1 });
    return;
  }

  current.count += 1;
}

export function selectAiProvider(
  estimate?: Pick<AiWorkloadEstimate, "providerHint">
): AiProviderConfig {
  const providers = getAiProviders();

  if (providers.length === 0) {
    throw new Error("At least one Klawpen Core provider key is required");
  }

  const preferred = estimate?.providerHint
    ? providers.find((provider) => provider.key === estimate.providerHint)
    : null;
  const orderedProviders = [
    ...(preferred ? [preferred] : []),
    ...providers.filter((provider) => provider.key !== preferred?.key),
  ].sort((a, b) => {
    if (a.key === preferred?.key) return -1;
    if (b.key === preferred?.key) return 1;
    return a.priority - b.priority;
  });

  const selectedProvider =
    orderedProviders.find(
      (provider) => getDailyCount(provider.key) < provider.dailyRequestLimit
    ) || orderedProviders[0];

  if (!selectedProvider) {
    throw new Error("No Klawpen Core provider is available");
  }

  return selectedProvider;
}

