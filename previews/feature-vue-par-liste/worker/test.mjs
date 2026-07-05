#!/usr/bin/env node
// Test du filtre du worker sur le vrai calendrier généré (data/planning.ics).
// Usage : node worker/test.mjs — échoue (exit 1) à la moindre incohérence.

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { filterIcs } from "./src/index.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const ics = readFileSync(join(root, "data", "planning.ics"), "utf8")
const planning = JSON.parse(
  readFileSync(join(root, "data", "planning.json"), "utf8"),
)

const count = (s) => (s.match(/BEGIN:VEVENT/g) || []).length
const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const total = planning.events.length
if (count(ics) !== total)
  fail(`ICS source : ${count(ics)} ≠ ${total} événements`)

// Sans paramètre → identité stricte.
if (filterIcs(ics, { listes: [], sans: [], annules: true }) !== ics)
  fail("sans filtre, la sortie devrait être identique à l'entrée")

// Par listes : le compte doit correspondre exactement au JSON.
const listes = ["Liste 01", "Liste 04"]
const expected = planning.events.filter((e) => listes.includes(e.liste)).length
const byListe = filterIcs(ics, { listes, sans: [], annules: true })
if (count(byListe) !== expected)
  fail(`filtre listes : ${count(byListe)} ≠ ${expected} attendus`)
if (/X-BEMOL-LISTE:(?!Liste 01|Liste 04)/m.test(byListe))
  fail("filtre listes : une autre liste a fui dans la sortie")
if (!byListe.includes("X-WR-CALNAME:OSR — Mon planning (Bémol)"))
  fail("filtre listes : le calendrier devrait être renommé « Mon planning »")

// Par catégories exclues.
const sans = ["resa", "concours"]
const expectedSans = planning.events.filter(
  (e) => !sans.includes(e.category),
).length
const byCat = filterIcs(ics, { listes: [], sans, annules: true })
if (count(byCat) !== expectedSans)
  fail(`filtre catégories : ${count(byCat)} ≠ ${expectedSans} attendus`)

// Sans les annulés.
const expectedActifs = planning.events.filter((e) => !e.cancelled).length
const actifs = filterIcs(ics, { listes: [], sans: [], annules: false })
if (count(actifs) !== expectedActifs)
  fail(`filtre annulés : ${count(actifs)} ≠ ${expectedActifs} attendus`)

// La structure reste un VCALENDAR équilibré et terminé proprement.
for (const [name, out] of [
  ["listes", byListe],
  ["catégories", byCat],
]) {
  if (!out.endsWith("END:VCALENDAR\r\n"))
    fail(`${name} : fin de fichier invalide`)
  if (
    (out.match(/BEGIN:VEVENT/g) || []).length !==
    (out.match(/END:VEVENT/g) || []).length
  )
    fail(`${name} : BEGIN/END VEVENT déséquilibrés`)
}

console.log(
  `✓ filtre OK — complet ${total}, listes ${count(byListe)}, ` +
    `catégories ${count(byCat)}, sans annulés ${count(actifs)}`,
)
