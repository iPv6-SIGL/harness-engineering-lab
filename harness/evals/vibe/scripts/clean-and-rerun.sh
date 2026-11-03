#!/usr/bin/env bash
# Fresh deskvibe state, then run the vibe app's own pipeline again. Never touches the harness's deskbook DB.
set -u
export PATH="$HOME/.bun/bin:$PATH"
D="$1"
( cd "$D/app" && timeout 300 gitlab-ci-local --force-shell-executor --variable ACTION=purge > "$D/purge.log" 2>&1 )
podman exec postgres.internal psql -U postgres -c "DROP DATABASE IF EXISTS deskvibe WITH (FORCE);" -c "DROP ROLE IF EXISTS deskvibe;" > "$D/clean.log" 2>&1
rm -f "$D/pipeline.log"
~/vibe-runs/run-vibe-pipeline.sh "$D"
