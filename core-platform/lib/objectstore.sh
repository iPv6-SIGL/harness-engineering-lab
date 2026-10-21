#!/usr/bin/env bash
# lib/objectstore.sh — provisioning the S3 object store (SeaweedFS, Apache-2.0).
#
# Source it, then:
#
#     . "$(dirname "$0")/lib/objectstore.sh"
#     s3_wait
#     s3_ensure_bucket   myapp
#     s3_ensure_identity myapp myapp "$AK" "$SK"     # scoped to the myapp bucket
#     s3_allow_anonymous_read myapp                  # public assets, optional
#
# ═══ WHY `podman exec ... weed shell` AND NOT AN S3 CLIENT ═════════════════
# Creating a bucket is plain S3 (any client can do it). Creating a SCOPED
# CREDENTIAL is an admin operation, and every object store exposes its own:
# MinIO had `mc admin user svcacct add`, SeaweedFS has `weed shell s3.configure`.
# We go through the container so that provisioning needs NO host CLI at all —
# `mc` becomes a convenience for humans, not a prerequisite.
#
# The isolation this buys (verified): an identity created with
# `-buckets=<app> -actions=Read,Write,List,Tagging` gets `Access Denied` on
# any other bucket. That is strictly better than the shared root key the
# platform used to hand out.
#
# Env read (all optional):
#   S3_CONTAINER  default s3
#   S3_MASTER     default localhost:9333   (the master, as seen INSIDE the container)
#   S3_URL        default http://localhost:9000  (the S3 API, as seen from the HOST)
#   S3_BROWSER_URL default http://localhost:9001  (the filer browser, host view)
# ═══════════════════════════════════════════════════════════════════════════

S3_CONTAINER="${S3_CONTAINER:-s3}"
S3_MASTER="${S3_MASTER:-localhost:9333}"
S3_URL="${S3_URL:-http://localhost:9000}"
S3_BROWSER_URL="${S3_BROWSER_URL:-http://localhost:9001}"
export S3_URL S3_BROWSER_URL

# s3_shell <weed-shell-command...> — pipes one command into `weed shell`.
# `weed shell` reads its commands on stdin; it exits after the last one.
s3_shell() {
  podman exec -i "$S3_CONTAINER" sh -c \
    "echo '$*' | weed shell -master=$S3_MASTER" 2>&1
}

# s3_wait [attempts] — blocks until the S3 gateway answers.
# /healthz, not / : once the first identity exists (seed-admin.sh, and from then
# on across every restart — identities persist in the volume) the store is
# authenticated and an anonymous GET / is a 403, i.e. "never ready".
s3_wait() {
  local n="${1:-60}" i
  for i in $(seq 1 "$n"); do
    curl -sf -o /dev/null "$S3_URL/healthz" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# s3_bucket_exists <bucket>
# `s3.bucket.list` prints one bucket per line as:
#     "  <name>\tsize:0\tlogical:0\tchunk:0[\towner:\"…\"]"
# so the name is field 1 of the whitespace-split line — never the whole line.
s3_bucket_exists() {
  s3_shell "s3.bucket.list" | awk -v b="$1" '$1 == b { found = 1 } END { exit !found }'
}

# s3_ensure_bucket <bucket> — idempotent.
s3_ensure_bucket() {
  if s3_bucket_exists "$1"; then
    echo "[s3] the bucket '$1' already exists"
  else
    s3_shell "s3.bucket.create -name=$1" >/dev/null
    echo "[s3] the bucket '$1' was created"
  fi
}

# s3_ensure_identity <user> <bucket> <access_key> <secret_key>
#   Creates (or updates) an identity whose rights are SCOPED to <bucket>.
#   Idempotent: re-running with the same keys is a no-op server-side.
#
#   ⚠ TWO TRAPS, both cost a debugging session:
#     1. The secret key has to be >= 8 characters — the S3 clients (mc, aws-cli)
#        refuse anything shorter before even sending the request.
#     2. Pass BARE actions (`-actions=Read,Write,…`) alongside `-buckets=<b>`.
#        SeaweedFS then stores `Read:<b>` — a BUCKET-level grant. Qualifying the
#        action yourself (`-actions=Read:<b>`) stores `Read:<b>:<b>`, where the
#        third segment is an OBJECT PREFIX: the identity is then denied on the
#        bucket root and can only touch keys under `<b>/`. Verified both ways.
s3_ensure_identity() {
  local user="$1" bucket="$2" ak="$3" sk="$4"
  if [ "${#sk}" -lt 8 ]; then
    echo "[s3] ✗ the secret key of '$user' is shorter than 8 characters — the S3 clients would refuse it" >&2
    return 1
  fi
  s3_shell "s3.configure -access_key=$ak -secret_key=$sk -user=$user \
-buckets=$bucket -actions=Read,Write,List,Tagging -apply" >/dev/null
  echo "[s3] the identity '$user' is scoped to the bucket '$bucket'"
}

# s3_ensure_admin <access_key> <secret_key> — the platform's admin identity
# (every action, every bucket). It is the equivalent of the old MinIO root user.
#
# ⚠ ORDER MATTERS: as long as NO identity exists, the SeaweedFS gateway serves
#   everything anonymously. From the first identity onwards it authenticates.
#   So this is the call that closes the store — the pipeline runs it right after
#   the compose-up.
s3_ensure_admin() {
  local ak="$1" sk="$2"
  s3_shell "s3.configure -access_key=$ak -secret_key=$sk -user=platform-admin \
-actions=Admin,Read,Write,List,Tagging -apply" >/dev/null
  echo "[s3] the identity 'platform-admin' is active — the store now requires authentication"
}

# s3_allow_anonymous_read <bucket> — public read on ONE bucket (static assets
# served straight to the browser). Everything else stays closed.
s3_allow_anonymous_read() {
  s3_shell "s3.configure -user=anonymous -buckets=$1 -actions=Read -apply" >/dev/null
  echo "[s3] anonymous read is granted on the bucket '$1'"
}
