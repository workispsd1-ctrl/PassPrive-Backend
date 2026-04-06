import type { NextFunction, Request, Response } from "express";
import { redisGet, redisIncr, redisSet } from "../services/redisClient";

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
const redisPrefix = String(process.env.RESPONSE_CACHE_REDIS_PREFIX ?? "passprive:response-cache:v1").trim();

const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();
const localScopeVersions = new Map<string, number>();

const excludedPrefixes = ["/api/payments", "/api/auth", "/api/admin", "/api/user"];
const cacheScopes = [
  "/api/offers",
  "/api/restaurants",
  "/api/stores",
  "/api/store",
  "/api/store-catalogue",
  "/api/store-catalog",
  "/api/homeherooffers",
  "/api/dineinhomebanners",
  "/api/inyourpassprive",
  "/api/moodcategories",
  "/api/storemoodcategories",
  "/api/spotlight",
  "/api/restaurant-bookings",
  "/api/editorial-collections",
  "/api/stores-home",
  "/api/corporates",
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

function buildScopeVersionKey(scope: string) {
  return `${redisPrefix}:version:${encodeURIComponent(scope)}`;
}

function resolveCacheScope(path: string) {
  const normalized = normalizePath(path);
  const matchingScope = cacheScopes
    .filter((scope) => normalized === scope || normalized.startsWith(`${scope}/`))
    .sort((left, right) => right.length - left.length)[0];

  if (matchingScope) return matchingScope;
  if (!normalized.startsWith("/api/")) return normalized;

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `/${parts[0]}/${parts[1]}`;
  }

  return normalized;
}

async function getScopeVersion(scope: string) {
  const redisKey = buildScopeVersionKey(scope);
  const remoteVersion = await redisGet(redisKey);
  if (remoteVersion !== null) {
    const parsed = Number(remoteVersion);
    if (Number.isFinite(parsed) && parsed >= 0) {
      localScopeVersions.set(scope, parsed);
      return parsed;
    }
  }

  return localScopeVersions.get(scope) ?? 0;
}

async function bumpScopeVersion(scope: string) {
  const redisKey = buildScopeVersionKey(scope);
  const next = await redisIncr(redisKey);
  if (next > 0) {
    localScopeVersions.set(scope, next);
    return next;
  }

  const localNext = (localScopeVersions.get(scope) ?? 0) + 1;
  localScopeVersions.set(scope, localNext);
  return localNext;
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
  res.setHeader("Content-Type", cached.contentType || "application/json");
  return res.send(cached.body);
}

function parseCacheEntry(raw: string) {
  try {
    const parsed = JSON.parse(raw) as CacheEntry;
    if (
      typeof parsed?.body === "string" &&
      typeof parsed?.contentType === "string" &&
      typeof parsed?.statusCode === "number" &&
      typeof parsed?.expiresAt === "number"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

async function readCachedEntry(key: string) {
  const local = store.get(key);
  if (local && local.expiresAt > Date.now()) {
    return local;
  }

  const raw = await redisGet(key);
  if (!raw) return null;
  const parsed = parseCacheEntry(raw);
  if (!parsed || parsed.expiresAt <= Date.now()) return null;
  store.set(key, parsed);
  return parsed;
}

async function writeCachedEntry(key: string, entry: CacheEntry) {
  store.set(key, entry);
  await redisSet(key, JSON.stringify(entry), Math.max(1, entry.expiresAt - Date.now()));
}

export async function cacheInvalidationMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    const scope = resolveCacheScope(req.path);
    if (scope && scope.startsWith("/api/")) {
      try {
        await bumpScopeVersion(scope);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[cache] Unable to bump scope version", { scope, message });
      }
    }
  }
  next();
}

export async function responseCacheMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!shouldHandle(req)) {
    if (isPaymentRoute(req)) {
      res.setHeader("X-Cache", "BYPASS");
    }
    return next();
  }

  trimExpiredAndOverflow();
  const scope = resolveCacheScope(req.path);
  const version = await getScopeVersion(scope);
  localScopeVersions.set(scope, version);
  const key = `${redisPrefix}:${encodeURIComponent(scope)}:${version}:${req.method}:${req.originalUrl}`;
  const now = Date.now();
  const cached = await readCachedEntry(key);
  if (cached && cached.expiresAt > now) {
    setCacheHeaders(res, "HIT");
    return sendCachedResponse(req, res, cached);
  }

  setCacheHeaders(res, "MISS");
  const running = inflight.get(key);
  if (running) {
    await running.catch(() => undefined);
    const replay = await readCachedEntry(key);
    if (replay && replay.expiresAt > Date.now()) {
      return sendCachedResponse(req, res, replay);
    }
    return next();
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
      store.set(key, entry);
      void writeCachedEntry(key, entry).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[cache] Failed to write Redis cache entry", { key, message });
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
