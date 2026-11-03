---
name: decide
description: Use once the brief is ready. Prices the bricks the requirements need, writes the decision log (design.md), compiles each decision into a guard, and writes the OpenSpec change and the plan. Never adds a brick no requirement pays for.
---

# decide — steps 2, 3 and 5 of the reconciliation harness

The bill is arithmetic, not taste. You run it; you do not redo it by hand.

```bash
bun harness/src/cli.ts plan harness/briefs/<app>.v<N>.yaml --app-dir <app>
```

It writes, from the capability graph rebuilt from `core-platform/`:

| File | What it holds |
|---|---|
| `openspec/changes/add-<app>/proposal.md` | the brief after brief-check, defaults included |
| `openspec/changes/add-<app>/design.md` | the bill and every decision: serves R-id, rejected, avoids |
| `openspec/changes/add-<app>/tasks.md` | small tasks, each proven by named spec scenarios |
| `openspec/changes/add-<app>/specs/<app>/spec.md` | requirements as SHALL + WHEN/THEN scenarios |
| `.harness/bill.yaml` | bricks bought with their payers, bricks refused with their reason |
| `.harness/guards/D<n>.yaml` | one guard per decision: forbid_* rules + witness claims |
| `.harness/ledger.json` | the plan's state — only `passes` ever flips |
| `podman-compose.yml`, `.gitlab-ci.yml` | the topology the bill paid for, nothing else |

## When you think a brick is missing

Do not add it to the code. Ask the platform why it was refused:
`explain(<brick>)` and `need_test(<requirement text>)` on the MCP server `platform`.
If a requirement really needs it, the requirement's text is what must change —
edit the brief, re-plan, and the new decision goes to the human at step 5.

## Over budget

The plan still writes the desired state, but `approve … spec` refuses without a
`--waiver "<reason, expiry>"`. The waiver lands in the README's **CCoE waivers**.
