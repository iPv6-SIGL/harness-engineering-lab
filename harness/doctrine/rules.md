# CCoE doctrine — what an app on the Core Platform must be

> "The CCoE rules are not provided — writing them is your job. Every rule you
> write states why the pattern is a good one AND which compute it avoids."
> — core-platform/README.md

Each rule below says **why**, **what compute it avoids**, and **where it is
enforced** — a rule nobody runs is dead. A rule enters this file only with an
eval case that fails without it (`harness evals`, the ablation).

## Purchase rules — what an app may run

| # | Rule | Why | Compute avoided | Enforced by |
|---|---|---|---|---|
| P1 | **A brick enters only with a requirement id.** Scaffold (frontend, api, postgres, openbao, registry, dozzle) is free; anything else is paid by an `R<n>`. | An unpaid brick is a container, a secret, a console and an alert someone runs for years "in case". | Every brick not bought: 2 points for Valkey or Temporal, 1 for Umami… | `needs.ts` need test · `bill.yaml` · D-"Nothing unasked" guard |
| P2 | **The app class comes from the needs, never from the agent.** | A CRUD app that declares itself a "process app" buys itself a 17-point budget. | The budget inflation | `budgets.yaml` `trigger_needs` |
| P3 | **A recurrence without a side effect is read at query time.** "Repeat every week until a date" is a row and a rule; "every Monday, e-mail the list" needs a scheduler. | A clock that fires for nothing still has to be kept alive. | A worker, a stream, a Temporal namespace | `V-read-time-recurrence`, `V-read-time-recurrence-only` |
| P4 | **Queue only above the thresholds.** A unit of work above 350 ms, or one action fanning out ≥ 100 units. | Below, a loop in the request is cheaper than a queue + a worker + a backlog to watch. | Valkey (2) + worker (2) | `S-volume`, `S-bulk`, `S-heavy` + `thresholds` |
| P5 | **Durable only for waiting.** Temporal when a step waits for a person or a timer beyond 30 s, must survive a restart, or must compensate. | Workflows bring versioning on every deploy and runs to operate. | Temporal (2) + UI (1) + worker (2) | `durable-wait` signals |
| P6 | **Files above 1 MB or binary go to the app's bucket, private by default.** Public read only when a requirement serves anonymous browsers. | Blobs bloat backups; a public bucket is a leak waiting for a wrong key name. | DB reads per page; an exposure | `blob-storage`, `public-media`, D-"private" guard (`PUBLIC_BUCKET` forbidden) |
| P7 | **Analytics only when someone named a metric.** | A beacon nobody reads is a privacy-register entry for nothing. | Umami (1) | `S-metric` · D-"Nothing unasked" |
| P8 | **What the platform cannot host is refused at the brief, not discovered at deploy.** Local LLMs, firehoses, native mobile, regulated data. | The cheapest refusal is before any code. | A whole failed project | `unsupported` (U-*) |

## Build rules — how the app is written

| # | Rule | Why | Compute avoided | Enforced by |
|---|---|---|---|---|
| B1 | **Business rules live in one pure module** (`api/src/domain.ts`). | It is what the harness mutates: a test counts only if it kills mutants. | Debugging fake-green suites | `mutants` (bar 70 %) |
| B2 | **Bun built-ins before libraries** (`Bun.serve`, `Bun.SQL`, `Bun.S3Client`, WebCrypto). | Every dependency is an audit, an upgrade and a supply-chain risk. | `bun audit` surface; image size | `audit` gate · README "Libraries outside the recommendations" |
| B3 | **No auth of our own.** OIDC through casdoor, roles from persona groups, checked server-side. | A users table is a second user store to secure. | Password storage, reset flows | D-"Identity" witness (the API reads `secret/<app>/oidc`) |
| B4 | **Same-origin frontend** (nginx proxies `/api` and `/auth`). | No CORS policy to get wrong; `connect-src 'self'`. | A CORS preflight per call | `C1 frontend` scenario (CSP asserted) |
| B5 | **Every scenario is a test named `<R-id> <scenario-id>`, run as a seeded persona.** | "Done" means a scenario passes, not that code exists. | Re-work after a false "done" | `verify-task` · ledger |

## Process rules — how a run is governed

| # | Rule | Why | Enforced by |
|---|---|---|---|
| G1 | The desired state (`design.md`, guards, ledger, compose, CI) is out of the builder's reach. | An agent that can edit its constraints has none. | `hooks/guard.ts` `PROTECTED` |
| G2 | Each decision compiles into a guard enforced three times: **prevent** (hook), **detect** (CI fitness), **prove** (platform witness). | An audit after the fact only detects. | `guards.ts` · `fitness` gate · `witness.ts` |
| G3 | One failing witness claim blocks the merge, whatever the tests say. | The trails show what really ran. | `reconcile` → merge gate |
| G4 | Three failures on one task → a human. | Loops burn tokens; a stuck task is often a wrong decision. | `max_task_tries` |
| G5 | The reviewer runs on the other model family; no key → skipped **and said so**. | Judges favour their own family; a silent skip is a silent pass. | `review.ts` · report "Humans" line |
| G6 | **Every decision is archived with what reopens it and how it scales.** `Revisit when` names the signal that would add or drop a brick; `Scales by` says how the choice grows and where it stops. | An app stays modular only if the next change knows which brick it may add, and scalable only if each choice states its limit. | `archive.ts` refuses a decision without both · `openspec/specs/<app>/decisions.md` |
| G7 | **The API holds no state.** Sessions, login states and data live in the platform (Postgres, S3); migrations run under a lock; the proxy re-resolves the API. | A replica is then a copy, not a migration. | `C1 stateless` scenario (a session survives a new API process) |
