#!/usr/bin/env bun
// cli.ts — the reconciliation harness, one command per moment of the run.
//
//   frame   graph · brief · plan            steps 1–5   (brief loop on 1–4)
//   gate    approve <app> spec|merge        steps 5, 14 (a human)
//   build   verify-task · fitness           steps 6–9   (the builder is an agent; the harness checks)
//   verify  witness · mutants · review · reconcile   steps 10–13
//   learn   evals                           step 18
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkBrief } from "./brief";
import { buildGraph, HARNESS_DIR, loadHarnessConfig } from "./catalog";
import { decide } from "./decide";
import { formatViolation, loadGuards, scanRepo } from "./guards";
import { type Ledger, logEvent, newRunId, readLedger, runDir, sha, writeLedger } from "./ledger";
import { mutate } from "./mutants";
import { type Brief, needTest } from "./needs";
import { designMd, planTasks, proposalMd, specMd, tasksMd } from "./openspec";
import { review } from "./review";
import { writeScaffold } from "./scaffold";
import { witness } from "./witness";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = loadHarnessConfig();
const y = (o: unknown) => Bun.YAML.stringify(o, null, 2);
const die = (msg: string, code = 1): never => {
  console.error(msg);
  process.exit(code);
};

function readBrief(p: string): Brief {
  return Bun.YAML.parse(readFileSync(p, "utf8")) as Brief;
}

function ports(appDir: string) {
  const v = (Bun.YAML.parse(readFileSync(join(appDir, ".gitlab-ci.yml"), "utf8")) as any).variables;
  return { app: v.APP as string, frontendPort: Number(v.FRONTEND_PORT), apiPort: Number(v.API_PORT) };
}

// ── frame ───────────────────────────────────────────────────────────────────
function cmdGraph() {
  const g = buildGraph();
  writeFileSync(join(HARNESS_DIR, "catalog", "graph.json"), `${JSON.stringify(g, null, 2)}\n`);
  console.log(`capability graph: ${Object.keys(g.bricks).length} bricks, ${Object.keys(g.needs).length} needs, ${Object.keys(g.vetoes).length} vetoes — built from ${g.built_from.length} files`);
  for (const b of Object.values(g.bricks)) console.log(`  ${b.brick.padEnd(12)} ${String(b.ops_points).padStart(2)} pt${b.price_assumed ? "*" : " "} ${b.scaffold ? "scaffold" : `bought by ${b.bought_by.join(", ") || "—"}`}`);
}

function cmdBrief() {
  const g = buildGraph();
  const brief = readBrief(args[0]);
  const round = Number(flag("round") ?? brief.version ?? 1);
  const c = checkBrief(brief, g, round, cfg.stop_rules.max_brief_rounds, cfg.stop_rules.max_questions_per_round);
  console.log(`BRIEF-CHECK · ${c.score} / 5 (round ${round})`);
  for (const k of c.criteria) console.log(`  ${k.ok ? "✓" : "✗"} ${k.id} · ${k.name}${k.gap ? ` — ${k.gap}` : ""}`);
  c.questions.forEach((q, i) => console.log(`  ? ${i + 1} · ${q.ask}  [${q.id}] ${q.why} Affects ${q.affects}. Default: ${q.default}.`));
  for (const q of c.defaults_applied) console.log(`  ↳ default applied: ${q.ask} → ${q.default}`);
  console.log(c.ready ? "Brief ready → step 5." : "Brief not ready → answer in `answers:`, bump `version`, back to step 1.");
  process.exit(c.ready ? 0 : 3);
}

