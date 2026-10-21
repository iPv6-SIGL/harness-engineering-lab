# The secret store's AUDIT DEVICE — every secret access (read/write, by whom,
# when) is appended to a file. The auditability brick of the platform.
#
# ═══ WHY THIS IS A FILE AND NOT A SCRIPT ═══════════════════════════════════
# It used to be `enable-audit.sh`, running `vault audit enable file …`.
# **OpenBao 2.6 removed that**: enabling an audit device through the API now
# returns
#
#     Code: 400. * cannot enable audit device via API;
#                  use declarative, config-based audit device management instead
#
# So the device is declared here and mounted into the container's config
# directory. Two things follow, both improvements:
#   · the trail is on **from the first boot**, not from whenever someone
#     remembered to run a script — an audit device you have to opt into is an
#     audit device that is off when it matters;
#   · it cannot be silently disabled at runtime.
#
# ⚠ The SYNTAX is unforgiving, and the error messages point elsewhere. It is
#   `audit "<type>" "<mount path>"` with the settings inside an `options` block.
#   `audit "file" { file_path = … }`            → "audit type must be specified"
#   `audit "file" "file/" { file_path = … }`    → the server starts, then dies
#                                                 with "file_path is required"
#   Only the form below works. (Verified against openbao:2.6.2.)
#
# ⚠ Do NOT also pass `-config=` on the command line: the image already loads
#   /openbao/config, and passing the file explicitly makes it load twice
#   ("ignoring duplicate configuration found in directory").
#
# The trail lands in the `openbao-logs` volume, so it survives a container
# restart even though the dev-mode secrets themselves do not.
#
# To read it:
#   podman exec openbao.internal sh -c 'tail -f /openbao/logs/audit.log'
#
# NB: values are HMAC'd in the trail — it records WHO touched WHICH path and
# WHEN, not the secret itself. That is the point: an audit log you would have to
# protect as hard as the vault is not an audit log.

audit "file" "file/" {
  options = {
    file_path = "/openbao/logs/audit.log"
  }
}
