#!/usr/bin/env bash
# bootstrap.sh — provisions an app's core dependencies, idempotent.
#
# What the script does (read-only unless something is missing):
#   1. Creates the Postgres DB <APP> + the user <APP> with a random password
#   2. Stores the connection string under secret/<APP>/postgres
#   3. Creates the S3 bucket <APP> if it does not exist
#   4. Optionally, applies anonymous public read access on the bucket
#   5. Generates an S3 key pair SCOPED TO THE APP'S BUCKET if the store has none
#   6. Stores the S3 keys under secret/<APP>/objectstore
#   7. Optionally (LLM_VKEY=1), publishes the app's LLM virtual key in
#      secret/core/llm-vkeys (self-service) + a copy in secret/<APP>/llm
#   8. Optionally (TEMPORAL_NS=1), creates the app's Temporal namespace
#      + a copy of the coordinates in secret/<APP>/temporal
#   9. Optionally (ANALYTICS_SITE=1), creates the app's analytics website
#      + its runtime config in secret/<APP>/analytics
#
# Re-runs are harmless: every step checks the state before acting.
#
# Usage:
#   APP=myapp ./bootstrap.sh
#   APP=myapp PUBLIC_BUCKET=1 ./bootstrap.sh        # media served to the browser
#   APP=myapp LLM_VKEY=1 ./bootstrap.sh             # an agentic app
#   APP=myapp TEMPORAL_NS=1 ./bootstrap.sh          # durable workflows
#   APP=myapp ANALYTICS_SITE=1 ./bootstrap.sh       # navigation tracking
#
# ═══ NO HOST CLI IS REQUIRED ═══════════════════════════════════════════════
# The platform's services ship their own CLI. This script resolves each one as
#   a host binary that ANSWERS  →  otherwise `podman exec <container>`
# so a bare machine can bootstrap an app. `bao`, `mc` and `temporal` on the host
# are comfort, never prerequisites. Only `podman` and `openssl` are required
# (+ `curl` and `python3` for ANALYTICS_SITE=1).
#
# ⚠ A binary being on the PATH is NOT proof that it works: a workstation set up
#   before the OpenBao swap may carry a `vault` that is itself a
#   `podman exec vault.internal …` shim pointing at a container that no longer
#   exists under that name. So each candidate is PROBED, not merely detected.
#
# Overrides (rare — the defaults point at the core in dev):
#   BAO_ADDR=http://localhost:8200        BAO_TOKEN=root-dev-token
#   BAO_CONTAINER=openbao.internal
#   S3_URL=http://localhost:9000          S3_CONTAINER=s3
#   POSTGRES_CONTAINER=postgres.internal
#   POSTGRES_ROOT_USER=postgres           POSTGRES_ROOT_PASSWORD=postgres-dev-password
#   TEMPORAL_CONTAINER=temporal.internal  TEMPORAL_ADDRESS=localhost:7233
#   CORE_PLATFORM=../core-platform        ANALYTICS_DOMAIN=localhost

set -euo pipefail

# Where the core platform checkout lives, for the steps delegated to its
# scripts (analytics). Same convention as the README's `cd ../core-platform`.
CORE_PLATFORM="${CORE_PLATFORM:-$(cd "$(dirname "$0")" && pwd)/../core-platform}"

: "${APP:?APP has to be set (e.g. APP=myapp ./bootstrap.sh)}"

# --- The default contexts (aligned on the core in dev) --------------------
BAO_ADDR="${BAO_ADDR:-${VAULT_ADDR:-http://localhost:8200}}"
BAO_TOKEN="${BAO_TOKEN:-${VAULT_TOKEN:-root-dev-token}}"
BAO_CONTAINER="${BAO_CONTAINER:-openbao.internal}"
S3_URL="${S3_URL:-http://localhost:9000}"
S3_CONTAINER="${S3_CONTAINER:-s3}"
S3_MASTER="${S3_MASTER:-localhost:9333}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgres.internal}"
POSTGRES_ROOT_USER="${POSTGRES_ROOT_USER:-postgres}"
POSTGRES_ROOT_PASSWORD="${POSTGRES_ROOT_PASSWORD:-postgres-dev-password}"
TEMPORAL_CONTAINER="${TEMPORAL_CONTAINER:-temporal.internal}"
TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
TEMPORAL_RETENTION="${TEMPORAL_RETENTION:-168h}"
export BAO_ADDR BAO_TOKEN

# --- Checks that the strict-minimum CLIs are there ------------------------
for bin in podman openssl; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "[bootstrap] ERROR: '$bin' not found in PATH" >&2
    exit 1
  }
