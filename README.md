# Bémol ♭ — Planning OSR

Web app de visualisation du planning de l'**Orchestre de la Suisse Romande**,
pour les musiciens de l'orchestre. Elle remplace la « Bible de saison » PDF
statique par une interface toujours à jour, alimentée automatiquement par
l'export ICS du logiciel de planification (Dièse).

**App : <https://isc.github.io/bemol-osr/>**

## Fonctionnalités

- **Vue Grille** : reprend la présentation de la « Bible de saison » — périodes
  de 4 semaines, colonnes Lundi→Dimanche, lignes Matin / Après-midi / Soir,
  codes couleur par type d'activité (concert, générale, italienne,
  enregistrement, répétition…).
- **Vue Agenda** : liste chronologique des prochains services, pratique sur
  téléphone (vue par défaut sur petit écran).
- **Vue Modifs** : journal des changements de planning détectés à chaque
  mise à jour de l'ICS (ajouts, annulations, changements d'horaire ou de
  lieu, avant → après). Un badge indique les nouveautés depuis ta dernière
  visite, et les événements récemment modifiés sont marqués d'un point rouge.
- **Préférences personnelles** (mémorisées sur l'appareil) : masquer des
  catégories d'un clic sur la légende, filtrer par Liste, afficher ou non les
  événements annulés.
- **Abonnement calendrier (ICS)** : bouton 📅 dans l'en-tête → abonne ton
  agenda habituel (iPhone, Google Agenda, Outlook…) au planning. Le calendrier
  ([`data/planning.ics`](data/planning.ics)) se met à jour tout seul et enrichit chaque
  service avec les infos du mémo de production (chef, solistes, œuvres,
  instrumentation, effectif), comme la vue Grille. Un lien personnalisé (même
  bouton) suit en plus les Réglages actuels (listes/catégories), et peut être
  complété par des **notifications push** (⚙ Réglages) sur les changements
  concernant ces mêmes listes — le tout via un petit worker Cloudflare
  ([`worker/`](worker/)), seule exception à la règle « site 100 % statique ».
- Bouton « Aujourd'hui ». Une seule saison est publiée (la saison en cours,
  filtre `ONLY_SEASON` du pipeline — l'export ICS en contient d'autres).

## Architecture

Site **statique sans build** (HTML/CSS/JS natif) hébergé sur GitHub Pages :

- [`index.html`](index.html), [`style.css`](style.css), [`app.js`](app.js) —
  l'application.
- [`data/planning.json`](data/planning.json) — les événements normalisés,
  **générés** par le pipeline (ne pas éditer à la main).
- [`data/changes.json`](data/changes.json) — journal des différences entre
  deux relevés de l'ICS.
- [`scripts/update-data.mjs`](scripts/update-data.mjs) — téléchargement de
  l'ICS, conversion, calcul du diff. Zéro dépendance, Node ≥ 20.
- [`data/planning.ics`](data/planning.ics) — calendrier ICS abonnable, **généré** à
  partir de `planning.json` + `productions.json` (ne pas éditer à la main).
- [`scripts/build-ics.mjs`](scripts/build-ics.mjs) — génération du calendrier
  ICS enrichi (mémo de production). Zéro dépendance, Node ≥ 20.

### Pipeline de données

`.github/workflows/update-data.yml` s'exécute **toutes les 2 heures** :

1. Télécharge l'export ICS (URL dans le secret `ICS_URL` — elle contient un
   jeton d'accès, elle ne doit jamais apparaître dans le code).
2. Régénère `data/planning.json` ; s'il y a des changements, les journalise
   dans `data/changes.json`, régénère le calendrier `data/planning.ics`, committe
   et republie le site.

`update-data.mjs` régénère aussi le calendrier même quand le planning est
inchangé, pour que l'abonnement reflète les évolutions du mémo de production
(`productions.json`, régénéré chaque nuit par `update-memo.yml`) sous 2 h.

Test en local, sans toucher au vrai export :

```bash
curl -o /tmp/osr.ics "$ICS_URL"
node scripts/update-data.mjs /tmp/osr.ics
npx serve .   # ou python3 -m http.server
```

### Déploiement

- **`deploy.yml`** — push sur `main` → publication à la racine de la branche
  `gh-pages`.
- **`preview.yml`** / **`preview-cleanup.yml`** — chaque PR est déployée en
  preview isolée sous `previews/<branche>/`, avec lien posté en commentaire,
  puis nettoyée à la fermeture.

## Collaboration avec Claude (issues → PR)

Le dépôt est configuré pour que les évolutions puissent être demandées **sans
coder** :

1. Ouvre une **issue** décrivant le besoin (en français, comme tu
   l'expliquerais à un collègue).
2. Le workflow **`claude-issue-to-pr.yml`** lance Claude, qui implémente la
   demande et ouvre une **PR** ; la preview est déployée automatiquement et le
   lien posté sur la PR.
3. Teste la preview, puis laisse tes retours en commentant **`@claude …`** sur
   la PR ; le workflow **`claude.yml`** relance Claude qui ajuste et repush.
4. Le mainteneur relit et merge (squash).

### Mise en place (admin, une fois)

1. **Installer l'app GitHub Claude** sur le dépôt :
   <https://github.com/apps/claude> (permissions Contents / Issues / Pull
   requests). _Astuce : la commande `/install-github-app` dans Claude Code fait
   l'app + le secret d'un coup._
2. **Ajouter les secrets** (_Settings → Secrets and variables → Actions_) :
   - `CLAUDE_CODE_OAUTH_TOKEN` — généré avec `claude setup-token` (abonnement
     Claude Pro/Max, pas de facturation API).
   - `ICS_URL` — l'URL complète de l'export ICS Dièse.
3. **Inviter les contributeurs comme collaborateurs** (accès _write_) :
   _Settings → Collaborators_. C'est ce statut qui sert de barrière anti-abus —
   les workflows Claude ne se déclenchent que pour le propriétaire ou des
   collaborateurs.

> **Confidentialité** : le dépôt est public (GitHub Pages gratuit l'exige) ;
> le planning normalisé (`data/`) est donc visible publiquement, comme le
> serait le site. L'URL de l'export ICS, qui contient un jeton personnel,
> reste secrète. Ne jamais committer de données nominatives sensibles.