function cmdPlan() {
  const briefPath = resolve(args[0]);
  const appDir = resolve(flag("app-dir") ?? die("--app-dir is required"));
  const brief = readBrief(briefPath);
  const run = newRunId();
  mkdirSync(join(appDir, ".harness", "guards"), { recursive: true });
  const g = buildGraph();
  logEvent(appDir, run, 1, "prompt", { app: brief.app, brief_version: brief.version, prompt_hash: sha(brief.prompt) });
  logEvent(appDir, run, 2, "graph", { bricks: Object.keys(g.bricks).length, built_from: g.built_from });

  const check = checkBrief(brief, g, brief.version, cfg.stop_rules.max_brief_rounds, cfg.stop_rules.max_questions_per_round);
  logEvent(appDir, run, 4, "brief-check", { score: check.score, questions: check.questions.map((q) => q.id), defaults: check.defaults_applied.map((q) => q.id) });
  if (!check.ready) die(`brief-check ${check.score}/5 — not ready:\n${check.questions.map((q) => `  ? ${q.ask} (${q.affects}; default: ${q.default})`).join("\n")}\nAnswer, bump the brief version, re-plan.`, 3);

  const bill = needTest(brief, g);
  logEvent(appDir, run, 3, "bill", { class: bill.class, points: bill.points, budget: bill.budget, bought: bill.bought, refused: bill.refused.map((r) => ({ brick: r.brick, reason: r.reason })) });
  if (bill.unsupported.length) die(`refused: the platform cannot host this —\n${bill.unsupported.map((u) => `  ${u.id} "${u.match}": ${u.why}`).join("\n")}`, 4);

  const decisions = decide(brief, bill, g);
  const tasks = planTasks(brief, bill);
  const change = join(appDir, "openspec", "changes", `add-${brief.app}`);
  mkdirSync(join(change, "specs", brief.app), { recursive: true });
  mkdirSync(join(appDir, "openspec", "specs"), { recursive: true });
  writeFileSync(join(change, "proposal.md"), proposalMd(brief, check, bill, brief.version));
  writeFileSync(join(change, "design.md"), designMd(brief, bill, decisions, g, run));
  writeFileSync(join(change, "tasks.md"), tasksMd(brief, tasks));
  writeFileSync(join(change, "specs", brief.app, "spec.md"), specMd(brief));
  writeFileSync(join(appDir, ".harness", "bill.yaml"), y({ app: bill.app, class: bill.class, budget: bill.budget, total: bill.points, within_budget: bill.within_budget, scaffold: bill.scaffold, bought: bill.bought, refused: bill.refused, flags: bill.flags, needs: bill.needs }));
  for (const d of decisions) writeFileSync(join(appDir, ".harness", "guards", `${d.id}.yaml`), `# compiled from design.md ${d.id} — the builder reads it, never edits it\n${y(d.guard)}`);
  const ledger: Ledger = { app: brief.app, run, prompt_hash: sha(brief.prompt), tasks: tasks.map((t) => ({ ...t, passes: false, tries: 0, status: "open" })), gates: { spec: { approved: false }, merge: { approved: false } } };
  writeLedger(appDir, ledger);
  writeScaffold(appDir, brief, bill, resolve(HARNESS_DIR, cfg.core_platform));
  for (const d of decisions) logEvent(appDir, run, 5, "decision", { id: d.id, title: d.title, serves: d.serves, rejected: d.rejected, avoids: d.avoids });

  console.log(`run ${run} · ${brief.app} · ${bill.class} app · ${bill.points} / ${bill.budget} ops points${bill.within_budget ? "" : " — OVER BUDGET"}`);
  console.log(`  scaffold ${bill.scaffold.join(", ")}`);
  for (const b of bill.bought) console.log(`  + ${b.brick} (${b.points}) paid by ${b.paid_by.join(", ")} for ${b.needs.join(", ")}`);
  for (const r of bill.refused) console.log(`  − ${r.brick} (${r.points}) ${r.reason}`);
  for (const d of decisions) console.log(`  ${d.id} · ${d.title} — serves ${d.serves.join(", ")}`);
  console.log(`desired state written: openspec/changes/add-${brief.app}/ · .harness/ · scaffold. Step 5 waits for a human: harness approve ${appDir} spec --by <name>`);
}

