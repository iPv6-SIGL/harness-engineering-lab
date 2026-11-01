// ledger.ts — the state of the plan, owned by the harness, not the chat.
// Only `passes` flips, and only after the task's scenarios ran green; three
// failures on one task hand it to a human. The run log (decisions.jsonl) keeps
// the why of every step with its run context.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./openspec";

export type LedgerTask = Task & { passes: boolean; tries: number; status: "open" | "passed" | "needs-human"; last_run?: string };
export type Gate = { approved: boolean; by?: string; at?: string; note?: string };
export type Ledger = { app: string; run: string; prompt_hash: string; tasks: LedgerTask[]; gates: { spec: Gate; merge: Gate } };

export const ledgerPath = (app: string) => join(app, ".harness", "ledger.json");

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `run-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export function readLedger(appDir: string): Ledger {
  return JSON.parse(readFileSync(ledgerPath(appDir), "utf8"));
}

export function writeLedger(appDir: string, l: Ledger) {
  writeFileSync(ledgerPath(appDir), `${JSON.stringify(l, null, 2)}\n`);
}

export function runDir(appDir: string, run: string): string {
  const d = join(appDir, "artifacts", run);
  mkdirSync(d, { recursive: true });
  return d;
}

/** One line per harness event, with the run context the deck asks for. */
export function logEvent(appDir: string, run: string, step: number, event: string, data: Record<string, unknown> = {}) {
  const l = existsSync(ledgerPath(appDir)) ? readLedger(appDir) : null;
  const line = {
    at: new Date().toISOString(),
    run,
    step,
    event,
    agent: process.env.HARNESS_AGENT ?? "harness (deterministic)",
    model_alias: process.env.HARNESS_MODEL_ALIAS ?? null,
    prompt_hash: l?.prompt_hash ?? null,
    ...data,
  };
  appendFileSync(join(runDir(appDir, run), "decisions.jsonl"), `${JSON.stringify(line)}\n`);
}
