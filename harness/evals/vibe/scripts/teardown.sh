#!/usr/bin/env bash
# Remove a renamed vibe deployment from the live platform. Never touches `deskbook`.
set -u
export PATH="$HOME/.bun/bin:$PATH"
D="$1"
( cd "$D/app" && timeout 300 gitlab-ci-local --force-shell-executor --variable ACTION=purge > "$D/teardown.log" 2>&1 )
podman exec postgres.internal psql -U postgres -c "DROP DATABASE IF EXISTS deskvibe WITH (FORCE);" -c "DROP ROLE IF EXISTS deskvibe;" >> "$D/teardown.log" 2>&1
echo done
