#!/usr/bin/env bash
# seed-and-deploy.sh — injects the LLM secrets from the secret store into the
# `llm.internal` gateway (APISIX), then (re)starts the apisix container with those
# secrets in the environment. The store is the SOURCE OF TRUTH; nothing in the
# clear in the repository.
#
# Idempotent. Called by core-platform/.gitlab-ci.yml (the seed-llm-gateway job),
# also usable by hand:  ./apisix/seed-and-deploy.sh
#
# ═══ A SWITCHABLE PROVIDER ════════════════════════════════════
# The gateway knows how to proxy TWO providers, with the SAME app-side contract
# (baseURL `llm.internal:9080/v1`, a virtual key, the `task:*` aliases, a token budget):
#
#     LLM_PROVIDER=openai      (the default)  → apisix/routes.openai.yaml
#                                          secret/core/openai    field api_key
#     LLM_PROVIDER=anthropic             → apisix/routes.anthropic.yaml
#                                          secret/core/anthropic field api_key
#
# Switching = `LLM_PROVIDER=anthropic ./apisix/seed-and-deploy.sh`. **NO line
# of application code changes**: it is the counter-measure when a provider
# is down on the day of a workshop.
#
# The value is persisted in the store (`secret/core/llm-provider`) so that the later
# re-seeds (the CI job, a restart) keep the same provider without having to
# pass the variable again.
#
# ⚠️ `task:image` exists only in openai mode (Anthropic has no image-generation
#    endpoint) — see the banner of routes.anthropic.yaml.
#
# The prerequisites: the core up (openbao healthy) and podman compose. NO host
# secrets CLI is required — lib/secrets.sh falls back to the CLI shipped inside
# the openbao.internal container.
# The provider's real key is supplied EITHER already in the store, OR through the
# env variable (OPENAI_API_KEY / ANTHROPIC_API_KEY), then written here.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/

. lib/secrets.sh

# --- waiting for the secret store -------------------------------------------
bao_wait 30 || { echo "[seed] ✗ the secret store is unreachable on $BAO_ADDR" >&2; exit 1; }

# --- resolving the provider: env > the store > the openai default ---------------
PROVIDER="${LLM_PROVIDER:-$(bao kv get -field=provider secret/core/llm-provider 2>/dev/null || echo openai)}"
case "$PROVIDER" in
  openai|anthropic) ;;
  *) echo "[seed] ✗ LLM_PROVIDER='$PROVIDER' is unknown (expected: openai | anthropic)" >&2; exit 1 ;;
esac
ROUTES="apisix/routes.${PROVIDER}.yaml"
[ -f "$ROUTES" ] || { echo "[seed] ✗ $ROUTES not found" >&2; exit 1; }
# persists the choice for the following re-seeds (CI, a restart)
bao kv put secret/core/llm-provider provider="$PROVIDER" >/dev/null 2>&1 || true
echo "[seed] provider = $PROVIDER  ($ROUTES)"

# --- the provider's key: seeded from the env if absent from the store ----------
case "$PROVIDER" in
  openai)    KEY_PATH="secret/core/openai";    ENV_VAR="OPENAI_API_KEY";    HINT="sk-..." ;;
  anthropic) KEY_PATH="secret/core/anthropic"; ENV_VAR="ANTHROPIC_API_KEY"; HINT="sk-ant-api03-..." ;;
esac
if ! bao kv get -field=api_key "$KEY_PATH" >/dev/null 2>&1; then
  ENV_VAL="${!ENV_VAR:-}"
  if [ -n "$ENV_VAL" ]; then
    bao kv put "$KEY_PATH" api_key="$ENV_VAL" >/dev/null
    echo "[seed] the $PROVIDER key was written into the store ($KEY_PATH) from the env"
  else
    echo "[seed] ⚠ $KEY_PATH is absent from the store AND $ENV_VAR is not set."
    echo "       The gateway will start WITH NO valid key ($PROVIDER calls → 401)."
    echo "       To supply it:  bao kv put $KEY_PATH api_key=$HINT"
    if [ "$PROVIDER" = "anthropic" ]; then
      echo "       ⚠ An Anthropic API key is needed (console.anthropic.com), NOT a"
      echo "         Claude Code OAuth token (sk-ant-oat01-…): that one is tied to"
      echo "         the subscription and does not authenticate the API."
    fi
  fi
fi

