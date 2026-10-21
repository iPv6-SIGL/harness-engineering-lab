#!/usr/bin/env bash
# analytics/seed-and-deploy.sh — provisions the product-analytics service
# (Umami) and (re)starts its container with the secrets in the environment.
#
# Idempotent. Called by core-platform/.gitlab-ci.yml (the seed-analytics job),
# also usable by hand:  ./analytics/seed-and-deploy.sh
#
# ═══ WHAT IT DOES ═══════════════════════════════════════════════════════════
#   1. creates the `umami` Postgres DB + user (idempotent, psql through the
#      container — no host CLI);
#   2. generates (or reads back) APP_SECRET and TWO_FACTOR_ENCRYPTION_KEY;
#   3. publishes everything in secret/core/analytics — the ONE place humans and
#      scripts read the backoffice credentials from;
#   4. recreates the umami container with those secrets in the env — the same
#      pattern as idp/ and apisix/seed-and-deploy.sh;
#   5. rotates the SHIPPED DEFAULT PASSWORD (admin/umami) on the first boot and
#      stores the new one, then logs in and caches an API token for
#      analytics/site-create.sh.
#
# ⚠ Umami ships a well-known default account (admin / umami). Step 5 is not
#   cosmetic: until it runs, anyone who can reach 9400 is an admin. It is
#   idempotent — once the password is the stored one, the rotation is skipped.
#
# The admin password DEFAULTS to a readable dev value (analytics-dev-password)
# — a workshop needs it on a slide. Override: UMAMI_ADMIN_PASSWORD=….
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/

. lib/secrets.sh

bao_wait 30 || { echo "[analytics] ✗ the secret store is unreachable on $BAO_ADDR" >&2; exit 1; }

psql_root() {
  podman exec -e PGPASSWORD=postgres-dev-password postgres.internal psql -U postgres "$@"
}

UMAMI_URL="${UMAMI_URL:-http://localhost:9400}"

# --- 1. the umami database (idempotent) --------------------------------------
PG_PASS="$(bao kv get -field=pg_password secret/core/analytics 2>/dev/null || true)"
if [ -z "$PG_PASS" ]; then
  PG_PASS="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-24)"
fi
if ! psql_root -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'umami'" | grep -q 1; then
  psql_root -d postgres -c 'CREATE DATABASE "umami"' >/dev/null
  echo "[analytics] database umami created"
fi
if ! psql_root -d postgres -tAc "SELECT 1 FROM pg_user WHERE usename = 'umami'" | grep -q 1; then
  psql_root -d postgres -c "CREATE USER \"umami\" WITH PASSWORD '$PG_PASS'" >/dev/null
else
  psql_root -d postgres -c "ALTER USER \"umami\" WITH PASSWORD '$PG_PASS'" >/dev/null
fi
psql_root -d postgres -c 'GRANT ALL PRIVILEGES ON DATABASE "umami" TO "umami"' >/dev/null
psql_root -d umami    -c 'GRANT ALL ON SCHEMA public TO "umami"' >/dev/null

# --- 2. the service secrets ---------------------------------------------------
APP_SECRET="$(bao kv get -field=app_secret secret/core/analytics 2>/dev/null || true)"
[ -n "$APP_SECRET" ] || APP_SECRET="$(openssl rand -hex 32)"
TFA_KEY="$(bao kv get -field=two_factor_key secret/core/analytics 2>/dev/null || true)"
[ -n "$TFA_KEY" ] || TFA_KEY="$(openssl rand -hex 32)"

ADMIN_USER="admin"
ADMIN_PASS="$(bao kv get -field=admin_password secret/core/analytics 2>/dev/null || true)"
[ -n "$ADMIN_PASS" ] || ADMIN_PASS="${UMAMI_ADMIN_PASSWORD:-analytics-dev-password}"

# --- 3. publish before deploying (the container reads these from the env) -----
bao kv put secret/core/analytics \
  url="$UMAMI_URL" \
  internal_url="http://analytics.internal:3000" \
  pg_password="$PG_PASS" \
  app_secret="$APP_SECRET" \
  two_factor_key="$TFA_KEY" \
  admin_user="$ADMIN_USER" \
  admin_password="$ADMIN_PASS" >/dev/null
echo "[analytics] secret/core/analytics published"

# --- 4. (re)deploy ------------------------------------------------------------
export UMAMI_PG_PASSWORD="$PG_PASS" UMAMI_APP_SECRET="$APP_SECRET" UMAMI_2FA_KEY="$TFA_KEY"
# --no-deps: recreate ONLY this service (podman-compose ≥ 1.1, Podman 5). The
# 1.0.x shipped with Podman 4 ignores the flag and also stops/restarts
# postgres.internal — which is why seed-analytics waits for seed-idp in the CI.
podman compose -p core up -d --no-deps --force-recreate umami

# --- 5. wait for health, then rotate the shipped default ----------------------
echo -n "[analytics] waiting for the API"
for _ in $(seq 1 60); do
  if curl -sf "$UMAMI_URL/api/heartbeat" >/dev/null 2>&1; then break; fi
  echo -n "."; sleep 2
done
echo

login() {  # $1 = password → prints the token, or nothing
  curl -sf -X POST "$UMAMI_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$ADMIN_USER\",\"password\":$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" \
    2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true
}

TOKEN="$(login "$ADMIN_PASS")"
if [ -z "$TOKEN" ]; then
  # Not on the stored password yet → try the shipped default and rotate.
  TOKEN="$(login "umami")"
  if [ -z "$TOKEN" ]; then
    echo "[analytics] ✗ cannot authenticate with either the stored password or the" >&2
    echo "             shipped default. Someone changed it by hand — reset it in the" >&2
    echo "             UI ($UMAMI_URL) and rerun, or purge the umami DB." >&2
    exit 1
  fi
  # /api/auth/verify is a POST (it returns the authenticated user), and the
  # password is changed through POST /api/users/<id> with just {password}
  # (min 8 chars) — there is no dedicated /password route in v3.
  USER_ID="$(curl -sf -X POST -H "Authorization: Bearer $TOKEN" "$UMAMI_URL/api/auth/verify" \
             | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
  curl -sf -X POST "$UMAMI_URL/api/users/$USER_ID" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"password\":$(printf '%s' "$ADMIN_PASS" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" >/dev/null
  echo "[analytics] ✔ the shipped default password was rotated"
  TOKEN="$(login "$ADMIN_PASS")"
fi

bao kv patch secret/core/analytics api_token="$TOKEN" >/dev/null 2>&1 \
  || bao kv put secret/core/analytics \
       url="$UMAMI_URL" internal_url="http://analytics.internal:3000" \
       pg_password="$PG_PASS" app_secret="$APP_SECRET" two_factor_key="$TFA_KEY" \
       admin_user="$ADMIN_USER" admin_password="$ADMIN_PASS" api_token="$TOKEN" >/dev/null

echo "[analytics] ✔ ready — $UMAMI_URL (admin: $ADMIN_USER, password in secret/core/analytics)"
