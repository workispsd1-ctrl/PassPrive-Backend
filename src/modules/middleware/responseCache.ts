import type { NextFunction, Request, Response } from "express";
import { getRedisClient, isRedisConfigured } from "../services/redisClient";

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
const redisKeyPrefix = String(process.env.RESPONSE_CACHE_REDIS_PREFIX ?? "response-cache:v1").trim();

const memoryStore = new Map<string, CacheEntry>();
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

function buildRedisKey(cacheKey: string) {
  return `${redisKeyPrefix}:${cacheKey}`;
}

function trimExpiredAndOverflow() {
  const now = Date.now();
  for (const [key, value] of memoryStore.entries()) {
    if (value.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }

  if (memoryStore.size <= maxEntries) return;
  const overflow = memoryStore.size - maxEntries;
  const keys = memoryStore.keys();
  for (let i = 0; i < overflow; i += 1) {
    const next = keys.next();
    if (next.done) break;
    memoryStore.delete(next.value);
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

async function readRedisEntry(cacheKey: string) {
  const redis = await getRedisClient();
  if (!redis) return null;

  const raw = await redis.get(buildRedisKey(cacheKey));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.expiresAt <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeRedisEntry(cacheKey: string, entry: CacheEntry) {
  const redis = await getRedisClient();
  if (!redis) return false;

  await redis.set(buildRedisKey(cacheKey), JSON.stringify(entry), {
    PX: defaultTtlMs,
  });
  return true;
}

async function deleteRedisByPrefixes(prefixes: string[]) {
  const redis = await getRedisClient();
  if (!redis) return;

  for (const prefix of prefixes) {
    const pattern = `${redisKeyPrefix}:GET:${prefix}*`;
    for await (const key of redis.scanIterator({
      MATCH: pattern,
      COUNT: 100,
    })) {
      await redis.del(key);
    }
  }
}

function invalidateMemoryByPath(path: string) {
  for (const key of memoryStore.keys()) {
    const index = key.indexOf(":");
    if (index < 0) continue;
    const originalUrl = key.slice(index + 1);
    if (path.startsWith("/api/offers") && originalUrl.startsWith("/api/offers")) {
      memoryStore.delete(key);
      continue;
    }
    if (path.startsWith("/api/restaurants") && originalUrl.startsWith("/api/restaurants")) {
      memoryStore.delete(key);
      continue;
    }
    if (path.startsWith("/api/stores") && originalUrl.startsWith("/api/stores")) {
      memoryStore.delete(key);
      continue;
    }
    if (path.startsWith("/api/store") && originalUrl.startsWith("/api/store")) {
      memoryStore.delete(key);
      continue;
    }
    if (path.startsWith("/api/store-catalogue") && originalUrl.startsWith("/api/store-catalogue")) {
      memoryStore.delete(key);
      continue;
    }
    if (path.startsWith("/api/store-catalog") && originalUrl.startsWith("/api/store-catalog")) {
      memoryStore.delete(key);
      continue;
    }
    if (path.startsWith("/api/homeherooffers") && originalUrl.startsWith("/api/homeherooffers")) {
      memoryStore.delete(key);
      continue;
    }
  }
}

function buildInvalidationPrefixes(path: string) {
  const prefixes: string[] = [];
  if (path.startsWith("/api/offers")) prefixes.push("/api/offers");
  if (path.startsWith("/api/restaurants")) prefixes.push("/api/restaurants");
  if (path.startsWith("/api/stores")) prefixes.push("/api/stores");
  if (path.startsWith("/api/store")) prefixes.push("/api/store");
  if (path.startsWith("/api/store-catalogue")) prefixes.push("/api/store-catalogue");
  if (path.startsWith("/api/store-catalog")) prefixes.push("/api/store-catalog");
  if (path.startsWith("/api/homeherooffers")) prefixes.push("/api/homeherooffers");
  return prefixes;
}

export function cacheInvalidationMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    invalidateMemoryByPath(req.path);
    if (isRedisConfigured()) {
      void deleteRedisByPrefixes(buildInvalidationPrefixes(req.path)).catch((error: any) => {
        console.warn("[response-cache] Redis invalidation failed", {
          path: req.path,
          message: String(error?.message ?? error ?? "Unknown Redis invalidation error"),
        });
      });
    }
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

  void (async () => {
    trimExpiredAndOverflow();
    const key = buildCacheKey(req);
    const now = Date.now();
    const memoryCached = memoryStore.get(key);
    if (memoryCached && memoryCached.expiresAt > now) {
      setCacheHeaders(res, "HIT");
      sendCachedResponse(req, res, memoryCached);
      return;
    }

    const redisCached = isRedisConfigured() ? await readRedisEntry(key) : null;
    if (redisCached) {
      memoryStore.set(key, redisCached);
      setCacheHeaders(res, "HIT");
      sendCachedResponse(req, res, redisCached);
      return;
    }

    setCacheHeaders(res, "MISS");
    const running = inflight.get(key);
    if (running) {
      running
        .then(async () => {
          const replay = memoryStore.get(key);
          if (replay && replay.expiresAt > Date.now()) {
            sendCachedResponse(req, res, replay);
            return;
          }

          const redisReplay = isRedisConfigured() ? await readRedisEntry(key) : null;
          if (redisReplay) {
            memoryStore.set(key, redisReplay);
            sendCachedResponse(req, res, redisReplay);
            return;
          }

          next();
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
        const entry: CacheEntry = {
          statusCode: res.statusCode,
          contentType,
          body: bodyBuffer,
          etag,
          expiresAt: Date.now() + defaultTtlMs,
        };
        memoryStore.set(key, entry);
        trimExpiredAndOverflow();
        if (isRedisConfigured()) {
          void writeRedisEntry(key, entry).catch((error: any) => {
            console.warn("[response-cache] Redis write failed", {
              key,
              message: String(error?.message ?? error ?? "Unknown Redis write error"),
            });
          });
        }
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

    const promise = new Promise<void>((resolve) => {
      res.on("finish", () => {
        recordIfCacheable();
        resolve();
      });
      res.on("close", () => {
        recordIfCacheable();
        resolve();
      });
    });
    inflight.set(key, promise);

    next();
  })().catch((error: any) => {
    console.warn("[response-cache] Middleware failed, bypassing cache", {
      path: req.originalUrl,
      message: String(error?.message ?? error ?? "Unknown response cache error"),
    });
    next();
  });
}
