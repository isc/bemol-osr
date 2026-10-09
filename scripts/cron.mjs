#!/usr/bin/env node
// Les étapes des crons de données (update-data.yml, update-memo.yml), sorties
// du YAML. Le bot Claude ne peut pas modifier .github/workflows/ (cf.
// CLAUDE.md) : tant que cette logique vivait dans les workflows, la moindre
// correction attendait Ivan (cf. #210 : diagnostic posté en une minute, appliqué
// 18 h plus tard). Ici, elle se corrige par une PR ordinaire, et ne s'exécute
// avec les secrets qu'une fois mergée sur main. Les workflows ne gardent que
// ce qui ne peut pas en sortir : déclencheurs, permissions, secrets, file
// d'attente gh-pages et publication.
//
// Usage (dans un workflow GitHub Actions) :
//   node scripts/cron.mjs run planning|memo [args…]
//     Récupère l'état servi sur gh-pages, lance le script de mise à jour (les
//     args lui sont transmis, ex. un export .ics local), détecte un changement
//     (sortie `changed=true|false`) et prépare dans out/ les fichiers à
//     publier sur gh-pages.
//   node scripts/cron.mjs alert planning|memo
//     Ouvre (ou commente) l'issue qui signale l'échec du cron. Utilise `gh`
//     (variable GH_TOKEN) et les variables GITHUB_* fournies par Actions.

