// needs.ts — the need test (step 3): a brick enters only with a requirement id.
//
//   requirement text ──signals──▶ needs ──(vetoes)──▶ bricks ──▶ bill
//
// Deterministic on purpose: an LLM may PROPOSE needs (`needs:` on a requirement,
// with a `because`), but the arithmetic of what is bought, what is refused and
// what it costs is code — reproducible, diffable, testable.
import type { Graph, Need } from "./catalog";
import { scaffoldBricks } from "./catalog";

export type Scenario = { id: string; when: string; then: string };
export type Requirement = {
  id: string;
  text: string;
  persona?: string;
  volume?: number; // units of work triggered by ONE action
  scenarios?: Scenario[];
  needs?: { need: string; because: string }[]; // explicit proposal (LLM or human), must say why
};
export type Brief = {
  app: string;
  version: number;
  prompt: string;
  anonymous?: boolean;
  port_block?: number;
  personas: { slug: string; does: string }[];
  requirements: Requirement[];
  data?: { entity: string; volume?: string; size?: string }[];
  never?: string[];
  out_of_scope?: string[];
  answers?: Record<string, string>;
};

export type Hit = { need: string; signal: string; match: string };
export type Refusal = { brick: string; points: number; reason: string; rule?: string; requirement?: string; avoids?: string };
export type Bill = {
  app: string;
  class: string;
  budget: number;
  points: number;
  within_budget: boolean;
  scaffold: string[];
  bought: { brick: string; points: number; paid_by: string[]; needs: string[] }[];
  refused: Refusal[];
  flags: string[];
  profile_notes: string[];
  needs: Record<string, string[]>; // need → R-ids
  vetoed: { need: string; requirement: string; rule: string; why: string; avoids: string }[];
  hits: Record<string, Hit[]>; // R-id → hits
  unsupported: { id: string; why: string; match: string }[];
  provider_constraints: string[];
};

const rx = (s: string) => new RegExp(s, "i");

function signalHits(need: Need, needId: string, r: Requirement, g: Graph): Hit[] {
  const hits: Hit[] = [];
  for (const s of need.signals ?? []) {
    if (s.numeric) {
      const threshold = g.thresholds[s.numeric];
      if ((r.volume ?? 0) >= threshold) hits.push({ need: needId, signal: s.id, match: `volume ${r.volume} ≥ ${s.numeric} ${threshold}` });
      continue;
    }
    const m = (s.re && r.text.match(rx(s.re))) || (s.also && r.text.match(rx(s.also)));
    if (m) hits.push({ need: needId, signal: s.id, match: m[0] });
  }
  return hits;
}

export type NeedTestOptions = { disabledRules?: string[] };

