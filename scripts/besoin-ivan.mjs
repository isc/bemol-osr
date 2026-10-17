#!/usr/bin/env node
// Prévient Ivan par email quand une issue ou une PR reçoit l'étiquette
// « besoin-ivan » (workflow besoin-ivan.yml).
//
// Claude la pose quand il ne peut pas avancer seul : modifier un fichier de
// .github/workflows/, poser un secret, un accès à Dièse, une décision qui
// revient à Ivan… Les notifications GitHub d'Ivan sont coupées (trop de bruit
// d'autres dépôts), d'où un email dédié, qui reprend le dernier commentaire
// posté pour qu'on sache sans ouvrir GitHub ce qui est attendu.
//
// Entrées (variables d'environnement) : RESEND_API_KEY, IVAN_EMAIL (secrets
// du dépôt, jamais en clair : le dépôt est public), GH_TOKEN, REPO, NUMBER.

const { RESEND_API_KEY, IVAN_EMAIL, GH_TOKEN, REPO, NUMBER } = process.env
const FROM = "Bémol <bemol@arabesque.app>"

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  })
  if (!res.ok) throw new Error(`GitHub ${path} : ${res.status}`)
  return res.json()
}

if (!RESEND_API_KEY || !IVAN_EMAIL) {
  console.error("RESEND_API_KEY ou IVAN_EMAIL absent : rien n'est envoyé.")
  process.exit(1)
}

const issue = await gh(`issues/${NUMBER}`)
// Les 100 derniers commentaires suffisent : on ne garde que le plus récent.
const comments = await gh(
  `issues/${NUMBER}/comments?per_page=100&page=${Math.max(1, Math.ceil(issue.comments / 100))}`,
)
const last = comments.at(-1)
const kind = issue.pull_request ? "PR" : "issue"

const text = [
  `On a besoin de toi sur la ${kind} #${NUMBER} « ${issue.title} » :`,
  issue.html_url,
  "",
  last
    ? `Dernier commentaire (${last.user.login}) :\n\n${last.body}`
    : issue.body || "",
  "",
  "—",
  "Retire l'étiquette « besoin-ivan » une fois le point réglé.",
].join("\n")

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${RESEND_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from: FROM,
    to: [IVAN_EMAIL],
    subject: `Bémol : on a besoin de toi (#${NUMBER} ${issue.title})`,
    text,
  }),
})
if (!res.ok) {
  console.error(`Resend : ${res.status} ${await res.text()}`)
  process.exit(1)
}
console.log(`Email envoyé pour la ${kind} #${NUMBER}.`)