import { spawnSync, execFileSync } from "node:child_process"
import { appendFileSync, cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// Rappel pour l'issue d'alerte : on ne recommente pas une issue dont le
// dernier message a moins de MIN_HOURS_BETWEEN_COMMENTS. Une panne externe
// longue (cf. #98, ~24 h d'indisponibilité de l'export Dièse) produisait sinon
// un commentaire à chaque passage du cron alors que le diagnostic ne change
// plus. L'échec reste de toute façon visible dans l'onglet Actions.
const MIN_HOURS_BETWEEN_COMMENTS = 6

const JOBS = {
  planning: {
    script: "scripts/update-data.mjs",
    // Fichiers servis à restaurer depuis gh-pages avant de régénérer : data/
    // est la référence du journal des différences (changes.json), et
    // productions.json le mémo vivant que build-ics.mjs reporte dans le
    // calendrier abonné (#215 : la copie de main, figée au 4 juillet, servait
    // depuis trois mois).
    live: ["data/", "productions.json"],
    // Fichiers régénérés : un changement déclenche la publication…
    watch: ["data/"],
    // …de ceux-ci (copiés tels quels dans out/, keep_files garde le reste).
    publish: ["data/"],
    title: "⚠️ La mise à jour automatique du planning ICS échoue",
    body: (
      runUrl,
    ) => `Le robot qui actualise le planning (depuis l'export ICS de Dièse) vient d'échouer : ${runUrl}

Tant que ce problème dure, le site continue de fonctionner mais affiche des données de plus en plus anciennes (un bandeau d'avertissement apparaît dans l'app au-delà de 26 h).

Causes possibles : jeton du lien ICS invalide ou expiré (secret \`ICS_URL\`), changement côté Dièse, incident GitHub. Les échecs suivants seront ajoutés en commentaire ici. **Fermer cette issue une fois le problème réglé.**

cc @isc`,
  },
  memo: {
    script: "scripts/update-memo.mjs",
    // L'état servi est la référence de la comparaison d'idempotence et du
    // journal des modifications du mémo (data/changes.json).
    live: ["productions.json", "data/"],
    watch: ["productions.json", "data/"],
    publish: ["productions.json", "data/changes.json"],
    title: "⚠️ La mise à jour automatique du mémo de production échoue",
    body: (
      runUrl,
    ) => `Le robot qui actualise le mémo de production (une fois par nuit depuis le mini-site Dièse) vient d'échouer : ${runUrl}

Le site continue de fonctionner : seules les infos de production (chef, solistes, œuvres, instrumentation) cessent d'être actualisées.

Causes possibles : changement du mini-site Dièse (URL, format du PDF), garde-fou du parseur déclenché (moins de 20 fiches), incident GitHub. Les échecs suivants seront ajoutés en commentaire ici. **Fermer cette issue une fois le problème réglé.**

cc @isc`,
  },
}

const [command, jobName, ...rest] = process.argv.slice(2)
const job = JOBS[jobName]
if (!["run", "alert"].includes(command) || !job) {
  console.error("Usage : node scripts/cron.mjs run|alert planning|memo")
  process.exit(2)
}

const git = (...args) =>
  spawnSync("git", args, { cwd: root, stdio: "inherit" }).status === 0

// Sortie d'étape lisible par le workflow (steps.<id>.outputs.<nom>).
function setOutput(name, value) {
  console.log(`${name}=${value}`)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

function run() {
  // 1. Les données de référence sont celles actuellement servies, pas
  // l'instantané de main.
  if (!git("fetch", "-q", "origin", "gh-pages")) process.exit(1)
  const missing = job.live.filter(
    (p) => !git("checkout", "-q", "FETCH_HEAD", "--", p),
  )
  if (missing.length)
    console.log(
      `gh-pages sans ${missing.join(", ")} (premier run, ou publication précédente incomplète)`,
    )

  // 2. Régénérer. Un échec fait échouer l'étape, donc déclenche l'alerte.
  const res = spawnSync("node", [job.script, ...rest], {
    cwd: root,
    stdio: "inherit",
  })
  if (res.status !== 0) process.exit(res.status ?? 1)

  // 3. Publier si quelque chose a changé. Si gh-pages n'avait pas encore l'un
  // des fichiers surveillés, on publie toujours : le `git diff` comparerait
  // alors au seul instantané de main, qui peut coïncider par hasard avec le
  // résultat frais et laisser gh-pages sans données.
  const incomplete = job.watch.some((p) => missing.includes(p))
  const changed = incomplete || !git("diff", "--quiet", "--", ...job.watch)
  setOutput("changed", changed)
  if (!changed) {
    console.log("Aucun changement à publier.")
    return
  }

  // 4. Dossier de mise en scène : on ne publie que les fichiers générés
  // (keep_files préserve tout le reste de gh-pages).
  const out = join(root, "out")
  rmSync(out, { recursive: true, force: true })
  for (const p of job.publish) {
    mkdirSync(dirname(join(out, p)), { recursive: true })
    cpSync(join(root, p), join(out, p), { recursive: true })
  }
}

function alert() {
  const repo = process.env.GITHUB_REPOSITORY
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
  const gh = (...args) =>
    execFileSync("gh", [...args, "-R", repo], { encoding: "utf8" }).trim()

  const num = gh(
    "issue",
    "list",
    "--state",
    "open",
    "--search",
    `"${job.title}" in:title`,
    "--json",
    "number",
    "--jq",
    ".[0].number",
  )
  if (!num) {
    gh("issue", "create", "--title", job.title, "--body", job.body(runUrl))
    return
  }
  // En cas de doute (API muette, date illisible), on commente : rater une
  // alerte est pire qu'un commentaire de trop.
  let last = NaN
  try {
    last = Date.parse(
      gh(
        "issue",
        "view",
        num,
        "--json",
        "comments,createdAt",
        "--jq",
        ".comments[-1].createdAt // .createdAt",
      ),
    )
  } catch {}
  const elapsedHours = (Date.now() - last) / 3_600_000
  if (elapsedHours < MIN_HOURS_BETWEEN_COMMENTS) {
    console.log(
      `Dernier message de l'issue #${num} il y a ${Math.floor(elapsedHours)} h (< ${MIN_HOURS_BETWEEN_COMMENTS} h) : pas de nouveau commentaire.`,
    )
    return
  }
  gh("issue", "comment", num, "--body", `Nouvel échec du cron : ${runUrl}`)
}

if (command === "run") run()
else alert()