export function needTest(brief: Brief, g: Graph, opts: NeedTestOptions = {}): Bill {
  const disabled = new Set(opts.disabledRules ?? []);
  const needs: Record<string, Set<string>> = {};
  const vetoed: Bill["vetoed"] = [];
  const hits: Bill["hits"] = {};
  const add = (n: string, rid: string) => (needs[n] ??= new Set()).add(rid);

  // Structural need: identity is paid by every requirement a persona performs.
  if (!brief.anonymous && brief.personas.length > 0 && !disabled.has("identity")) {
    for (const r of brief.requirements) if (r.persona) add("identity", r.id);
  }

  for (const r of brief.requirements) {
    const rHits: Hit[] = [];
    for (const [needId, need] of Object.entries(g.needs)) {
      if (need.structural) continue;
      const h = signalHits(need, needId, r, g).filter((x) => !disabled.has(x.signal));
      if (!h.length) continue;
      // Vetoes: a counter-signal cancels the need for THIS requirement.
      const matched = new Set(h.map((x) => x.signal));
      const veto = (need.vetoed_by ?? []).find((vId) => {
        if (disabled.has(vId)) return false;
        const v = g.vetoes[vId];
        if (!rx(v.re).test(r.text)) return false;
        if (v.unless && matched.has(v.unless)) return false;
        if (v.only_if_signals && ![...matched].every((s) => v.only_if_signals!.includes(s))) return false;
        return true;
      });
      rHits.push(...h);
      if (veto) {
        const v = g.vetoes[veto];
        vetoed.push({ need: needId, requirement: r.id, rule: veto, why: v.why, avoids: v.avoids });
        continue;
      }
      add(needId, r.id);
    }
    for (const n of r.needs ?? []) {
      rHits.push({ need: n.need, signal: "explicit", match: n.because });
      add(n.need, r.id);
    }
    hits[r.id] = rHits;
  }

  // A need that depends on another (public-media → blob-storage) dies without it.
  for (const [needId, need] of Object.entries(g.needs)) {
    if (need.requires_need && needs[needId] && !needs[need.requires_need]) delete needs[needId];
  }

  // Bricks: scaffold + what the needs buy + what those bricks require.
  const scaffold = scaffoldBricks(g);
  const paidBy: Record<string, Set<string>> = {};
  const byNeed: Record<string, Set<string>> = {};
  const queue: [string, string[], string][] = [];
  for (const [needId, rids] of Object.entries(needs)) for (const b of g.needs[needId].buys) queue.push([b, [...rids], needId]);
  while (queue.length) {
    const [b, rids, needId] = queue.shift()!;
    if (scaffold.includes(b)) continue;
    const first = !paidBy[b];
    for (const rid of rids) (paidBy[b] ??= new Set()).add(rid);
    (byNeed[b] ??= new Set()).add(needId);
    if (first) for (const req of g.bricks[b].requires) queue.push([req, rids, needId]);
  }

  const bought = Object.keys(paidBy)
    .sort((a, b) => Object.keys(g.bricks).indexOf(a) - Object.keys(g.bricks).indexOf(b))
    .map((b) => ({ brick: b, points: g.bricks[b].ops_points, paid_by: [...paidBy[b]].sort(), needs: [...byNeed[b]].sort() }));
  const scaffoldPoints = scaffold.reduce((s, b) => s + g.bricks[b].ops_points, 0);
  const points = scaffoldPoints + bought.reduce((s, b) => s + b.points, 0);

  // Class: the richest need wins.
  const active = new Set(Object.keys(needs));
  const [cls, klass] = Object.entries(g.classes)
    .filter(([, c]) => {
      if (c.trigger_needs_all) return c.trigger_needs_all.every((n) => active.has(n));
      if (c.trigger_needs) return c.trigger_needs.some((n) => active.has(n));
      return true;
    })
    .sort((a, b) => b[1].rank - a[1].rank)[0];

  // Refusals: every brick the app does not run, with the reason it stays out.
  const owned = new Set([...scaffold, ...Object.keys(paidBy)]);
  const refused: Refusal[] = [];
  for (const b of Object.keys(g.bricks)) {
    if (owned.has(b)) continue;
    const v = vetoed.find((x) => g.needs[x.need].buys.includes(b) || g.needs[x.need].buys.some((nb) => g.bricks[nb].requires.includes(b)));
    if (v) {
      refused.push({ brick: b, points: g.bricks[b].ops_points, rule: v.rule, requirement: v.requirement, reason: `${v.requirement}: ${v.why}`, avoids: v.avoids });
    } else if (klass.profile.includes(b)) {
      const need = Object.entries(g.needs).find(([, n]) => n.buys.includes(b));
      refused.push({ brick: b, points: g.bricks[b].ops_points, reason: `the ${cls} profile predicts it, but no requirement cites it${need ? ` (${need[0]}: ${need[1].question ?? need[1].why})` : ""}` });
    } else {
      refused.push({ brick: b, points: g.bricks[b].ops_points, reason: "no requirement emits a signal for it" });
    }
  }

  const flags = [...new Set(Object.keys(needs).map((n) => g.needs[n].flag).filter(Boolean) as string[])];
  const profile_notes: string[] = [];
  for (const b of klass.profile) if (!owned.has(b)) profile_notes.push(`profile predicted ${b}; not bought — the requirement decides, not the matrix`);
  for (const b of Object.keys(paidBy)) if (!klass.profile.includes(b)) profile_notes.push(`bought ${b} outside the ${cls} profile, paid by ${[...paidBy[b]].join(", ")}`);

  const fullText = [brief.prompt, ...brief.requirements.map((r) => r.text)].join("\n");
  const unsupported = g.unsupported
    .map((u) => ({ u, m: fullText.match(rx(u.re)) }))
    .filter((x) => x.m && !disabled.has(x.u.id))
    .map((x) => ({ id: x.u.id, why: x.u.why, match: x.m![0] }));

  return {
    app: brief.app,
    class: cls,
    budget: klass.budget,
    points,
    within_budget: points <= klass.budget,
    scaffold,
    bought,
    refused,
    flags,
    profile_notes,
    needs: Object.fromEntries(Object.entries(needs).map(([k, v]) => [k, [...v].sort()])),
    vetoed,
    hits,
    unsupported,
    provider_constraints: [...new Set(Object.keys(needs).map((n) => g.needs[n].provider_constraint).filter(Boolean) as string[])],
  };
}

export function ownedBricks(bill: Bill): string[] {
  return [...bill.scaffold, ...bill.bought.map((b) => b.brick)];
}
