import express from "express";
import * as dockerService from "../services/docker";

const router = express.Router();
const PREVIEW_PROXY_TIMEOUT_MS = Number(
  process.env.PREVIEW_PROXY_TIMEOUT_MS || "15000"
);

const skippedResponseHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-security-policy",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-frame-options",
]);

function getCookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return null;

  return (
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) || null
  );
}

function getTokenFromReferer(req: express.Request): string | null {
  const referer = req.headers.referer;
  if (typeof referer !== "string") return null;

  try {
    return new URL(referer).searchParams.get("token");
  } catch {
    return null;
  }
}

function getPreviewContainerIdFromReferer(req: express.Request): string | null {
  const referer = req.headers.referer;
  if (typeof referer !== "string") return null;

  try {
    const match = new URL(referer).pathname.match(/\/preview\/([^/?#]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function redirectPreviewEscapeRequest(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (req.path.startsWith("/preview")) {
    next();
    return;
  }

  const containerId = getPreviewContainerIdFromReferer(req);
  if (!containerId) {
    next();
    return;
  }

  const target = `/preview/${containerId}${req.originalUrl.startsWith("/") ? req.originalUrl : `/${req.originalUrl}`}`;
  console.warn("preview_escape_redirected", {
    trace: "preview_escape_redirected",
    containerId,
    from: req.originalUrl,
    to: target,
  });
  res.redirect(req.method === "GET" || req.method === "HEAD" ? 302 : 307, target);
}

function getPreviewToken(req: express.Request, containerId: string) {
  const queryToken = req.query.token;
  const cookieToken = getCookieValue(
    req.headers.cookie,
    `klawpen_preview_${containerId}`
  );

  return (
    (typeof queryToken === "string" ? queryToken : null) ||
    cookieToken ||
    getTokenFromReferer(req) ||
    undefined
  );
}

function rememberPreviewToken(
  req: express.Request,
  res: express.Response,
  containerId: string
) {
  const queryToken = req.query.token;
  if (typeof queryToken !== "string" || !queryToken) return;

  res.cookie(`klawpen_preview_${containerId}`, queryToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: Number(process.env.PREVIEW_TOKEN_COOKIE_MAX_AGE_MS || "3600000"),
    path: `/preview/${containerId}`,
  });
}

function resolveUpstreamPath(req: express.Request, containerId: string) {
  const url = new URL(req.originalUrl, "http://klawpen-preview.local");
  const prefix = `/preview/${containerId}`;
  const path = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length) || "/"
    : "/";

  url.searchParams.delete("token");

  return {
    path: path.startsWith("/") ? path : `/${path}`,
    search: url.searchParams.toString(),
  };
}

function buildProxyHeaders(req: express.Request) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    const lowerName = name.toLowerCase();
    if (
      [
        "host",
        "connection",
        "content-length",
        "cookie",
        "authorization",
        "x-backend-token",
        "accept-encoding",
      ].includes(lowerName)
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item));
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }

  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-host", req.headers.host || "");
  headers.set("x-forwarded-proto", req.protocol);

  return headers;
}

function shouldRewriteBody(contentType: string | null) {
  if (!contentType) return false;

  return (
    contentType.includes("text/") ||
    contentType.includes("javascript") ||
    contentType.includes("json") ||
    contentType.includes("x-component")
  );
}

