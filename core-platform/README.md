# Core Platform

The cross-cutting bricks provided by the platform team (CCoE), shared between
every business app that joins the `core-network` network.

The platform is **agnostic**: it knows nothing about the apps that consume it.
Every application team manages its own lifecycle (images, secrets, deployment)
by leaning on the services exposed here. No script in this folder names an app.

> **The CCoE rules are not provided — writing them is your job.** This
> platform runs as is; what it does NOT ship is the doctrine that says what an
> app must be (the stack, the patterns, the MUST/SHOULD rules) and the harness
> that makes a coding agent follow it. Every rule you write states why the
> pattern is a good one AND which compute it avoids.

**The app-side contracts** the platform already implies:

| Contract | Subject |
|---|---|
| Network | `.internal` DNS on `core-network` |
| Ports | A per-app block of 10 within `8000-8999`, canonical offsets (see [The ports convention](#the-ports-convention)) |
| Observability | Logs on `stdout`/`stderr` aggregated by Dozzle |
| Secrets | Self-service via OpenBao, namespace `secret/<app>/` |
| Database | Postgres self-service, 1 DB + 1 user per app |
| Cache / queue | Valkey, naming by the `<app>:` prefix, a structure per use case |
| Registry | Self-service, absolute paths `localhost:5000/<app>/<service>:<tag>` |
| Object storage | S3 modelled as an external service, 1 bucket + 1 scoped key per app |
| Durable orchestration | Temporal, 1 namespace per app |
| Identity | Casdoor (OIDC), 1 self-service client per app |
| Pipelines | `gitlab-ci-local` serverless, variable `ACTION` |
| Health checks | `/health` liveness + `/ready` readiness |
| Graceful shutdown | SIGTERM, drain, exit < 10 s |
| Airgap | A dedicated upstream container for external upstream flows |
| API errors + CORS + rate-limit | A uniform envelope, CORS dev/prod, `@fastify/rate-limit` |
| Product analytics | Umami, 1 self-service website per app → `secret/<app>/analytics` |

## The services exposed

Official images, rootless friendly, single-node (dev/workshop).

| Service | Image | Licence | Host port | Internal DNS | Role |
|---|---|---|---|---|---|
| `valkey` | `docker.io/valkey/valkey:9-alpine` | BSD-3-Clause | 6379 | `valkey.internal` *(+ `redis.internal`)* | Shared state + pub/sub + streams |
| `openbao` | `docker.io/openbao/openbao:2.6` | MPL-2.0 | 8200 | `openbao.internal` *(+ `vault.internal`)* | The secrets store (dev mode, token `root-dev-token`) |
| `dozzle` | `docker.io/amir20/dozzle:latest` | MIT | 9999 | `dozzle.internal` | Real-time log visualisation |
| `registry` | `docker.io/library/registry:2` | Apache-2.0 | 5000 | `registry.internal` | A local OCI registry (dev, no auth) |
| `postgres` | `docker.io/pgvector/pgvector:pg17` | PostgreSQL | 5432 | `postgres.internal` | A shared relational database (1 DB + user per app) + Temporal's persistence — ships the `vector` extension for RAG, opt-in per app |
| `s3` | `docker.io/chrislusf/seaweedfs:4.44` | Apache-2.0 | 9000 + 9001 | — *(modelled as external, see "The object store" below)* | S3-compatible object storage (media, assets) |
| `apisix` | `docker.io/apache/apisix:3.17.0-debian` | Apache-2.0 | 9080 | `llm.internal` | An OpenAI-compatible LLM gateway — model aliases, a virtual key + a token budget per app |
| `temporal` | `docker.io/temporalio/auto-setup:1.29` | MIT | 7233 | `temporal.internal` | Durable orchestration — long workflows, timers, retries, compensation |
| `temporal-ui` | `docker.io/temporalio/ui:2.53.3` | MIT | 9233 | `temporal-ui.internal` | The Temporal operator surface — run history, activity I/O, replay |
| `casdoor` | `docker.io/casbin/casdoor:v1.858.0` | Apache-2.0 | 9300 | `casdoor.internal` *(+ `idp.internal`)* | The identity provider: OIDC, one self-service OIDC client per app — one container (no worker), persistence on the shared Postgres |
| `umami` | `ghcr.io/umami-software/umami:3.3.1` | MIT | 9400 | `analytics.internal` | Product analytics — navigation tracking + value events, one website per app |

### Why these images and not the "usual" ones

The platform's rule is **100 % OSI-approved open source**, and no *open core* —
no project whose community edition is the deliberately crippled half of a paid
product. Four services had to move; the compatibility aliases make the swaps
invisible to the apps.

| Was | Now | The reason |
|---|---|---|
| `redis:7-alpine` | **`valkey/valkey:9-alpine`** | Redis 7.4 left OSI licensing (RSALv2 / SSPLv1). Valkey is the Linux Foundation fork, BSD-3-Clause, wire- and command-compatible — its image even ships `redis-cli`. The alias **`redis.internal` is kept**: no app changes. |
| `hashicorp/vault:1.18` | **`openbao/openbao:2.6`** | Vault 1.15 moved to BUSL-1.1 — source-available, not open source. OpenBao is the Linux Foundation fork, MPL-2.0, with the same HTTP API; it still accepts the `X-Vault-Token` header, so existing SDKs keep working. The alias **`vault.internal` is kept**. |
| `minio/minio:latest` | **`chrislusf/seaweedfs:4.44`** | MinIO ships under AGPL-3.0, but the community edition had its console and admin surface stripped in favour of the proprietary AIStor — open core in practice. SeaweedFS is Apache-2.0 with a complete S3 gateway. The **host ports are unchanged** (9000 API / 9001 browser). |
| `ghcr.io/goauthentik/server` (authentik) | **`casbin/casdoor`** | authentik's MIT core only passed the bar under a **reviewed exception** (a separately-licensed `enterprise/` directory) and cost 2 containers plus a Valkey coupling. Casdoor is Apache-2.0 with nothing gated at all — no exception needed — and runs as **one** container, on the shared Postgres like everything else, with no Valkey and no worker. (The `all-in-one` variant was tried and rejected: it bundles MariaDB and has no sqlite3 driver, so it panics at boot.) The alias **`idp.internal` is kept**. |

Kept as they are, already fully open source: PostgreSQL, APISIX (ASF), the
`distribution` registry, Dozzle. Added: **Temporal** (MIT) and **Umami** (MIT).

> **Migrating an existing workstation.** The old container *names*
> (`redis.internal`, `vault.internal`, `minio`) no longer exist in the compose
> file, so `podman compose down` would leave them behind as orphans still
> holding 6379 / 8200 / 9000. The `migrate-legacy-services` job of the pipeline
> removes them on the next `start` — nothing to do by hand.
>
> ⚠ If your workstation carries a `~/.local/bin/vault` that is itself a
> `podman exec vault.internal vault …` shim, it now points at a container name
> that is gone. The platform scripts detect that (they **probe** each candidate
> CLI, they do not merely look at `$PATH`) and fall back to the container. But
> your own by-hand `vault …` calls will fail — replace the shim with
> `podman exec openbao.internal bao`, or just delete it.

## The ports convention

The platform keeps **out of `8000-8999`**: that range belongs to the apps. Each
app takes **one block of 10 contiguous ports** (`8000-8009`, `8010-8019`, …) and
places its services at **canonical offsets**, so that anyone can guess where an
app's API answers without reading its compose:

| Offset | Service | Template variable |
|---|---|---|
| +0 | the frontend (nginx) | `FRONTEND_PORT` |
| +1 | the REST API | `API_PORT` |
| +8 | the worker's `/health` + `/ready` | `WORKER_HEALTH_PORT` |

The other offsets are free for the app's own needs. The block is set **once**, in
the `variables:` of the app's `.gitlab-ci.yml` (`templates/gitlab-ci.yml`); the
app's `podman-compose.yml` reads it through `${…}`. Two apps on the same
workstation = two different blocks.

## The administration URLs

| | URL | Auth |
|---|---|---|
| OpenBao UI | http://localhost:8200 | Token `root-dev-token` |
| Dozzle | http://localhost:9999 | — |
| Registry catalog | http://localhost:5000/v2/_catalog | — (dev, no auth) |
| S3 browser (filer) | http://localhost:9001 | — (dev) |
| S3 API | http://localhost:9000 | `platformadmin` / `platformadmin-dev-password`, or a per-app key |
| Temporal UI | http://localhost:9233 | — |
| IdP (Casdoor) | http://localhost:9300 | `admin` / `secret/core/idp` (`casdoor-dev-password` by default) |
| Analytics (Umami) | http://localhost:9400 | `admin` / `secret/core/analytics` (`analytics-dev-password` by default; the shipped `umami` password is rotated at seed) |
| Temporal gRPC | `localhost:7233` | — (dev, no mTLS) |
| Postgres (CLI) | `psql -h localhost -U postgres` | `postgres-dev-password` *(no native UI — use an external DBeaver/pgAdmin if needed)* |
| LLM gateway | `http://localhost:9080/v1/chat/completions` | a per-app virtual key in `Authorization: Bearer <vkey>` (the real provider key injected from the store, never exposed) |

## The prerequisites

See [`requirements.md`](./requirements.md) — the essentials:

- **Podman** ≥ 4 (Windows through WSL2 **or** native Linux, as you prefer)
- `podman compose` (a docker-compose v3 compatible extension)
- **`gitlab-ci-local`** to run the pipeline in serverless mode (Node ≥ 20)
- `python3` (the LLM gateway's seeding) and `openssl`

**No secrets / S3 / Temporal CLI is required on the host.** Every platform
script resolves its CLI as *a host binary that answers* → otherwise
`podman exec <container>`. A bare machine runs the platform. `bao`, `mc` and
`temporal` on the workstation are comfort for a human, never prerequisites.

Any other host configuration (the user's Podman socket, the `insecure = true`
exception for the HTTP registry, creating the network) is taken care of by the
pipeline itself — no manual setup.

**Check your machine in one command**:

```bash
./preflight.sh
```

The script modifies nothing — it checks the prerequisites (the
platform + the Bun app-builder toolchain; Rust optional for the waivers) and
exits with an error if an item is missing. The installation doc:
[`requirements.md`](./requirements.md); Bun: https://bun.sh.

## The lifecycle

The GitLab CI pipeline ([`.gitlab-ci.yml`](./.gitlab-ci.yml)) covers the
platform's **3 lifecycle actions** through an `ACTION` variable
(the default: `start`):

| Action | Command | Effect |
|---|---|---|
| **start** (the default) | `gitlab-ci-local --force-shell-executor` | Configures the host, creates the network, removes the legacy containers, starts the containers, seeds S3/Temporal/IdP/LLM gateway/analytics, checks the health |
| **stop** | `gitlab-ci-local --force-shell-executor --variable ACTION=stop` | Stops the containers, **keeps the volumes and the network** (a hot restart is possible) |
| **purge** | `gitlab-ci-local --force-shell-executor --variable ACTION=purge` | Destroys everything: the containers + the volumes + the network (a fresh state) |

The pipeline is run **with no GitLab Runner and no GitLab server** thanks to
`gitlab-ci-local`. The `--force-shell-executor` flag runs the jobs in the host's
shell (and not in job containers) so that they have access to the user's
rootless Podman.

### The pipeline's structure

| Stage | Job | When | Role |
|---|---|---|---|
| `prepare` | `prepare-host` | **always** (no `rules:`) | The user's Podman socket + the `insecure = true` exception for HTTP registries |
| `core-platform-start` | `prepare-network` | `ACTION=start` | Creates the `core-network` network |
| `core-platform-start` | `migrate-legacy-services` | `ACTION=start` | Removes the pre-swap `redis.internal` / `vault.internal` / `minio` containers |
| `core-platform-start` | `compose-up` | `ACTION=start` | `podman compose -p core up -d` |
| `core-platform-start` | `seed-object-store` | `ACTION=start` (needs `compose-up`) | Creates the `platform-admin` S3 identity — **a security step**: SeaweedFS serves everything anonymously until the first identity exists |
| `core-platform-start` | `seed-temporal` | `ACTION=start` (needs `compose-up`) | Waits for the cluster, guarantees the `default` namespace |
| `core-platform-start` | `seed-idp` | `ACTION=start` (needs `compose-up`) | Rotates the seed admin, mints the bootstrap client, publishes the secrets, recreates the IdP container |
| `core-platform-start` | `seed-llm-gateway` | `ACTION=start` (needs `compose-up`) | Generates `apisix.yaml` from the store (the consumers + the per-app budgets) — tolerates an empty store (0 consumers, the apps publish their vkey self-service) |
| `core-platform-start` | `seed-analytics` | `ACTION=start` (needs `compose-up` + `seed-idp` — both restart Postgres under podman-compose 1.0.x) | Creates the Umami DB, publishes `secret/core/analytics`, rotates the shipped `admin/umami` password, caches an API token — until it runs, port 9400 is an open admin |
| `core-platform-start` | `verify` | `ACTION=start` (needs the 5 seeds) | Polls the healthchecks + prints the endpoints |
| `core-platform-stop` | `stop` | `ACTION=stop` | `podman compose -p core down` (keeps the volumes/network) |
| `core-platform-purge` | `purge` | `ACTION=purge` | `podman compose down --volumes` + the legacy leftovers + removing the network |

`prepare-host` is deliberately without `rules:` and therefore runs
systematically — it guarantees the host is in the right state whatever the
action requested. The other jobs are **strict** on the value of `ACTION`; they
only fire for their own mode.

That pattern (an action variable + strict `rules`) is exactly the one the
business apps take up in their own `.gitlab-ci.yml` (a template ready to copy
in `templates/gitlab-ci.yml`).

## The files in this folder

| File | Role |
|---|---|
| `README.md` (this doc) | The CCoE view — operating the platform |
| [`requirements.md`](./requirements.md) | The minimum installation prerequisites |
| [`preflight.sh`](./preflight.sh) | A read-only check of the prerequisites |
| [`onboard-app.sh`](./onboard-app.sh) | **Generic** app onboarding: `./onboard-app.sh <app>` — the vkey, the budget, the LLM config, the Temporal namespace, a gateway re-seed. Idempotent, names no app |
| [`audit-trail.sh`](./audit-trail.sh) | Reports on the audit device and reads the trail (one readable line per access; `--raw` for the JSONL) |
| [`.gitlab-ci.yml`](./.gitlab-ci.yml) | Pipeline start / stop / purge |
| [`podman-compose.yml`](./podman-compose.yml) | The definition of the 11 services |
| [`lib/`](./lib/) | The host-independent access layers: `secrets.sh` (bao), `objectstore.sh` (S3), `temporal.sh` (the `temporal` CLI, `tctl` wrapper). Sourced by every script here; the apps' `bootstrap.sh` copies the `secrets.sh` resolver verbatim and re-implements the S3/Temporal helpers |
| [`apisix/`](./apisix/) | The `llm.internal` LLM gateway: `config.yaml` (standalone), `routes.openai.yaml` + `routes.anthropic.yaml` (the per-provider routes/aliases — committed), `seed-and-deploy.sh` (picks the variant according to `LLM_PROVIDER`, generates the consumers from the store → the runtime `apisix.yaml`, gitignored) |
| [`openbao/`](./openbao/) | `audit.hcl` — the audit device, **declared**: OpenBao 2.6 removed enabling one through the API, so the trail is on from the first boot rather than from whenever someone runs a script |
| [`objectstore/`](./objectstore/) | `seed-admin.sh` — creates the `platform-admin` S3 identity and publishes its credentials |
| [`analytics/`](./analytics/) | `seed-and-deploy.sh` (the Umami DB + secrets + admin rotation + API token → `secret/core/analytics`) · `site-create.sh <app> [domain]` (a self-service website per app → `secret/<app>/analytics`) |
| [`temporal/`](./temporal/) | `seed-namespaces.sh` (the `default` namespace) · `ns-create.sh <app>` (self-service per-app namespace) |
| [`idp/`](./idp/) | `seed-and-deploy.sh` (the bootstrap client + secrets + deploy) · `onboard-oidc.sh <app> <redirect_uri>` (a self-service OIDC client per app → `secret/<app>/oidc`) · `seed-test-users.sh <app> [persona-slug…]` (deterministic test identities, one shared password → `secret/<app>/test-users`) |
| [`templates/`](./templates/) | The canonical platform templates (see the dedicated section below) |

## The host-independent access layers (`lib/`)

Three tiny shims, one per stateful service, all built on the same rule:

```
a host binary that ANSWERS  →  otherwise  podman exec <container>
```

They exist because of two traps that each cost a debugging session, and both are
documented at the top of the files concerned:

1. **`command -v bao` matches the shell function `bao`** defined right below it,
   and resolves to itself → infinite recursion. Hence `type -P`, which only ever
   looks at executables in `$PATH`.
2. **A binary being on the `$PATH` is not proof that it works.** A workstation
   set up before the swap carries a `vault` that is itself a
   `podman exec vault.internal …` shim pointing at a container that no longer
   exists under that name. So each candidate is **probed** with one cheap
   `status` call; the first that answers wins.

A third trap lives in `lib/temporal.sh`: the Temporal frontend binds to the
**container's IP**, never `127.0.0.1` (we deliberately do not force
`BIND_ON_IP=0.0.0.0`, which would make ringpop advertise `0.0.0.0` — harmless
single-node, a trap as soon as you scale). Inside the container the right
address is therefore `$(hostname -i):7233`.

## The canonical templates (`templates/`)

The files every app copies at bootstrap. Which ones are mandatory is for your
CCoE rules to decide:

| Template | Role |
|---|---|
| `core.theme.css` | A Tailwind v4 + daisyUI 5 theme (the `core` + `core-dark` themes), the design/UX tokens |
| `nginx.conf` | The canonical nginx config of the static frontend |
| `biome.json` | Biome lint + format (a single config, zero debate) |
| `README.app.md` | A canonical app README skeleton — the 14 sections |
| `p99.ts` | A p99 latency measurement helper, app-side |
| `bootstrap.sh` · `gitlab-ci.yml` · `podman-compose.yml` · `gitignore` | The app lifecycle scaffolds: provisioning, pipeline, compose, exclusions |

## The object store

**SeaweedFS**, modelled as an **external service** (cloud-S3 style): no
`.internal` alias; apps and browsers consume the same HTTP endpoint through the
published port (`host.containers.internal:9000` from a container,
`localhost:9000` from the host).

- **The store starts OPEN.** SeaweedFS serves everything anonymously as long as
  no S3 identity exists. Creating the first identity is what switches the
  gateway into authenticated mode — that is why `objectstore/seed-admin.sh` is a
  pipeline job and not a convenience, and why it runs immediately after
  `compose-up`.
- **One bucket + one SCOPED key per app**, created by the app's own
  `bootstrap.sh`. The identity is granted `Read,Write,List,Tagging` on *its*
  bucket and gets `Access Denied` on every other one — strictly better than the
  root-inheriting service account the platform used to hand out.
- **Public read is per bucket**, never global: `PUBLIC_BUCKET=1 ./bootstrap.sh`
  grants the `anonymous` identity `Read` on that one bucket.

> ⚠ **The action-scoping trap.** Pass **bare** actions
> (`-actions=Read,Write,List,Tagging`) alongside `-buckets=<b>`; SeaweedFS then
> stores `Read:<b>` — a bucket-level grant. Qualifying the action yourself
> (`-actions=Read:<b>`) stores `Read:<b>:<b>`, whose third segment is an **object
> prefix**: the identity is then denied on the bucket root and can only touch
> keys under `<b>/`. Both forms were verified; only the bare form is correct.

## Durable orchestration — `temporal.internal`

**Temporal** (MIT) complements the Valkey Stream, it does **not** replace
it. The rule of thumb:

| Need | Brick |
|---|---|
| Fan out N independent units of work to competing consumers | **Valkey Stream** + consumer group |
| A process that must **survive a restart**, wait for hours/days, retry per step with backoff, compensate on failure, or wait for a human | **Temporal** |

- **Persistence rides on the shared Postgres** — the `auto-setup` image creates
  the `temporal` and `temporal_visibility` databases on the first boot.
  That is the **dev** image: production splits `temporalio/server` from an
  explicit schema migration.
- **One namespace per app** is the isolation contract (task queues, workflow ids,
  retention and search attributes are namespaced). The platform creates **none**:
  an app creates its own from its `bootstrap.sh` (`TEMPORAL_NS=1`), or through
  `./temporal/ns-create.sh <app>`.
- The coordinates land in `secret/<app>/temporal` (`address`, `namespace`) —
  written by `bootstrap.sh` / `onboard-app.sh`, **not** by `ns-create.sh`, which
  only creates the namespace.

## The identity provider — `idp.internal`

**Casdoor**, one container on the shared Postgres — no Valkey, no worker
coupling. Apps that authenticate users consume it over standard OIDC instead
of rolling their own user store — users and groups live in ONE place.

- **One self-service OIDC client per app**:
  ```bash
  ./idp/onboard-oidc.sh myapp http://localhost:8501/auth/callback
  ```
  Idempotent — it creates (or reuses) the application and writes
  `secret/myapp/oidc` (`issuer`, `public_issuer`, `client_id`, `client_secret`,
  `authorize_endpoint`, `token_endpoint`, `userinfo_endpoint`, `jwks_uri`,
  `redirect_uri`). Rerun with a new redirect URI to update it. Discovery:
  `http://localhost:9300/.well-known/openid-configuration` (Casdoor's OIDC
  endpoints are global to the instance, not one issuer path per app).
- **Test identities per app**: `./idp/seed-test-users.sh myapp <persona-slug…>`
  — one deterministic user per **business persona** (`myapp-test-<persona>`,
  member of the `myapp-<persona>` group), all sharing ONE unsecured password,
  in `secret/myapp/test-users`. That is what integration/e2e tests log in
  with — never the platform admin, never a baked-in bypass. The personas
  should be the app's own `spec` personas, and the README documents
  each one's username + the shared password + its usage scenario.
- **The admin** is `admin` (org `built-in`); every credential (its password,
  the bootstrap client_id/client_secret the onboarding scripts use) lives in
  `secret/core/idp` — seeded by `idp/seed-and-deploy.sh`, rerun after every
  `ACTION=purge`.
- **First boot is fast** — a plain Go process start, no schema migration to
  wait for (unlike authentik's ~2-minute Django migration + blueprint import).
- ⚠ The seed admin's `built-in`/`admin`/`123` password is rotated on the
  **first boot only**, right there in `idp/seed-and-deploy.sh`; changing it
  later on a live instance goes through the UI/API.

## The `llm.internal` LLM gateway

**APISIX** in standalone mode (YAML, no etcd) exposes an **OpenAI-compatible**
API on `llm.internal:9080`. The apps never call a provider directly:

- **Model aliases** — the app sends `model: "task:cheap|quality|vision|reasoning"`, the
  gateway maps it onto the real model. `task:embed` (`/v1/embeddings`)
  is the same mechanism for retrieval — a different alias, a different model.
- **A virtual key per app (self-service)** — `Authorization: Bearer <vkey>`
  (key-auth); a token budget (`ai-rate-limiting`) → an overrun = a **429**. An
  app **publishes its vkey** in `secret/core/llm-vkeys` (the field = the app's name);
  `seed-and-deploy.sh` **generates the APISIX consumers from the whole map** and
  produces the runtime `apisix.yaml` from the active provider's routes. **No
  manual edit** of the gateway to onboard an app. Revocation = remove the field.
  An empty store (0 vkeys) is a **valid state** of an agnostic platform: the seed
  then generates 0 consumers and the gateway starts anyway.
- **A token budget PER APP** — the map `secret/core/llm-budgets` (the field =
  the app's name, the value = tokens per 60 s window; **a default of 50000/60 s**
  if absent). For every consumer `seed-and-deploy.sh` generates an
  **`ai-rate-limiting` override** that wins over the route's limit → the
  "budget exceeded" 429 is attributable per app. Adjusting a budget =
  editing the field + rerunning the seed, without touching the YAML.
- **Secrets through the store** — the real provider key lives in
  `secret/core/<provider>`, the virtual keys in `secret/core/llm-vkeys`.
  `apisix/seed-and-deploy.sh` (launched by the pipeline) injects them; **never a
  secret in the clear in the repository** — the expected variables are documented
  through `.env.example` files committed **with no values**.

> **Supplying the provider's key** (once, or after a `purge` that empties the store):
> ```bash
> export OPENAI_API_KEY=sk-...      # seeded into the store at the next start
> # …or directly:  podman exec openbao.internal bao kv put secret/core/openai api_key=sk-...
> ```

### A switchable provider — OpenAI ⇄ Anthropic

The gateway knows how to proxy **two providers**, with the **same app-side
contract** (baseURL `llm.internal:9080/v1`, a virtual key, the `task:*` aliases,
the budget). Switching changes **no line of application code** — it is the
counter-measure when a provider is down or out of quota.

| `LLM_PROVIDER` | Routes | Secret path | Alias `task:*` |
|---|---|---|---|
| `openai` *(the default)* | `apisix/routes.openai.yaml` | `secret/core/openai` | gpt-4.1-mini · gpt-5.5 · o3 · **gpt-image-1** · **text-embedding-3-small** |
| `anthropic` | `apisix/routes.anthropic.yaml` | `secret/core/anthropic` | claude-haiku-4-5-20251001 · claude-sonnet-5 · claude-opus-5 · **text-embedding-3-small** *(via `secret/core/openai`, see below)* |

```bash
LLM_PROVIDER=anthropic ./apisix/seed-and-deploy.sh   # switch + re-seed
./apisix/seed-and-deploy.sh                          # keeps the persisted provider
```

The choice is **persisted** in `secret/core/llm-provider`: the CI job
`seed-llm-gateway` and the restarts keep it without passing the variable again.

Each variant absorbs its provider's *quirks* so that the apps do not have to know
them: on the OpenAI side, `max_tokens` → `max_completion_tokens` and the
neutralisation of `temperature` on gpt-5.x/o-series; on the Anthropic side,
`max_tokens` is **mandatory** (a default injected if absent) and the OpenAI-only
fields are stripped. That is the gateway's job, not the app's.

> ⚠️ **`task:image` exists only in openai mode** — Anthropic has no
> image-generation endpoint, so the `llm-images` route is absent from this
> variant. An app that depends on it has to stay in openai mode.

> ⚠️ **`task:embed` is the mirror case** — Anthropic has NO embeddings API at
> all, so `/v1/embeddings` always proxies OpenAI, in BOTH provider variants.
> RAG therefore needs `secret/core/openai` populated even in
> anthropic mode; `apisix/seed-and-deploy.sh` seeds it independently of
> `$LLM_PROVIDER` for exactly this reason.

> ⚠️ **An Anthropic API key ≠ a Claude Code token.** The anthropic mode expects
> an `sk-ant-api03-…` key (console.anthropic.com). A Claude Code OAuth token
> (`sk-ant-oat01-…`) is tied to the subscription and does not authenticate the
> API — it is your coding agent's credential, not the gateway's.

> ⚠️ **A trap: `apisix/apisix.yaml` deleted by hand.** That file is
> **generated** (gitignored) but it is **bind-mounted** by the compose. If it is
> deleted and then `podman compose up` is run **before** it has been
> regenerated, Podman creates a **directory** in its place — and the seed then
> fails with `apisix/apisix.yaml: Is a directory`. The remedy:
> ```bash
> podman rm -f apisix && rmdir apisix/apisix.yaml
> ./apisix/seed-and-deploy.sh          # regenerates the file THEN brings the container back up
> ```
> The rule: always run `seed-and-deploy.sh` **before** (re)bringing apisix up
> after a manual deletion of the runtime YAML.

## Onboarding an app — `onboard-app.sh`

```bash
./onboard-app.sh myapp
LLM_BUDGET=120000 ./onboard-app.sh myapp
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-api03-... ./onboard-app.sh myapp
```

It provisions **everything the platform can provision** for one app, whatever the
app is: the provider key, the virtual key (generated), the token budget, the LLM
config, the Temporal namespace, then a gateway re-seed. **Idempotent** — it does
not regenerate an already published vkey and can be rerun safely.

Not included — separate self-service steps: the OIDC client
(`idp/onboard-oidc.sh`), the test identities (`idp/seed-test-users.sh`) and the
analytics website (`analytics/site-create.sh`, or `ANALYTICS_SITE=1 ./bootstrap.sh`).

What it deliberately does **not** provision: the app's Postgres database, its S3
bucket and its non-core secrets. Those belong to the app and are created by its
own `bootstrap.sh`, from its own repository. The boundary is what keeps the
platform agnostic — the app's name is an *argument*, never a line of code here.

**To be rerun after every `ACTION=purge`** (the store is in-memory).

## Auditability

Every secret access — read/write, by whom, when — is appended to
`/openbao/logs/audit.log` (the `openbao-logs` volume, so the trail survives a
container restart even though the dev-mode secrets do not).

It is **on from the first boot**, and that is not a convenience: OpenBao 2.6
**removed the ability to enable an audit device through the API** (`cannot
enable audit device via API; use declarative, config-based audit device
management instead`), so it is declared in
[`openbao/audit.hcl`](./openbao/audit.hcl) and mounted by the compose. An audit
device you have to opt into is an audit device that is off on the day you need
it — the removal turned out to be an improvement.

```bash
./audit-trail.sh              # the last 20 accesses, one readable line each
./audit-trail.sh --follow     # a live feed
./audit-trail.sh --raw        # the JSONL, for jq or an export
```

Values are **HMAC'd** in the trail: it records who touched which path and when,
not the secret itself. An audit log you would have to protect as hard as the
store is not an audit log.

> ⚠ The HCL syntax is unforgiving and its error messages point elsewhere — the
> two wrong forms and the one right form are documented at the top of
> `openbao/audit.hcl`. Do not also pass `-config=` on the command line: the
> image already loads `/openbao/config`, and passing the file explicitly makes
> it load twice.

## The limits owned deliberately

- OpenBao runs in **dev mode** (in-memory, a public token, **never in production**)
- The registry has **no auth and no TLS** (dev only, **never in production**)
- The object store is **single-node**, with public admin credentials, no TLS (dev only)
- Postgres is **single-node**, with a public root password, no TLS, no replication (dev only)
- Casdoor runs in **HTTP, single-instance, on the shared Postgres**, with a public
  default admin password and every test identity sharing one unsecured
  password by design (a demo platform, not a bank) — in production:
  TLS, a real per-user password policy, MFA enforced
- Temporal runs from the **`auto-setup` dev image** (it migrates the schema at
  boot), single-node, **no mTLS and no auth on 7233** — production splits
  `temporalio/server` from an explicit migration and closes the frontend
- Umami runs **single-instance on the shared Postgres**, HTTP, with a public
  default admin password (dev only) — port 9400 is an open admin until
  `seed-analytics` has rotated the shipped one
- Dozzle: logs only (no metrics, no tracing) — minimally viable
- APISIX is **standalone single-node**, with a token budget per sliding window
  (no persistent cumulative quota) — a workshop, not production
- No internal TLS between the services (a workshop, not production)
- No `gitlab-ci-local` pipeline cache between runs
