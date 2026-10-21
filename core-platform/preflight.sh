#!/usr/bin/env bash
# preflight.sh — checks that the machine satisfies the prerequisites.
#
# It covers three levels:
#   - Platform     : podman (rootless), podman compose, node 20, gitlab-ci-local,
#                    python3, openssl, the ports, docker.io access.
#                    See requirements.md.
#                    NOTE: no secrets/S3/Temporal CLI is required on the host —
#                    the platform scripts fall back to the CLI shipped inside the
#                    corresponding container (lib/secrets.sh, lib/objectstore.sh,
#                    lib/temporal.sh). Those CLIs are checked as OPTIONAL comfort.
#   - App-builder  : Bun (the backend runtime + toolchain, REQUIRED). Rust + the
#                    musl target OPTIONAL (only with a measured hot-path waiver).
#   - Coding agent : at least one (`claude` or `vibe`) — the agent your
#                    harness drives. Reported, never a failure.
#
# This script MODIFIES NOTHING. Read-only checks.
# Exit 0 if all is well, 1 if at least one prerequisite is missing.
#
# Usage:
#   ./preflight.sh

set -u
cd "$(dirname "$0")"

FAIL=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$*"; FAIL=1; }
warn() { printf "  \033[33mℹ\033[0m %s\n" "$*"; }   # non-blocking info (does not affect FAIL)
section() { printf "\n== %s ==\n" "$*"; }
banner() { printf "\n\033[1m──── %s ────\033[0m\n" "$*"; }

banner "The platform — the prerequisites for running the core stack"

# ---------------------------------------------------------------------------
# Podman ≥ 4
# ---------------------------------------------------------------------------
section "Podman ≥ 4"
if v=$(podman --version 2>/dev/null); then
  major=$(echo "$v" | awk '{print $3}' | cut -d. -f1)
  if [ "${major:-0}" -ge 4 ]; then
    ok "$v"
  else
    err "$v — required: >= 4"
  fi
  if podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null | grep -qi true; then
    ok "rootless mode"
  else
    err "podman is not running rootless (see requirements.md → Podman ≥ 4)"
  fi
else
  err "podman is absent (see requirements.md → Podman ≥ 4)"
fi

# ---------------------------------------------------------------------------
# podman compose (the sub-command the pipeline calls). Podman 5 provides it
# natively over a podman-compose OR docker-compose backend; Podman 4 needs the
# podman-compose package. Testing the sub-command covers both.
# ---------------------------------------------------------------------------
section "podman compose"
if podman compose version >/dev/null 2>&1; then
  # Cleans the ANSI escapes emitted by the backend and keeps the version line
  line=$(podman compose version 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -i "version" | head -1)
  ok "${line:-podman compose is available}"
else
  err "podman compose is unavailable (see requirements.md → 'podman compose')"
fi

# ---------------------------------------------------------------------------
# Node.js ≥ 20  (required by gitlab-ci-local)
# ---------------------------------------------------------------------------
section "Node.js ≥ 20"
if v=$(node --version 2>/dev/null); then
  major=$(echo "$v" | sed 's/^v//' | cut -d. -f1)
  if [ "${major:-0}" -ge 20 ]; then
    ok "node $v"
  else
    err "node $v — required: >= 20 (install through NodeSource, see requirements.md)"
  fi
else
  err "node is absent (see requirements.md → gitlab-ci-local)"
fi

# ---------------------------------------------------------------------------
# gitlab-ci-local
# ---------------------------------------------------------------------------
section "gitlab-ci-local"
if v=$(gitlab-ci-local --version 2>/dev/null); then
  ok "gitlab-ci-local $v"
else
  err "gitlab-ci-local is absent (sudo npm i -g gitlab-ci-local)"
fi

# ---------------------------------------------------------------------------
# python3 + openssl (the gateway seed renders YAML with python3; the onboarding
# scripts and bootstrap.sh generate their keys with openssl)
# ---------------------------------------------------------------------------
section "python3 + openssl"
if v=$(python3 --version 2>/dev/null); then ok "$v"; else err "python3 is absent (see requirements.md → python3 + openssl)"; fi
if v=$(openssl version 2>/dev/null); then ok "$v"; else err "openssl is absent (see requirements.md → python3 + openssl)"; fi

# ---------------------------------------------------------------------------
# The OPTIONAL host CLIs.
#
# None of them is a prerequisite any more: every platform script resolves its
# CLI as  host binary → `podman exec <container>`  (lib/secrets.sh,
# lib/objectstore.sh, lib/temporal.sh). A bare machine runs the platform.
# They are reported because they are far more comfortable for a human poking at
# the store by hand — never as a failure.
# ---------------------------------------------------------------------------
section "The optional host CLIs (comfort — the containers ship their own)"
if command -v bao >/dev/null 2>&1; then
  ok "bao $(bao --version 2>/dev/null | head -1)"
elif command -v vault >/dev/null 2>&1; then
  warn "bao is absent; the host \`vault\` is present and works against OpenBao (API-compatible)"
else
  warn "neither bao nor vault on the host — the scripts will go through \`podman exec openbao.internal\`"
fi
if command -v mc >/dev/null 2>&1; then
  ok "mc $(mc --version 2>/dev/null | head -1)"
