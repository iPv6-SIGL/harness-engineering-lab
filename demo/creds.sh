#!/usr/bin/env bash
# demo/creds.sh — the seeded test personas of the demo apps (dev secret store, test-only passwords).
# Run it before going on stage, not on the projected screen.
for app in photoshelf gearup deskbook; do
  curl -s -H "X-Vault-Token: ${BAO_TOKEN:-root-dev-token}" "${BAO_ADDR:-http://localhost:8200}/v1/secret/data/$app/test-users" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["data"]; print(sys.argv[1] + ":"); [print("  ", k.removesuffix("_username"), "→", v) for k, v in d.items() if k.endswith("_username")]; print("   mot de passe →", d["shared_password"])' "$app"
done
