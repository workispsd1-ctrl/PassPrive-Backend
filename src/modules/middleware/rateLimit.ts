import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

const enabled = String(process.env.RATE_LIMIT_ENABLED ?? "true").trim().toLowerCase() !== "false";
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const maxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 1200);
const maxEntries = Number(process.env.RATE_LIMIT_MAX_ENTRIES ?? 20_000);
const excludedPrefixes = ["/api/payments/iveri/return", "/api/payments/mips/imn", "/api/public-menu/payments/webhook"];
const buckets = new Map<string, Bucket>();

const TEN_MINUTES = 10 * 60_000;

const strictRules: Array<{ prefix: string; max: number; windowMs: number }> = [
  { prefix: "/api/auth/send-otp", max: 20, windowMs: TEN_MINUTES },
  { prefix: "/api/auth/verify-otp", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/auth/register-phone", max: 20, windowMs: TEN_MINUTES },
  { prefix: "/api/auth/change-phone", max: 20, windowMs: TEN_MINUTES },
  { prefix: "/api/gifts/redeem", max: 20, windowMs: TEN_MINUTES },
  { prefix: "/api/payments/iveri/initiate", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/payments/mips/initiate", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/public-menu/payments/create-session", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/restaurant-bookings/confirm", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/store-service-booking", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/service-bookings", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/store-bookings", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/support-chat/message", max: 60, windowMs: TEN_MINUTES },
  { prefix: "/api/support-chat/", max: 60, windowMs: TEN_MINUTES },
  { prefix: "/api/payments/", max: 60, windowMs: TEN_MINUTES },
  { prefix: "/api/public-menu/payments/", max: 60, windowMs: TEN_MINUTES },
  { prefix: "/api/gifts/", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/cashback/", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/share/", max: 30, windowMs: TEN_MINUTES },
  { prefix: "/api/analytics/", max: 300, windowMs: TEN_MINUTES },
  { prefix: "/api/", max: 600, windowMs: TEN_MINUTES },
];

const proxyKey = process.env.PROXY_SHARED_KEY?.trim();

function getClientIp(req: Request) {
  const forwardedFor = String(req.headers["x-client-ip"] ?? "").trim();
  if (proxyKey && forwardedFor && req.headers["x-proxy-key"] === proxyKey) return forwardedFor;
  return req.ip || req.socket.remoteAddress || "unknown";
}

function hit(key: string, max: number, window: number, now: number) {
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + window });
    return 0;
  }
  current.count += 1;
  return current.count > max ? Math.max(1, Math.ceil((current.resetAt - now) / 1000)) : 0;
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

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!enabled) return next();
  if (!req.path.startsWith("/api/")) return next();
  if (excludedPrefixes.some((prefix) => req.path.startsWith(prefix))) return next();

  const ip = getClientIp(req);
  const now = Date.now();
  cleanup(now);

  const rule = req.method === "GET" ? null : strictRules.find((r) => req.path.startsWith(r.prefix));
  const retryAfterSec = rule
    ? hit(`${ip}:${rule.prefix}`, rule.max, rule.windowMs, now) || hit(`${ip}:${req.method}`, maxRequests, windowMs, now)
    : hit(`${ip}:${req.method}`, maxRequests, windowMs, now);

  if (retryAfterSec) {
    res.setHeader("Retry-After", String(retryAfterSec));
    return res.status(429).json({
      error: "Too many requests. Please retry shortly.",
      code: "RATE_LIMITED",
      retry_after_seconds: retryAfterSec,
    });
  }

  return next();
}
