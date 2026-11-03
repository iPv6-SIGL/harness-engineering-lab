# La démo de soutenance — mode d'emploi

**Ce qu'elle doit prouver.** Un agent de code livre vite, mais rien ne prouve
qu'il a construit ce qu'on demandait, avec les bons services, ni que ça marche.
Le harnais **cadre** la demande, **choisit** les briques et **prouve** le résultat
sur la vraie plateforme. Chaque étape ci-dessous montre un de ces gestes en
direct, puis un contraste mesuré avec des agents sans harnais.

Durée : **8 à 10 minutes** (dont 3 dans le navigateur). Tout tourne en local,
sans clé d'IA. Rien n'est détruit : les plans sont rejoués dans un dossier
temporaire et la dérive injectée est toujours retirée, même sur Ctrl-C.

## Avant de monter sur scène (10 min)

```bash
./up.sh                          # tout le lab : plateforme + DeskBook, PhotoShelf, GearUp
DEMO_AUTO=1 bash demo/demo.sh    # répétition sans pause : doit finir sur « FIN », exit 0
bash demo/creds.sh               # les comptes de test (à NE PAS projeter)
```

Ouvrir à l'avance, connecté (un onglet par persona, ou une fenêtre privée pour le second) :

| Onglet | Adresse | Compte |
|---|---|---|
| PhotoShelf · marketing | http://localhost:8020 | `photoshelf-test-marketing` |
| PhotoShelf · boutique (anonyme) | fenêtre privée, même adresse | aucun |
| GearUp · employé | http://localhost:8030 | `gearup-test-employee` |
| GearUp · manager | fenêtre privée, http://localhost:8030 | `gearup-test-manager` |
| Console des attentes | http://localhost:9233/namespaces/gearup/workflows | aucun |

**Ordre** : faire la répétition (`DEMO_AUTO=1`) *avant* d'ouvrir les onglets. Les
scénarios de GearUp ferment les demandes restées en attente : une demande créée avant
la répétition aurait disparu. Si une page paraît ancienne après un redéploiement :
Ctrl+Maj+R (le navigateur garde `app.js` en cache).