// ── gates ───────────────────────────────────────────────────────────────────
function cmdApprove() {
  const appDir = resolve(args[0]);
  const gate = args[1] as "spec" | "merge";
  const by = flag("by") ?? die("--by <human> is required: a gate is a person");
  const l = readLedger(appDir);
  const bill = Bun.YAML.parse(readFileSync(join(appDir, ".harness", "bill.yaml"), "utf8")) as any;
  if (gate === "spec" && !bill.within_budget && !flag("waiver")) die(`over budget (${bill.total}/${bill.budget}): approve with --waiver "<reason, expiry>" — it lands in the README's CCoE waivers`);
  if (gate === "merge") {
    const v = join(runDir(appDir, l.run), "verdicts.json");
    if (!existsSync(v) || JSON.parse(readFileSync(v, "utf8")).verdict !== "green") die("merge gate: run `harness reconcile` first — the verdict must be green");
  }
  l.gates[gate] = { approved: true, by, at: new Date().toISOString(), note: flag("note") ?? flag("waiver") };
  writeLedger(appDir, l);
  logEvent(appDir, l.run, gate === "spec" ? 5 : 14, `gate:${gate}`, { by, note: flag("note"), waiver: flag("waiver") });
  console.log(`gate ${gate} approved by ${by}`);
}

