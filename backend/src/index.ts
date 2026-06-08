import express from "express";
import { requireAccount } from "./services/account";
import accountRoutes from "./routes/account";
import chatRoutes from "./routes/chat";
import containerRoutes from "./routes/containers";
import previewRoutes, { redirectPreviewEscapeRequest } from "./routes/preview";
import {
  getAiProviderDiagnostics,
  runAiProviderSmokeTest,
} from "./services/aiProvider";
import {
  getDockerRuntimeDiagnostics,
  getPreviewProxyOrigin,
} from "./services/docker";

const app = express();

const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([
  "https://klawpen.com",
  "https://www.klawpen.com",
  "https://builder.klawpen.com",
  "https://api.builder.klawpen.com",
  "https://preview.builder.klawpen.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3010",
  "http://localhost:7000",
  "http://127.0.0.1:3000",
  ...configuredOrigins,
]);

const isAllowedOrigin = (origin?: string) => {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;

  if (process.env.NODE_ENV !== "production") {
    return /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  }

  return false;
};

app.use((req, res, next): void => {
  const origin = req.headers.origin;

  if (typeof origin === "string" && isAllowedOrigin(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Backend-Token"
  );

  if (req.method === "OPTIONS") {
    res.sendStatus(isAllowedOrigin(origin) ? 204 : 403);
    return;
  }

  if (!isAllowedOrigin(origin)) {
    res.status(403).json({
      success: false,
      error: "Origin is not allowed",
    });
    return;
  }

  next();
});

const backendApiToken = process.env.BACKEND_API_TOKEN || "";

function hasValidBackendToken(req: express.Request): boolean {
  if (!backendApiToken) return true;

  const backendToken = req.headers["x-backend-token"];

  if (!backendToken) return true;

  return backendToken === backendApiToken;
}

app.use((req, res, next): void => {
  if (hasValidBackendToken(req)) {
    next();
    return;
  }

  res.status(401).json({
    success: false,
    error: "Unauthorized API request",
  });
});

interface RateBucket {
  windowStart: number;
  count: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || "240");
const EXPENSIVE_RATE_LIMIT = Number(
  process.env.EXPENSIVE_RATE_LIMIT_PER_MINUTE || "30"
);
const rateBuckets = new Map<string, RateBucket>();

function getClientKey(req: express.Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  const forwardedIp =
    typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : "";

  return forwardedIp || req.ip || req.socket.remoteAddress || "unknown";
}

function getRequestRateLimit(req: express.Request): number {
  const isExpensiveRequest =
    req.path === "/containers/create" ||
    req.path.endsWith("/messages") ||
    req.path.endsWith("/dependencies") ||
    req.path.endsWith("/export");

  return isExpensiveRequest ? EXPENSIVE_RATE_LIMIT : DEFAULT_RATE_LIMIT;
}

function cleanupExpiredRateBuckets(now: number): void {
  if (rateBuckets.size < 1000) return;

  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateBuckets.delete(key);
    }
  }
}

app.use((req, res, next): void => {
  const now = Date.now();
  const limit = getRequestRateLimit(req);
  const key = `${getClientKey(req)}:${limit}`;
  const current = rateBuckets.get(key);

  cleanupExpiredRateBuckets(now);

  if (!current || now - current.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { windowStart: now, count: 1 });
    next();
    return;
  }

  current.count += 1;
  if (current.count > limit) {
    res.status(429).json({
      success: false,
      error: "Too many requests. Please slow down and try again shortly.",
    });
    return;
  }

  next();
});

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: "klawpen-builder-api",
    marker: "route-complete-preview-proxy-v9",
    timestamp: new Date().toISOString(),
  });
});

