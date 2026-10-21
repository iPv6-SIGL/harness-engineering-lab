#!/usr/bin/env bash
# onboard-app.sh <app> — provisions EVERYTHING the platform can provision for one
# app, whatever the app is. IDEMPOTENT and replayable.
#
#     ./onboard-app.sh myapp
#     LLM_BUDGET=120000 ./onboard-app.sh myapp
#     LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-api03-... ./onboard-app.sh myapp
#
# ═══ WHAT IT PROVISIONS ════════════════════════════════════════════════════
#   1. the active LLM provider's key           secret/core/<provider>
#   2. the app's virtual key (generated)       secret/core/llm-vkeys[<app>]
#   3. the app's token budget                  secret/core/llm-budgets[<app>]
#   4. the LLM config the app reads at boot    secret/<app>/llm
#   5. the Temporal namespace                  <app>
#   6. a gateway re-seed                       (without it, the vkey returns 401)
#
# ═══ WHAT IT DOES **NOT** PROVISION ════════════════════════════════════════
# The app's Postgres database, its S3 bucket and its NON-CORE secrets (a third
# party's API token, a dataset credential…). Those belong to the app, not to the
# platform: they are created by the app's own `bootstrap.sh`
# (templates/bootstrap.sh), which the app owns and which
# runs in the app's repository.
#
# The boundary is deliberate. The platform stays AGNOSTIC — it knows no app by
# name, hardcodes no app's third-party dependency, and this script takes the
# app's name as an argument precisely so that nothing here has to be edited to
# onboard the next one.
#
# ⚠ The secret store runs in dev mode (in-memory): an `ACTION=purge` of the core
#   platform EMPTIES it → rerun this script after every purge.
#
set -euo pipefail
cd "$(dirname "$0")"

APP="${1:-${APP:-}}"
if [ -z "$APP" ]; then
  echo "usage: $0 <app>            (e.g. $0 myapp)" >&2
  exit 1
fi
case "$APP" in
  [a-z][a-z0-9-]*) ;;
  *) echo "✗ the app name '$APP' is invalid: [a-z][a-z0-9-]* expected" >&2; exit 1 ;;
esac

. lib/secrets.sh
. lib/temporal.sh

# The app's tokens/60 s budget. The platform default is 50000; an app running a
# tool-use loop chains several iterations per run where a linear
# workflow does one round trip — raise it through LLM_BUDGET.
LLM_BUDGET="${LLM_BUDGET:-50000}"
TEMPORAL_RETENTION="${TEMPORAL_RETENTION:-168h}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
info() { printf '  \033[36mℹ\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

echo "── the secret store ($BAO_ADDR · mode $(bao_mode)) ─────────────────"
bao_wait 30 || die "the secret store is unreachable — is the core platform started?"
ok "the store answers"

# ── 1. The active LLM provider's key ──────────────────────────────────────
echo
echo "── 1/6 · the LLM provider key ─────────────────────────────────────"
PROVIDER="${LLM_PROVIDER:-$(bao kv get -field=provider secret/core/llm-provider 2>/dev/null || echo openai)}"
case "$PROVIDER" in
  openai)    KEY_PATH="secret/core/openai";    ENV_VAR="OPENAI_API_KEY";    HINT="sk-..." ;;
  anthropic) KEY_PATH="secret/core/anthropic"; ENV_VAR="ANTHROPIC_API_KEY"; HINT="sk-ant-api03-..." ;;
  *) die "LLM_PROVIDER='$PROVIDER' is unknown (expected: openai | anthropic)" ;;
esac
info "the active provider: $PROVIDER  →  $KEY_PATH"

if bao kv get -field=api_key "$KEY_PATH" >/dev/null 2>&1; then
  ok "$KEY_PATH already present (unchanged)"
elif [ -n "${!ENV_VAR:-}" ]; then
  bao kv put "$KEY_PATH" api_key="${!ENV_VAR}" >/dev/null
  ok "$KEY_PATH written from the environment"
else
  warn "$KEY_PATH is ABSENT and $ENV_VAR is not set."
  warn "→ the gateway will start, but EVERY LLM call will return 401."
  warn "→ supply it:  $ENV_VAR=$HINT $0 $APP"
  if [ "$PROVIDER" = "anthropic" ]; then
    warn "→ ⚠ an Anthropic API key (console.anthropic.com), NOT a Claude Code"
    warn "    OAuth token (sk-ant-oat01-…): that one is tied to the subscription,"
    warn "    does not authenticate the API."
  fi
fi

# ── 2. The app's virtual key (self-service) ────────────────────────
echo
echo "── 2/6 · virtual-key '$APP' ───────────────────────────────────────"
VKEY="$(bao kv get -field="$APP" secret/core/llm-vkeys 2>/dev/null || true)"
if [ -n "$VKEY" ]; then
  ok "the vkey '$APP' is already published in secret/core/llm-vkeys (kept)"
