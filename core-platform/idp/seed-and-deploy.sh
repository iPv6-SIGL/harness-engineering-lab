#!/usr/bin/env bash
# idp/seed-and-deploy.sh — provisions the identity provider (Casdoor) and
# (re)starts its container with the secrets in the environment.
#
# Idempotent. Called by core-platform/.gitlab-ci.yml (the seed-idp job), also
# usable by hand:  ./idp/seed-and-deploy.sh
#
# ═══ WHAT IT DOES ═══════════════════════════════════════════════════════════
#   1. creates the `casdoor` Postgres DB + user (idempotent, psql through the
#      container — no host CLI), like authentik did before it;
#   2. (re)deploys the ONE casdoor container with those secrets in the env;
#   3. on the FIRST boot only: logs in with the image's well-known seed account
#      (org `built-in`, user `admin`, password `123` — Casdoor ships no
#      override hook for it), immediately rotates that password to a generated
#      one, then mints the platform's own application ("platform-bootstrap")
#      whose client_id/client_secret every other idp/*.sh script authenticates
#      with from then on;
#   4. publishes everything in secret/core/idp — the ONE place humans and
#      scripts read it from.
#
# ═══ API SHAPES — VERIFIED against the pinned tag v1.858.0 ══════════════════
#   · admin calls authenticate EITHER with a session cookie from /api/login
#     (used here, first boot) OR with HTTP Basic client_id:client_secret of an
#     application (used by the other idp/*.sh) — both tested, both work.
#     `?username=&password=` as query params is NOT a Casdoor mechanism: it
#     returns a beego error page.
#   · /api/set-password takes FORM-ENCODED `userOwner`/`userName`/`newPassword`.
#     Sent as JSON it answers `The user: / doesn't exist` and changes nothing —
#     which, on the rotation below, would silently leave the well-known `123`
#     in place. Do not "simplify" it back to JSON.
#   · the bootstrap application is owned by `admin`, so it reads back as
#     `?id=admin/platform-bootstrap` — not `built-in/...`.
#
# ⚠ The image's `all-in-one` variant was tried and rejected: it bundles MariaDB
#   and has no sqlite3 driver compiled in, so `driverName: sqlite3` panics at
#   boot. Hence the plain image on the shared Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/

. lib/secrets.sh

bao_wait 30 || { echo "[idp] ✗ the secret store is unreachable on $BAO_ADDR" >&2; exit 1; }

psql_root() {
  podman exec -e PGPASSWORD=postgres-dev-password postgres.internal psql -U postgres "$@"
}

IDP_URL="http://localhost:9300"
INTERNAL_URL="http://idp.internal:8000"
COOKIE="$(mktemp)"; trap 'rm -f "$COOKIE"' EXIT

# --- 1. the casdoor database (idempotent) -----------------------------------
PG_PASS="$(bao kv get -field=pg_password secret/core/idp 2>/dev/null || true)"
[ -n "$PG_PASS" ] || PG_PASS="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-24)"

if ! psql_root -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'casdoor'" | grep -q 1; then
  psql_root -d postgres -c 'CREATE DATABASE "casdoor"' >/dev/null
  echo "[idp] database casdoor created"
fi
if ! psql_root -d postgres -tAc "SELECT 1 FROM pg_user WHERE usename = 'casdoor'" | grep -q 1; then
  psql_root -d postgres -c "CREATE USER \"casdoor\" WITH PASSWORD '$PG_PASS'" >/dev/null
else
  psql_root -d postgres -c "ALTER USER \"casdoor\" WITH PASSWORD '$PG_PASS'" >/dev/null
fi
psql_root -d postgres -c 'GRANT ALL PRIVILEGES ON DATABASE "casdoor" TO "casdoor"' >/dev/null
psql_root -d casdoor  -c 'GRANT ALL ON SCHEMA public TO "casdoor"' >/dev/null

# --- 2. deploy ---------------------------------------------------------------
ADMIN_PASS="$(bao kv get -field=admin_password secret/core/idp 2>/dev/null || true)"
[ -n "$ADMIN_PASS" ] || ADMIN_PASS="${CASDOOR_BOOTSTRAP_ADMIN_PASSWORD:-casdoor-dev-password}"

