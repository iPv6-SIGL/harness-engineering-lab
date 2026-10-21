#!/usr/bin/env bash
# temporal/ns-create.sh <app> [retention] — self-service creation of an app's
# Temporal namespace. Idempotent.
#
#     ./temporal/ns-create.sh myapp 168h
#
# A standalone alternative to bootstrap.sh's TEMPORAL_NS=1 (which has its own
# tctl). It creates the namespace only — it does NOT write secret/<app>/temporal.
# The platform provisions nothing per app
# itself — see temporal/seed-namespaces.sh for the rationale.
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/
. lib/temporal.sh

APP="${1:-}"
[ -n "$APP" ] || { echo "usage: $0 <app> [retention]" >&2; exit 1; }
tctl_wait 60 || { echo "[temporal] ✗ the cluster is not SERVING" >&2; exit 1; }
ns_ensure "$APP" "${2:-168h}"
