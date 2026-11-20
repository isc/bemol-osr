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
//     (variable GH_TOKEN) et les variables GITHUB_* fournies par Actions. À
//     l'ouverture, prévient aussi Ivan par email (RESEND_API_KEY, IVAN_EMAIL).

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
    // Vérifications, lancées avant le principal (même s'il échoue, elles
    // disent pourquoi) : leur échec fait échouer le run sans rien empêcher.
    // check-lien-ics.mjs : Dièse affiche-t-il toujours le lien de Bémol (#270) ?
    // Un changement de lien ouvre l'issue LIEN_ICS_ALERT plutôt que celle du
    // cron.
    checks: ["scripts/check-lien-ics.mjs"],
    // Scripts d'appoint, lancés après le principal : leur échec fait échouer
    // le run, donc ouvre l'issue d'alerte, mais n'empêche pas de publier le
    // planning (la version servie de leur fichier, restaurée ci-dessous avec
    // data/, reste en place).
    // update-salles.mjs : occupation des salles d'Uni Mail (#264).
    extras: ["scripts/update-salles.mjs"],
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

Causes possibles : jeton du lien ICS invalide ou expiré (secret \`ICS_URL\`), changement côté Dièse, incident GitHub. Si le journal du run dit seulement \`update-salles.mjs a échoué\`, le planning a bien été publié : seul l'écran « Salles Marie Laggé » n'est plus actualisé (lien partagé du secret \`SALLES_URL\`, format de la page Dièse). S'il dit \`check-lien-ics.mjs a échoué\` sans autre erreur, le planning a aussi été publié : c'est la page Dièse où s'affiche le lien ICS qui n'a pas pu être lue (adresse du secret \`DIESE_PAGE_URL\` périmée, à redemander à Loïc, ou format de la page changé). Les échecs suivants seront ajoutés en commentaire ici. **Fermer cette issue une fois le problème réglé.**

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

// check-lien-ics.mjs a vu sur la page Dièse un lien ICS autre que celui de
// Bémol. Ce n'est pas une panne du cron : issue distincte. La décision de
// changer de lien revient à Ivan (cf. CLAUDE.md, « Remplacer ICS_URL n'est pas
// un simple réglage ») ; Loïc est mis en copie pour les collègues abonnés
// directement à Dièse.
const LIEN_ICS_ALERT = {
  title: "⚠️ Dièse affiche un nouveau lien ICS",
  body: (
    runUrl,
  ) => `Le lien ICS affiché par Dièse (page « Calendriers partagés / Partitions / Documents ») n'est plus celui que lit Bémol (secret \`ICS_URL\`) : ${runUrl}

Bémol continue de lire l'ancien lien (s'il ne répond plus, le planning n'est plus mis à jour). Mais en novembre 2026 (#270), les deux liens ne couvraient pas la même chose : le nouveau avait un concours absent de l'ancien, l'ancien une quarantaine de services absents du nouveau.

**Ivan :** comparer les deux exports avant de remplacer le secret \`ICS_URL\` (nombre d'événements, horizon, services présents d'un seul côté). Claude peut le faire dans une session locale. Depuis #274, \`update-data.mjs\` rapproche les services des deux liens, mais ce que le nouveau n'a plus partira en retraits, avec une notification aux abonnés. La décision te revient.

@schneiderflute-create, pour info : rien à faire de ton côté, Bémol a repéré le changement tout seul. Les collègues abonnés directement au lien Dièse gardent l'ancien : ils devront se réabonner avec le nouveau.

Pour garder l'ancien lien, supprimer le secret \`DIESE_PAGE_URL\` : la vérification s'arrête. Sinon, tant que les deux liens diffèrent, une issue fermée est remplacée par une nouvelle au passage suivant, avec un nouvel email. **Fermer cette issue une fois le problème réglé.**`,
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

// Scripts annexes (checks, extras) : leur échec fait échouer le run sans
// interrompre la suite.
function runSide(scripts = [], suite = "") {
  for (const script of scripts) {
    const r = spawnSync("node", [script], { cwd: root, stdio: "inherit" })
    if (r.status !== 0) {
      console.log(`::warning::${script} a échoué${suite}`)
      process.exitCode = 1
    }
  }
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
  runSide(job.checks)
  const res = spawnSync("node", [job.script, ...rest], {
    cwd: root,
    stdio: "inherit",
  })
  if (res.status !== 0) process.exit(res.status ?? 1)
  runSide(job.extras, ", version servie conservée")

  // 3. Publier si le résultat diffère de ce que sert gh-pages. On compare à son
  // commit et non à l'index : un fichier qu'il n'a pas encore garde dans l'index
  // sa version de main, qui peut coïncider avec le résultat frais et le laisser
  // sans publication.
  git("add", "-A", "--", ...job.watch)
  const changed = !git(
    "diff",
    "--quiet",
    "--cached",
    "FETCH_HEAD",
    "--",
    ...job.watch,
  )
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

async function alert() {
  // Posée par check-lien-ics.mjs (cron du planning) dans GITHUB_ENV.
  const { title, body } = process.env.LIEN_ICS_CHANGE ? LIEN_ICS_ALERT : job
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
    `"${title}" in:title`,
    "--json",
    "number",
    "--jq",
    ".[0].number",
  )
  if (!num) {
    const url = gh(
      "issue",
      "create",
      "--title",
      title,
      "--body",
      body(runUrl),
      "--label",
      "besoin-ivan",
    )
    // Ivan a coupé ses notifications GitHub, l'issue seule ne le prévient pas.
    // Posée avec GITHUB_TOKEN, l'étiquette ne déclenche pas besoin-ivan.yml :
    // on envoie l'email ici. Un seul par panne : les échecs suivants ne font
    // que commenter l'issue, tant qu'elle reste ouverte.
    process.env.REPO = repo
    process.env.NUMBER = url.split("/").pop()
    await import("./besoin-ivan.mjs")
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
else await alert()
