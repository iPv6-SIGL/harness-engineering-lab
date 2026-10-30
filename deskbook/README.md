# deskbook

## Overview
Employees book a desk or a meeting room for a half-day; office managers open and
close rooms and upload floor plans. Built by the reconciliation harness
(`../harness`) from `../harness/briefs/deskbook.v2.yaml`: a **crud** app at
**9 / 10 ops points**.

## Getting started
```bash
bun ../harness/src/cli.ts plan ../harness/briefs/deskbook.v2.yaml --app-dir .   # the desired state
bun ../harness/src/cli.ts approve . spec --by <you>
gitlab-ci-local --force-shell-executor          # provision → gates → build → deploy → verify
bun ../harness/src/cli.ts verify-task . all     # the spec scenarios, as the personas
bun ../harness/src/cli.ts reconcile .           # mutants, platform witness, verdict
```
Frontend http://localhost:8010 · API http://localhost:8011 (port block 8010–8019).

## Design vocabulary
A plain, system-font UI with four semantic colours (free, taken, mine, closed),
light and dark. No component kit: one screen, a positioned floor plan of 44 px
buttons. Not the `core` daisyUI theme — that would buy Tailwind + a build step
for one screen (see Structuring decisions).

## Code language
en

## Tested critical paths
Each scenario of `openspec/changes/add-deskbook/specs/deskbook/spec.md` is a test
in `e2e/scenarios.test.ts`, named `<R-id> <scenario-id>`: desk taken with two
nearby suggestions, one desk per half-day, no double booking under concurrency,
SSO login, anonymous refusal, rooms closed by a manager, private floor plans,
weekly bookings until an end date and their conflicts, plus the contracts.

Test personas (`idp/seed-test-users.sh deskbook employee office-manager`):

| Username | Scenario |
|---|---|
| `deskbook-test-employee` | books desks and rooms, weekly or not |
| `deskbook-test-office-manager` | closes rooms, uploads floor plans, books too |

Shared password: `secret/deskbook/test-users` → `shared_password`.

## Performance
Every endpoint is synchronous and well under 350 ms: a booking is one
transaction with two advisory locks over a few rows. No endpoint switched to
202/polling. p99 to be measured from the API's JSON logs (`ms` field).

## Personal data register
`bookings.user_sub` + `user_name` (the IdP subject and login), purpose: show who
holds a desk; retention: the booking's last day + 90 days (not automated yet);
erasure: delete the user's bookings. `sessions`: the same two fields, 8 hours.
No analytics (no metric in the brief — Umami refused).

## External data sources
None

## Exposed interfaces
REST `/api/v1` — `GET /me`, `GET /resources?floor&day&half`, `POST /bookings`,
`PATCH /resources/:id` (manager), `PUT|GET /floors/:n/plan`. Errors:
`{error: {code, message, details?}}`. Auth: `/auth/login`, `/auth/callback`,
`/auth/logout`.

## LLM FinOps
None

## Durable workflows
None — decision D3: the weekly booking is a rule evaluated at query time
(`domain.ts` `occursOn`), not a workflow.

## Libraries outside the recommendations
None at runtime: `Bun.serve`, `Bun.SQL`, `Bun.S3Client` and WebCrypto replace a
web framework, a Postgres driver, an S3 SDK and a JWT library. Dev only:
`typescript`, `@types/bun`.

## Structuring decisions
- **D1–D4** — the decisions in force, each with what reopens it (**Revisit
  when**) and how it scales (**Scales by**), live in
  `openspec/specs/deskbook/decisions.md` once archived (the open change keeps
  them in `openspec/changes/add-deskbook/design.md` until then).
- **Stateless API** — bookings, sessions and login states are in Postgres,
  files in S3; migrations run under an advisory lock. Proven by the `C1
  stateless` scenario (a session survives a new API process). To add replicas:
  drop `container_name` on `api` in the compose (the bill re-renders it) and
  point nginx at the service name. Known limit: the rate limiter is per process
  (N replicas → N × 30 req/s); a shared one needs Valkey, which D3 refuses —
  revisit when one replica no longer carries the load.
- **No Fastify** — context: the CCoE lists `@fastify/rate-limit`; choice:
  `Bun.serve` + a 20-line token bucket; consequence: zero runtime dependency,
  one less audit surface.
- **No Vite build for the frontend** — context: the template builds with Vite;
  choice: one ES module served as is; consequence: no `build-frontend` job, no
  bundle; revisit past three screens.
- **Same-origin API** — nginx proxies `/api` and `/auth`, so CSP
  `connect-src 'self'` and the session cookie never cross an origin.

## CCoE waivers
None
