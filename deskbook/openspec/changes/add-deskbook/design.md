# Design — add-deskbook

Written by the decide step of run `run-20261030-115323` from the capability graph (6 sources). Each decision names the requirement it serves, what it rejected and the compute it avoids; its guard lives in `.harness/guards/<id>.yaml`.

## The bill

| Brick | Points | Paid by | Need |
|---|---|---|---|
| openbao | 1 | scaffold | — |
| dozzle | 1 | scaffold | — |
| registry | 1 | scaffold | — |
| postgres | 1 | scaffold | — |
| frontend | 1 | scaffold | — |
| api | 1 | scaffold | — |
| **s3** | 1 | R4 | blob-storage |
| **casdoor** | 2 | R1, R2, R3, R4, R5 | identity |

**Total: 9 / 10** (crud budget). \* price assumed.

## Decisions

### D1 · Identity through casdoor (OIDC)

- **Serves** R1, R2, R3, R4, R5
- **Chose** one OIDC client, one group per persona, roles checked server-side
- **Rejected** a users table in the app (a second user store)
- **Avoids** password storage, reset flows, a login screen to secure
- **Guard** `.harness/guards/D1.yaml` · witness: secret-read present

### D2 · Files in the app's S3 bucket, private

- **Serves** R4
- **Chose** the app's bucket with its scoped key, streamed through the API
- **Rejected** files as Postgres blobs; PUBLIC_BUCKET=1 (no requirement serves files to anonymous users)
- **Avoids** bloated backups and DB reads on every page
- **Guard** `.harness/guards/D2.yaml` · witness: s3-anonymous denied

### D3 · No Valkey, no worker, no Temporal

- **Serves** R5
- **Chose** a recurrence with no side effect is a rule evaluated when someone reads it — no clock has to fire; "repeat every week until a date" is data read at query time, not a process that waits
- **Rejected** a scheduler job per recurrence; one workflow per recurring item
- **Avoids** a worker container, a stream to watch, a scheduler to keep alive; a Temporal namespace, a worker, a UI to operate
- **Guard** `.harness/guards/D3.yaml` · witness: valkey-keys absent, temporal-namespace absent

### D4 · Nothing unasked

- **Serves** *
- **Chose** stay out: apisix, umami — no requirement emits a signal for them
- **Rejected** apisix "in case", umami "in case"
- **Avoids** 2 ops points: 1 virtual key, a token budget, provider quirks, evals; 1 website, a beacon proxied first-party, a privacy register entry
- **Guard** `.harness/guards/D4.yaml` · witness: llm-consumer absent, analytics-site absent

## Refused, with the reason

| Brick | Points | Why it stays out |
|---|---|---|
| valkey | 2 | R5: a recurrence with no side effect is a rule evaluated when someone reads it — no clock has to fire (rule `V-read-time-recurrence`) |
| apisix | 1 | no requirement emits a signal for it |
| temporal | 2 | R5: "repeat every week until a date" is data read at query time, not a process that waits (rule `V-read-time-recurrence-only`) |
| temporal-ui | 1 | R5: "repeat every week until a date" is data read at query time, not a process that waits (rule `V-read-time-recurrence-only`) |
| umami | 1 | the crud profile predicts it, but no requirement cites it (product-metrics: the brief names a usage metric someone will read) |
| worker | 2 | R5: a recurrence with no side effect is a rule evaluated when someone reads it — no clock has to fire (rule `V-read-time-recurrence`) |

9 points not spent: fewer containers, secrets and alerts to run for the life of the app.

## Against the family profile

- profile predicted umami; not bought — the requirement decides, not the matrix
- bought s3 outside the crud profile, paid by R4
