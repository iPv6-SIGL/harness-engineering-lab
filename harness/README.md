# The reconciliation harness

A harness that makes a coding agent build **only what the brief pays for** on the
Core Platform, then **proves** it with the platform's own trails. It implements
the canvases *Core Platform — application types* and *Harness — file structure &
complexity budget*: 18 steps, four loops (brief, task, change, learning).

The core is **deterministic** — the bill, the guards, the ledger, the verdict are
code, reproducible without an LLM key. LLMs plug in at the edges (writing the
brief, building tasks, the cross-family review) through the skills and agents in
`.claude/`, and are checked by the same code.

```bash
bun install
bun src/cli.ts graph                                        # step 2 — the capability graph
bun src/cli.ts brief briefs/deskbook.v1.yaml                # step 4 — 3/5, three questions
bun src/cli.ts plan briefs/deskbook.v2.yaml --app-dir ../deskbook   # steps 2–5
bun src/cli.ts approve ../deskbook spec --by <you>          # step 5 — a human
bun src/cli.ts verify-task ../deskbook all                  # steps 8–9 — the ledger
bun src/cli.ts reconcile ../deskbook                        # steps 7, 10–13
bun src/cli.ts approve ../deskbook merge --by <you>         # step 14
bun src/cli.ts archive ../deskbook                          # step 15 — spec + decision log in force
bun src/cli.ts mine ../deskbook                             # step 16
bun src/cli.ts evals                                        # step 18 — with vs without, ablation
bash e2e/run.sh                                             # everything, on the running platform
```

## The criteria — how the harness chooses

The heart is `catalog/criteria.yaml`. A requirement's **text** emits **signals**;
signals become **needs** unless a **counter-signal** vetoes them; a need **buys**
bricks; every bought brick is paid by requirement ids; the **class** (and so the
budget) is derived from the needs.

| Need | Bought when | Refused when (veto) | Buys |
|---|---|---|---|
| identity | a persona logs in | the app is anonymous | casdoor (2) |
| blob-storage | uploads, images, PDFs, scans — binary or > 1 MB | — | s3 (1) |
| public-media | anonymous browsers load the files | — | `PUBLIC_BUCKET=1` |
| async-work | bulk, heavy (render/resize/transcode), nightly import, ≥ 100 units per action, a recurrence **with** a side effect | a recurrence alone (`V-read-time-recurrence`) | valkey (2) + worker (2) |
| durable-wait | approval, timers of days, reminders, compensation, waiting for a human | "repeat weekly until a date" (`V-read-time-recurrence-only`) | temporal (2) + UI (1) + worker |
| llm / semantic-search / image-generation | drafting, triage, answering from documents, generated images | — | apisix (1), `LLM_VKEY=1` |
| product-metrics | someone named a metric | nobody did | umami (1) |
| — | local GPUs, firehoses, native mobile, regulated data | refused outright (U-*) | — |

Thresholds (`latency_budget_ms: 350`, `durable_wait_s: 30`, `fanout_units: 100`,
`blob_bytes: 1 MB`) turn "it feels heavy" into a decision. Prices are ops points
(what the app team runs for the life of the app); budgets per class live in
`catalog/budgets.yaml` (crud 10 · jobs 16 · media/rag/process 17 · agent 18).

**Every rule is proven by an eval.** `harness evals` runs 26 cases (the six
families, traps, one probe per signal), compares each bill with a naive agent
(family profile + every keyword, no veto), then switches each of the 25 rules
off in turn: a rule no case misses fails the run.

## The file structure

```
harness/
├─ harness.yaml            budgets, stop rules, mutation bar, gates
├─ catalog/                the capability graph (2) — criteria.yaml, budgets.yaml; graph.json generated
├─ mcp/platform/server.ts  list_bricks · explain · price · need_test, over MCP (2)
├─ .claude/                skills brief-check (4), decide (5); agents builder (6), reviewer (12)
├─ hooks/guard.ts          PreToolUse refusal (7) — reconstructs the file after the edit
├─ doctrine/rules.md       the CCoE rules, each with its why, its compute avoided, its enforcer
├─ src/
│  ├─ catalog.ts           graph from compose + README + bootstrap.sh; fails on drift
│  ├─ brief.ts             5 criteria, ≤ 3 questions that change a brick or a requirement
│  ├─ needs.ts             the need test → the bill
│  ├─ decide.ts            decisions → guards (forbid_* + witness claims)
│  ├─ openspec.ts          proposal · design · tasks · spec deltas
│  ├─ scaffold.ts          compose + CI rendered from the bill
│  ├─ guards.ts            prevent (hook) + detect (fitness)
│  ├─ ledger.ts            only `passes` flips; decisions.jsonl run log
│  ├─ mutants.ts           a dependency-free mutator (10)
│  ├─ witness.ts           probes on the running platform (11)
│  ├─ review.ts            cross-family reviewer via llm.internal (12)
│  ├─ archive.ts           spec in force, cumulative decision log, evidence to S3 (15)
│  └─ cli.ts               reconcile (13), gates (5, 14), mine (16)
├─ evals/                  cases.yaml + run.ts (18)
├─ test/                   unit tests of the harness itself
└─ e2e/run.sh              the whole run against the live platform
```

What a run writes in the app repo: `openspec/changes/add-<app>/` (the desired
state), `.harness/` (bill, guards, decisions, ledger — builder read-only),
`artifacts/run-*/` (decisions.jsonl, evidence.json, verdicts.json, report.md —
outside Git). At step 15, `archive` makes it permanent: the requirements merge
into `openspec/specs/<app>/spec.md`, every decision — with **Revisit when** (the
signal that would add or drop a brick: modularity) and **Scales by** (how it
grows and where that stops: scalability) — appends to
`openspec/specs/<app>/decisions.md`, the change moves to
`openspec/changes/archive/<date>-<change>/` with its run trail, and the
evidence pack goes to `s3://harness/<app>/<run>/`. A decision without those two
fields is refused.

## Not built yet (rollout V4)

- **The run as a Temporal workflow** (namespace `harness`, one activity per agent
  turn, gates as signals). Today the run is a sequence of CLI steps; the gates are
  recorded in the ledger, not waited on durably.
- **The cross-family reviewer is wired but skipped** until `secret/core/openai`
  (or anthropic) and a `harness` vkey exist; the run report says so and the merge
  gate note must cover it.
- **Doctrine PRs are proposed by `mine`, not opened.**
