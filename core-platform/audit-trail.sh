#!/usr/bin/env bash
# audit-trail.sh — reports on the secret store's audit device and tails the trail.
#
#     ./audit-trail.sh            # status + the last 20 accesses, one line each
#     ./audit-trail.sh --follow   # status + a live feed
#     ./audit-trail.sh --raw      # the raw JSONL (for jq / an export)
#
# ═══ THERE IS NOTHING TO ENABLE ════════════════════════════════════════════
# This script used to be `enable-audit.sh`. OpenBao 2.6 removed the ability to
# enable an audit device through the API — it is now declared in the server's
# config (`openbao/audit.hcl`, mounted by the compose) and is therefore active
# **from the first boot**. An audit device you have to opt into is an audit
# device that is off on the day you need it.
#
# So this script only observes. If it reports no device, the fix is the compose
# mount or the HCL syntax, not a command.
set -euo pipefail
cd "$(dirname "$0")"
. lib/secrets.sh

bao_wait 30 || { echo "[audit] ✗ the secret store is unreachable" >&2; exit 1; }

echo "── The audit devices ───────────────────────────────────────────────"
if bao audit list 2>/dev/null | grep -q '^file/'; then
  bao audit list
  echo
  echo "  ✓ the 'file/' device is active → /openbao/logs/audit.log (the openbao-logs volume)"
else
  echo "  ✗ NO audit device is active."
  echo "    It is declared in openbao/audit.hcl and mounted by the compose at"
  echo "    /openbao/config/audit.hcl. Check the mount, then the HCL syntax —"
  echo "    the error messages point elsewhere (see the header of that file)."
  echo "    podman logs openbao.internal | grep -i audit"
  exit 1
fi

echo
echo "── The trail ───────────────────────────────────────────────────────"
echo "  (values are HMAC'd: the trail records WHO touched WHICH path and WHEN,"
echo "   not the secret itself)"
echo
# Each entry is a fat JSON object (a few KB: the full request AND response, with
# every value HMAC'd). Twenty of those raw is a wall of text nobody reads, which
# is how an audit trail quietly stops being consulted. Default to one readable
# line per access; `--raw` keeps the JSONL for jq.
compact() {
  python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except json.JSONDecodeError:
        continue
    if e.get("type") != "response":      # request+response are paired; keep one
        continue
    r = e.get("request", {})
    a = e.get("auth", {})
    err = e.get("error")
    print("{:<24} {:<7} {:<45} {:<12} {}".format(
        e.get("time", "")[:19],
        r.get("operation", "?"),
        r.get("path", "?")[:45],
        a.get("display_name", "-")[:12],
        "ERROR: " + err if err else "",
    ))
'
}

case "${1:-}" in
  --raw)
    podman exec "$BAO_CONTAINER" sh -c 'tail -n 20 /openbao/logs/audit.log' ;;
  --follow|-f)
    printf '%-24s %-7s %-45s %-12s %s\n' TIME OP PATH WHO ""
    podman exec "$BAO_CONTAINER" sh -c 'tail -f /openbao/logs/audit.log' | compact ;;
  *)
    printf '%-24s %-7s %-45s %-12s %s\n' TIME OP PATH WHO ""
    podman exec "$BAO_CONTAINER" sh -c 'tail -n 40 /openbao/logs/audit.log' | compact | tail -n 20 ;;
esac
