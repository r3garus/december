import express from "express";
import { requireAccount } from "./services/account";
import accountRoutes from "./routes/account";
import chatRoutes from "./routes/chat";
import containerRoutes from "./routes/containers";

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