done

# --- The secret store -------------------------------------------------------
# The resolver below is the CANONICAL one, copied verbatim from
# core-platform/lib/secrets.sh between the snip markers — an app repo is
# standalone, so this is the one copy a symlink cannot remove.
# Keep the two blocks identical: edit lib/secrets.sh, then copy its marked
# block over this one.
# --8<-- [start:bao]
# _bao_resolve — picks the first candidate that ACTUALLY ANSWERS, memoised in
# _BAO_MODE (the probe costs one call; the scripts then call bao in a loop).
#
# ⚠ TWO TRAPS, both met for real on a workshop machine:
#
#   1. `command -v bao` matches the SHELL FUNCTION `bao` defined below and
#      resolves to itself → infinite recursion. Hence `type -P`, which only ever
#      looks at executables in PATH and returns their absolute path.
#
#   2. A binary being ON THE PATH does not mean it WORKS. Workstations set up
#      before the OpenBao swap carry a `~/.local/bin/vault` that is itself a
#      `podman exec vault.internal vault …` shim — `vault.internal` is now only a
#      NETWORK ALIAS, not a container name, so that shim fails on every call.
#      Trusting PATH would pick it and every script would die.
#
# So we PROBE rather than detect: each candidate gets one `status`, the first
# that answers wins. Self-healing, and it costs one call.
_BAO_MODE=""
_bao_probe() {  # <mode> — true if this mode answers
  case "$1" in
    host:*)
      BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" \
      VAULT_ADDR="$BAO_ADDR" VAULT_TOKEN="$BAO_TOKEN" \
        "${1#host:}" status >/dev/null 2>&1
      ;;
    exec)
      podman container exists "$BAO_CONTAINER" 2>/dev/null \
        && podman exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$BAO_TOKEN" \
             "$BAO_CONTAINER" bao status >/dev/null 2>&1
      ;;
  esac
}

_bao_resolve() {
  [ -n "$_BAO_MODE" ] && return 0
  local candidates=() bin
  if [ -n "${BAO_BIN:-}" ]; then
    candidates+=("host:$(type -P "$BAO_BIN" 2>/dev/null || echo "$BAO_BIN")")
  else
    for name in bao vault; do
      bin="$(type -P "$name" 2>/dev/null || true)"
      [ -n "$bin" ] && candidates+=("host:$bin")
    done
  fi
  candidates+=("exec")

  local c
  for c in "${candidates[@]}"; do
    if _bao_probe "$c"; then _BAO_MODE="$c"; return 0; fi
  done

  echo "[secrets] ✗ no secrets CLI answers on $BAO_ADDR." >&2
  echo "          Tried: ${candidates[*]}" >&2
  echo "          Start the core (gitlab-ci-local --force-shell-executor), or set" >&2
  echo "          BAO_CONTAINER / BAO_ADDR if your stack is not the default one." >&2
  return 1
}

# bao <args...> — the CLI, wherever it lives.
bao() {
  _bao_resolve || return 1
  case "$_BAO_MODE" in
    host:*)
      BAO_ADDR="$BAO_ADDR" BAO_TOKEN="$BAO_TOKEN" \
      VAULT_ADDR="$BAO_ADDR" VAULT_TOKEN="$BAO_TOKEN" \
        "${_BAO_MODE#host:}" "$@"
      ;;
    exec)
      # Inside the container the server is on the loopback — never $BAO_ADDR,
      # which is the HOST's view (localhost:8200 there means the container itself).
      podman exec \
        -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$BAO_TOKEN" \
        -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN="$BAO_TOKEN" \
        "$BAO_CONTAINER" bao "$@"
      ;;
  esac
}
# --8<-- [end:bao]

# --- The object store: admin operations go through the container's shell ---
# Creating a bucket is plain S3; creating a SCOPED credential is an admin
# operation whose shape is store-specific (SeaweedFS: `weed shell s3.configure`).
# Going through the container is what removes the host-CLI prerequisite.
s3_shell() {
  podman exec -i "$S3_CONTAINER" sh -c "echo '$*' | weed shell -master=$S3_MASTER" 2>&1
}

# --- Temporal: same pattern -------------------------------------------------
# ⚠ The frontend binds to the CONTAINER'S IP, never 127.0.0.1 — hence
#   `$(hostname -i)` in the exec branch. That is the classic trap.
tctl() {
  local bin; bin="$(type -P temporal 2>/dev/null || true)"
  if [ -n "$bin" ] && "$bin" operator cluster health --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1; then
    "$bin" "$@" --address "$TEMPORAL_ADDRESS"
  else
    podman exec "$TEMPORAL_CONTAINER" sh -c \
      "temporal $(printf '%q ' "$@") --address \$(hostname -i):7233"
  fi
}

