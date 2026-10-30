# AGENTS.md — start here

You are a coding agent in **harness-engineering-lab**. Read this file fully
before any change. It tells you where every kind of work goes, and what you
must never touch. Humans: the same map is in [README.md](README.md).

## The repository in one breath

| Folder | What it is | Who changes it |
|---|---|---|
| `core-platform/` | The shared platform: 11 OSS services (podman compose), app templates, onboarding scripts. **Agnostic: no script names an app.** | The CCoE |
| `harness/` | The reconciliation harness: decides which platform bricks an app may use, writes the desired state, guards it, proves it. | The CCoE |
| `deskbook/` | An app built **through** the harness. Its code is yours; its desired state is not. | Builder agents, under the harness |

The rule behind everything: **a brick (Valkey, Temporal, S3, an LLM, a worker…)
enters an app only if a requirement id pays for it.** Over-engineering is the
failure this repo exists to prevent.

## Where do I go? — pick your task

**Add or change a feature of an app** (even one line of behaviour)
1. Read `deskbook/openspec/specs/deskbook/spec.md` (requirements in force) and
   `deskbook/openspec/specs/deskbook/decisions.md` (decisions in force — read the
   **Revisit when** lines). Before the first archive, both are in
   `deskbook/openspec/changes/add-deskbook/`.
2. Write the need as a requirement in a new brief version
   `harness/briefs/<app>.v<N+1>.yaml` (skill `brief-check`). Never code first.
3. `bun harness/src/cli.ts plan harness/briefs/<app>.v<N+1>.yaml --app-dir <app>`
   → new bill, decisions, guards, tasks. **Stop: a human approves** (`approve … spec`).
4. Build the open tasks (agent `builder`), then `verify-task`, `reconcile`.

**Fix a bug in an app's code** — `deskbook/api/src/` (business rules ONLY in
`domain.ts`, pure, with tests in `domain.test.ts`), `deskbook/frontend/public/`,
`deskbook/e2e/scenarios.test.ts` (tests named `<R-id> <scenario-id>`).
Then `bun harness/src/cli.ts verify-task deskbook all`.

**You think the app needs a new brick or dependency** — it does not, until a
requirement says so. Ask the platform why it was refused:
`bun harness/src/cli.ts brief …`, or the MCP server `harness/mcp/platform`
(`explain`, `need_test`). If a requirement truly needs it, change the brief (step 2 above).

**Create a new app** — a brief `harness/briefs/<app>.v1.yaml` (copy
`deskbook.v2.yaml`'s shape), then `plan --app-dir <app>`. The harness writes the
scaffold (compose, CI, bootstrap) from the bill.

**Change how the harness chooses bricks** — `harness/catalog/criteria.yaml`
(signals, vetoes, thresholds, prices) and `harness/catalog/budgets.yaml`.
**Every rule needs an eval case** in `harness/evals/cases.yaml` that fails
without it: `bun harness/src/cli.ts evals` enforces it (ablation).

**Change the harness itself** — `harness/src/` (one module per step, see
`harness/README.md`), tests in `harness/test/`.

**Change a platform service** — `core-platform/` (README there). Never add an
app name to it. A new compose service must be priced in
`harness/catalog/criteria.yaml` or the harness build fails — by design.

## Never edit — the harness owns these

`<app>/.harness/**` · `<app>/openspec/changes/*/{design,tasks,proposal}.md` ·
`<app>/openspec/specs/**` · `<app>/openspec/changes/archive/**` ·
`<app>/podman-compose.yml` · `<app>/.gitlab-ci.yml` · `<app>/bootstrap.sh` ·
`<app>/.claude/settings.json`

A PreToolUse hook (`harness/hooks/guard.ts`) refuses these edits and any edit
that breaks a decision (e.g. importing `ioredis` when D3 says "No Valkey"). When
it refuses, it quotes the decision: respect it, do not work around it.

## Where the truth lives

| Question | File |
|---|---|
| What must the app do? | `<app>/openspec/specs/<app>/spec.md` (+ open change's `specs/` delta) |
| Why is it built this way, and when may that change? | `<app>/openspec/specs/<app>/decisions.md` (+ open change's `design.md`) |
| Which bricks may it use, paid by which requirement? | `<app>/.harness/bill.yaml` |
| What is forbidden? | `<app>/.harness/guards/D*.yaml` |
| Is a task done? | `<app>/.harness/ledger.json` — only the harness flips `passes` |
| The CCoE rules and their why | `harness/doctrine/rules.md` |
| How the platform works | `core-platform/README.md` |

## Commands (run in WSL Ubuntu, `export PATH=$HOME/.bun/bin:$PATH`)

```bash
cd core-platform && gitlab-ci-local --force-shell-executor   # the platform must be up first
bun harness/src/cli.ts <graph|brief|plan|approve|verify-task|fitness|reconcile|archive|mine|evals>
cd harness && bun test test/ && bunx tsc --noEmit             # the harness's own tests
bash harness/e2e/run.sh                                       # everything, end to end
```

## Done means

A task is done when its scenarios pass through `verify-task` (the ledger
flips), `reconcile` is green (guards, mutants ≥ 70 %, platform witness), and a
human approved the merge. Code that exists is not done.
