#!/usr/bin/env bash
# up.sh — bring the whole lab back in one command: on a fresh clone, after
# `ACTION=stop`, or after the host (or WSL) rebooted.
#
# Why a script and not `restart: unless-stopped`: rootless Podman has no daemon
# to honour restart policies across a reboot, and OpenBao runs in dev mode
# (in-memory) — even containers that came back would start with an EMPTY secret
# store and the apps would crash-loop on their missing secrets. The pipelines
# are idempotent and re-seed everything, so recovering = re-running them, in order:
#   1. the core platform (containers + every seed)
#   2. the harness's own bucket (evidence packs)
#   3. every app built by the harness (provision → gates → build → deploy → verify)
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$PATH"

echo "── core-platform"
(cd core-platform && gitlab-ci-local --force-shell-executor)

echo "── harness bucket"
APP=harness CORE_PLATFORM="$PWD/core-platform" core-platform/templates/bootstrap.sh >/dev/null

for dir in */; do
  app="${dir%/}"
  [ -f "$app/.gitlab-ci.yml" ] && [ -d "$app/.harness" ] || continue
  echo "── $app"
  (cd "$app" && gitlab-ci-local --force-shell-executor)
done
echo "lab up."