echo "[bootstrap] app=$APP — provisioning the core dependencies"

# --- 1 + 2. Postgres : DB + user + password + the secret store -------------
psql_root() {
  podman exec -e PGPASSWORD="$POSTGRES_ROOT_PASSWORD" \
    "$POSTGRES_CONTAINER" psql -U "$POSTGRES_ROOT_USER" "$@"
}

if bao kv get -field=password "secret/$APP/postgres" >/dev/null 2>&1; then
  echo "  ✓ the Postgres DB of $APP is already provisioned (secret/$APP/postgres)"
else
  echo "  → creating the DB $APP + the user $APP + a random password + storing it"
  pg_password="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-24)"

  # CREATE DATABASE / CREATE USER are not idempotent — check first.
  if ! psql_root -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$APP'" | grep -q 1; then
    psql_root -d postgres -c "CREATE DATABASE \"$APP\"" >/dev/null
  fi
  if ! psql_root -d postgres -tAc "SELECT 1 FROM pg_user WHERE usename = '$APP'" | grep -q 1; then
    psql_root -d postgres -c "CREATE USER \"$APP\" WITH PASSWORD '$pg_password'" >/dev/null
  else
    psql_root -d postgres -c "ALTER USER \"$APP\" WITH PASSWORD '$pg_password'" >/dev/null
  fi
  psql_root -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE \"$APP\" TO \"$APP\"" >/dev/null
  # Postgres 15+: an explicit grant on the public schema in the target DB
  psql_root -d "$APP" -c "GRANT ALL ON SCHEMA public TO \"$APP\"" >/dev/null

  bao kv put "secret/$APP/postgres" \
    host=postgres.internal \
    port=5432 \
    database="$APP" \
    user="$APP" \
    password="$pg_password" >/dev/null
fi

# --- 3. The S3 bucket -------------------------------------------------------
# `s3.bucket.list` prints "  <name>\tsize:0\t…" — the name is field 1, never the
# whole line.
if s3_shell "s3.bucket.list" | awk -v b="$APP" '$1 == b { f = 1 } END { exit !f }'; then
  echo "  ✓ the bucket $APP already exists"
else
  echo "  → creating the bucket $APP"
  s3_shell "s3.bucket.create -name=$APP" >/dev/null
fi

# --- 4. Public read access on the bucket (optional) ------------------------
# The `anonymous` identity is granted Read on THIS bucket only. Every other
# bucket stays closed — granting anonymous read is per bucket, never global.
if [ "${PUBLIC_BUCKET:-0}" = "1" ]; then
  echo "  → enabling public read access on $APP"
  s3_shell "s3.configure -user=anonymous -buckets=$APP -actions=Read -apply" >/dev/null
fi

# --- 5 + 6. The S3 keys, SCOPED to the app's bucket ------------------------
# A real improvement over the old MinIO service account, which inherited the
# ROOT user's rights: this identity gets `Access Denied` on any other bucket.
# ⚠ TWO TRAPS, both cost a debugging session:
#   1. The secret key must be >= 8 characters — the S3 clients (mc, aws-cli)
#      refuse anything shorter before even sending the request.
#   2. Pass BARE actions (`-actions=Read,Write,…`) alongside `-buckets=<b>`.
#      SeaweedFS then stores `Read:<b>` — a BUCKET-level grant. Qualifying the
#      action yourself (`-actions=Read:<b>`) stores `Read:<b>:<b>`, where the
#      third segment is an OBJECT PREFIX: the identity is then denied on the
#      bucket root and can only touch keys under `<b>/`.
if bao kv get -field=access_key "secret/$APP/objectstore" >/dev/null 2>&1; then
  echo "  ✓ the S3 keys of $APP are already provisioned (secret/$APP/objectstore)"
else
  echo "  → generating the S3 keys scoped to the bucket $APP + storing them"
  access_key="$(openssl rand -hex 10)"
  secret_key="$(openssl rand -base64 30 | tr -d '=+/' | cut -c1-32)"

  s3_shell "s3.configure -access_key=$access_key -secret_key=$secret_key -user=$APP \
-buckets=$APP -actions=Read,Write,List,Tagging -apply" >/dev/null

  # `endpoint` is the HOST/browser view (localhost:9000). A container reaches the
  # store through S3_ENDPOINT (host.containers.internal:9000, set in the compose).
  bao kv put "secret/$APP/objectstore" \
    endpoint="$S3_URL" \
    bucket="$APP" \
    access_key="$access_key" \
    secret_key="$secret_key" >/dev/null
