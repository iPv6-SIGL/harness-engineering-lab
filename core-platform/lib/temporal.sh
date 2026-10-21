#!/usr/bin/env bash
# lib/temporal.sh — access to the Temporal cluster, HOST-INDEPENDENT.
#
# Source it, then:
#
#     . "$(dirname "$0")/lib/temporal.sh"
#     tctl_wait
#     ns_ensure myapp 168h
#
# ═══ WHY `podman exec` RATHER THAN A HOST CLI ══════════════════════════════
# Same reasoning as lib/secrets.sh: the temporal.internal container already
# ships the `temporal` CLI, so the platform needs NO extra host prerequisite.
# A host `temporal` binary is used when present (faster, nicer output).
#
# ⚠ THE ADDRESS TRAP. The Temporal frontend binds to the CONTAINER'S IP, not to
#   127.0.0.1 (we deliberately do not force BIND_ON_IP=0.0.0.0 — that would make
#   ringpop advertise 0.0.0.0, harmless single-node and a trap as soon as you
#   scale). So inside the container the right address is `$(hostname -i):7233`,
#   never `localhost:7233`. That one line is the reason this wrapper exists.
#
# Env read (all optional):
#   TEMPORAL_CONTAINER  default temporal.internal
#   TEMPORAL_ADDRESS    default localhost:7233   (as seen from the HOST)
# ═══════════════════════════════════════════════════════════════════════════

TEMPORAL_CONTAINER="${TEMPORAL_CONTAINER:-temporal.internal}"
TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
export TEMPORAL_ADDRESS

# tctl <args...> — the `temporal` CLI, wherever it lives.
# ⚠ `type -P`, not `command -v` — see the same note in lib/secrets.sh: a host
#   binary must be resolved by PATH only, never through a shell function, and a
#   binary on the PATH is not proof that it works.
_TCTL_BIN=""
_tctl_resolve() {
  [ -n "$_TCTL_BIN" ] && return 0
  local bin; bin="$(type -P temporal 2>/dev/null || true)"
  if [ -n "$bin" ] && "$bin" operator cluster health --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1; then
    _TCTL_BIN="$bin"
  else
    _TCTL_BIN="exec"
  fi
}

tctl() {
  _tctl_resolve
  if [ "$_TCTL_BIN" = "exec" ]; then
    podman exec "$TEMPORAL_CONTAINER" sh -c \
      "temporal $(printf '%q ' "$@") --address \$(hostname -i):7233"
  else
    "$_TCTL_BIN" "$@" --address "$TEMPORAL_ADDRESS"
  fi
}

# tctl_wait [attempts] — blocks until the cluster answers SERVING.
tctl_wait() {
  local n="${1:-60}" i
  for i in $(seq 1 "$n"); do
    tctl operator cluster health 2>/dev/null | grep -q SERVING && return 0
    sleep 2
  done
  return 1
}

# ns_ensure <namespace> [retention] — idempotent.
#   retention defaults to 72h (dev). Production: sized on the audit requirement,
#   never below the longest workflow's expected lifetime.
ns_ensure() {
  local ns="$1" retention="${2:-72h}"
  if tctl operator namespace describe -n "$ns" >/dev/null 2>&1; then
    echo "[temporal] the namespace '$ns' already exists"
  else
    tctl operator namespace create -n "$ns" --retention "$retention" >/dev/null
    echo "[temporal] the namespace '$ns' was created (retention $retention)"
  fi
}
