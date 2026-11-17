#!/usr/bin/env node
// Vérifie que le lien ICS de Dièse (secret ICS_URL) n'est pas périmé (#270).
//
// En novembre 2026, Dièse affichait un nouveau lien ICS sans prévenir ; l'ancien,
// celui de Bémol, répondait toujours mais ne recevait plus tout (un concours
// du 14 mai 2027 manquait). Rien ne le signalait : c'est Loïc qui l'a vu.
//
// Le mémo de production, lu chaque nuit par un autre chemin, liste toutes les
// productions de la saison. update-memo.mjs relève dans productions.json
// (« _fichesHorsPlanning ») ses fiches dont le nom ne correspond à aucune
// Liste du planning. absentsIcs() garde celles qui ne sont pas terminées et
// manquent toujours au planning le plus récent.
//
// Lancé après chaque mise à jour du planning (cf. `extras` dans cron.mjs), ce
// script échoue s'il en reste : le run passe en échec, sans empêcher la
// publication du planning, et `cron.mjs alert planning` rappelle absentsIcs()
// pour ouvrir l'issue dédiée plutôt que celle d'une panne du cron.
//
// Usage : node scripts/check-lien-ics.mjs

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// Fiches du mémo qui n'ont, en temps normal, aucun service dans le lien ICS
// (nom exact, ou motif pour une série). Si l'alerte se déclenche pour l'une
// d'elles alors que le lien est à jour (le lien affiché par Dièse n'en montre
// pas trace non plus), l'ajouter ici.
const FICHES_HORS_ICS = [
  // Fiche d'attente du mémo, sans service : absente de l'ancien comme du
  // nouveau lien Dièse (#270, vérifié le 16/11/2026).
  "Auditions de musicien·nes supplémentaires à définir",
  // Séances du Conseil de Fondation, sans orchestre : l'ancien lien les
  // donnait, le lien actuel (#270) ne les donne plus. Leurs services de
  // décembre en sont sortis au changement de lien, le 16/11/2026 (#277).
  /^Conseil de Fondation /,
]
const horsIcs = (fiche) =>
  FICHES_HORS_ICS.some((m) =>
    m instanceof RegExp ? m.test(fiche) : m === fiche,
  )

const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"))

export function absentsIcs() {
  if (!existsSync(join(root, "productions.json"))) return []
  const listes = new Set(read("data/planning.json").events.map((e) => e.liste))
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Europe/Zurich",
  })
  return (read("productions.json")._fichesHorsPlanning || []).filter(
    ({ fiche, fin }) => fin >= today && !listes.has(fiche) && !horsIcs(fiche),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const absents = absentsIcs()
  if (!absents.length) {
    console.log("Lien ICS : toutes les productions à venir du mémo y figurent.")
    process.exit(0)
  }
  console.log(
    `::warning::Lien ICS peut-être périmé : ${absents.length} production(s) à venir du mémo absente(s) du planning`,
  )
  for (const { fiche, fin } of absents)
    console.log(`  - ${fiche} (jusqu'au ${fin})`)
  process.exit(1)
}
