import type { NextFunction, Request, Response } from "express";

interface CacheEntry {
  body: string;
  contentType: string;
  statusCode: number;
  etag?: string;
  expiresAt: number;
}

const defaultTtlMs = Number(process.env.RESPONSE_CACHE_TTL_MS ?? 15_000);
const maxEntries = Number(process.env.RESPONSE_CACHE_MAX_ENTRIES ?? 1000);
const enabled = String(process.env.RESPONSE_CACHE_ENABLED ?? "true").trim().toLowerCase() !== "false";

const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();

const excludedPrefixes = [
  "/api/payments",
  "/api/auth",
  "/api/admin",
  "/api/user",
];

function normalizePath(value: string) {
  return String(value || "").trim().toLowerCase();
}

function isPaymentRoute(req: Request) {
  const path = normalizePath(req.path);
  const originalUrl = normalizePath(req.originalUrl);

  return (
    path.startsWith("/api/payments") ||
    originalUrl.startsWith("/api/payments") ||
    path.startsWith("/payments") ||
    originalUrl.startsWith("/payments") ||
    path.startsWith("/iveri/") ||
    originalUrl.includes("/iveri/")
  );
}

function shouldHandle(req: Request) {
  if (!enabled) return false;
  if (req.method !== "GET") return false;
  if (isPaymentRoute(req)) return false;
  if (!req.path.startsWith("/api/")) return false;
  if (req.headers.authorization) return false;
  if (String(req.query?.nocache ?? "").trim().toLowerCase() === "true") return false;
  return !excludedPrefixes.some((prefix) => req.path.startsWith(prefix));
}

function buildCacheKey(req: Request) {
  return `${req.method}:${req.originalUrl}`;
}

function trimExpiredAndOverflow() {
  const now = Date.now();
  for (const [key, value] of store.entries()) {
    if (value.expiresAt <= now) {
      store.delete(key);
    }
  }

  if (store.size <= maxEntries) return;
  const overflow = store.size - maxEntries;
  const keys = store.keys();
  for (let i = 0; i < overflow; i += 1) {
    const next = keys.next();
    if (next.done) break;
    store.delete(next.value);
  }
}

function setCacheHeaders(res: Response, hit: "HIT" | "MISS" | "BYPASS") {
  res.setHeader("X-Cache", hit);
}

function headerToString(value: string | string[] | undefined) {
  if (!value) return "";
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function matchesIfNoneMatch(ifNoneMatchHeader: string | string[] | undefined, etag?: string) {
  const ifNoneMatch = headerToString(ifNoneMatchHeader).trim();
  if (!ifNoneMatch || !etag) return false;
  if (ifNoneMatch === "*") return true;

  return ifNoneMatch
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .includes(etag);
}

function sendCachedResponse(req: Request, res: Response, cached: CacheEntry) {
  if (cached.etag) {
    res.setHeader("ETag", cached.etag);
  }

  if (matchesIfNoneMatch(req.headers["if-none-match"], cached.etag)) {
    res.status(304);
    return res.end();
  }

  res.status(cached.statusCode);
  res.type(cached.contentType || "application/json");
  return res.send(cached.body);
}

function invalidateByPath(path: string) {
  for (const key of store.keys()) {
    const index = key.indexOf(":");
    if (index < 0) continue;
    const originalUrl = key.slice(index + 1);
    if (path.startsWith("/api/offers") && originalUrl.startsWith("/api/offers")) {
      store.delete(key);
      continue;
    }
    if (path.startsWith("/api/restaurants") && originalUrl.startsWith("/api/restaurants")) {
      store.delete(key);
      continue;
    }
    if (path.startsWith("/api/stores") && originalUrl.startsWith("/api/stores")) {
      store.delete(key);
      continue;
    }
    if (path.startsWith("/api/store") && originalUrl.startsWith("/api/store")) {
      store.delete(key);
      continue;
    }
    if (path.startsWith("/api/store-catalogue") && originalUrl.startsWith("/api/store-catalogue")) {
      store.delete(key);
      continue;
    }
    if (path.startsWith("/api/store-catalog") && originalUrl.startsWith("/api/store-catalog")) {
      store.delete(key);
      continue;
    }
    if (path.startsWith("/api/homeherooffers") && originalUrl.startsWith("/api/homeherooffers")) {
      store.delete(key);
      continue;
    }
  }
}

export function cacheInvalidationMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    invalidateByPath(req.path);
  }
  next();
}

export function responseCacheMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!shouldHandle(req)) {
    if (isPaymentRoute(req)) {
      res.setHeader("X-Cache", "BYPASS");
    }
    return next();
  }

  trimExpiredAndOverflow();
  const key = buildCacheKey(req);
  const now = Date.now();
  const cached = store.get(key);
  if (cached && cached.expiresAt > now) {
    setCacheHeaders(res, "HIT");
    return sendCachedResponse(req, res, cached);
  }

  setCacheHeaders(res, "MISS");
  const running = inflight.get(key);
  if (running) {
    running
      .then(() => {
        const replay = store.get(key);
        if (replay && replay.expiresAt > Date.now()) {
          return sendCachedResponse(req, res, replay);
        }
        return next();
      })
      .catch(() => next());
    return;
  }

  let resolved = false;
  const originalSend = res.send.bind(res);
  const originalJson = res.json.bind(res);
  let bodyBuffer = "";

  const recordIfCacheable = () => {
    if (resolved) return;
    resolved = true;
    inflight.delete(key);
    if (res.statusCode >= 200 && res.statusCode < 300 && bodyBuffer.length > 0) {
      const contentType = String(res.getHeader("content-type") ?? "application/json");
      const etag = headerToString(res.getHeader("etag") as string | string[] | undefined) || undefined;
      store.set(key, {
        statusCode: res.statusCode,
        contentType,
        body: bodyBuffer,
        etag,
        expiresAt: Date.now() + defaultTtlMs,
      });
      trimExpiredAndOverflow();
    }
  };

  res.send = ((body?: any) => {
    if (body !== undefined) {
      bodyBuffer = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    }
    recordIfCacheable();
    return originalSend(body);
  }) as any;

  res.json = ((body?: any) => {
    if (body !== undefined) {
      bodyBuffer = JSON.stringify(body);
    }
    recordIfCacheable();
    return originalJson(body);
  }) as any;

  const p = new Promise<void>((resolve) => {
    res.on("finish", () => {
      recordIfCacheable();
      resolve();
    });
    res.on("close", () => {
      recordIfCacheable();
      resolve();
    });
  });
  inflight.set(key, p);

  return next();
}
