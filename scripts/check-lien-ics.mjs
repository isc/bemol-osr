#!/usr/bin/env node
// Vérifie que Bémol lit bien le lien ICS que Dièse affiche aux musiciens (#270).
//
// En novembre 2026, Dièse affichait un nouveau lien ICS sans prévenir. L'ancien,
// celui de Bémol, répondait toujours mais ne couvrait plus la même chose (un
// concours du 14 mai 2027 manquait). Rien ne le signalait : c'est Loïc qui l'a vu.
//
// Ce lien s'affiche sur la page « Calendriers partagés / Partitions /
// Documents » du mini-site Dièse, celle où Loïc le récupère. Elle se lit sans
// connexion ; son corps se charge à part (`&service=renderHTML`, comme le fait
// le script de la page). Son adresse est dans le secret DIESE_PAGE_URL : la
// page affiche aussi l'identifiant et le mot de passe de l'espace documents de
// l'orchestre, qui n'ont rien à faire dans un dépôt public.
//
// Une première version (#271) déduisait un lien périmé des fiches du mémo de
// production absentes du planning. Elle a donné trois fausses alertes en une
// semaine (#275, #277, #281), pour des fiches qui n'ont jamais de service.
//
// Lancé avant chaque mise à jour du planning (cf. `checks` dans cron.mjs), ce
// script échoue si le lien affiché n'est pas celui d'ICS_URL, ou si la page
// n'en affiche plus aucun. Le run passe alors en échec, sans empêcher la
// publication du planning. Un changement de lien pose LIEN_ICS_CHANGE pour les
// étapes suivantes du job : `cron.mjs alert planning` ouvre alors l'issue
// dédiée plutôt que celle d'une panne du cron.
//
// Usage : DIESE_PAGE_URL=… ICS_URL=… node scripts/check-lien-ics.mjs

import { appendFileSync } from "node:fs"

// Seul le jeton compte : https:// ou webcal://, peu importe.
const JETON_RE = /contact_ics-[^\s"'<>/]+?\.ics/g

async function main() {
  const { DIESE_PAGE_URL: page, ICS_URL: ics } = process.env
  if (!page || !ics) {
    // En annotation sous Actions : une vérification coupée doit se voir.
    console.log(
      `${process.env.GITHUB_ACTIONS ? "::warning::" : ""}DIESE_PAGE_URL ou ICS_URL absent : vérification du lien ICS sautée.`,
    )
    return
  }
  const res = await fetch(`${page}&service=renderHTML`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`page Dièse : HTTP ${res.status}`)
  const affiches = new Set((await res.text()).match(JETON_RE))
  if (!affiches.size)
    throw new Error(
      "la page Dièse n'affiche plus de lien ICS (adresse DIESE_PAGE_URL périmée, ou format de la page changé)",
    )
  if (affiches.has(ics.match(JETON_RE)?.[0])) {
    console.log("Lien ICS : Bémol lit bien le lien affiché par Dièse.")
    return
  }
  if (process.env.GITHUB_ENV)
    appendFileSync(process.env.GITHUB_ENV, "LIEN_ICS_CHANGE=1\n")
  console.log(
    "::warning::Dièse affiche un nouveau lien ICS, différent de celui de Bémol (secret ICS_URL)",
  )
  process.exitCode = 1
}

await main().catch((e) => {
  console.log(`::warning::Vérification du lien ICS impossible : ${e.message}`)
  process.exitCode = 1
})