else
  VKEY="$(openssl rand -hex 24)"
  bao_put_map secret/core/llm-vkeys "$APP=$VKEY"
  ok "the vkey '$APP' was generated and published (24 random bytes)"
fi

# ── 3. The per-app token budget ──────────────────────────────────────
echo
echo "── 3/6 · budget tokens '$APP' ─────────────────────────────────────"
CUR_BUDGET="$(bao kv get -field="$APP" secret/core/llm-budgets 2>/dev/null || true)"
if [ -n "$CUR_BUDGET" ]; then
  ok "the budget '$APP' is already set: ${CUR_BUDGET} tokens/60 s (unchanged)"
else
  bao_put_map secret/core/llm-budgets "$APP=$LLM_BUDGET"
  ok "the budget '$APP' was set to ${LLM_BUDGET} tokens/60 s"
fi

# ── 4. The LLM config consumed by the app at boot ─────────────────────────
echo
echo "── 4/6 · secret/$APP/llm ──────────────────────────────────────────"
bao kv put "secret/$APP/llm" \
  virtual_key="$VKEY" \
  base_url="http://llm.internal:9080/v1" >/dev/null
ok "secret/$APP/llm written (virtual_key + base_url)"

# ── 5. Temporal namespace ────────────────────────────────────────
echo
echo "── 5/6 · Temporal namespace '$APP' ────────────────────────────────"
if tctl_wait 30; then
  ns_ensure "$APP" "$TEMPORAL_RETENTION"
  bao kv put "secret/$APP/temporal" \
    address="temporal.internal:7233" \
    namespace="$APP" >/dev/null
  ok "secret/$APP/temporal written (address + namespace)"
else
  warn "the Temporal cluster is not SERVING — the namespace was not created."
  warn "→ fine if the app runs no durable workflow (KISS)."
  warn "→ otherwise: podman logs temporal.internal, then ./temporal/ns-create.sh $APP"
fi

# ── 6. Re-seeding the gateway (otherwise the vkey does not exist APISIX-side) ─
echo
echo "── 6/6 · re-seeding the llm.internal gateway ──────────────────────"
if [ -x ./apisix/seed-and-deploy.sh ]; then
  LLM_PROVIDER="$PROVIDER" ./apisix/seed-and-deploy.sh
  ok "the APISIX consumers were regenerated (the provider $PROVIDER)"
else
  warn "apisix/seed-and-deploy.sh not found or not executable."
  warn "→ with no re-seed, the app's calls will return 401."
fi

# ── The recap ─────────────────────────────────────────────────────────────
echo
echo "══ The recap — app '$APP' ═════════════════════════════════════════"
printf '  %-38s %s\n' "the active LLM provider" "$PROVIDER"
printf '  %-38s %s\n' "$KEY_PATH" \
  "$(bao kv get -field=api_key "$KEY_PATH" >/dev/null 2>&1 && echo 'present' || echo 'ABSENT (blocking)')"
printf '  %-38s %s\n' "secret/core/llm-vkeys[$APP]" "present"
printf '  %-38s %s\n' "secret/core/llm-budgets[$APP]" \
  "$(bao kv get -field="$APP" secret/core/llm-budgets 2>/dev/null) tokens/60 s"
printf '  %-38s %s\n' "secret/$APP/llm" "present"
printf '  %-38s %s\n' "secret/$APP/temporal" \
  "$(bao kv get -field=namespace "secret/$APP/temporal" >/dev/null 2>&1 && echo 'present' || echo 'absent')"
echo
echo "What remains for the APP to do, from its own repository:"
echo "  ./bootstrap.sh          # its Postgres DB, its S3 bucket + scoped key, its non-core secrets"
echo
echo "If the app authenticates users — an OIDC client on the platform IdP:"
echo "  (cd $(pwd) && ./idp/onboard-oidc.sh $APP http://localhost:<api-port>/auth/callback)"
echo "  → writes secret/$APP/oidc (issuer, client_id/secret, endpoints, redirect_uri)"
echo "  (cd $(pwd) && ./idp/seed-test-users.sh $APP <persona-slug>...)"
echo "  → pass the spec's own personas, not admin/user, once one exists"
echo "  → writes secret/$APP/test-users — one shared password, what the e2e tests log in with"
echo
echo "To check the gateway end to end:"
echo "  VKEY=\$(bao kv get -field=$APP secret/core/llm-vkeys)"
echo "  curl -s http://localhost:9080/v1/chat/completions \\"
echo "    -H \"Authorization: Bearer \$VKEY\" -H 'Content-Type: application/json' \\"
echo "    -d '{\"model\":\"task:cheap\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":5}'"