fi

# --- 7. The LLM virtual key (agentic apps — self-service) ---------
# The app publishes ITS vkey in the shared map secret/core/llm-vkeys (the field =
# the app's name); the llm.internal gateway generates its consumer at the next
# `core-platform/apisix/seed-and-deploy.sh` (the seed-llm-gateway job). The vkey
# is also copied into secret/<APP>/llm for the runtime read by the workers.
if [ "${LLM_VKEY:-0}" = "1" ]; then
  if bao kv get -field="$APP" secret/core/llm-vkeys >/dev/null 2>&1; then
    echo "  ✓ the LLM vkey of $APP is already published (secret/core/llm-vkeys)"
    llm_vkey="$(bao kv get -field="$APP" secret/core/llm-vkeys)"
  else
    echo "  → generating the LLM vkey + a self-service publication (secret/core/llm-vkeys)"
    llm_vkey="$(openssl rand -hex 24)"
    bao kv patch secret/core/llm-vkeys "$APP=$llm_vkey" >/dev/null 2>&1 \
      || bao kv put secret/core/llm-vkeys "$APP=$llm_vkey" >/dev/null
    echo "    ⚠ re-run core-platform/apisix/seed-and-deploy.sh (or the"
    echo "      seed-llm-gateway job) to regenerate the APISIX consumers."
  fi
  if ! bao kv get -field=virtual_key "secret/$APP/llm" >/dev/null 2>&1; then
    bao kv put "secret/$APP/llm" \
      virtual_key="$llm_vkey" \
      base_url="http://llm.internal:9080/v1" >/dev/null
  fi
fi

# --- 8. The Temporal namespace (durable orchestration) --------------
# One namespace per app is the isolation contract: task queues, workflow ids,
# retention and search attributes are namespaced. The platform creates none —
# the app creates its own, exactly as it creates its DB and its bucket.
if [ "${TEMPORAL_NS:-0}" = "1" ]; then
  if tctl operator namespace describe -n "$APP" >/dev/null 2>&1; then
    echo "  ✓ the Temporal namespace '$APP' already exists"
  else
    echo "  → creating the Temporal namespace '$APP' (retention $TEMPORAL_RETENTION)"
    tctl operator namespace create -n "$APP" --retention "$TEMPORAL_RETENTION" >/dev/null
  fi
  bao kv put "secret/$APP/temporal" \
    address="temporal.internal:7233" \
    namespace="$APP" >/dev/null
fi

# --- 9. The analytics website (optional) ------------------------------
# One website per app is the isolation contract: its own websiteId, its own
# dashboard scope, and an event prefix so two apps never collide in a export.
# Delegated to the core script, which owns the API contract (and is idempotent).
if [ "${ANALYTICS_SITE:-0}" = "1" ]; then
  if [ -x "$CORE_PLATFORM/analytics/site-create.sh" ]; then
    echo "  → creating the analytics website '$APP'"
    "$CORE_PLATFORM/analytics/site-create.sh" "$APP" "${ANALYTICS_DOMAIN:-localhost}"
  else
    echo "  ✗ $CORE_PLATFORM/analytics/site-create.sh not found —" >&2
    echo "    set CORE_PLATFORM=/path/to/core-platform, or create the site by hand." >&2
    exit 1
  fi
fi

# --- The recap -------------------------------------------------------------
echo
echo "[bootstrap] done."
echo "  Postgres (from a container)     : postgres.internal:5432, db=$APP, user=$APP"
echo "  Secret path Postgres            : secret/$APP/postgres"
echo "  S3 endpoint (from a container)  : http://host.containers.internal:9000"
echo "  The S3 endpoint (host/browser)  : $S3_URL/$APP/<key>"
echo "  Secret path object store        : secret/$APP/objectstore"
if [ "${PUBLIC_BUCKET:-0}" = "1" ]; then
  echo "  Public read access on $APP      : enabled"
else
  echo "  Public read access on $APP      : disabled (PUBLIC_BUCKET=1 to enable)"
fi
if [ "${LLM_VKEY:-0}" = "1" ]; then
  echo "  Vkey LLM (self-service)   : secret/core/llm-vkeys[$APP] + secret/$APP/llm"
fi
if [ "${TEMPORAL_NS:-0}" = "1" ]; then
  echo "  Temporal namespace     : $APP @ temporal.internal:7233 + secret/$APP/temporal"
fi