Photos à envoyer : `photoshelf/e2e/fixtures/` (`shoot-2000.jpg` donne les trois tailles,
`narrow-500.png` une seule : pas d'agrandissement).

## Le déroulé

Lancer `bash demo/demo.sh` et appuyer sur Entrée à chaque `[Entrée]`.
`bash demo/demo.sh 4` reprend à l'étape 4 si on manque de temps.

### 1 · Cadrer — 1 min 30
- **On voit** la demande DeskBook d'un paragraphe, notée 3/5 ; trois questions ; le plan refusé (exit 3) ; la version complétée, 5/5.
- **On dit** : « Sans harnais, l'agent aurait choisi seul : les 3 agents DeskBook ont fixé la répétition à 52 semaines sans le dire. Ici, pas une ligne de code tant que la demande est floue, et seulement les questions qui changent une brique. »

### 2 · Choisir — 1 min 30
- **On voit** les trois factures : DeskBook 9 points sur 10, PhotoShelf et GearUp 13 sur 17, avec les briques achetées (+) et refusées (−), puis la décision écrite « pas de file d'attente » et sa condition de réouverture.
- **On dit** : « Même harnais, même socle, trois architectures. Un point d'exploitation, c'est une chose de plus à surveiller pour la vie de l'app. Un refus est écrit, avec ce qui le rouvrira. »

### 3 · Les apps tournent — 3 min (navigateur)
- **PhotoShelf** : en marketing, saisir un SKU (ex. `DEMO-01`), envoyer `shoot-2000.jpg` et `narrow-500.png`. La barre progresse pendant que le travailleur redimensionne ; la fenêtre anonyme (« On the shop ») montre les photos **sans connexion**.
- **GearUp** : en employé, demander un casque ; en manager, l'approuver : la demande passe à `ordered`, le budget baisse de 120 €. Demander ensuite un `LAPTOP-14` et le laisser en attente.
- **Console** : ouvrir le workflow `request-…` à l'état **Running** ; l'entrée montre `remindAfterMs: 172800000` (2 jours), l'onglet *Event History* l'événement **Timer Started**. L'attente est durable : elle survit à un redémarrage.
- **On dit** : « Ce sont les briques de la facture, et seulement elles : une file pour les photos, une attente durable pour la validation. »

### 4 · Prouver — 2 min 30
- **On voit** l'agent arrêté **pendant qu'il écrit** : ajouter une file d'attente à GearUp, un workflow à PhotoShelf, cocher lui-même ses tâches. Trois refus, avec la décision citée.
- Puis `verify-task` (les 16 scénarios de PhotoShelf rejoués en vrai), et **un piège en direct** sur une copie du code : dans PhotoShelf, « au plus 200 photos » devient « moins de 200 » → ses tests passent au **rouge** (31 pass, 1 fail). Le même genre de piège dans le DeskBook d'un agent sans harnais (deux réservations bout à bout deviennent un conflit) → ses tests restent **verts** (15 pass, 0 fail) : le bug partirait en production.
- Enfin `reconcile` : 0 dérive, 10/10 tâches, **83 % des pièges détectés**, traces du socle, **latence p99 sous 350 ms**.
- Enfin une dérive invisible dans le code (un script écrit une clé Valkey pour GearUp) : verdict **rouge**, livraison refusée ; on la retire : **vert**.
- **On dit** : « Le harnais ne croit pas le code sur parole : il vérifie ce que la plateforme a réellement vu. »

### 5 · Et sans harnais ? — 1 min
- **On voit** un agent seul où « est connecté celui qui le dit » (en-tête `X-User`), les scores de pièges des 9 agents (8 sous le seuil), et le serveur d'e-mail qu'un agent a ajouté au socle commun sans le dire.
- **On dit** : « Ce n'est pas l'agent qui est mauvais : personne ne lui demandait ces preuves. Le harnais les rend obligatoires. »

## Si quelque chose casse

| Symptôme | Remède |
|---|---|
| « La plateforme ne répond pas » | `./up.sh` (après un redémarrage, les secrets sont en mémoire) |
| Page de connexion blanche | relancer le job `provision` de l'app (`cd photoshelf && gitlab-ci-local --force-shell-executor provision`) |
| Une étape s'éternise | Ctrl-C (la dérive est nettoyée), puis `bash demo/demo.sh <étape suivante>` |
| Plus de réseau | tout est local ; seule l'étape 3 demande le navigateur |

## Répétition du 03/11/2026 (ce qui a été vérifié)

- `DEMO_AUTO=1 bash demo/demo.sh` : exit 0. Les verdicts attendus apparaissent dans l'ordre : 3/5 puis 5/5 ; 9, 13 et 13 points ; trois refus du garde-fou (exit 2) ; PhotoShelf vert ; GearUp rouge, merge refusé, puis vert.
- Pièges en direct (`bash demo/demo.sh 4`) : PhotoShelf 31 pass / 1 fail (détecté), agent sans harnais 15 pass / 0 fail (raté). Les copies sont jetées, le code d'origine n'est pas touché.
- Navigateur, PhotoShelf : connexion marketing → envoi d'une photo de 2000 px et d'une de 500 px → « 2 / 2 resized », 3 tailles contre 1. (Répété avec des images générées dans la page, passées au même champ de fichier : le sélecteur de fichiers lui-même est celui du navigateur, à essayer une fois avant la séance avec `photoshelf/e2e/fixtures/`.) La boutique répond sans session (200), l'envoi sans connexion est refusé (401), la grande taille est servie en `image/webp` à un anonyme.
- Navigateur, GearUp : employé → casque et portable demandés ; manager → casque approuvé, `ordered`, budget −120 € ; portable resté en attente, visible **Running** dans la console.

**Bug trouvé par cette répétition, et corrigé.** Une image à l'en-tête valide mais
au contenu corrompu était acceptée, puis le travailleur la réessayait sans fin : le
lot restait à « 0 / 1 » pour toujours, et le scénario `batch-200` (0 message en
attente) aurait échoué pendant la démo. Désormais l'image est marquée illisible,
acquittée, et le lot se termine en le signalant (« 1 unreadable, not published »).
PhotoShelf : 10/10 tâches, 85 % des pièges détectés, verdict vert.

## Ce que la démo ne montre pas (et qu'il faut dire si on le demande)

- La relecture par un second modèle d'IA est sautée : pas de clé d'IA sur la plateforme.
- L'expiration à 3 jours n'est pas attendue en direct : on montre le minuteur posé.
- Les agents sans harnais n'avaient pas le droit d'exécuter leur code ; les chiffres viennent de `harness/evals/vibe/` (01/11/2026).