// ── build ───────────────────────────────────────────────────────────────────
function runScenarios(appDir: string, names: string[]): { ok: boolean; pass: number; fail: number; out: string } {
  const pattern = names.map((n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const p = Bun.spawnSync(["bun", "test", "--timeout", "30000", "--test-name-pattern", pattern, "./e2e/"], { cwd: appDir, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const out = `${p.stdout}${p.stderr}`;
  const pass = Number(out.match(/(\d+) pass/)?.[1] ?? 0);
  const fail = Number(out.match(/(\d+) fail/)?.[1] ?? 0);
  return { ok: p.exitCode === 0 && pass > 0 && fail === 0, pass, fail, out };
}

function cmdVerifyTask() {
  const appDir = resolve(args[0]);
  const which = args[1] ?? "all";
  const l = readLedger(appDir);
  if (!l.gates.spec.approved) die("step 5 gate: the spec is not approved — no code is checked against an unapproved plan");
  let red = 0;
  for (const t of l.tasks) {
    if (which !== "all" && t.id !== which) continue;
    if (t.status === "needs-human") {
      console.log(`  ⚑ ${t.id} needs a human (${t.tries} tries)`);
      red++;
      continue;
    }
    const r = runScenarios(appDir, t.scenarios);
    t.last_run = new Date().toISOString();
    if (r.ok) {
      t.passes = true;
      t.status = "passed";
    } else {
      t.passes = false;
      t.tries++;
      if (t.tries >= cfg.stop_rules.max_task_tries) t.status = "needs-human";
      red++;
    }
    logEvent(appDir, l.run, 9, "ledger", { task: t.id, passes: t.passes, tries: t.tries, pass: r.pass, fail: r.fail });
    console.log(`  ${t.passes ? "✓" : "✗"} ${t.id} ${t.scenarios.join(", ")} — ${r.pass} pass, ${r.fail} fail${t.status === "needs-human" ? " → a human" : ""}`);
    if (!r.ok && process.env.HARNESS_VERBOSE) console.log(r.out);
  }
  writeLedger(appDir, l);
  process.exit(red ? 1 : 0);
}

function cmdFitness() {
  const appDir = resolve(args[0] ?? ".");
  const v = scanRepo(loadGuards(appDir), appDir);
  if (!v.length) console.log(`fitness: ${loadGuards(appDir).length} guards, 0 violations ✓`);
  for (const x of v) console.log(formatViolation(x));
  process.exit(v.length ? 1 : 0);
}

// ── verify ──────────────────────────────────────────────────────────────────
function cmdWitness(appDir = resolve(args[0])) {
  const ev = witness(loadGuards(appDir), ports(appDir));
  const l = readLedger(appDir);
  writeFileSync(join(runDir(appDir, l.run), "evidence.json"), `${JSON.stringify(ev, null, 2)}\n`);
  for (const e of ev) console.log(`  ${e.ok ? "✓" : "✗"} ${e.decision} — ${e.claim}: ${e.observed}`);
  return ev;
}

function cmdMutants(appDir = resolve(args[0])) {
  const files: string[] = cfg.verify.mutate ?? ["api/src/domain.ts"];
  return files.map((f) => {
    const r = mutate(join(appDir, f.split("/")[0]), join(appDir, f));
    console.log(`  mutants ${r.file}: ${r.killed}/${r.total} killed (${(r.score * 100).toFixed(0)} %, bar ${(cfg.verify.mutation_bar * 100).toFixed(0)} %)`);
    for (const s of r.survivors.slice(0, 8)) console.log(`    survivor line ${s.line}: ${s.op} ${s.from} → ${s.to}`);
    return r;
  });
}

async function cmdReconcile() {
  const appDir = resolve(args[0]);
  const l = readLedger(appDir);
  const t0 = Date.now();
  console.log("step 7 · fitness (guards on the repo)");
  const violations = scanRepo(loadGuards(appDir), appDir);
  for (const v of violations) console.log(`  ${formatViolation(v)}`);
  console.log(`  ${violations.length} violations`);
  console.log("step 9 · ledger");
  const open = l.tasks.filter((t) => !t.passes);
  console.log(`  ${l.tasks.length - open.length}/${l.tasks.length} tasks pass${open.length ? ` — open: ${open.map((t) => t.id).join(", ")}` : ""}`);
  console.log("step 10 · mutants");
  const mutants = cmdMutants(appDir);
  console.log("step 11 · witness (platform trails)");
  const evidence = cmdWitness(appDir);
  console.log("step 12 · reviewer (other model family)");
  const rv = await review(appDir, join(appDir, "openspec", "changes", `add-${l.app}`));
  console.log(`  ${rv.status}: ${rv.reason}`);
  const failedClaims = evidence.filter((e) => !e.ok);
  const lowMutants = mutants.filter((m) => m.score < cfg.verify.mutation_bar);
  const drift: { kind: string; back_to: number; detail: string }[] = [];
  for (const v of violations) drift.push({ kind: "code", back_to: 6, detail: formatViolation(v) });
  for (const t of open) drift.push({ kind: t.status === "needs-human" ? "decision" : "code", back_to: t.status === "needs-human" ? 5 : 6, detail: `task ${t.id} not passing (${t.tries} tries)` });
  for (const e of failedClaims) drift.push({ kind: e.decision === "contract" ? "code" : "decision", back_to: e.decision === "contract" ? 6 : 5, detail: `${e.decision}: ${e.claim} — observed ${e.observed}` });
  for (const m of lowMutants) drift.push({ kind: "code", back_to: 6, detail: `mutation score ${(m.score * 100).toFixed(0)} % < bar on ${m.file}` });
  const verdict = drift.length ? "drift" : "green";
  console.log(`step 13 · reconciler: ${verdict}${drift.length ? "" : " — desired state = observed state"}`);
  for (const d of drift) console.log(`  → back to ${d.back_to} (${d.kind}): ${d.detail}`);
  const dir = runDir(appDir, l.run);
  const verdicts = { run: l.run, verdict, drift, mutants, review: rv, evidence_ok: evidence.length - failedClaims.length, evidence_total: evidence.length };
  writeFileSync(join(dir, "verdicts.json"), `${JSON.stringify(verdicts, null, 2)}\n`);
  appendFileSync(join(dir, "reconciles.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), verdict, drift })}\n`); // history for `mine`
  const tries = l.tasks.reduce((s, t) => s + t.tries, 0);
  writeFileSync(
    join(dir, "report.md"),
    [
      `# Run report — ${l.run}`,
      "",
      `- **Verdict**: ${verdict}`,
      `- **Tasks**: ${l.tasks.length - open.length}/${l.tasks.length} passing, ${tries} failed tries in the task loop`,
      `- **Guards**: ${violations.length} violations on the repo`,
      `- **Witness**: ${evidence.length - failedClaims.length}/${evidence.length} claims proven by the platform's trails`,
      `- **Mutants**: ${mutants.map((m) => `${m.file} ${m.killed}/${m.total}`).join(", ")}`,
      `- **Reviewer**: ${rv.status} — ${rv.reason}`,
      `- **Humans**: spec gate ${l.gates.spec.approved ? `approved by ${l.gates.spec.by}` : "pending"}; merge gate ${l.gates.merge.approved ? `approved by ${l.gates.merge.by}` : "pending"}${rv.status === "skipped" ? " — must cover the skipped review" : ""}`,
      `- **Cost**: 0 LLM tokens (deterministic run), reconcile took ${((Date.now() - t0) / 1000).toFixed(0)} s`,
      "",
    ].join("\n"),
  );
  logEvent(appDir, l.run, 13, "reconcile", { verdict, drift: drift.length });
  process.exit(verdict === "green" ? 0 : 1);
}

// ── learn ───────────────────────────────────────────────────────────────────
/** Step 16: read every run's evidence and propose doctrine changes (step 17 is the human's PR). */
function cmdMine() {
  const appDir = resolve(args[0]);
  const runs = [...new Bun.Glob("artifacts/run-*/reconciles.jsonl").scanSync(appDir)].sort();
  const reconciles = runs.flatMap((f) => readFileSync(join(appDir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  const byGuard = new Map<string, number>();
  const failedClaims = new Map<string, number>();
  let humans = 0;
  for (const v of reconciles) {
    for (const d of v.drift as { kind: string; detail: string }[]) {
      const g = d.detail.match(/breaks (D\d+ · [^·]+)/)?.[1]?.trim();
      if (g) byGuard.set(g, (byGuard.get(g) ?? 0) + 1);
      const c = d.detail.match(/^(D\d+ · [^:]+): (.+?) — observed/);
      if (c) failedClaims.set(`${c[1]} — ${c[2]}`, (failedClaims.get(`${c[1]} — ${c[2]}`) ?? 0) + 1);
      if (d.kind === "decision") humans++;
    }
  }
  console.log(`mined ${reconciles.length} reconciliations over ${runs.length} run(s) of ${appDir}`);
  for (const [g, n] of byGuard) console.log(`  ${n}× code drift caught by ${g}${n >= 2 ? " → propose: ship this guard as a template for every app of the class" : ""}`);
  for (const [c, n] of failedClaims) console.log(`  ${n}× platform witness contradicted ${c} → propose: a fitness rule that catches it before the stack runs`);
  if (!byGuard.size && !failedClaims.size) console.log("  no drift across the runs — the doctrine held");
  console.log(`  ${humans} drift(s) went back to a decision (step 5): a human had to rule`);
}

async function cmdEvals() {
  const { runEvals } = await import("../evals/run");
  process.exit((await runEvals()) ? 0 : 1);
}

function cmdPrice() {
  const g = buildGraph();
  const total = args.reduce((s, b) => s + (g.bricks[b]?.ops_points ?? die(`unknown brick ${b}`)), 0);
  console.log(`${args.join(" + ")} = ${total} ops points`);
}

const commands: Record<string, () => unknown> = {
  graph: cmdGraph,
  brief: cmdBrief,
  plan: cmdPlan,
  approve: cmdApprove,
  "verify-task": cmdVerifyTask,
  fitness: cmdFitness,
  witness: () => cmdWitness(),
  mutants: () => cmdMutants(),
  reconcile: cmdReconcile,
  mine: cmdMine,
  evals: cmdEvals,
  price: cmdPrice,
};
if (!commands[cmd]) die(`usage: harness <${Object.keys(commands).join("|")}> …`);
await commands[cmd]();
