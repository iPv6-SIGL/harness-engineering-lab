# Vibe coding vs the harness — measured, 2026-11-01

**Question.** Does the harness bring real value over an agent that simply builds the app (vibe coding), and is DeskBook the right app to show it?

**Method.** Real agents that never saw the harness, in isolated directories outside the repo, holding only `core-platform/`. Tools and protocol: [`harness/evals/vibe/`](../harness/evals/vibe/README.md). Every detector was calibrated on the harness DeskBook (must give 9 points, 0 unpaid, 0 violation) **and** on the runs it must reject; three instrument bugs were found and fixed before any conclusion (a scanner that read the harness's own evidence folders, an identity detector fooled by the word "OIDC" in comments, then blind to camelCase config).

| arm | input | runs |
|---|---|---|
| raw | one-paragraph prompt | DeskBook ×3, PayslipRun ×2, GearUp ×2 |
| spec | full brief (requirements, scenarios, never-list) rendered as `SPEC.md`, no harness | DeskBook ×2 |
| change | spec-arm app + "Monday e-mail digest" | ×2 |
| harness | the repository's DeskBook | ×1 |

## What the measures say

| | raw (7) | spec (2) | harness |
|---|---|---|---|
| over-built bricks | **0** | 0 | 0 |
| real SSO (Casdoor OIDC) | **0 / 7** (header `X-User`, or nothing) | 2 / 2 | yes |
| DeskBook ops points | 7 (SSO missing) | 9 | 9 |
| deployed on the live platform with its own pipeline | not run | 2 / 2 (spec1 8/8 scenarios; spec2 verify green) | 16 scenarios green |
| mutation score of its tests (≥ 70 % required) | 50–72 %, **1 of 7 passes** | 47 %, 69.9 % | **91 %** |
| architecture check (fitness) in CI | 0 / 7 | 0 / 2 | yes |
| written decisions with a revisit condition | 0 / 7 | 0 / 2 | D1–D4 |

Change request "every Monday, e-mail each office manager" (brief v3):
- harness (before the correction): class `crud → jobs`, 9 → 13 points (Valkey + worker), Temporal refused — computed before any code; **after the correction: 11, as the agents**; D3 (`forbid_service worker`) **fires on both agents' code**; the catalog **refuses to build on both agents' modified platforms** (`compose service 'mailpit' has no entry in catalog/criteria.yaml — price it before any app can buy it`).
- agents (2/2): +1 worker container, **a new service (Mailpit) added to the shared platform without saying so**, one added a dependency (nodemailer), the other wrote its own SMTP client; 11 points; nothing deployed.

## What did NOT hold — and was therefore removed from the deck

- **"An agent alone over-builds" is false on these runs** (0 over-built bricks in 9). The earlier `16 → 9` came from `naiveBill`, a simulated agent made from the harness's own code with the vetoes off: a circular baseline. The `31 cases, 331 vs 291 points` figure is still produced by that simulation and is now labelled as such.
- **Given a complete brief, an agent matches the harness on bricks and ships working code** (2/2 deployed, spec1's 8 scenarios pass on the real Casdoor). The value is not in "choosing fewer bricks".

## Where the harness's value really is (measured)

1. **The brief.** Raw agents silently chose (52-week repetition 3/3; no half-day; no real login 7/7). The brief loop turns the prompt into the spec that fixes this — it is the difference between the raw and spec columns.
2. **A blocking test-strength gate.** 91 % vs a median of 55 % without; 8 of 9 agent test suites are green yet under the harness's threshold.
3. **Enforced decisions and a priced platform.** Fitness, D3 and the catalog check caught what both change-request agents did; none of the 9 CIs had such a check.
4. **Evidence on the real platform** (16 scenarios, witness 11/11), not just unit tests.

## Corrections made after the measure (and re-measured)

Two findings were turned into harness changes, each with eval cases that fail without it (`harness evals`: 35 cases, **26 / 26 rules proven**, up from 31 cases and 25 rules).

1. **Valkey was over-priced for a periodic job.** New need `scheduled-job` (`catalog/criteria.yaml`): a clock that fires a side effect with fewer than 100 units per run buys **a worker only** (decision "a scheduled job in a worker, claimed in Postgres"); a stream stays for real fan-out (`async-work`: 5 000 payslip e-mails still buy Valkey + worker — eval case). Re-measured on the same change request: the harness bill goes **13 → 11 points, equal to both agents' 11, missing nothing**.
2. **The catalog had no e-mail brick, and both agents filled the hole themselves.** New concept `gaps:` — a requirement asks for something the platform has no brick for. Not a refusal, not a purchase: the bill lists it (`! G-outbound-mail`), the decision log records it (D6 "Platform gap: the CCoE decides"), `approve spec` is refused without `--ack-gap "<who decides, by when>"` (checked: refused without, accepted with), and a guard forbids `nodemailer`, `createTransport`, `smtp://`, `mailpit`, `RCPT TO`. Run on the two agents' real change-request code: **4 violations (chg1: `nodemailer` ×2, `createTransport`, a Mailpit CI variable) and 1 (chg2: a hand-written SMTP client)**.

**PayslipRun (5 000 rows a month): measured, left to the CCoE.** Both agents used a Postgres queue (`FOR UPDATE SKIP LOCKED`, 9 points) where the platform's guidance and our rule buy a Valkey stream (13). `harness/evals/vibe/scripts/pg-queue-bench.sh` times the queue alone on the platform's Postgres: **5 000 rows claimed and completed in 6.5 s with 1 worker, 3.0 s with 4, 1.4 s with 16**, no duplicate, nothing stuck — rendering the PDFs, not the queue, is the bottleneck. So a stream buys no measurable throughput at this scale. Flipping the rule is a platform-doctrine decision (it would turn every current job case into worker-only, and Valkey would only be bought above a volume threshold such as 10 000 units a run): it is documented here with data and left to the CCoE, not decided on two samples.

## The honest answer on the demo app

Keep DeskBook (identity, S3, a written refusal, 16 scenarios, a 21 s pipeline) but demo what it proves — brief-check, verification, the priced change — not "fewer bricks".

## Limits

9 raw/spec agents + 2 change agents; same model family as the harness's builder; agents were forbidden to run anything (a real developer would run the app), so the two spec-arm apps were deployed by us once with their own pipeline (spec2's first run failed because of our own test bench — a database left by spec1 under the same name — and passed after cleaning); the spec arm received the brief **after** the harness's brief loop; PayslipRun and GearUp briefs are one sentence from `evals/cases.yaml`. Isolation was imperfect once: the DeskBook raw-prompt agent 2 wrote a copy of its `.gitlab-ci.yml` to the repository root (a relative path); it was identical to the copy in its own folder and was deleted, no other file left its sandbox.
