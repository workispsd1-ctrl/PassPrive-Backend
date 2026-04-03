import type { NextFunction, Request, Response } from "express";

const slowMs = Number(process.env.SLOW_REQUEST_LOG_MS ?? 1200);

export function requestTelemetryMiddleware(req: Request, res: Response, next: NextFunction) {
  const started = process.hrtime.bigint();
  const startedAt = Date.now();

  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const cacheHeader = String(res.getHeader("X-Cache") ?? "");
    const level = elapsedMs >= slowMs || res.statusCode >= 500 ? "warn" : "info";
    const payload = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Number(elapsedMs.toFixed(2)),
      cache: cacheHeader || undefined,
      at: new Date(startedAt).toISOString(),
    };

    if (level === "warn") {
      console.warn("[request]", payload);
      return;
    }
    if (String(process.env.REQUEST_LOG_VERBOSE ?? "false").trim().toLowerCase() === "true") {
      console.log("[request]", payload);
    }
  });

  next();
}
