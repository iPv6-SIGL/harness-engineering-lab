#!/usr/bin/env bash
# lib/secrets.sh — the platform's secret-store access layer, HOST-INDEPENDENT.
#
# Source it, then call `bao`:
#
#     . "$(dirname "$0")/lib/secrets.sh"
#     bao kv put secret/core/openai api_key=sk-...
#     bao kv get -field=api_key secret/core/openai
#
# ═══ WHY A WRAPPER ═════════════════════════════════════════════════════════
# The store is OpenBao (MPL-2.0), whose CLI is `bao`. Three reasons not to
# hardcode a host binary:
#
#   1. ZERO HOST PREREQUISITE. The openbao.internal container already ships
#      `bao`. If neither `bao` nor `vault` is installed on the workstation, we
#      fall back to `podman exec` — the platform stays runnable on a bare
#      machine, which is the point of a workshop.
#   2. LEGACY COMPATIBILITY. OpenBao is an API-compatible fork: a host `vault`
#      binary left over from before the swap keeps working against it. We accept
#      it rather than making people uninstall something.
#   3. ONE PLACE TO CHANGE. If the store moves again, this file is the only
#      edit.
#
# The resolution order (the first that answers wins):
#     $BAO_BIN  →  host `bao`  →  host `vault`  →  podman exec openbao.internal bao
#
# Env read (all optional):
#   BAO_BIN         forces the binary/command (e.g. "bao" or "vault")
#   BAO_ADDR        default http://localhost:8200      (VAULT_ADDR is honoured too)
#   BAO_TOKEN       default root-dev-token             (VAULT_TOKEN is honoured too)
#   BAO_CONTAINER   default openbao.internal
# ═══════════════════════════════════════════════════════════════════════════

# The address/token, tolerating the two prefixes. VAULT_* wins if it alone is set
# (a workstation configured before the swap keeps working with no change).
BAO_ADDR="${BAO_ADDR:-${VAULT_ADDR:-http://localhost:8200}}"
BAO_TOKEN="${BAO_TOKEN:-${VAULT_TOKEN:-root-dev-token}}"
BAO_CONTAINER="${BAO_CONTAINER:-openbao.internal}"
export BAO_ADDR BAO_TOKEN
# Both prefixes are exported: a sub-process may be either CLI.
export VAULT_ADDR="$BAO_ADDR" VAULT_TOKEN="$BAO_TOKEN"

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

# bao_wait [attempts] — blocks until the store answers. Returns 1 on timeout.
bao_wait() {
  local n="${1:-30}"
  local i
  for i in $(seq 1 "$n"); do
    bao status >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# bao_mode — prints the resolved mode (for the logs / debugging).
bao_mode() { _bao_resolve && echo "$_BAO_MODE"; }

# bao_put_map <path> <field>=<value> — writes ONE field of a map secret without
# clobbering the others. `kv patch` fails if the path does not exist yet; the
# `kv put` fallback creates it. That two-step is the idiom used everywhere for
# secret/core/llm-vkeys and secret/core/llm-budgets.
bao_put_map() {
  local path="$1"; shift
  bao kv patch "$path" "$@" >/dev/null 2>&1 || bao kv put "$path" "$@" >/dev/null
}
