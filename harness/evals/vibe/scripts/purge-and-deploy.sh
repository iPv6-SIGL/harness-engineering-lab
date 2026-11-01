#!/usr/bin/env bash
# 1) purge the previous renamed vibe deployment  2) deploy the next one with its own pipeline, unchanged
set -u
export PATH="$HOME/.bun/bin:$PATH"
PREV="$1"; NEXT="$2"
( cd "$PREV/app" && timeout 300 gitlab-ci-local --force-shell-executor --variable ACTION=purge > "$PREV/purge.log" 2>&1 )
rm -rf "$NEXT"; mkdir "$NEXT"
SRC="$HOME/vibe-runs/$(basename "$NEXT" | sed 's/d$//')"
cp -r "$SRC/app" "$NEXT/app"; cp -r "$SRC/core-platform" "$NEXT/core-platform"
rm -rf "$NEXT/app/node_modules" "$NEXT/app/.git"
grep -rl "deskbook" "$NEXT/app" --exclude-dir=node_modules | xargs sed -i 's/deskbook/deskvibe/g'
~/vibe-runs/run-vibe-pipeline.sh "$NEXT"