# --- the embeddings key: ALWAYS OpenAI, regardless of $PROVIDER ----
# task:embed (/v1/embeddings) has no Anthropic equivalent at all — both route
# variants proxy it to OpenAI (see the banner in routes.anthropic.yaml). So
# secret/core/openai is needed even in anthropic mode, seeded independently of
# the $PROVIDER branch above (which only touches the ACTIVE chat provider's key).
if [ "$PROVIDER" != "openai" ] && ! bao kv get -field=api_key secret/core/openai >/dev/null 2>&1; then
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    bao kv put secret/core/openai api_key="$OPENAI_API_KEY" >/dev/null
    echo "[seed] the openai key was written into the store (secret/core/openai) from the env — needed for task:embed even in $PROVIDER mode"
  else
    echo "[seed] ⚠ secret/core/openai is absent AND OPENAI_API_KEY is not set."
    echo "       task:embed (/v1/embeddings) will 401 even though \$PROVIDER=$PROVIDER — it always proxies OpenAI."
    echo "       To supply it:  bao kv put secret/core/openai api_key=sk-..."
  fi
fi

# --- a virtual key per app: SELF-SERVICE PROVISIONING -----------------------
# The source of truth = secret/core/llm-vkeys (a map app -> vkey). Every app
# publishes its key through ITS bootstrap.sh (see templates/
# bootstrap.sh, the vkey step) — the platform knows NO app by its name.
# A manual example:  bao kv patch secret/core/llm-vkeys myapp=$(openssl rand -hex 24)
ensure_vkey() {  # <app> <default> — kept for manual/debug use
  bao kv get -field="$1" secret/core/llm-vkeys >/dev/null 2>&1 && return 0
  bao_put_map secret/core/llm-vkeys "$1=$2"
}

# --- GENERATES the APISIX consumers from the store (EVERY app in it) ------
# the runtime apisix.yaml = the banner + the consumers (generated) + routes.<provider>.yaml.
# The token budget PER APP: an ai-rate-limiting override at the
# consumer level (it wins over the route), read from secret/core/llm-budgets (the
# field = the app, tokens/60 s) — a default of 50000 if absent. The 429 "llm
# budget exceeded" is therefore really per app, not a shared global cap.
# ⚠ The `name`/`provider` of the ai-rate-limiting instance HAS TO match that of
#   the route (otherwise the override does not apply) → parameterised here.
# An empty store (no app has published its vkey yet) = a VALID state of a freshly
# started agnostic platform: a gateway with no consumer, each app will add one
# through its bootstrap (LLM_VKEY=1) then a re-seed.
VKEYS_JSON="$(bao kv get -format=json secret/core/llm-vkeys 2>/dev/null || echo '{"data":{"data":{}}}')"
BUDGETS_JSON="$(bao kv get -format=json secret/core/llm-budgets 2>/dev/null || echo '{"data":{"data":{}}}')"
{
  echo "# GENERATED by seed-and-deploy.sh — DO NOT EDIT."
  echo "# Consumers from secret/core/llm-vkeys · provider = $PROVIDER"
  { echo "$VKEYS_JSON"; echo "$BUDGETS_JSON"; } | PROVIDER="$PROVIDER" python3 -c '
import sys, json, os
provider = os.environ["PROVIDER"]
docs = sys.stdin.read().strip().splitlines()
raw = "\n".join(docs)
dec = json.JSONDecoder()
vkeys, idx = dec.raw_decode(raw)
budgets, _ = dec.raw_decode(raw[idx:].lstrip())
m = vkeys["data"]["data"]
b = budgets.get("data", {}).get("data", {})
print("consumers:" if m else "consumers: []")
for app, key in sorted(m.items()):
    limit = int(b.get(app, 50000))
    print(f"  - username: {app}")
    print( "    plugins:")
    print( "      key-auth:")
    print(f"        key: \"{key}\"")
    print( "      ai-rate-limiting:")
    print( "        instances:")
    print(f"          - name: {provider}")
    print(f"            provider: {provider}")
    print(f"            limit: {limit}")
    print( "            time_window: 60")
    print( "        rejected_code: 429")
    print( "        rejected_msg: \"llm budget exceeded\"")
'
  cat "$ROUTES"
} > apisix/apisix.yaml
echo "[seed] APISIX consumers generated: $(echo "$VKEYS_JSON" | python3 -c 'import sys,json;apps=sorted(json.load(sys.stdin)["data"]["data"]);print(", ".join(apps) if apps else "(none — the apps will publish their vkey self-service)")')"

# --- reading the provider's key (the SoT) and (re)deploying APISIX ----------
# BOTH variables are exported (empty for the inactive provider): the compose
# references both of them; an absent variable would make the `${{...}}`
# rendering fail APISIX-side.
OPENAI_API_KEY="$(bao kv get -field=api_key secret/core/openai    2>/dev/null || true)"
ANTHROPIC_API_KEY="$(bao kv get -field=api_key secret/core/anthropic 2>/dev/null || true)"
export OPENAI_API_KEY ANTHROPIC_API_KEY
# --no-deps: recreate ONLY this service (apisix has no dependency today, but a
# targeted recreate must never touch the shared ones).
podman compose -p core up -d --no-deps --force-recreate apisix
echo "[seed] apisix (llm.internal) deployed — the provider $PROVIDER + the consumers from the store"