app.get("/diagnostics", (_req, res) => {
  if (process.env.KLAWPEN_DIAGNOSTICS_ENABLED !== "true") {
    res.status(404).json({
      success: false,
      error: "Not found",
    });
    return;
  }

  const aiDiagnostics = getAiProviderDiagnostics();

  res.json({
    success: true,
    service: "klawpen-builder-api",
    marker: "route-complete-preview-proxy-v9",
    build: {
      stagedBuild: process.env.KLAWPEN_STAGED_BUILD === "true",
      stagedInlineApply: process.env.KLAWPEN_STAGED_INLINE_APPLY === "true",
      promptAwareLocalFallback:
        process.env.KLAWPEN_PROMPT_AWARE_LOCAL_FALLBACK === "true" &&
        process.env.KLAWPEN_ALLOW_LOCAL_TEMPLATE_FALLBACK === "true",
      localEmergencyBuild:
        process.env.KLAWPEN_LOCAL_EMERGENCY_BUILD === "true" &&
        process.env.KLAWPEN_ALLOW_LOCAL_TEMPLATE_FALLBACK === "true",
      localTemplateFallbackDefault: "disabled",
      localEmergencyEnvValue:
        process.env.KLAWPEN_LOCAL_EMERGENCY_BUILD || "(unset)",
      localTemplateFallbackAllowed:
        process.env.KLAWPEN_ALLOW_LOCAL_TEMPLATE_FALLBACK || "(unset)",
      premiumFallback: process.env.KLAWPEN_ENABLE_PREMIUM_FALLBACK === "true",
      timeoutRecovery: process.env.KLAWPEN_TIMEOUT_RECOVERY !== "false",
      architectSpec: process.env.KLAWPEN_ENABLE_ARCHITECT_SPEC === "true",
    },
    llm: {
      streaming: process.env.KLAWPEN_LLM_STREAMING !== "false",
      ttfbTimeoutMs:
        process.env.AI_STREAM_TTFB_TIMEOUT_MS ||
        process.env.KLAWPEN_STREAM_TTFB_TIMEOUT_MS ||
        "18000",
      idleTimeoutMs:
        process.env.AI_STREAM_IDLE_TIMEOUT_MS ||
        process.env.KLAWPEN_STREAM_IDLE_TIMEOUT_MS ||
        "20000",
      fallbackModels:
        process.env.AI_STREAM_FALLBACK_MODELS ||
        process.env.KLAWPEN_LLM_FALLBACK_MODELS ||
        "deepseek/deepseek-chat,anthropic/claude-3.5-sonnet",
    },
    preview: {
      publicOrigin: getPreviewProxyOrigin(),
      upstreamTemplate: process.env.PREVIEW_UPSTREAM_URL_TEMPLATE || "(unset)",
      upstreamHost: process.env.PREVIEW_UPSTREAM_HOST || "(unset)",
      baseUrl: process.env.PREVIEW_BASE_URL || "(unset)",
    },
    docker: getDockerRuntimeDiagnostics(),
    ai: {
      ...aiDiagnostics,
      deepBuildModel:
        process.env.KLAWPEN_DEEP_BUILD_MODEL ||
        process.env.AI_DEEP_BUILD_MODEL ||
        process.env.AI_BUILDER_MODEL ||
        "(default provider model)",
      tokenParameter:
        process.env.AI_CHAT_TOKEN_PARAMETER ||
        "(auto: official OpenAI=max_completion_tokens, compatible gateways=max_tokens)",
      reasoningEffort:
        process.env.AI_REASONING_EFFORT ||
        process.env.KLAWPEN_REASONING_EFFORT ||
        "(unset)",
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/diagnostics/ai-smoke", async (req, res) => {
  if (process.env.KLAWPEN_DIAGNOSTICS_ENABLED !== "true") {
    res.status(404).json({
      success: false,
      error: "Not found",
    });
    return;
  }

  const purpose = req.query.purpose === "chat" ? "chat" : "build";
  const result = await runAiProviderSmokeTest(purpose);
  res.status(result.success ? 200 : 502).json(result);
});

app.use("/preview", previewRoutes);
app.use(redirectPreviewEscapeRequest);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use(requireAccount);
app.use("/account", accountRoutes);
app.use("/containers", containerRoutes);
app.use("/chat", chatRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Docker Container API running on port ${PORT}`);
});

export default app;
