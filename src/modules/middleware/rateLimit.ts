import type { NextFunction, Request, Response } from "express";
import { redisEval } from "../services/redisClient";

interface Bucket {
  count: number;
  resetAt: number;
}

const enabled = String(process.env.RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() !== "false";
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const maxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 1200);
const maxEntries = Number(process.env.RATE_LIMIT_MAX_ENTRIES ?? 20_000);
const redisPrefix = String(process.env.RATE_LIMIT_REDIS_PREFIX ?? "passprive:rate-limit:v1").trim();
const excludedPrefixes = ["/api/payments/iveri/return"];
const buckets = new Map<string, Bucket>();

const rateLimitScript = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return {current, ttl}
`;

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

async function checkRedisRateLimit(key: string) {
  const result = await redisEval<unknown>(rateLimitScript, [key], [String(windowMs)]);
  if (!Array.isArray(result) || result.length < 2) {
    return null;
  }

  const current = Number(result[0]);
  const ttlMs = Number(result[1]);
  if (!Number.isFinite(current) || !Number.isFinite(ttlMs)) {
    return null;
  }

  return { current, ttlMs };
}

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!enabled) return next();
  if (!req.path.startsWith("/api/")) return next();
  if (excludedPrefixes.some((prefix) => req.path.startsWith(prefix))) return next();

  const ip = getClientIp(req);
  const key = `${ip}:${req.method}`;
  const redisKey = `${redisPrefix}:${key}`;

  try {
    const redisResult = await checkRedisRateLimit(redisKey);
    if (redisResult) {
      if (redisResult.current > maxRequests) {
        const retryAfterSec = Math.max(1, Math.ceil(redisResult.ttlMs / 1000));
        res.setHeader("Retry-After", String(retryAfterSec));
        return res.status(429).json({
          error: "Too many requests. Please retry shortly.",
          code: "RATE_LIMITED",
          retry_after_seconds: retryAfterSec,
        });
      }

      return next();
    }
  } catch {
    // Fall back to in-memory counters if Redis is unavailable.
  }

  const now = Date.now();
  cleanup(now);

  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return next();
  }

  current.count += 1;
  if (current.count > maxRequests) {
    const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({
      error: "Too many requests. Please retry shortly.",
      code: "RATE_LIMITED",
      retry_after_seconds: retryAfterSec,
    });
  }

  return next();
}
