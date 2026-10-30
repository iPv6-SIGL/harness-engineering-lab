// evals/run.ts — step 18: "kept only if it fails without, passes with".
//
// 1. WITH the harness: the need test on every case must give the expected bill.
// 2. WITHOUT: a naive agent buys every brick its family profile lists plus every
//    brick a keyword hints at (no vetoes, no requirement ids) — the bill we
//    would get by default. The difference is the over-engineering avoided.
// 3. ABLATION: every rule (veto, signal, unsupported pattern) is switched off in
//    turn; a rule whose absence no case notices is reported as dead weight.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildGraph, type Graph } from "../src/catalog";
import { type Brief, needTest, ownedBricks } from "../src/needs";

type Expect = { class?: string; buy?: string[]; refuse?: string[]; points?: number; flags?: string[]; unsupported?: string[]; vetoed?: string[] };
type Case = { name: string; brief: Brief | string; expect: Expect };

const HERE = import.meta.dir;

function load(): { name: string; brief: Brief; expect: Expect }[] {
  const raw = Bun.YAML.parse(readFileSync(join(HERE, "cases.yaml"), "utf8")) as { cases: Case[] };
  return raw.cases.map((c) => {
    const brief = typeof c.brief === "string" ? (Bun.YAML.parse(readFileSync(resolve(HERE, c.brief), "utf8")) as Brief) : ({ ...c.brief, version: c.brief.version ?? 1, prompt: c.brief.prompt ?? "" } as Brief);
    return { name: c.name, brief, expect: c.expect };
  });
}

/** Returns the reasons a bill misses its expectation (empty = pass). */
export function judge(g: Graph, brief: Brief, e: Expect, disabledRules: string[] = []): string[] {
  const bill = needTest(brief, g, { disabledRules });
  const owned = new Set(ownedBricks(bill));
  const miss: string[] = [];
  if (e.unsupported) {
    for (const u of e.unsupported) if (!bill.unsupported.some((x) => x.id === u)) miss.push(`not refused as ${u}`);
    return miss;
  }
  if (bill.unsupported.length) miss.push(`wrongly unsupported: ${bill.unsupported.map((u) => u.id).join(",")}`);
  if (e.class && bill.class !== e.class) miss.push(`class ${bill.class} ≠ ${e.class}`);
  for (const b of e.buy ?? []) if (!owned.has(b)) miss.push(`did not buy ${b}`);
  for (const b of e.refuse ?? []) if (owned.has(b)) miss.push(`bought ${b}`);
  if (e.points !== undefined && bill.points !== e.points) miss.push(`${bill.points} points ≠ ${e.points}`);
  for (const f of e.flags ?? []) if (!bill.flags.includes(f)) miss.push(`flag ${f} missing`);
  for (const v of e.vetoed ?? []) if (!bill.vetoed.some((x) => `${x.need}@${x.requirement}` === v)) miss.push(`decision log lost the veto ${v}`);
  return miss;
}

/** The bill of an agent without the harness: the family profile + every keyword hint, no veto. */
export function naiveBill(g: Graph, brief: Brief): { bricks: string[]; points: number } {
  const noVetoes = needTest(brief, g, { disabledRules: Object.keys(g.vetoes) });
  const klass = g.classes[noVetoes.class];
  const bricks = [...new Set([...ownedBricks(noVetoes), ...klass.profile])];
  return { bricks, points: bricks.reduce((s, b) => s + g.bricks[b].ops_points, 0) };
}

export function allRules(g: Graph): string[] {
  return [
    ...Object.keys(g.vetoes),
    ...Object.values(g.needs).flatMap((n) => (n.signals ?? []).map((s) => s.id)),
    ...g.unsupported.map((u) => u.id),
    "identity",
  ];
}

export async function runEvals(): Promise<boolean> {
  const g = buildGraph(resolve(dirname(HERE), "..", "core-platform"));
  const cases = load();
  let ok = true;
  let withPts = 0;
  let withoutPts = 0;
  console.log("WITH the harness vs WITHOUT (naive: family profile + keyword hints, no veto)\n");
  for (const c of cases) {
    const miss = judge(g, c.brief, c.expect);
    if (miss.length) ok = false;
    const bill = needTest(c.brief, g);
    const naive = naiveBill(g, c.brief);
    if (!c.expect.unsupported) {
      withPts += bill.points;
      withoutPts += naive.points;
    }
    const over = naive.bricks.filter((b) => !ownedBricks(bill).includes(b));
    console.log(`${miss.length ? "✗" : "✓"} ${c.name}`);
    if (c.expect.unsupported) console.log(`    refused: ${bill.unsupported.map((u) => u.id).join(", ")}`);
    else console.log(`    with: ${bill.points}/${bill.budget} (${bill.class})   without: ${naive.points}${over.length ? `  — over-built: ${over.join(", ")}` : ""}`);
    for (const m of miss) console.log(`    ✗ ${m}`);
  }
  console.log(`\nops points across the cases: with ${withPts}, without ${withoutPts} → ${withoutPts - withPts} avoided (${Math.round((100 * (withoutPts - withPts)) / withoutPts)} %)\n`);

  console.log("ABLATION — a rule is kept only if some case fails without it");
  const dead: string[] = [];
  const green = cases.filter((c) => judge(g, c.brief, c.expect).length === 0); // a red case proves nothing about a rule
  for (const rule of allRules(g)) {
    const caught = green.filter((c) => judge(g, c.brief, c.expect, [rule]).length > 0).map((c) => c.name.replace(/^trap: /, "trap «").replace(/ \(.*$/, "") + (c.name.startsWith("trap") ? "»" : ""));
    if (!caught.length) dead.push(rule);
    console.log(`  ${caught.length ? "✓" : "·"} ${rule.padEnd(26)} ${caught.length ? `missed by: ${[...new Set(caught)].join(", ")}` : "no case needs it — candidate for removal, or add a case"}`);
  }
  console.log(`\n${ok ? "✓" : "✗"} ${cases.length} cases · ${allRules(g).length - dead.length}/${allRules(g).length} rules proven by a case${dead.length ? ` · unproven: ${dead.join(", ")}` : ""}`);
  return ok && dead.length === 0; // the meta-rule is enforced, not advised
}

if (import.meta.main) process.exit((await runEvals()) ? 0 : 1);
