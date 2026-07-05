# CLAUDE.md — conventions du projet

**Bémol** est une web app de visualisation du **planning de l'Orchestre de la
Suisse Romande (OSR)**, à destination des musiciens de l'orchestre. Elle
remplace un PDF statique (« Bible de saison ») par une interface toujours à
jour, alimentée par l'export ICS du logiciel de planification Dièse.

Ce fichier décrit les conventions à respecter **impérativement** quand tu
modifies l'application, pour que tout reste cohérent et fonctionne en
production (GitHub Pages) comme dans les previews de PR.

## Architecture

- **Site statique, sans étape de build.** Le cœur tient en trois fichiers :
  `index.html`, `style.css`, `app.js`. S'y ajoutent, depuis la PWA (#31), le
  service worker `sw.js`, le `manifest.webmanifest` et le dossier `icons/`.
  Pas de framework, pas de bundler, pas de CDN, pas de dépendance externe.
- **PWA (installable + hors-ligne).** `sw.js` sert la page en _réseau d'abord_
  (une nouvelle version d'`index.html` est prise dès qu'on est en ligne) et met
  en cache les ressources versionnées par `?v=`. Si tu ajoutes un fichier
  chargé au premier lancement hors-ligne, pense à l'ajouter à la liste
  `PRECACHE` de `sw.js`.
- **Chemins relatifs uniquement.** Jamais de chemin commençant par `/`.
  C'est critique : le site est servi sous un sous-dossier (`/bemol-osr/`, et
  `/bemol-osr/previews/<branche>/` pour les previews de PR).
- **Interface 100 % en français.** Les utilisateurs sont des musiciens
  d'orchestre, pas des développeurs.
- **Mobile-friendly** : l'app est consultée surtout sur téléphone. Grandes
  cibles tactiles, la vue Agenda est la vue par défaut sur petit écran, les
  effets de survol restent dans `@media (hover: hover) { … }`.

## Pipeline de données (à ne pas casser)

- `scripts/update-data.mjs` (Node ≥ 20, zéro dépendance) télécharge l'export
  ICS (URL dans le secret Actions `ICS_URL` — **jamais en clair dans le code**,
  elle contient un jeton d'accès), le convertit en `data/planning.json` et
  journalise les différences dans `data/changes.json`.
- Le workflow `.github/workflows/update-data.yml` l'exécute toutes les 2 h et
  publie le résultat **directement sur la branche `gh-pages`** (jamais de push
  sur `main`). Les données vivantes n'existent que sur `gh-pages` ; les copies
  de `data/` et `productions.json` présentes sur `main` ne sont que des
  **instantanés** pour le dev local et le smoke test (les workflows de deploy
  et de preview servent toujours les données de `gh-pages`).
- `scripts/update-memo.mjs` (Node ≥ 20 + `pdftotext`) régénère de la même façon
  `productions.json` (chef, solistes, œuvres, instrumentation par programme) à
  partir du « Mémo de Production » du mini-site Dièse — génération PDF côté
  serveur puis parsing. Workflow `update-memo.yml`, une fois par nuit.
- **Ne jamais éditer `data/` ni `productions.json` à la main** : ils sont
  générés (et de toute façon jamais servis depuis `main`, cf. ci-dessus). Pour
  tester en local : `node scripts/update-data.mjs export.ics` /
  `node scripts/update-memo.mjs [memo.txt]`.
- `scripts/build-ics.mjs` (appelé par `update-data.mjs`) génère
  `data/planning.ics`, le calendrier abonnable. Chaque `VEVENT` porte des
  propriétés `X-BEMOL-LISTE` / `X-BEMOL-CAT` : elles servent au **worker
  Cloudflare** (`worker/`, seule exception à la règle « site 100 % statique »)
  qui filtre le calendrier à la volée pour les abonnements personnalisés
  (`?listes=…&sans=…&annules=0`). Test : `node worker/test.mjs` (aussi en CI).
  L'URL du worker est la constante `PERSONAL_CALENDAR_URL` d'`app.js` (vide =
  fonctionnalité masquée). Déploiement : `deploy-worker.yml` (inactif tant que
  la variable Actions `CLOUDFLARE_READY` n'est pas `true`).
- Format d'un événement dans `planning.json` :
  `{ uid, start, end, liste, activity, category, location, project, cancelled }`
  avec `start`/`end` en heure locale « `2026-08-13T21:15` » (fuseau de Genève),
  `liste` comme « Liste 04 » / « Liste A », `category` parmi : `concert`,
  `generale`, `italienne`, `enregistrement`, `repetition`, `concours`, `autre`,
  `resa`.
- `changes.json` : `{ entries: [{ at, added: [evt], removed: [evt], modified:
[{ uid, fields, before, after }] }] }`, entrée la plus récente en premier.
  Les évolutions du **mémo de production** (généré par `update-memo.mjs`) y sont
  journalisées avec un type distinct :
  `{ at, type: "memo", programs: [{ liste, status: "modified" | "added" |
"removed", fields: [{ field, before, after }], worksAdded: [oeuvre],
worksRemoved: [oeuvre], worksModified: [{ oeuvre, fields }] }] }`. Les deux
  scripts partagent le même plafond d'entrées (`MAX_CHANGE_ENTRIES`).

## Vocabulaire métier (important pour comprendre les demandes)

- Une **Liste** est un programme/production (Liste 01, Liste 24b, Liste A…) ;
  les numéros recommencent à chaque saison.
- Un **service** est une séance de travail (répétition, concert…).
- La **saison** va du 1er lundi d'août au dimanche précédant le 1er lundi
  d'août suivant, découpée en **périodes** de 4 semaines (c'est le découpage
  utilisé par la vue Grille, calqué sur la « Bible » de saison papier).
- Les ordinaux (« première », « neuvième »…) sont des **représentations**
  d'opéra ou de ballet ; « italienne », « scène et orchestre », « générale »
  sont des types de répétitions lyriques.
- Lieux fréquents : VH = Victoria Hall, UM-ML = Uni Mail salle Marie Laggé,
  GTG = Grand Théâtre de Genève, BFM = Bâtiment des Forces Motrices.

## Préférences utilisateur

Les préférences d'affichage (catégories masquées, filtre par liste,
affichage des annulés, vue courante) sont stockées dans `localStorage`
(`bemol-prefs`, `bemol-view`, `bemol-last-visit`). Toute nouvelle préférence
suit le même modèle : locale à l'appareil, jamais côté serveur.