else
  warn "mc is absent — the scripts provision S3 through \`podman exec s3 weed shell\`; mc only helps for browsing by hand"
fi
if command -v temporal >/dev/null 2>&1; then
  ok "temporal $(temporal --version 2>/dev/null | head -1)"
else
  warn "the temporal CLI is absent — the scripts go through \`podman exec temporal.internal\`"
fi

# ---------------------------------------------------------------------------
# Free ports.
#
# The platform deliberately keeps OUT of the 8000-8999 range, which is reserved
# for the apps (README.md → The ports convention). The newcomers: Temporal
# (7233 gRPC + 9233 UI), Casdoor (9300) and Umami (9400).
#
# A special case: if the core stack is already active, its ports are obviously
# taken — that is a legitimate state, not a failure. We detect it
# through the io.podman.compose.project=core label.
# ---------------------------------------------------------------------------
PORTS="5000 5432 6379 7233 8200 9000 9001 9080 9233 9300 9400 9999"
PORTS_RE="$(echo "$PORTS" | tr ' ' '|')"
section "Free ports ($(echo "$PORTS" | tr ' ' ','))"
core_running=$(podman ps -q --filter "label=io.podman.compose.project=core" 2>/dev/null | wc -l)
busy=$(ss -ltn 2>/dev/null | awk '{print $4}' | grep -oE ":($PORTS_RE)\$" | sort -u || true)
if [ -z "${busy:-}" ]; then
  ok "$(echo "$PORTS" | tr ' ' ',') are free"
elif [ "$core_running" -gt 0 ]; then
  printf "  \033[33mℹ\033[0m the core stack is already active (%s containers) — ports taken by the platform: %s\n" \
    "$core_running" "$(echo "$busy" | tr '\n' ' ')"
else
  err "ports already taken by something else: $(echo "$busy" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# Outbound network access: docker.io
# ---------------------------------------------------------------------------
section "docker.io access (outbound HTTPS)"
code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 https://registry-1.docker.io/v2/ 2>/dev/null || echo "000")
case "$code" in
  2*|4*) ok "registry-1.docker.io answers (HTTP $code)" ;;
  000)   err "registry-1.docker.io is unreachable — a corporate proxy to configure?" ;;
  *)     err "registry-1.docker.io answers HTTP $code (unexpected)" ;;
esac

banner "App-builder — the prerequisites for building the application services"

# ---------------------------------------------------------------------------
# Bun (the default backend runtime + toolchain). REQUIRED.
# ---------------------------------------------------------------------------
section "Bun ≥ 1.1"
if v=$(bun --version 2>/dev/null); then
  major=$(echo "$v" | cut -d. -f1); minor=$(echo "$v" | cut -d. -f2)
  if [ "${major:-0}" -ge 2 ] || { [ "${major:-0}" -eq 1 ] && [ "${minor:-0}" -ge 1 ]; }; then
    ok "bun $v"
  else
    err "bun $v — required: >= 1.1 (curl -fsSL https://bun.sh/install | bash)"
  fi
else
  err "bun is absent (curl -fsSL https://bun.sh/install | bash — see https://bun.sh)"
fi

# ---------------------------------------------------------------------------
# The Rust toolchain — OPTIONAL. Only if a service is under a hot-path waiver
# Its absence = info, not a failure.
# ---------------------------------------------------------------------------
section "The Rust toolchain (optional — a hot-path waiver)"
if command -v cargo >/dev/null 2>&1; then
  ok "$(cargo --version 2>/dev/null)"
  if rustup target list --installed 2>/dev/null | grep -q "x86_64-unknown-linux-musl"; then
    ok "the target x86_64-unknown-linux-musl is installed"
  else
    warn "the musl target is absent (rustup target add x86_64-unknown-linux-musl) — required only for a Rust service"
  fi
  if command -v musl-gcc >/dev/null 2>&1 || command -v x86_64-linux-musl-gcc >/dev/null 2>&1; then
    ok "musl-gcc is present"
  else
    warn "musl-gcc is absent (sudo apt install -y musl-tools) — required only for a Rust service with C deps"
  fi
else
  warn "rustup/cargo is absent — fine as long as no service is under a Rust waiver"
fi

banner "Coding agent — the agent your harness drives"

section "A coding agent (claude OR vibe)"
have_claude=0; have_vibe=0
command -v claude >/dev/null 2>&1 && have_claude=1
command -v vibe   >/dev/null 2>&1 && have_vibe=1
if [ "$have_claude" = "1" ] || [ "$have_vibe" = "1" ]; then
  detected=""
  [ "$have_claude" = "1" ] && detected="${detected}claude "
  [ "$have_vibe"   = "1" ] && detected="${detected}vibe"
  ok "detected: $detected"
else
  warn "neither claude nor vibe detected (Claude Code: npm i -g @anthropic-ai/claude-code, or Mistral Vibe)"
fi

# ---------------------------------------------------------------------------
# The verdict
# ---------------------------------------------------------------------------
echo
if [ "$FAIL" = "0" ]; then
  printf "\033[32m✓ Every prerequisite is satisfied\033[0m — ready for:\n"
  echo "    gitlab-ci-local --force-shell-executor"
  exit 0
else
  printf "\033[31m✗ At least one prerequisite is missing\033[0m — see requirements.md\n"
  exit 1
fi
