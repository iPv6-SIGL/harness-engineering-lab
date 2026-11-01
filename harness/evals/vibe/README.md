# Vibe coding vs the harness — the experiment

`harness evals` compares the harness with a **simulated** agent (`naiveBill`: the
harness's own code with the vetoes off). That baseline is circular: it proves the
vetoes work, not that real agents need them. This folder replaces it with
**real agents that never saw the harness**.

## Protocol

Every run is a fresh agent in its own directory **outside the repository**
(`~/vibe-runs/<run>/`), holding only `core-platform/` (what any developer has)
and, for the spec arm, a `SPEC.md`. No `AGENTS.md`, no harness, no hook, no
`brief-check`. The agent writes files only: it does not start a container.

| arm | input | runs |
|---|---|---|
| **raw** | the one-paragraph prompt, verbatim | DeskBook ×3, PayslipRun ×2, GearUp ×2 |
| **spec** | the full brief (personas, requirements + scenarios, data, never, out of scope) rendered as `SPEC.md`, still no harness | DeskBook ×2 |
| **change** | an existing spec-arm app + one new request (weekly e-mail digest) | DeskBook ×2 |
| **harness** | `harness plan` → builder → `verify-task` → `reconcile` | DeskBook ×1 (the repository) |

## Instruments (all in this folder, all deterministic)

| tool | answers | calibrated against |
|---|---|---|
| `measure.ts <app> <brief>` | which bricks are really in the code (comments stripped), their ops points, over-built / missing against the bill, guard violations | the harness DeskBook must give 9 points, 0 unpaid, 0 violation |
| `mutate-all.ts` | do the agent's own tests kill mutants? (step 10's mutator, same operators and sample) | the harness DeskBook gives 91 % |
| `scripts/run-vibe-pipeline.sh` | does the app's **own** pipeline deploy and verify on the live platform? (renamed copy, so `deskbook` is untouched) | — |

Two instrument bugs were found and fixed *before* any conclusion: the first
scanner counted 16 points on the harness DeskBook (it read the harness's own
evidence folders), and a first identity detector matched the word "OIDC" in
comments ("No OIDC yet") and then missed camelCase configuration. Every
detector is validated on the harness DeskBook **and** on the runs it must
reject. One test-bench bug was found too: two apps deployed one after the other
under the same name shared a leftover Postgres table (the `purge` job does not
drop the database); `clean-and-rerun.sh` drops it.

## Limits to state out loud

- Small samples (9 raw, 2 spec, 2 change). Same model family as the harness's builder.
- Agents were forbidden to run anything: a real developer would run the app before
  shipping. The spec-arm apps were therefore deployed by us, once, with their own pipeline.
- The spec arm was given the brief **after** the harness's brief loop and a human's
  answers: it measures the value of a good specification, not of the harness's gates.
- `PayslipRun`/`GearUp` briefs come from `evals/cases.yaml`; their raw prompts are one sentence.