## Face à un signalement de bug

Avant de construire un correctif complet, **vérifier d'abord que le
comportement signalé est réellement indésirable** : le reproduire avec les
données réelles (celles de `gh-pages`, cf. pipeline de données ci-dessus),
en pensant aux cas de bord — notamment l'**inter-saison** (aucune saison
n'est « en cours » entre la fin d'une saison et le 1er lundi d'août
suivant, cf. Vocabulaire métier). Si le comportement s'avère normal/voulu,
l'expliquer clairement et proposer de fermer l'issue sans changement,
plutôt que d'ouvrir une PR pour un problème qui n'existe pas.

## Style de code

- Prettier est configuré (`.prettierrc` : `tabWidth: 2`, pas de point-virgule).
- JavaScript moderne natif (modules non nécessaires côté navigateur, un seul
  fichier `app.js`), pas de TypeScript.
- Le DOM est construit via le helper `el()` de `app.js` — pas d'`innerHTML`
  avec des données du planning (risque d'injection).

## Captures d'écran dans les PRs (obligatoire pour tout changement visible)

Les relecteurs sont des musiciens : une PR qui change quelque chose à l'écran
doit **montrer le résultat en images dans sa description** (avant/après quand
c'est pertinent), en plus du lien de preview.

1. Générer les captures : `npm install --no-save playwright` puis
   `node scripts/screenshots.mjs <dossier> <prefixe>` (sert le dépôt local et
   capture les vues Grille/Agenda en mobile 390px et desktop 1280px). Pour un
   « avant », lancer le script depuis `main` avant d'appliquer les changements
   (ou depuis un worktree de `main`).
2. Les publier sur la branche **`pr-assets`** — une branche orpheline UNIQUE
   et partagée, réservée aux images des descriptions de PR, jamais mergée.
   **Ne pas créer une branche d'assets par PR**, et ne rien y supprimer (les
   PRs mergées y font toujours référence). Un dossier par PR :

   ```bash
   git fetch origin pr-assets
   git worktree add /tmp/pr-assets origin/pr-assets
   mkdir -p /tmp/pr-assets/pr/<numéro-de-PR>
   cp <captures>.png /tmp/pr-assets/pr/<numéro-de-PR>/
   cd /tmp/pr-assets && git add -f pr/ \
     && git commit -m "assets: captures PR #<numéro>" \
     && git push origin HEAD:pr-assets
   ```

   (Ouvrir la PR d'abord pour connaître son numéro, pousser les captures,
   puis compléter la description avec `gh pr edit`.)

3. Les référencer dans la description avec l'URL brute :
   `https://raw.githubusercontent.com/isc/bemol-osr/pr-assets/pr/<numéro>/<nom>.png`
   — par exemple dans un tableau avant/après.

## Déploiement (pour info)

- Push sur `main` → publication sur GitHub Pages
  (<https://isc.github.io/bemol-osr/>).
- Chaque PR → preview isolée déployée automatiquement, avec lien posté en
  commentaire. C'est cette preview qui sert à valider un changement avant merge.
- Mise à jour des données : workflow cron `update-data.yml` (toutes les 2 h).
- **Cache-busting automatique** : dans `index.html`, `app.js` et `style.css`
  sont référencés avec un suffixe `?v=dev`. Ce `dev` est un placeholder que les
  workflows de publication remplacent par le SHA du commit — **ne jamais le
  bumper à la main**, ni ajouter de suffixe de version manuel.
