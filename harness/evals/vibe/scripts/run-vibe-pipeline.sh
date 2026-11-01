#!/usr/bin/env bash
# Deploy a vibe-coded app (renamed copy) on the live platform with ITS OWN pipeline, unchanged.
# usage: run-vibe-pipeline.sh <dir containing app/ and core-platform/>
set -u
D="$1"
cd "$D/app"
[ -d .git ] || { git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm vibe; }
export PATH="$HOME/.bun/bin:$PATH"
timeout 900 gitlab-ci-local --force-shell-executor > "$D/pipeline.log" 2>&1
echo "EXIT=$?" >> "$D/pipeline.log"