export CASDOOR_PG_PASSWORD="$PG_PASS" CASDOOR_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASS"
# --no-deps: recreate ONLY this service (podman-compose ≥ 1.1, Podman 5). The
# 1.0.x shipped with Podman 4 ignores the flag and also stops/restarts
# postgres.internal — which is why seed-analytics waits for seed-idp in the CI.
podman compose -p core up -d --no-deps --force-recreate casdoor
echo "[idp] casdoor deployed — UI http://localhost:9300"

echo -n "[idp] waiting for the API"
for _ in $(seq 1 36); do
  curl -sf -o /dev/null "$IDP_URL/api/get-account" 2>/dev/null && break
  echo -n "."; sleep 5
done
echo
curl -sf -o /dev/null "$IDP_URL/api/get-account" \
  || { echo "[idp] ✗ casdoor never answered on $IDP_URL" >&2; exit 1; }

# --- 3. first boot: rotate the seed admin, mint the bootstrap application ----
# ⚠ Casdoor answers HTTP 200 on a FAILED call too — the outcome is the JSON
#   `status` ("ok" | "error"), so `curl -f` proves nothing. And the cookie jar is
#   never empty (curl always writes its `# Netscape` header), so it cannot prove
#   a login either. Every call below is judged on `status` — trusting the HTTP
#   code used to skip the rotation silently and leave the shipped `123` in place.
api_ok() {  # stdin = a Casdoor JSON answer → 0 if status == "ok"
  python3 -c 'import json,sys
try: sys.exit(0 if json.load(sys.stdin).get("status") == "ok" else 1)
except Exception: sys.exit(1)'
}

login() {  # $1 = password → 0 if the session was opened
  : > "$COOKIE"
  curl -s -c "$COOKIE" -X POST "$IDP_URL/api/login" \
    -H 'Content-Type: application/json' \
    -d "{\"application\":\"app-built-in\",\"organization\":\"built-in\",\"username\":\"admin\",\"password\":$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"type\":\"login\",\"autoSignin\":true}" \
    | api_ok
}

CLIENT_ID="$(bao kv get -field=client_id secret/core/idp 2>/dev/null || true)"
CLIENT_SECRET="$(bao kv get -field=client_secret secret/core/idp 2>/dev/null || true)"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "[idp] first boot — rotating the seed admin and minting the bootstrap application"

  if ! login "$ADMIN_PASS"; then
    login "123" || { echo "[idp] ✗ neither the stored password nor the shipped default authenticates" >&2; exit 1; }
    # FORM-ENCODED — see the header. JSON here silently leaves `123` in place.
    curl -s -b "$COOKIE" -X POST "$IDP_URL/api/set-password" \
      --data-urlencode "userOwner=built-in" \
      --data-urlencode "userName=admin" \
      --data-urlencode "newPassword=$ADMIN_PASS" | api_ok \
      || { echo "[idp] ✗ could not rotate the seed admin password" >&2; exit 1; }
    echo "[idp] ✔ the shipped default password (123) was rotated"
    login "$ADMIN_PASS" || { echo "[idp] ✗ the rotated password does not authenticate" >&2; exit 1; }
  fi

  curl -s -b "$COOKIE" -X POST "$IDP_URL/api/add-application" \
    -H 'Content-Type: application/json' \
    -d '{"owner":"admin","name":"platform-bootstrap","displayName":"platform-bootstrap",
         "organization":"built-in","grantTypes":["client_credentials","authorization_code"],
         "redirectUris":[]}' | api_ok \
    || echo "[idp] (the bootstrap application already exists — reused)"

  READBACK="$(curl -sf -b "$COOKIE" "$IDP_URL/api/get-application?id=admin/platform-bootstrap")"
  CLIENT_ID="$(python3 -c "import sys,json;print((json.load(sys.stdin).get('data') or {}).get('clientId',''))" <<<"$READBACK")"
  CLIENT_SECRET="$(python3 -c "import sys,json;print((json.load(sys.stdin).get('data') or {}).get('clientSecret',''))" <<<"$READBACK")"
  [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] \
    || { echo "[idp] ✗ could not read back the bootstrap client_id/client_secret" >&2; exit 1; }
fi

# --- 4. publish --------------------------------------------------------------
bao kv put secret/core/idp \
  url="$IDP_URL" \
  internal_url="$INTERNAL_URL" \
  pg_password="$PG_PASS" \
  admin_org="built-in" \
  admin_user="admin" \
  admin_password="$ADMIN_PASS" \
  client_id="$CLIENT_ID" \
  client_secret="$CLIENT_SECRET" >/dev/null
echo "[idp] ✔ ready — credentials in secret/core/idp"
