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
  `representation` (représentation d'opéra/ballet, distinguée du `concert`
  symphonique depuis #83 — reconnue aux ordinaux de l'activité, cf. § ci-dessous),
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

**Cas particulier : une preview (ou la prod) qui renvoie 404.** Avant de
chercher une cause dans le code, suspecter d'abord l'**infrastructure GitHub
Pages** : le build _natif_ « pages-build-deployment » se déclenche à chaque
écriture sur `gh-pages` (deploy de `main`, previews de PR, crons de données)
et, lors de rafales de push rapprochés, il lui arrive de rester figé sur
« building » ou d'échouer — l'URL répond alors 404 alors que le code est
parfaitement correct (cf. preview de la PR #65). Réflexe : vérifier l'état du
dernier build (`gh api repos/isc/bemol-osr/pages/builds/latest --jq .status`)
et, s'il est bloqué/en erreur, en redéclencher un
(`gh api -X POST repos/isc/bemol-osr/pages/builds`) — la page repasse en 200
sans toucher au code. Ne pas partir en chasse d'un bug fantôme.

## Style de code

- Prettier est configuré (`.prettierrc` : `tabWidth: 2`, pas de point-virgule).
- JavaScript moderne natif (modules non nécessaires côté navigateur, un seul
  fichier `app.js`), pas de TypeScript.
- Le DOM est construit via le helper `el()` de `app.js` — pas d'`innerHTML`
  avec des données du planning (risque d'injection).

## Descriptions de PR : commencer par le pourquoi

Une PR se relit **sans l'issue sous les yeux** (et c'est elle qui reste dans
l'historique). Sa description doit donc être auto-suffisante, dans cet ordre :

1. **Pourquoi** — reprendre la motivation exprimée dans l'issue, avec le
   contexte métier et, s'il éclaire la demande, le vécu raconté par son auteur
   (« consulter le planning en fosse dans le noir »…). Ne pas se contenter de
   « Closes #N » : le lien ferme l'issue, il ne raconte rien.
2. **Quoi** — ce qui change, du point de vue de l'utilisateur d'abord,
   technique ensuite.
3. **Comment vérifier** — preview, captures, cas à tester.

« Closes #N » reste obligatoire (fermeture automatique au merge), mais en
complément du pourquoi, pas à sa place.

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

3. Les référencer dans la description avec l'URL brute **suffixée `?v=1`** :
   `https://raw.githubusercontent.com/isc/bemol-osr/pr-assets/pr/<numéro>/<nom>.png?v=1`
   — par exemple dans un tableau avant/après.

4. **Vérifier l'affichage réel** : `node scripts/pr-images-check.mjs <numéro>`.
   Le CDN de raw (et le cache d'images des navigateurs des relecteurs) peut
   servir une version tronquée ou périmée d'une image ; le script compare ce
   qui est servi à la vraie taille du fichier (API GitHub) et incrémente
   lui-même le `?v=` dans la description en cas d'écart. À lancer après toute
   édition des images d'une description.

⚠️ Ne jamais **remplacer** une image existante de `pr-assets` sous le même nom
sans relancer le script du point 4 (les caches continueraient de servir
l'ancienne) — ou plus simple : nouveau nom de fichier à chaque version.

## Commentaires « @claude » sur une PR déjà mergée ou fermée

Quand un retour « @claude … » arrive sur une PR **déjà mergée ou fermée**, sa
branche n'existe plus (ou n'est plus déployée) : y repousser un commit ne
produit **aucune preview** et ne met **rien** en production. Ne jamais se
contenter, dans ce cas, de committer sur une branche jetable et de laisser un
lien « Create PR » pré-rempli : le demandeur est un musicien, pas un
développeur — il ne cliquera pas ce lien, verra que « rien n'a changé » et
relancera en boucle (cf. la série de retours sur la PR #84, débloquée
seulement le lendemain par l'ouverture manuelle de la PR #87).

Réflexe : si la PR ciblée est mergée ou fermée, **ouvrir une nouvelle pull
request vers `main`** (avec un « Closes #N » vers l'issue d'origine si elle est
encore ouverte) exactement comme pour une nouvelle demande, puis poster le lien
de cette PR. Ne repousser sur la branche existante que lorsque la PR est
**encore ouverte**.

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
