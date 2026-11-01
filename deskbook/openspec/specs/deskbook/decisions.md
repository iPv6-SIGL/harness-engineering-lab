# deskbook — decision log

Every decision in force, newest change last. A decision is reopened only by a new change whose requirement matches its **Revisit when** — then the harness re-plans and a human approves the new bill.

## 2026-10-30 · add-deskbook · run-20261030-122642

Status **accepted** — merge approved by e2e-runner (stand-in for the human reviewer). Bill: **crud**, 9 / 10 ops points; bought s3 (R4), casdoor (R1, R2, R3, R4, R5).

### D1 · Identity through casdoor (OIDC)

- **Serves** R1, R2, R3, R4, R5 · **bricks** casdoor
- **Chose** one OIDC client, one group per persona, roles checked server-side
- **Rejected** a users table in the app (a second user store)
- **Avoids** password storage, reset flows, a login screen to secure
- **Revisit when** a persona must act without a company account (visitors, partners) — that is a new persona and a new group, not a users table
- **Scales by** sessions live in Postgres, so any API replica serves any user; the IdP is shared and scales with the platform
- **Enforced by** `.harness/guards/D1.yaml` (hook · fitness · witness)

### D2 · Files in the app's S3 bucket, private

- **Serves** R4 · **bricks** s3
- **Chose** the app's bucket with its scoped key, streamed through the API
- **Rejected** files as Postgres blobs; PUBLIC_BUCKET=1 (no requirement serves files to anonymous users)
- **Avoids** bloated backups and DB reads on every page
- **Revisit when** a requirement serves the files to anonymous browsers (public-media → PUBLIC_BUCKET=1), or the files need processing (async-work)
- **Scales by** the object store holds the bytes, the API only streams them; past ~50 requests/s of downloads, serve signed URLs instead of streaming
- **Enforced by** `.harness/guards/D2.yaml` (hook · fitness · witness)

### D3 · No Valkey, no worker, no Temporal

- **Serves** R5 · **bricks** valkey, worker, temporal, temporal-ui
- **Chose** a recurrence with no side effect is a rule evaluated when someone reads it — no clock has to fire; "repeat every week until a date" is data read at query time, not a process that waits
- **Rejected** a scheduler job per recurrence; one workflow per recurring item
- **Avoids** a worker container, a stream to watch, a scheduler to keep alive; a Temporal namespace, a worker, a UI to operate
- **Revisit when** the recurrence gains a side effect (send, e-mail, notify, charge) or one action fans out ≥ 100 units — then buy valkey + worker with that R-id; a step must wait for a person or a timer beyond 30 s, survive a restart, or compensate — then buy temporal with that R-id
- **Scales by** the rule is evaluated at read time in SQL + domain code: cost grows with the rows read, not with a clock; no process waits, so nothing to replicate or version
- **Enforced by** `.harness/guards/D3.yaml` (hook · fitness · witness)

### D4 · Nothing unasked

- **Serves** * · **bricks** apisix, umami
- **Chose** stay out: apisix, umami — no requirement emits a signal for them
- **Rejected** apisix "in case", umami "in case"
- **Avoids** 2 ops points: 1 virtual key, a token budget, provider quirks, evals; 1 website, a beacon proxied first-party, a privacy register entry
- **Revisit when** apisix: the app generates, classifies, summarises or embeds text; umami: a usage metric is named in the brief
- **Scales by** nothing to scale: what does not run costs nothing
- **Enforced by** `.harness/guards/D4.yaml` (hook · fitness · witness)
