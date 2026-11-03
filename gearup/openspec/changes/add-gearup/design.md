# Design — add-gearup

Written by the decide step of run `run-20261103-112305` from the capability graph (6 sources). Each decision names the requirement it serves, what it rejected and the compute it avoids; its guard lives in `.harness/guards/<id>.yaml`.

## The bill

| Brick | Points | Paid by | Need |
|---|---|---|---|
| openbao | 1 | scaffold | — |
| dozzle | 1 | scaffold | — |
| registry | 1 | scaffold | — |
| postgres | 1 | scaffold | — |
| frontend | 1 | scaffold | — |
| api | 1 | scaffold | — |
| **temporal** | 2* | R1, R2, R3 | durable-wait |
| **casdoor** | 2 | R1, R2, R3, R4 | identity |
| **temporal-ui** | 1* | R1, R2, R3 | durable-wait |
| **worker** | 2* | R1, R2, R3 | durable-wait |

**Total: 13 / 17** (process budget). \* price assumed.

## Decisions

### D1 · Identity through casdoor (OIDC)

- **Serves** R1, R2, R3, R4
- **Chose** one OIDC client, one group per persona, roles checked server-side
- **Rejected** a users table in the app (a second user store)
- **Avoids** password storage, reset flows, a login screen to secure
- **Revisit when** a persona must act without a company account (visitors, partners) — that is a new persona and a new group, not a users table
- **Scales by** sessions live in Postgres, so any API replica serves any user; the IdP is shared and scales with the platform
- **Guard** `.harness/guards/D1.yaml` · witness: secret-read present

### D2 · A Temporal workflow per long-running process

- **Serves** R1, R2, R3
- **Chose** one namespace, timers and signals, compensation as activities
- **Rejected** status columns polled by a cron
- **Avoids** lost state on restart, hand-written retry and reminder loops
- **Revisit when** the waits disappear from the requirements — a workflow that never waits is a function call
- **Scales by** add worker replicas on the task queue; workflow history is the platform's, versioned on every deploy
- **Guard** `.harness/guards/D2.yaml`

### D3 · Nothing unasked

- **Serves** *
- **Chose** stay out: valkey, s3, apisix, umami — no requirement emits a signal for them
- **Rejected** valkey "in case", s3 "in case", apisix "in case", umami "in case"
- **Avoids** 5 ops points: [object Object], a stream + consumer group to watch, memory; 1 bucket + 1 scoped key; 1 virtual key, a token budget, provider quirks, evals; 1 website, a beacon proxied first-party, a privacy register entry
- **Revisit when** valkey: fan out N independent units to competing consumers; s3: binary files or objects above 1 MB; apisix: the app generates, classifies, summarises or embeds text; umami: a usage metric is named in the brief
- **Scales by** nothing to scale: what does not run costs nothing
- **Guard** `.harness/guards/D3.yaml` · witness: valkey-keys absent, llm-consumer absent, analytics-site absent

## Refused, with the reason

| Brick | Points | Why it stays out |
|---|---|---|
| valkey | 2 | no requirement emits a signal for it |
| s3 | 1 | no requirement emits a signal for it |
| apisix | 1 | no requirement emits a signal for it |
| umami | 1 | no requirement emits a signal for it |

5 points not spent: fewer containers, secrets and alerts to run for the life of the app.
