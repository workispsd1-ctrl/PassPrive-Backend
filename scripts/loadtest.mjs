#!/usr/bin/env node
import { performance } from "node:perf_hooks";

function parseArgs(argv) {
  const args = {
    base: "http://127.0.0.1:8000",
    path: "/",
    method: "GET",
    duration: 20,
    concurrency: 25,
    timeoutMs: 10000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (!next) continue;

    if (key === "--base") args.base = next;
    if (key === "--path") args.path = next;
    if (key === "--method") args.method = next.toUpperCase();
    if (key === "--duration") args.duration = Number(next);
    if (key === "--concurrency") args.concurrency = Number(next);
    if (key === "--timeout") args.timeoutMs = Number(next);
  }

  return args;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const config = parseArgs(process.argv);
const target = `${config.base.replace(/\/+$/, "")}${config.path}`;
const stopAt = Date.now() + config.duration * 1000;

const latencies = [];
const byStatus = new Map();
let total = 0;
let ok = 0;
let failed = 0;

async function oneRequest() {
  const started = performance.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const res = await fetch(target, {
      method: config.method,
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    });
    clearTimeout(timeout);
    const elapsed = performance.now() - started;
    latencies.push(elapsed);
    total += 1;
    if (res.ok) ok += 1;
    else failed += 1;
    byStatus.set(res.status, (byStatus.get(res.status) ?? 0) + 1);
    await res.arrayBuffer().catch(() => {});
  } catch {
    const elapsed = performance.now() - started;
    latencies.push(elapsed);
    total += 1;
    failed += 1;
    byStatus.set("ERR", (byStatus.get("ERR") ?? 0) + 1);
  }
}

async function worker() {
  while (Date.now() < stopAt) {
    await oneRequest();
  }
}

console.log(`Running load test: ${config.method} ${target}`);
console.log(`Duration: ${config.duration}s | Concurrency: ${config.concurrency}`);

await Promise.all(Array.from({ length: config.concurrency }, () => worker()));

latencies.sort((a, b) => a - b);
const durationActual = config.duration;
const rps = total / durationActual;

console.log("\n=== Results ===");
console.log(`Total requests: ${total}`);
console.log(`Success (2xx/3xx): ${ok}`);
console.log(`Failed (4xx/5xx/ERR): ${failed}`);
console.log(`Requests/sec: ${rps.toFixed(2)}`);
console.log(`Latency p50: ${percentile(latencies, 50).toFixed(2)} ms`);
console.log(`Latency p95: ${percentile(latencies, 95).toFixed(2)} ms`);
console.log(`Latency p99: ${percentile(latencies, 99).toFixed(2)} ms`);
console.log(`Latency max: ${percentile(latencies, 100).toFixed(2)} ms`);
console.log("\nStatus breakdown:");
for (const [status, count] of byStatus.entries()) {
  console.log(`  ${status}: ${count}`);
}
