#!/usr/bin/env bash
# analytics/site-create.sh <app> [domain] — self-service creation of an app's
# analytics WEBSITE on the platform analytics service (Umami). IDEMPOTENT.
#
#     ./analytics/site-create.sh myapp
#     ./analytics/site-create.sh myapp localhost:8000
#
# ═══ WHAT IT CREATES ════════════════════════════════════════════════════════
#   · a WEBSITE named <app> (the isolation unit: its own websiteId, its own
#     dashboard scope — two apps never share one);
#   · the app's runtime config in secret/<app>/analytics:
#         website_id, collect_url, script_url, event_prefix
#     — the app reads THAT at boot, never the admin credentials.
#
# Idempotent: an existing website of the same name is reused and
# secret/<app>/analytics is refreshed from it.
#
# ⚠ `domain` is what Umami records as the site's hostname. It defaults to
#   localhost, which is right for a workshop; pass the real one in production.
#
# Uses the API token from secret/core/analytics — run
# ./analytics/seed-and-deploy.sh first (the CI's seed-analytics job does).
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/

. lib/secrets.sh

APP="${1:-}"
DOMAIN="${2:-localhost}"
[ -n "$APP" ] || { echo "usage: $0 <app> [domain]" >&2; exit 1; }
case "$APP" in [a-z][a-z0-9-]*) ;; *) echo "✗ app name '$APP' invalid: [a-z][a-z0-9-]*" >&2; exit 1;; esac

bao_wait 30 || { echo "[analytics] ✗ the secret store is unreachable on $BAO_ADDR" >&2; exit 1; }

URL="${UMAMI_URL:-$(bao kv get -field=url secret/core/analytics 2>/dev/null || true)}"
TOKEN="${UMAMI_TOKEN:-$(bao kv get -field=api_token secret/core/analytics 2>/dev/null || true)}"
[ -n "$URL" ] && [ -n "$TOKEN" ] || {
  echo "[analytics] ✗ secret/core/analytics has no url/api_token — run ./analytics/seed-and-deploy.sh first" >&2
  exit 1
}

um() { curl -sf -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
pyget() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

# --- the website: reuse by name, else create ---------------------------------
# GET /api/websites is paged: {data:[...],count,page,pageSize}. Match on the
# EXACT name — `search` is a fuzzy filter, it would happily return `myapp-2`.
# Not `d.get('data') or d`: on a fresh Umami `data` is [] — falsy — and the
# fallback would iterate over the envelope's keys (the very first app crashed).
EXISTING="$(um "$URL/api/websites?pageSize=200" | pyget \
  "next((w['id'] for w in (d['data'] if isinstance(d, dict) else d) if w.get('name')=='$APP'), '')")"

if [ -n "$EXISTING" ]; then
  WEBSITE_ID="$EXISTING"
  echo "[analytics] website '$APP' already exists — reused ($WEBSITE_ID)"
else
  WEBSITE_ID="$(um -X POST "$URL/api/websites" \
    -d "{\"name\":\"$APP\",\"domain\":\"$DOMAIN\"}" | pyget "d['id']")"
  [ -n "$WEBSITE_ID" ] || { echo "[analytics] ✗ creation failed" >&2; exit 1; }
  echo "[analytics] website '$APP' created ($WEBSITE_ID)"
fi

# --- the app's runtime config -------------------------------------------------
# collect_url / script_url are the app's OWN first-party paths: the
# browser must never talk to the analytics host directly — that is what keeps
# the API the only downstream surface AND what makes the beacon survive the ad-block filter lists.
bao kv put "secret/$APP/analytics" \
  website_id="$WEBSITE_ID" \
  site_name="$APP" \
  domain="$DOMAIN" \
  event_prefix="$APP." \
  script_url="/api/v1/_a/t.js" \
  collect_url="/api/v1/_a/send" \
  upstream="http://analytics.internal:3000" >/dev/null

echo "[analytics] ✔ secret/$APP/analytics written"
echo "            website_id=$WEBSITE_ID · event prefix '$APP.' · dashboard $URL"
