// openspec.ts — writes the desired state as an OpenSpec change:
//   openspec/changes/<change>/{proposal.md, design.md, tasks.md, specs/<app>/spec.md}
// proposal.md is the brief after brief-check, design.md the decision log,
// tasks.md the plan where every task names the scenario that proves it.
import type { BriefCheck } from "./brief";
import type { Graph } from "./catalog";
import type { Decision } from "./decide";
import type { Bill, Brief } from "./needs";

export type Task = { id: string; title: string; owner: string; scenarios: string[]; requirement?: string };

export function planTasks(brief: Brief, bill: Bill): Task[] {
  const tasks: Task[] = [];
  const flags = bill.flags.length ? `${bill.flags.join(" ")} ` : "";
  tasks.push({ id: "1.1", title: `${flags}APP=${brief.app} ./bootstrap.sh`, owner: "harness", scenarios: ["C1 ready"] });
  if (bill.needs.identity) {
    tasks.push({ id: "1.2", title: `OIDC client + ${brief.personas.length} test personas (${brief.personas.map((p) => p.slug).join(", ")})`, owner: "harness", scenarios: ["C1 oidc"] });
  }
  tasks.push({ id: "2.1", title: "Data model and seed (migrations in api/src/db.ts)", owner: "builder", scenarios: ["C1 ready"] });
  let n = 1;
  for (const r of brief.requirements) {
    tasks.push({ id: `3.${n++}`, title: `${r.id} · ${r.text}`, owner: "builder", requirement: r.id, scenarios: (r.scenarios ?? []).map((s) => `${r.id} ${s.id}`) });
  }
  tasks.push({ id: "4.1", title: "Screens: the persona journeys in frontend/", owner: "builder", scenarios: ["C1 frontend"] });
  tasks.push({ id: "5.1", title: `Contracts: /health, /ready, ports ${brief.port_block}–${(brief.port_block ?? 8000) + 1}, SIGTERM < 10 s`, owner: "builder", scenarios: ["C1 health", "C1 ready"] });
  return tasks;
}

export function proposalMd(brief: Brief, check: BriefCheck, bill: Bill, round: number): string {
  const l: string[] = [];
  l.push(`# Proposal — add-${brief.app}`, "", `> ${brief.prompt.trim()}`, "");
  l.push("## Why", "", `Brief v${brief.version}, brief-check ${check.score}/5 after round ${round}${check.defaults_applied.length ? ` — ${check.defaults_applied.length} default(s) applied` : ""}.`, "");
  l.push("## Personas", "", ...brief.personas.map((p) => `- **${p.slug}** — ${p.does}`), "");
  l.push("## Needs a test can check", "", ...brief.requirements.map((r) => `- **${r.id}**${r.persona ? ` (${r.persona})` : ""} — ${r.text}`), "");
  l.push("## Data", "", ...(brief.data ?? []).map((d) => `- ${d.entity}: ${d.volume ?? "volume unknown"}${d.size ? ` · ${d.size}` : ""}`), "");
  l.push("## Must never happen", "", ...(brief.never ?? []).map((x) => `- ${x}`), "");
  l.push("## Out of scope", "", ...(brief.out_of_scope ?? []).map((x) => `- ${x}`), "");
  if (brief.answers && Object.keys(brief.answers).length) l.push("## Answers from the brief loop", "", ...Object.entries(brief.answers).map(([k, v]) => `- \`${k}\`: ${v}`), "");
  if (check.defaults_applied.length) l.push("## Defaults applied (review at step 5)", "", ...check.defaults_applied.map((q) => `- ${q.ask} → **${q.default}** (${q.affects})`), "");
  l.push("## What changes", "", `A **${bill.class}** app: ${bill.points} / ${bill.budget} ops points. See design.md for every brick bought or refused.`, "");
  return l.join("\n");
}

export function designMd(brief: Brief, bill: Bill, decisions: Decision[], g: Graph, run: string): string {
  const l: string[] = [];
  l.push(`# Design — add-${brief.app}`, "", `Written by the decide step of run \`${run}\` from the capability graph (${g.built_from.length} sources). Each decision names the requirement it serves, what it rejected and the compute it avoids; its guard lives in \`.harness/guards/<id>.yaml\`.`, "");
  l.push("## The bill", "", "| Brick | Points | Paid by | Need |", "|---|---|---|---|");
  for (const b of bill.scaffold) l.push(`| ${b} | ${g.bricks[b].ops_points} | scaffold | — |`);
  for (const b of bill.bought) l.push(`| **${b.brick}** | ${b.points}${g.bricks[b.brick].price_assumed ? "*" : ""} | ${b.paid_by.join(", ")} | ${b.needs.join(", ")} |`);
  l.push("", `**Total: ${bill.points} / ${bill.budget}** (${bill.class} budget)${bill.within_budget ? "" : " — **OVER BUDGET: needs a logged waiver and a human signal**"}. \\* price assumed.`, "");
  l.push("## Decisions", "");
  for (const d of decisions) {
    l.push(`### ${d.id} · ${d.title}`, "", `- **Serves** ${d.serves.join(", ")}`, `- **Chose** ${d.chose}`, `- **Rejected** ${d.rejected}`, `- **Avoids** ${d.avoids}`, `- **Guard** \`.harness/guards/${d.id}.yaml\`${d.guard.witness.length ? ` · witness: ${d.guard.witness.map((w) => `${w.probe} ${w.expect}`).join(", ")}` : ""}`, "");
  }
  l.push("## Refused, with the reason", "", "| Brick | Points | Why it stays out |", "|---|---|---|");
  for (const r of bill.refused) l.push(`| ${r.brick} | ${r.points} | ${r.reason}${r.rule ? ` (rule \`${r.rule}\`)` : ""} |`);
  const saved = bill.refused.reduce((s, r) => s + r.points, 0);
  l.push("", `${saved} points not spent: fewer containers, secrets and alerts to run for the life of the app.`, "");
  if (bill.profile_notes.length) l.push("## Against the family profile", "", ...bill.profile_notes.map((n) => `- ${n}`), "");
  return l.join("\n");
}

export function specMd(brief: Brief): string {
  const l: string[] = ["## ADDED Requirements", ""];
  for (const r of brief.requirements) {
    l.push(`### Requirement: ${r.id} ${r.text.split(/[.;:]/)[0]}`, "", `The system SHALL ${r.text.charAt(0).toLowerCase()}${r.text.slice(1).replace(/\.$/, "")}.`, "");
    for (const s of r.scenarios ?? []) l.push(`#### Scenario: ${r.id} ${s.id}`, "", `- **WHEN** ${s.when}`, `- **THEN** ${s.then}`, "");
  }
  return l.join("\n");
}

export function tasksMd(brief: Brief, tasks: Task[]): string {
  const l: string[] = [`# Tasks — add-${brief.app}`, "", "Done means the named scenario passes (the harness flips `.harness/ledger.json`), not that code exists.", ""];
  for (const t of tasks) l.push(`- [ ] ${t.id} ${t.title} — owner: ${t.owner} · proves: ${t.scenarios.map((s) => `\`${s.trim()}\``).join(", ")}`);
  return `${l.join("\n")}\n`;
}
