#!/usr/bin/env bash
# objectstore/seed-admin.sh — closes the object store and publishes the platform
# admin credentials into the secret store.
#
# Idempotent. Called by core-platform/.gitlab-ci.yml (the seed-object-store job),
# also usable by hand:  ./objectstore/seed-admin.sh
#
# ═══ WHAT IT DOES, AND WHY IT MATTERS ══════════════════════════════════════
# SeaweedFS serves everything ANONYMOUSLY as long as no S3 identity exists.
# Creating the first identity is what switches the gateway into authenticated
# mode — so this script is a security step, not just a convenience.
#
# The admin credentials default to public dev values (overridable through
# S3_ROOT_USER / S3_ROOT_PASSWORD) and are published in
# secret/core/objectstore. An app never uses them: its bootstrap creates its own
# key scoped to its own bucket (templates/bootstrap.sh).
#
# The defaults S3_ROOT_USER / S3_ROOT_PASSWORD stay overridable through the env,
# for a workshop where everyone has to be able to open the browser with the
# credentials on a slide.
set -euo pipefail
cd "$(dirname "$0")/.."   # core-platform/

. lib/secrets.sh
. lib/objectstore.sh

S3_ROOT_USER="${S3_ROOT_USER:-platformadmin}"
S3_ROOT_PASSWORD="${S3_ROOT_PASSWORD:-platformadmin-dev-password}"

s3_wait 60 || { echo "[s3-seed] ✗ the S3 gateway does not answer on $S3_URL" >&2; exit 1; }
bao_wait 30 || { echo "[s3-seed] ✗ the secret store does not answer on $BAO_ADDR" >&2; exit 1; }

s3_ensure_admin "$S3_ROOT_USER" "$S3_ROOT_PASSWORD"

# The credentials are published so that the apps' bootstrap (and the humans) read
# them from ONE place rather than a variable copied from a README.
bao kv put secret/core/objectstore \
  endpoint="$S3_URL" \
  access_key="$S3_ROOT_USER" \
  secret_key="$S3_ROOT_PASSWORD" >/dev/null
echo "[s3-seed] the admin credentials are published in secret/core/objectstore"
echo "[s3-seed] the S3 API $S3_URL · the browser $S3_BROWSER_URL"
