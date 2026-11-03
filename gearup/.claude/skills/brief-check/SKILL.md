---
name: brief-check
description: Use before any design. Turns a user's prompt into a structured brief (personas, testable needs, data and volumes, invariants, scope) and checks it says enough to build what the user needs. Asks at most three questions a round, only when the answer changes a brick or a requirement.
---

# brief-check — step 4 of the reconciliation harness

You turn the user's prompt into `harness/briefs/<app>.v<N>.yaml`, then let the
deterministic checker grade it. You never grade the brief yourself.

## 1. Write the brief

Shape (see `harness/briefs/deskbook.v2.yaml`):

- `personas`: who logs in, with a kebab-case slug each (they become IdP groups and test identities).
- `requirements`: one `R<n>` per need, written as the user would say it. Each has a
  `persona` and at least one `scenarios` entry with a `when` and a `then` a test can check.
  Put the user's words in `text` — the need test reads them; do not paraphrase away "every week",
  "approve", "upload", "thousands".
- `volume` on a requirement when one action triggers many units of work.
- `data` with a volume for every entity; `never` (invariants); `out_of_scope`.
- Quote any YAML value that contains a comma inside `{…}`.

## 2. Grade it — with the harness, not by judgement

```bash
bun harness/src/cli.ts brief harness/briefs/<app>.v<N>.yaml
```

Exit 0 = ready. Exit 3 = not ready: the output lists the gaps and **at most three
questions**, each with what it `affects` and a default.

You may also ask the platform directly (MCP server `platform`): `need_test` on a
requirement's text shows which bricks it would buy and which counter-signals
veto them — use it to decide whether a question is worth asking.

## 3. Ask, in plain words

For each question: one sentence on the gap, one on what it changes in the build,
the proposed default. Write the answers under `answers:`, bump `version`, save
as `<app>.v<N+1>.yaml`, and grade again.

**Stop rule**: three rounds at most. After the third, the checker applies the
defaults and lists them; they appear in `proposal.md` for the human at step 5.