function rewritePreviewContent(
  content: string,
  contentType: string | null,
  containerId: string
) {
  const prefix = `/preview/${containerId}`;
  let rewritten = content
    .replace(/(["'`])\/_next\//g, `$1${prefix}/_next/`)
    .replace(/url\(\s*\/_next\//g, `url(${prefix}/_next/`)
    .replace(/\\(["'`])\/_next\//g, `\\$1${prefix}/_next/`)
    .replace(
      /(["'`])\/(?!\/|preview\/|_next\/|api\/|__nextjs|assets?\/|images?\/|img\/|fonts?\/|favicon|robots|sitemap)([^"'`<>{}\\]*)\1/g,
      `$1${prefix}/$2$1`
    )
    .replace(
      /\\(["'`])\/(?!\/|preview\/|_next\/|api\/|__nextjs|assets?\/|images?\/|img\/|fonts?\/|favicon|robots|sitemap)([^"'`{}\\]*)\\\1/g,
      `\\$1${prefix}/$2\\$1`
    );

  if (contentType?.includes("text/html")) {
    rewritten = rewritten
      .replace(/(<head[^>]*>)/i, `$1<base href="${prefix}/">`)
      .replace(
        /\b(href|src|action)=(["'])\/(?!\/|preview\/)([^"']*)\2/g,
        `$1=$2${prefix}/$3$2`
      )
      .replace(
        /\\(["'])\/(?!\/|preview\/|_next\/)([^"'\\]*)\\\1/g,
        `\\$1${prefix}/$2\\$1`
      );
  }

  return rewritten;
}

function copyResponseHeaders(
  upstreamResponse: Response,
  res: express.Response,
  containerId: string,
  upstreamUrl: string
) {
  upstreamResponse.headers.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (skippedResponseHeaders.has(lowerName)) return;

    if (lowerName === "location") {
      try {
        const location = new URL(value, upstreamUrl);
        const upstreamOrigin = new URL(upstreamUrl).origin;
        if (location.origin === upstreamOrigin) {
          const localLocation = `/preview/${containerId}${location.pathname}${location.search}${location.hash}`;
          res.setHeader("location", localLocation);
          return;
        }
      } catch {
        if (value.startsWith("/")) {
          res.setHeader("location", `/preview/${containerId}${value}`);
          return;
        }
      }
    }

    res.setHeader(name, value);
  });

  res.setHeader("cache-control", "no-store");
}

router.use("/:containerId", async (req, res) => {
  const { containerId } = req.params;
  const previewToken = getPreviewToken(req, containerId);

  if (!dockerService.isValidPreviewToken(containerId, previewToken)) {
    res.status(403).send("Preview token is invalid or expired.");
    return;
  }

  rememberPreviewToken(req, res, containerId);

  try {
    const { containerInfo, upstreamUrls } =
      await dockerService.getPreviewRuntime(containerId);

    if (!containerInfo.State?.Running) {
      res.status(503).send("Preview container is not running.");
      return;
    }

    const { path, search } = resolveUpstreamPath(req, containerId);
    const headers = buildProxyHeaders(req);
    const method = req.method.toUpperCase();
    const hasRequestBody = !["GET", "HEAD"].includes(method);
    let lastError: unknown = null;

    for (const upstreamBase of upstreamUrls) {
      try {
        const upstreamUrl = `${upstreamBase}${path}${search ? `?${search}` : ""}`;
        const upstreamResponse = await fetch(upstreamUrl, {
          method,
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(PREVIEW_PROXY_TIMEOUT_MS),
          ...(hasRequestBody ? { body: req as any, duplex: "half" as const } : {}),
        });

        const contentType = upstreamResponse.headers.get("content-type");
        copyResponseHeaders(upstreamResponse, res, containerId, upstreamUrl);
        res.status(upstreamResponse.status);

        if (method === "HEAD") {
          res.end();
          return;
        }

        const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());

        if (shouldRewriteBody(contentType)) {
          const body = rewritePreviewContent(
            responseBuffer.toString("utf8"),
            contentType,
            containerId
          );

          res.send(body);
          return;
        }

        res.send(responseBuffer);
        return;
      } catch (error) {
        console.warn("Preview upstream attempt failed:", {
          containerId,
          upstreamBase,
          path,
          error: error instanceof Error ? error.message : error,
        });
        lastError = error;
      }
    }

    console.warn("Preview proxy failed for all upstreams:", lastError);
    res
      .status(502)
      .send("Preview is not ready yet. Please wait a moment and refresh.");
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : "Preview failed.");
  }
});

export default router;
