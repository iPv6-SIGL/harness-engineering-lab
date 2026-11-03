# Design — add-photoshelf

Written by the decide step of run `run-20261103-112137` from the capability graph (6 sources). Each decision names the requirement it serves, what it rejected and the compute it avoids; its guard lives in `.harness/guards/<id>.yaml`.

## The bill

| Brick | Points | Paid by | Need |
|---|---|---|---|
| openbao | 1 | scaffold | — |
| dozzle | 1 | scaffold | — |
| registry | 1 | scaffold | — |
| postgres | 1 | scaffold | — |
| frontend | 1 | scaffold | — |
| api | 1 | scaffold | — |
| **valkey** | 2* | R1, R2 | async-work |
| **s3** | 1 | R1, R2, R3 | blob-storage |
| **casdoor** | 2 | R1, R2, R3, R4 | identity |
| **worker** | 2* | R1, R2 | async-work |

**Total: 13 / 17** (media budget). \* price assumed.

## Decisions

### D1 · Identity through casdoor (OIDC)

- **Serves** R1, R2, R3, R4
- **Chose** one OIDC client, one group per persona, roles checked server-side
- **Rejected** a users table in the app (a second user store)
- **Avoids** password storage, reset flows, a login screen to secure
- **Revisit when** a persona must act without a company account (visitors, partners) — that is a new persona and a new group, not a users table
- **Scales by** sessions live in Postgres, so any API replica serves any user; the IdP is shared and scales with the platform
- **Guard** `.harness/guards/D1.yaml` · witness: secret-read present

### D2 · Files in the app's S3 bucket

- **Serves** R1, R2, R3
- **Chose** the app's bucket with its scoped key, streamed through the API
- **Rejected** files as Postgres blobs
- **Avoids** bloated backups and DB reads on every page
- **Revisit when** a requirement serves the files to anonymous browsers (public-media → PUBLIC_BUCKET=1), or the files need processing (async-work)
- **Scales by** the object store holds the bytes, the API only streams them; past ~50 requests/s of downloads, serve signed URLs instead of streaming
- **Guard** `.harness/guards/D2.yaml`

### D3 · Anonymous read on the app's bucket only

- **Serves** R2
- **Chose** PUBLIC_BUCKET=1 — browsers load the files directly
- **Rejected** proxying every image through the API
- **Avoids** an API round-trip and its CPU per image view
- **Revisit when** a file in the bucket must stay private — split it into a second, private prefix with its own decision
- **Scales by** browsers hit the object store directly; the API is out of the read path
- **Guard** `.harness/guards/D3.yaml`

### D4 · Background work on a Valkey stream drained by a worker

- **Serves** R1, R2
- **Chose** a consumer group of competing workers, the API answers 202
- **Rejected** doing the work inside the request
- **Avoids** requests above the 350 ms budget, timeouts under load
- **Revisit when** a job must wait for a person or a timer beyond 30 s (durable-wait → Temporal), or the backlog never drains
- **Scales by** add worker replicas to the consumer group; each message is processed once
- **Guard** `.harness/guards/D4.yaml`

### D5 · Nothing unasked

- **Serves** *
- **Chose** stay out: apisix, temporal, umami — no requirement emits a signal for them
- **Rejected** apisix "in case", temporal "in case", umami "in case"
- **Avoids** 4 ops points: 1 virtual key, a token budget, provider quirks, evals; 1 namespace, workflow versioning on every deploy, runs to watch; 1 website, a beacon proxied first-party, a privacy register entry
- **Revisit when** apisix: the app generates, classifies, summarises or embeds text; temporal: a step waits, retries for hours, compensates, or waits for a human; umami: a usage metric is named in the brief
- **Scales by** nothing to scale: what does not run costs nothing
- **Guard** `.harness/guards/D5.yaml` · witness: llm-consumer absent, temporal-namespace absent, analytics-site absent

## Refused, with the reason

| Brick | Points | Why it stays out |
|---|---|---|
| apisix | 1 | no requirement emits a signal for it |
| temporal | 2 | no requirement emits a signal for it |
| temporal-ui | 1 | no requirement emits a signal for it |
| umami | 1 | no requirement emits a signal for it |

5 points not spent: fewer containers, secrets and alerts to run for the life of the app.

## Against the family profile

- bought casdoor outside the media profile, paid by R1, R2, R3, R4
