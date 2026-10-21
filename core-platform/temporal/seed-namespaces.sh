#!/usr/bin/env bash
# temporal/seed-namespaces.sh — waits for the Temporal cluster and guarantees the
# `default` namespace exists.
#
# Idempotent. Called by core-platform/.gitlab-ci.yml (the seed-temporal job).
#
# ═══ THE PLATFORM CREATES NO APP NAMESPACE ═════════════════════════════════
# One namespace per app is the isolation contract: task
# queues, workflow ids, retention and search attributes are namespaced. But the
# platform is AGNOSTIC — it knows no app by name. An app therefore creates its
# own namespace from ITS bootstrap.sh, exactly as it creates its Postgres
# database and its S3 bucket:
#
#     ./temporal/ns-create.sh <app> [retention]
#
# `default` is provisioned here only because the auto-setup image expects it and
# because a `temporal` CLI with no `-n` points at it.
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/

. lib/temporal.sh

tctl_wait 60 || { echo "[temporal-seed] ✗ the cluster is not SERVING" >&2; exit 1; }
ns_ensure default 72h
echo "[temporal-seed] the cluster is SERVING — gRPC localhost:7233 · UI http://localhost:9233"
