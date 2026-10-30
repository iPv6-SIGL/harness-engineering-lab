#!/usr/bin/env bash
# idp/onboard-oidc.sh <app> [redirect_uri] — self-service creation of an app's
# OIDC client on the platform IdP (Casdoor). IDEMPOTENT.
#
#     ./idp/onboard-oidc.sh myapp http://localhost:8501/auth/callback
#
# ═══ WHAT IT CREATES ════════════════════════════════════════════════════════
#   · an "application" named <app> in the `built-in` organization — Casdoor's
#     OIDC client abstraction (confidential, authorization_code grant, a
#     PKCE-capable standard flow — no implicit-consent shortcut);
#   · the app's runtime config in secret/<app>/oidc:
#         issuer, client_id, client_secret, authorize/token/userinfo/jwks
#     — the app reads THAT at boot, never the platform admin's
#     credentials.
#
# Idempotent: an existing application of the same name is reused, and
# secret/<app>/oidc is refreshed from it. Changing the redirect URI = rerun
# with the new one (the application is updated).
#
# ⚠ Unlike authentik, Casdoor's OIDC issuer is GLOBAL to the instance (one set
#   of /login/oauth/... endpoints for every application), not one issuer path
#   per app — the app is distinguished by its client_id in the auth request,
#   not by the issuer URL. Verify the exact endpoint paths below once against
#   the pinned image tag (see the header warning in seed-and-deploy.sh).
#
# ⚠ The REDIRECT URI is a positional argument, not a default: it is the app's
#   public callback and no generic value is right. The app's compose/port block
#   decides it (typically http://localhost:<api-port>/auth/callback).
#
# Uses the bootstrap client_credentials application from secret/core/idp — run
# ./idp/seed-and-deploy.sh first (the CI's seed-idp job does).
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/

. lib/secrets.sh

APP="${1:-}"; REDIRECT="${2:-}"
[ -n "$APP" ] && [ -n "$REDIRECT" ] || { echo "usage: $0 <app> <redirect_uri>" >&2; exit 1; }
case "$APP" in [a-z][a-z0-9-]*) ;; *) echo "✗ app name '$APP' invalid: [a-z][a-z0-9-]*" >&2; exit 1;; esac

bao_wait 30 || { echo "[oidc] ✗ the secret store is unreachable" >&2; exit 1; }
IDP_URL="${IDP_URL:-$(bao kv get -field=url secret/core/idp 2>/dev/null || true)}"
CLIENT_ID="${IDP_CLIENT_ID:-$(bao kv get -field=client_id secret/core/idp 2>/dev/null || true)}"
CLIENT_SECRET="${IDP_CLIENT_SECRET:-$(bao kv get -field=client_secret secret/core/idp 2>/dev/null || true)}"
[ -n "$IDP_URL" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] \
  || { echo "[oidc] ✗ secret/core/idp is missing — run ./idp/seed-and-deploy.sh first" >&2; exit 1; }

ak() { curl -sf -u "$CLIENT_ID:$CLIENT_SECRET" -H "Content-Type: application/json" "$@"; }
jsonget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$2" <<<"$1"; }

# Sanity check: the bootstrap application actually authenticates.
# Casdoor answers HTTP 200 on a failure too — judge the JSON `status`, never the
# HTTP code. get-users needs an admin identity, so it proves the bootstrap
# client authenticates (get-account answers "ok"-shaped errors for an app).
api_ok() { python3 -c 'import json,sys
try: sys.exit(0 if json.load(sys.stdin).get("status") == "ok" else 1)
except Exception: sys.exit(1)'; }
ak "$IDP_URL/api/get-users?owner=built-in" | api_ok \
  || { echo "[oidc] ✗ the bootstrap client_id/client_secret was rejected (still booting? purged?)" >&2; exit 1; }

# --- the application: reuse by id, else create -------------------------------
# The application is OWNED by `admin`, so its id is `admin/<app>` — not
# `built-in/<app>` (the organization), which always reads back as null.
FOUND="$(ak "$IDP_URL/api/get-application?id=admin/$APP" || echo '{"data":null}')"
if [ "$(jsonget "$FOUND" "d.get('data')")" != "None" ]; then
  # keep the redirect URI in sync — rerunning with a new one updates it
  # update-application REPLACES the record: send the one read back, with only the
  # redirect URI changed — a partial body would wipe the client id/secret.
  # ⚠ expireInHours: an application created without it gets 0 — every token is
  #   issued ALREADY EXPIRED (exp == iat) and /api/userinfo refuses it. Healed here.
  UPDATED="$(python3 -c 'import json,sys;d=json.loads(sys.argv[1])["data"];d["redirectUris"]=[sys.argv[2]];d["expireInHours"]=d.get("expireInHours") or 1;d["refreshExpireInHours"]=d.get("refreshExpireInHours") or 24;print(json.dumps(d))' "$FOUND" "$REDIRECT")"
  ak -X POST "$IDP_URL/api/update-application?id=admin/$APP" -d "$UPDATED" | api_ok \
    || { echo "[oidc] ✗ could not update the application '$APP'" >&2; exit 1; }
  echo "[oidc] the application '$APP' already exists — redirect URI refreshed"
  PROV="$FOUND"
else
  CREATED="$(ak -X POST "$IDP_URL/api/add-application" -d "{
    \"owner\": \"admin\", \"name\": \"$APP\", \"displayName\": \"$APP\",
    \"organization\": \"built-in\", \"grantTypes\": [\"authorization_code\"],
    \"redirectUris\": [\"$REDIRECT\"], \"expireInHours\": 1, \"refreshExpireInHours\": 24
  }")"
  api_ok <<<"$CREATED" || { echo "[oidc] ✗ could not create the application '$APP': $CREATED" >&2; exit 1; }
  echo "[oidc] the application '$APP' was created"
  PROV="$(ak "$IDP_URL/api/get-application?id=admin/$APP")"
fi

# --- the app's runtime config -------------------------------------------------
CLIENT_ID_APP="$(jsonget "$PROV" "d['data']['clientId']")"
CLIENT_SECRET_APP="$(jsonget "$PROV" "d['data']['clientSecret']")"
[ -n "$CLIENT_ID_APP" ] && [ -n "$CLIENT_SECRET_APP" ] \
  || { echo "[oidc] ✗ could not read back the client_id/client_secret of '$APP'" >&2; exit 1; }
INTERNAL="$(bao kv get -field=internal_url secret/core/idp)"

bao kv put "secret/$APP/oidc" \
  issuer="$INTERNAL" \
  public_issuer="$IDP_URL" \
  client_id="$CLIENT_ID_APP" \
  client_secret="$CLIENT_SECRET_APP" \
  authorize_endpoint="$IDP_URL/login/oauth/authorize" \
  token_endpoint="$IDP_URL/api/login/oauth/access_token" \
  userinfo_endpoint="$IDP_URL/api/userinfo" \
  jwks_uri="$IDP_URL/.well-known/jwks" \
  redirect_uri="$REDIRECT" >/dev/null
echo "[oidc] secret/$APP/oidc written (issuer, client_id/secret, endpoints, redirect_uri)"
echo "[oidc] discovery: $IDP_URL/.well-known/openid-configuration"
