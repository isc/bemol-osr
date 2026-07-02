# CLAUDE.md — conventions du projet

**Bémol** est une web app de visualisation du **planning de l'Orchestre de la
Suisse Romande (OSR)**, à destination des musiciens de l'orchestre. Elle
remplace un PDF statique (« Bible de saison ») par une interface toujours à
jour, alimentée par l'export ICS du logiciel de planification Dièse.

Ce fichier décrit les conventions à respecter **impérativement** quand tu
modifies l'application, pour que tout reste cohérent et fonctionne en
production (GitHub Pages) comme dans les previews de PR.

## Architecture

- **Site statique, sans étape de build.** Trois fichiers : `index.html`,
  `style.css`, `app.js`. Pas de framework, pas de bundler, pas de CDN, pas de
  dépendance externe.
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
- Le workflow `.github/workflows/update-data.yml` l'exécute toutes les 2 h,
  committe si quelque chose a changé et republie le site.
- **Ne jamais éditer les fichiers de `data/` à la main** : ils sont générés.
  Pour tester en local : `node scripts/update-data.mjs chemin/vers/export.ics`.
- Format d'un événement dans `planning.json` :
  `{ uid, start, end, liste, activity, category, location, project, cancelled }`
  avec `start`/`end` en heure locale « `2026-08-13T21:15` » (fuseau de Genève),
  `liste` comme « Liste 04 » / « Liste A », `category` parmi : `concert`,
  `generale`, `italienne`, `enregistrement`, `repetition`, `concours`, `autre`,
  `resa`.
- `changes.json` : `{ entries: [{ at, added: [evt], removed: [evt], modified:
  [{ uid, fields, before, after }] }] }`, entrée la plus récente en premier.

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

## Style de code

- Prettier est configuré (`.prettierrc` : `tabWidth: 2`, pas de point-virgule).
- JavaScript moderne natif (modules non nécessaires côté navigateur, un seul
  fichier `app.js`), pas de TypeScript.
- Le DOM est construit via le helper `el()` de `app.js` — pas d'`innerHTML`
  avec des données du planning (risque d'injection).

## Déploiement (pour info)

- Push sur `main` → publication sur GitHub Pages
  (<https://isc.github.io/bemol-osr/>).
- Chaque PR → preview isolée déployée automatiquement, avec lien posté en
  commentaire. C'est cette preview qui sert à valider un changement avant merge.
- Mise à jour des données : workflow cron `update-data.yml` (toutes les 2 h).
