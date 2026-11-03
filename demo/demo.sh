#!/usr/bin/env bash
# demo/demo.sh — the soutenance demo: what the harness adds, shown on the running platform.
#
#   1 · Cadrer    a thin request is refused before any code; three questions instead
#   2 · Choisir   three requests, three bills: what is bought, what is refused in writing
#   3 · Les apps  PhotoShelf and GearUp in the browser (the presenter drives, see demo/README.md)
#   4 · Prouver   the agent is stopped while it writes, the scenarios and traps run,
#                 a stray use on the platform turns the verdict red, then green again
#   5 · Sans      what agents without the harness delivered (measured on 01/11/2026)
#
# Nothing it does is destructive: the plans go to a temporary folder, the stray key
# it writes is always removed (even on Ctrl-C).
#
#   ./up.sh first, then:   bash demo/demo.sh            (Enter between steps)
#                          DEMO_AUTO=1 bash demo/demo.sh  (no pauses: the rehearsal)
#                          bash demo/demo.sh 4            (from step 4)
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
H="bun harness/src/cli.ts"
FROM="${1:-1}"
TMP="$(mktemp -d)"
STRAY="gearup:cache:hot"
cleanup() { podman exec valkey.internal valkey-cli del "$STRAY" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; C=$'\033[36m'; Y=$'\033[33m'; N=$'\033[0m'
title() { printf "\n${B}${C}━━ %s ━━${N}\n" "$*"; }
say()   { printf "${Y}» %s${N}\n" "$*"; }
pause() { [ "${DEMO_AUTO:-0}" = 1 ] && return; printf "${D}   [Entrée]${N}"; read -r _; }
run()   { printf "${D}\$ %s${N}\n" "$*"; eval "$@"; }
step()  { [ "$1" -ge "$FROM" ]; }

# The agent's edits, as Claude Code hands them to the PreToolUse hook (harness/hooks/guard.ts).
hook_edit() { # <app> <file> <old> <new>
  python3 -c 'import json,sys; print(json.dumps({"cwd": sys.argv[1], "tool_name": "Edit", "tool_input": {"file_path": sys.argv[2], "old_string": sys.argv[3], "new_string": sys.argv[4]}}))' \
    "$PWD/$1" "$PWD/$1/$2" "$3" "$4" | bun harness/hooks/guard.ts
}
hook_bash() { # <app> <command>
  python3 -c 'import json,sys; print(json.dumps({"cwd": sys.argv[1], "tool_name": "Bash", "tool_input": {"command": sys.argv[2]}}))' "$PWD/$1" "$2" | bun harness/hooks/guard.ts
}
# One trap, live: a copy of an API with one rule broken, then its own unit tests.
trap_live() { # <api dir> <file> <line> <from> <to>
  local src="$1" copy="$TMP/trap-$RANDOM"
  mkdir -p "$copy" && cp -r "$src/." "$copy/" 2>/dev/null; rm -rf "$copy/node_modules"
  [ -d "$src/node_modules" ] && ln -s "$src/node_modules" "$copy/node_modules"
  printf "${D}  ligne %s de %s :${N} %s\n" "$3" "$2" "$(sed -n "${3}p" "$copy/$2" | sed 's/^ *//')"
  sed -i "${3}s/$4/$5/" "$copy/$2"
  printf "${D}  piégée en      :${N} %s\n" "$(sed -n "${3}p" "$copy/$2" | sed 's/^ *//')"
  (cd "$copy" && bun test 2>&1 | grep -E "^ +[0-9]+ (pass|fail)" | tr '\n' ' '; echo)
  (cd "$copy" && bun test >/dev/null 2>&1)
}
verdict() { # <exit code> — what the audience should read
  if [ "$1" = 0 ]; then printf "  ${G}✓ accepté (exit 0)${N}\n"; else printf "  ${R}✗ refusé (exit %s)${N}\n" "$1"; fi
}

curl -sf http://localhost:8200/v1/sys/health >/dev/null || { echo "La plateforme ne répond pas : lancer ./up.sh d'abord."; exit 1; }

if step 1; then
title "1 · CADRER — une demande floue ne produit pas de code"
say "La demande DeskBook telle qu'un humain l'écrit d'abord :"
run "sed -n '/^prompt/,/^personas/p' harness/briefs/deskbook.v1.yaml | head -5"
pause
run "$H brief harness/briefs/deskbook.v1.yaml"; verdict $?
say "Le harnais pose au plus 3 questions — seulement celles qui changent une brique ou un besoin."
pause
run "$H plan harness/briefs/deskbook.v1.yaml --app-dir $TMP/deskbook-v1 | tail -4"
say "Le plan est refusé tant que la demande n'est pas complète. Avec les réponses (v2) :"
run "$H brief harness/briefs/deskbook.v2.yaml | head -1"
pause
fi

if step 2; then
title "2 · CHOISIR — trois demandes, trois factures"
say "Même harnais, même socle. Seul le besoin change. (Plans rejoués dans un dossier temporaire.)"
for app in deskbook:v2 photoshelf:v1 gearup:v1; do
  a="${app%%:*}"; v="${app##*:}"
  printf "\n${B}%s${N}\n" "$a"
  run "$H plan harness/briefs/$a.$v.yaml --app-dir $TMP/$a | grep -E '^run|^  [+−]'"
  pause
done
say "Un refus est une décision écrite, avec la condition qui la rouvrira :"
run "sed -n '/^### D3/,/^- \*\*Guard/p' $TMP/deskbook/openspec/changes/add-deskbook/design.md"
pause
fi

if step 3; then
title "3 · LES APPS TOURNENT — dans le navigateur"
say "PhotoShelf  http://localhost:8020   (marketing : envoyer des photos ; la boutique les voit sans connexion)"
say "GearUp      http://localhost:8030   (employé : demander ; manager : valider, le budget baisse)"
say "Attentes    http://localhost:9233   (namespace gearup : le minuteur de 2 jours est dans l'historique)"
say "Comptes de test : bash demo/creds.sh"
pause
fi

if step 4; then
title "4 · PROUVER — l'agent est arrêté pendant qu'il écrit"
say "L'agent de GearUp veut ajouter une file d'attente (Valkey), que la facture a refusée :"
hook_edit gearup api/src/server.ts 'import { Client, Connection } from "@temporalio/client";' $'import { Client, Connection } from "@temporalio/client";\nimport Redis from "ioredis";' 2>&1 | head -4
verdict $?
pause
say "L'agent de PhotoShelf veut un workflow durable, refusé lui aussi :"
hook_bash photoshelf "cd api && bun add @temporalio/client" 2>&1 | head -3
verdict $?
say "Et il ne peut pas cocher lui-même ses tâches :"
hook_edit photoshelf .harness/ledger.json '"passes": false' '"passes": true' 2>&1 | head -2
verdict $?
pause

title "4 · PROUVER — les besoins rejoués, les tests piégés, le socle témoin"
say "Chaque besoin de PhotoShelf est rejoué sur la vraie plateforme, avec de vrais comptes :"
run "$H verify-task photoshelf all"
pause
say "Un piège en direct. PhotoShelf (harnais) : « au plus 200 photos » devient « moins de 200 »."
trap_live photoshelf/api src/domain.ts 74 'files.length > MAX_BATCH' 'files.length >= MAX_BATCH'
if [ $? -ne 0 ]; then printf "  ${G}✓ piège détecté : les tests passent au rouge${N}\n"; else printf "  ${R}✗ piège raté${N}\n"; fi
pause
say "Le même genre de piège chez un agent sans harnais (DeskBook) : deux réservations bout à bout deviennent un conflit."
if [ -d ~/vibe-runs/desk1/app/api ]; then
  trap_live ~/vibe-runs/desk1/app/api src/domain.ts 20 'a.start < b.end' 'a.start <= b.end'
  if [ $? -ne 0 ]; then printf "  ${G}✓ piège détecté${N}\n"; else printf "  ${R}✗ piège raté : ses tests restent verts, le bug partirait en production${N}\n"; fi
else
  say "(code de l'agent absent sur cette machine : voir harness/evals/vibe/mutation-results.txt, desk1 L20 <→<=)"
fi
pause
say "Le harnais pose des dizaines de pièges comme celui-là et exige 70 % de détection. Puis la vérification complète :"
run "$H reconcile photoshelf"; verdict $?
pause

title "4 · PROUVER — une dérive que personne n'a vue dans le code"
say "Un script hors du dépôt se sert de Valkey pour GearUp (la décision le refuse) :"
run "podman exec valkey.internal valkey-cli set $STRAY 1 >/dev/null"
run "$H reconcile gearup | grep -E 'valkey|reconciler|back to'"; verdict $?
say "Tant que le verdict n'est pas vert, un humain ne peut pas accepter la livraison :"
run "$H approve gearup merge --by demo"; verdict $?
pause
say "On retire la dérive :"
run "podman exec valkey.internal valkey-cli del $STRAY >/dev/null"
run "$H reconcile gearup | grep -E 'valkey|p99|reconciler'"; verdict $?
pause
fi

if step 5; then
title "5 · ET SANS HARNAIS ? — 9 agents mesurés le 01/11/2026"
say "Un agent seul, DeskBook : qui est connecté ? Celui qui le dit."
run "sed -n '33,34p' ~/vibe-runs/desk1/app/api/src/server.ts"
pause
say "Ses tests sont verts… mais ne voient pas les pièges (seuil du harnais : 70 %) :"
run "sed -n '1,11p' harness/evals/vibe/mutation-results.txt | grep -E '^(harness|desk|spec|pay|gear)' | awk '{print \"  \" \$1, \$3, \$4, \$5}'"
pause
say "Une demande de plus (« un e-mail chaque lundi ») : les deux agents ont modifié le socle partagé sans le dire :"
run "grep -n -i -m2 mailpit ~/vibe-runs/chg1/core-platform/podman-compose.yml"
pause
fi

title "FIN — l'agent écrit le code ; le harnais fait en sorte qu'on puisse le croire"
