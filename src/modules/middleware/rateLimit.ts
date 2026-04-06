import type { NextFunction, Request, Response } from "express";
import { getRedisClient, isRedisConfigured } from "../services/redisClient";

interface Bucket {
  count: number;
  resetAt: number;
}

const enabled = String(process.env.RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() !== "false";
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const maxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 1200);
const maxEntries = Number(process.env.RATE_LIMIT_MAX_ENTRIES ?? 20_000);
const redisKeyPrefix = String(process.env.RATE_LIMIT_REDIS_PREFIX ?? "rate-limit:v1").trim();
const excludedPrefixes = ["/api/payments/iveri/return"];
const buckets = new Map<string, Bucket>();

function getClientIp(req: Request) {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  if (forwarded) return forwarded;
  return req.ip || req.socket.remoteAddress || "unknown";
}

function cleanup(now: number) {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size <= maxEntries) return;
  const overflow = buckets.size - maxEntries;
  const keys = buckets.keys();
  for (let i = 0; i < overflow; i += 1) {
    const next = keys.next();
    if (next.done) break;
    buckets.delete(next.value);
  }
}

function buildRedisKey(ip: string, method: string) {
  return `${redisKeyPrefix}:${ip}:${method}`;
}

async function checkRedisLimit(ip: string, method: string) {
  const redis = await getRedisClient();
  if (!redis) return null;

  const key = buildRedisKey(ip, method);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.pExpire(key, windowMs);
  }

  const ttl = await redis.pTTL(key);
  return {
    count,
    ttlMs: ttl > 0 ? ttl : windowMs,
  };
}

function reject(res: Response, retryAfterMs: number) {
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader("Retry-After", String(retryAfterSec));
  return res.status(429).json({
    error: "Too many requests. Please retry shortly.",
    code: "RATE_LIMITED",
    retry_after_seconds: retryAfterSec,
  });
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!enabled) return next();
  if (!req.path.startsWith("/api/")) return next();
  if (excludedPrefixes.some((prefix) => req.path.startsWith(prefix))) return next();

  void (async () => {
    const ip = getClientIp(req);

    if (isRedisConfigured()) {
      const redisResult = await checkRedisLimit(ip, req.method);
      if (redisResult) {
        if (redisResult.count > maxRequests) {
          reject(res, redisResult.ttlMs);
          return;
        }
        next();
        return;
      }
    }

    const now = Date.now();
    cleanup(now);

    const key = `${ip}:${req.method}`;
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      next();
      return;
    }

    current.count += 1;
    if (current.count > maxRequests) {
      reject(res, current.resetAt - now);
      return;
    }

    next();
  })().catch((error: any) => {
    console.warn("[rate-limit] Middleware failed, allowing request", {
      path: req.originalUrl,
      message: String(error?.message ?? error ?? "Unknown rate limit error"),
    });
    next();
  });
}
