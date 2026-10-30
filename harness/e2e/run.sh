#!/usr/bin/env bash
# e2e/run.sh — the reconciliation harness, end to end, on the running platform.
#
#   frame (1–5) → gate → build + deploy the app → task loop (6–9)
#   → PREVENT / DETECT / PROVE a drift → reconcile (10–13) → merge gate (14) → learn (16, 18)
#
# Prerequisite: the core platform is up (core-platform: gitlab-ci-local --force-shell-executor).
# No LLM key needed: the run is deterministic; the cross-family reviewer reports
# itself as skipped and the human gate is told so.
set -uo pipefail
cd "$(dirname "$0")/../.."           # the repository root
export PATH="$HOME/.bun/bin:$PATH"
H="bun harness/src/cli.ts"
APP_DIR=deskbook
STEP=0; FAILS=0
step() { STEP=$((STEP + 1)); printf "\n\033[1m── %02d · %s\033[0m\n" "$STEP" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
ko()   { printf "  \033[31m✗\033[0m %s\n" "$*"; FAILS=$((FAILS + 1)); }
expect_exit() { # <expected-code> <label> <cmd...>
  local want=$1 label=$2; shift 2
  local out; out="$("$@" 2>&1)"; local got=$?
  if [ "$got" = "$want" ]; then ok "$label (exit $got)"; else ko "$label — expected exit $want, got $got"; echo "$out" | tail -20; fi
  LAST="$out"
}

step "the platform is up"
curl -sf http://localhost:8200/v1/sys/health >/dev/null && ok "core platform answers" || { ko "start core-platform first"; exit 1; }

step "harness unit tests + typecheck"
expect_exit 0 "bun test harness/test" bash -c "cd harness && bun install --frozen-lockfile >/dev/null && bun test test/ && bunx tsc --noEmit"

step "evals: with vs without, every rule proven by a case (step 18)"
expect_exit 0 "26 cases, ablation" $H evals
echo "$LAST" | grep -E "ops points across|rules proven" | sed 's/^/  /'

step "clean the run state (generated files only — the builder's code and the archived history stay)"
SNAP="$(mktemp -d)"; [ -d "$APP_DIR/openspec" ] && cp -r "$APP_DIR/openspec" "$SNAP/"
rm -rf "$APP_DIR/.harness" "$APP_DIR/openspec/changes/add-deskbook" "$APP_DIR/artifacts"
ok "removed .harness/ artifacts/ and the open change (openspec/specs + changes/archive kept, snapshot in $SNAP)"

step "brief loop: v1 is too thin (steps 1–4)"
expect_exit 3 "brief-check v1 asks its questions" $H brief harness/briefs/deskbook.v1.yaml
echo "$LAST" | grep -E "BRIEF-CHECK|^  \?" | sed 's/^/  /'
expect_exit 3 "plan refuses an unready brief" $H plan harness/briefs/deskbook.v1.yaml --app-dir "$APP_DIR"

step "plan v2: graph, bill, decisions, guards, OpenSpec (steps 2–5)"
expect_exit 0 "plan v2" $H plan harness/briefs/deskbook.v2.yaml --app-dir "$APP_DIR"
echo "$LAST" | sed 's/^/  /' | head -20
grep -q "9 / 10" <<<"$LAST" && ok "bill 9 / 10 — casdoor (R1–R5) + s3 (R4)" || ko "unexpected bill"
for f in proposal.md design.md tasks.md specs/deskbook/spec.md; do
  [ -s "$APP_DIR/openspec/changes/add-deskbook/$f" ] && ok "openspec/changes/add-deskbook/$f" || ko "missing $f"
done

step "spec gate (step 5): nothing is checked against an unapproved plan"
expect_exit 1 "verify-task before approval is refused" $H verify-task "$APP_DIR" all
expect_exit 0 "spec approved" $H approve "$APP_DIR" spec --by "${HARNESS_HUMAN:-e2e-runner (stand-in for the human reviewer)}" --note "bill and D1–D4 reviewed"

step "the app pipeline: provision → gates (fitness, lint, test, audit, secrets) → build → deploy → verify"
expect_exit 0 "gitlab-ci-local (deskbook)" bash -c "cd $APP_DIR && gitlab-ci-local --force-shell-executor"
echo "$LAST" | grep -E "^ (PASS|FAIL) " | sed 's/^/ /'

step "task loop (steps 6–9): each task's spec scenarios, as the seeded personas"
expect_exit 0 "ledger: every task passes" $H verify-task "$APP_DIR" all
echo "$LAST" | sed 's/^/  /'

step "PREVENT (step 7): the PreToolUse hook refuses what breaks a decision"
hook() { echo "$1" | bun harness/hooks/guard.ts; }
expect_exit 2 "Edit adding ioredis → refused, D3 quoted back" hook "{\"cwd\":\"$PWD/$APP_DIR\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PWD/$APP_DIR/api/src/server.ts\",\"old_string\":\"import { S3Client } from \\\"bun\\\";\",\"new_string\":\"import { S3Client } from \\\"bun\\\";\\nimport Redis from \\\"ioredis\\\";\"}}"
echo "$LAST" | head -2 | sed 's/^/    /'
expect_exit 2 "bun add bullmq → refused" hook "{\"cwd\":\"$PWD/$APP_DIR/api\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"bun add bullmq\"}}"
expect_exit 2 "Write .harness/ledger.json → refused (the ledger is the harness's)" hook "{\"cwd\":\"$PWD/$APP_DIR\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PWD/$APP_DIR/.harness/ledger.json\",\"content\":\"{}\"}}"
expect_exit 2 "Write a worker service into the compose → refused" hook "{\"cwd\":\"$PWD/$APP_DIR\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PWD/$APP_DIR/podman-compose.yml\",\"content\":\"services: {worker: {}}\"}}"

step "DETECT (step 7, CI): a hand edit that bypassed the hook is caught by fitness"
TMP="$(mktemp -d)"; cp -r "$APP_DIR/." "$TMP/"; rm -rf "$TMP/api/node_modules"
printf '\nconst cache = new Bun.RedisClient("redis://valkey.internal:6379");\nexport { cache };\n' >> "$TMP/api/src/server.ts"
expect_exit 1 "fitness on the tampered copy" $H fitness "$TMP"
echo "$LAST" | sed 's/^/    /'
rm -rf "$TMP"

step "PROVE (step 11): the platform witness catches what no code scan saw"
podman exec valkey.internal valkey-cli set deskbook:cache:hot 1 >/dev/null
ok "a stray deskbook:* key written in Valkey (a script outside the repo, say)"
expect_exit 1 "reconcile → drift, routed back to step 5" $H reconcile "$APP_DIR"
echo "$LAST" | grep -E "✗|→ back to|reconciler" | sed 's/^/  /'
expect_exit 1 "merge gate refused while the verdict is not green" $H approve "$APP_DIR" merge --by "e2e-runner"
podman exec valkey.internal valkey-cli del deskbook:cache:hot >/dev/null
ok "stray key removed"

step "reconcile (steps 10–13): fitness, ledger, mutants, witness, reviewer"
expect_exit 0 "reconciler: green" $H reconcile "$APP_DIR"
echo "$LAST" | sed 's/^/  /'

step "merge gate (step 14) and learning (step 16)"
expect_exit 0 "merge approved" $H approve "$APP_DIR" merge --by "${HARNESS_HUMAN:-e2e-runner (stand-in for the human reviewer)}" --note "reviewer skipped (no provider key): diff read by the human"
expect_exit 0 "mine the runs" $H mine "$APP_DIR"
echo "$LAST" | sed 's/^/  /'
RUN="$(python3 -c 'import json;print(json.load(open("deskbook/.harness/ledger.json"))["run"])')"

step "archive (step 15): today's truth, the decision log, the evidence pack"
APP=harness CORE_PLATFORM="$PWD/core-platform" core-platform/templates/bootstrap.sh >/dev/null 2>&1 \
  && ok "the harness has its own bucket (APP=harness bootstrap)" || ko "harness bootstrap failed"
expect_exit 0 "archive" $H archive "$APP_DIR"
echo "$LAST" | sed 's/^/  /'
LOG="$APP_DIR/openspec/specs/deskbook/decisions.md"
for g in "$APP_DIR"/.harness/guards/D*.yaml; do
  id="$(basename "$g" .yaml)"
  awk -v id="$id" -v run="$RUN" '$0 ~ "^## .*" run {r=1} r && $0 ~ "^### " id " " {d=1} d && /Revisit when/ {v=1} d && /Scales by/ {s=1} END {exit !(v && s)}' "$LOG" \
    && ok "$id archived with Revisit when + Scales by" || ko "$id missing from the decision log"
done
grep -q "^### Requirement: R5 " "$APP_DIR/openspec/specs/deskbook/spec.md" && ok "spec in force holds R1–R5" || ko "spec not merged"
[ ! -d "$APP_DIR/openspec/changes/add-deskbook" ] && ok "open change moved to openspec/changes/archive/" || ko "change not moved"
podman exec -i s3 sh -c "echo 's3.bucket.list' | weed shell -master=localhost:9333" 2>/dev/null | grep -q "^ *harness" \
  && ok "evidence pack in s3://harness/deskbook/$RUN/" || ko "no harness bucket"
expect_exit 2 "the builder cannot rewrite the archived log" hook "{\"cwd\":\"$PWD/$APP_DIR\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PWD/$LOG\",\"old_string\":\"x\",\"new_string\":\"y\"}}"
if [ "${E2E_ARCHIVE:-restore}" = "keep" ]; then
  ok "E2E_ARCHIVE=keep: the archive stays (commit it)"
else
  rm -rf "$APP_DIR/openspec"; [ -d "$SNAP/openspec" ] && cp -r "$SNAP/openspec" "$APP_DIR/"
  bun harness/src/cli.ts plan harness/briefs/deskbook.v2.yaml --app-dir "$APP_DIR" >/dev/null
  ok "versioned openspec/ restored and the open change re-planned (E2E_ARCHIVE=keep to keep this run's archive)"
fi

printf "\n\033[1m%s\033[0m\n" "$([ $FAILS = 0 ] && echo "E2E GREEN — $STEP steps" || echo "E2E RED — $FAILS failure(s)")"
exit $FAILS
