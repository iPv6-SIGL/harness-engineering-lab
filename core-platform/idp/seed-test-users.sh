#!/usr/bin/env bash
# idp/seed-test-users.sh <app> [persona-slug…] — provisions the app's TEST
# IDENTITIES on the platform IdP. IDEMPOTENT.
#
#     ./idp/seed-test-users.sh claims-app claims-adjuster policyholder underwriter
#     ./idp/seed-test-users.sh myapp                 # no spec yet → admin, user
#
# ═══ WHY THE PLATFORM OWNS THIS ═════════════════════════════════
# Integration and e2e tests need to LOG IN. Without a sanctioned source of
# credentials, every generated app grows its own answer — usually an auth
# bypass (`/api/auth/dev-token`) that ships to production with the tests.
# This script is the sanctioned answer:
#
#   · one deterministic user per persona:  <app>-test-<persona-slug>
#   · member of the group:                 <app>-<persona-slug>   (what the
#     app maps to its own roles — the same groups real users will get)
#   · credentials in secret/<app>/test-users — the ONLY place the e2e journey
#     reads its login from. Never the platform admin, never a real person.
#
# ═══ PERSONAS, NOT PLACEHOLDERS ══════════════════════════════
# Once the app has a product spec, the roles passed here should be its
# own personas (kebab-case slugs of the spec's persona names), not generic
# `admin`/`user` — a group per business persona is what actually exercises the
# app's ACL model. `admin`/`user` remains the fallback ONLY for a manual
# onboarding run before any spec exists.
#
# ═══ ONE SHARED PASSWORD, ON PURPOSE ═════════════════════════
# Every identity this script provisions for an app shares ONE unsecured
# password — generated once per app, not once per persona. This is
# deliberate, not an oversight: the security boundary that matters is the
# server-side role check, not the entropy of a throwaway dev
# identity's password. A demoer or a reviewer needs to hop between personas
# without juggling N secrets. Document every persona + this password + its
# main usage scenario in the app's README — that pairing is what
# makes the identities usable by someone who is not the person who seeded them.
#
# Idempotent: existing groups/users are reused by name; the shared password is
# read back from the store when present (stable across runs), and re-applied
# to EVERY persona on every run — so the IdP and the store cannot drift apart.
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/

. lib/secrets.sh

APP="${1:-}"; shift || true
ROLES=("${@:-}"); [ -n "${ROLES[0]:-}" ] || ROLES=(admin user)
[ -n "$APP" ] || { echo "usage: $0 <app> [persona-slug…]" >&2; exit 1; }
case "$APP" in [a-z][a-z0-9-]*) ;; *) echo "✗ app name '$APP' invalid: [a-z][a-z0-9-]*" >&2; exit 1;; esac

bao_wait 30 || { echo "[test-users] ✗ the secret store is unreachable" >&2; exit 1; }
IDP_URL="${IDP_URL:-$(bao kv get -field=url secret/core/idp 2>/dev/null || true)}"
CLIENT_ID="${IDP_CLIENT_ID:-$(bao kv get -field=client_id secret/core/idp 2>/dev/null || true)}"
CLIENT_SECRET="${IDP_CLIENT_SECRET:-$(bao kv get -field=client_secret secret/core/idp 2>/dev/null || true)}"
[ -n "$IDP_URL" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] \
  || { echo "[test-users] ✗ secret/core/idp is missing — run ./idp/seed-and-deploy.sh first" >&2; exit 1; }

ak() { curl -sf -u "$CLIENT_ID:$CLIENT_SECRET" -H "Content-Type: application/json" "$@"; }
jsonget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2" <<<"$1"; }

# Casdoor answers HTTP 200 on a failure too — judge the JSON `status`, never the
# HTTP code. get-users needs an admin identity, so it proves the bootstrap
# client authenticates (get-account answers "ok"-shaped errors for an app).
api_ok() { python3 -c 'import json,sys
try: sys.exit(0 if json.load(sys.stdin).get("status") == "ok" else 1)
except Exception: sys.exit(1)'; }
ak "$IDP_URL/api/get-users?owner=built-in" | api_ok \
  || { echo "[test-users] ✗ the bootstrap client_id/client_secret was rejected (still booting? purged?)" >&2; exit 1; }

# --- the shared password: stable across runs, generated once per app --------
SHARED_PASS="$(bao kv get -field=shared_password "secret/$APP/test-users" 2>/dev/null || true)"
[ -n "$SHARED_PASS" ] || SHARED_PASS="demo-only-$(openssl rand -hex 4)"

FIELDS=("shared_password=$SHARED_PASS")
for role in "${ROLES[@]}"; do
  case "$role" in [a-z][a-z0-9-]*) ;; *) echo "✗ persona slug '$role' invalid" >&2; exit 1;; esac
  GROUP="$APP-$role"; USERNAME="$APP-test-$role"

  # --- the group: reuse by id, else create ----------------------------------
  FOUND_G="$(ak "$IDP_URL/api/get-group?id=built-in/$GROUP" || echo '{"data":null}')"
  if [ "$(jsonget "$FOUND_G" "d.get('data')")" = "None" ]; then
    ak -X POST "$IDP_URL/api/add-group" -d "{
      \"owner\": \"built-in\", \"name\": \"$GROUP\", \"displayName\": \"$APP / $role\"
    }" >/dev/null
    echo "[test-users] group '$GROUP' created"
  fi

  # --- the user: reuse by id, else create (with the group set inline) ------
  FOUND_U="$(ak "$IDP_URL/api/get-user?id=built-in/$USERNAME" || echo '{"data":null}')"
  if [ "$(jsonget "$FOUND_U" "d.get('data')")" = "None" ]; then
    ak -X POST "$IDP_URL/api/add-user" -d "{
      \"owner\": \"built-in\", \"name\": \"$USERNAME\", \"displayName\": \"$APP test $role\",
      \"email\": \"test-$role@$APP.local\", \"groups\": [\"built-in/$GROUP\"],
      \"password\": \"$SHARED_PASS\"
    }" >/dev/null
    echo "[test-users] user '$USERNAME' created (group $GROUP)"
  else
    echo "[test-users] user '$USERNAME' already exists"
  fi

  # --- the password: ALWAYS re-applied, so the IdP cannot drift from the store
  # FORM-ENCODED, not JSON: /api/set-password reads form values. Sent as JSON
  # it answers `The user: / doesn't exist` and silently changes nothing — so
  # this re-application would be a no-op and the IdP could drift from the
  # store without anyone noticing. Verified against v1.858.0.
  curl -sf -u "$CLIENT_ID:$CLIENT_SECRET" -X POST "$IDP_URL/api/set-password" \
     --data-urlencode "userOwner=built-in" \
     --data-urlencode "userName=$USERNAME" \
     --data-urlencode "newPassword=$SHARED_PASS" | api_ok \
     || { echo "[test-users] ✗ could not set the password for $USERNAME" >&2; exit 1; }
  FIELDS+=("${role}_username=$USERNAME")
done

bao kv put "secret/$APP/test-users" "${FIELDS[@]}" >/dev/null
echo "[test-users] secret/$APP/test-users written (${ROLES[*]}) — one shared password for all"
echo "[test-users] the e2e journey reads its login THERE — never the platform admin, never a baked-in bypass"
echo "[test-users] README: list each persona + this password + its usage scenario"
