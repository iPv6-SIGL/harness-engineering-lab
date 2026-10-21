#!/usr/bin/env bun
/**
 * p99.ts — the aggregator of the CCoE measurement contract.
 *
 * Computes the p50/p99/max of `duration_ms` PER ROUTE TEMPLATE from the
 * one-line JSON logs of the API middleware (method, route, status,
 * duration_ms). The same computation for every app — Dozzle visualises, this
 * script measures.
 *
 * Usage:
 *   bun p99.ts < logs.jsonl
 *   podman logs myapp-api 2>&1 | bun p99.ts
 */

type Sample = { method: string; route: string; duration: number; status: number };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const byRoute = new Map<string, Sample[]>();
let malformed = 0;

const text = await new Response(Bun.stdin.stream()).text();
for (const line of text.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  // Tolerates a non-JSON prefix (a podman timestamp): we find the first '{'.
  const start = trimmed.indexOf("{");
  if (start < 0) continue;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(trimmed.slice(start));
  } catch {
    malformed++;
    continue;
  }
  const route = entry.route;
  const duration = entry.duration_ms;
  if (typeof route !== "string" || typeof duration !== "number") continue;
  const method = typeof entry.method === "string" ? entry.method : "?";
  const status = typeof entry.status === "number" ? entry.status : 0;
  const key = `${method} ${route}`;
  const bucket = byRoute.get(key) ?? [];
  bucket.push({ method, route, duration, status });
  byRoute.set(key, bucket);
}

if (byRoute.size === 0) {
  console.error("No usable line (expected: JSON with route + duration_ms).");
  process.exit(1);
}

const rows = [...byRoute.entries()]
  .map(([key, samples]) => {
    const durations = samples.map((s) => s.duration).sort((a, b) => a - b);
    const errors = samples.filter((s) => s.status >= 500).length;
    return {
      route: key,
      n: samples.length,
      p50: percentile(durations, 50),
      p99: percentile(durations, 99),
      max: durations[durations.length - 1],
      "5xx": errors,
      // The SLO verdict: p99 ≤ 100 ms is OK; ≤ 350 ms needs justifying; beyond = out of contract
      slo: percentile(durations, 99) <= 100 ? "ok" : percentile(durations, 99) <= 350 ? "to be justified" : "OUT OF CONTRACT",
    };
  })
  .sort((a, b) => b.p99 - a.p99);

console.table(rows);
if (malformed > 0) console.error(`(${malformed} non-JSON lines ignored)`);
