#!/usr/bin/env node
// Vérifie qu'un run Claude (claude-issue-to-pr.yml, claude.yml) a bien laissé
// un commentaire dans le fil de l'issue ou de la PR qui l'a déclenché.
//
// Un run qui finit sans rien publier, vert (#258, deux heures d'attente) ou
// rouge (plafond de tours, #83), laisse le musicien devant « Claude a pris
// cette issue en charge », à attendre une réponse qui ne viendra pas. Dans ce
// cas, le script le signale dans le fil, pose l'étiquette « besoin-ivan » et
// envoie l'email à Ivan (besoin-ivan.mjs : posée avec GITHUB_TOKEN,
// l'étiquette ne déclenche pas besoin-ivan.yml), puis sort en erreur : le run
// passe au rouge, ce qui archive la transcription.
//
// Repère : le commentaire de démarrage posté par le workflow, qui contient le
// lien du run. Il faut un commentaire de claude[bot] postérieur.
//
// Entrées (variables d'environnement) : GH_TOKEN, REPO, NUMBER, les GITHUB_*
// fournies par Actions, et pour l'email RESEND_API_KEY, IVAN_EMAIL.

import { execFileSync } from "node:child_process"

const { REPO, NUMBER, GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env
const runPath = `/actions/runs/${GITHUB_RUN_ID}`
const gh = (...args) =>
  JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }))
const thread = `repos/${REPO}/issues/${NUMBER}`

const comments = gh("--paginate", "--slurp", `${thread}/comments`).flat()
// Le dernier, pour le cas d'un job relancé (même lien de run).
const start = comments.findLast((c) => c.body.includes(runPath))
if (!start) throw new Error(`Commentaire de démarrage introuvable (${runPath})`)

const replied = comments.some(
  (c) => c.user.login === "claude[bot]" && c.created_at > start.created_at,
)
if (replied) {
  console.log(`Claude a répondu sur #${NUMBER}.`)
  process.exit(0)
}

gh(
  `${thread}/comments`,
  "-f",
  `body=⚠️ **Claude a terminé sans rien publier ici.** Réponds « @claude réessaie » pour le relancer. Ivan est prévenu ([détail du run](${GITHUB_SERVER_URL}/${REPO}${runPath})).`,
)
gh(`${thread}/labels`, "-f", "labels[]=besoin-ivan")
// besoin-ivan.mjs s'exécute à l'import, avec le même environnement : il
// envoie le dernier commentaire, l'avertissement ci-dessus.
await import("./besoin-ivan.mjs")
console.error(`Claude n'a rien publié sur #${NUMBER} : signalé dans le fil.`)
process.exit(1)
