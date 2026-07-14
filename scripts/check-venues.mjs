#!/usr/bin/env node
// Vérifie la table des lieux de build-ics.mjs, en interrogeant le géocodeur
// d'Apple (CoreLocation) — celui-là même qu'utilise Calendar.app pour
// transformer la propriété LOCATION d'un événement en carte et en bouton
// « Itinéraire ».
//
// Pourquoi ce détour par Swift plutôt qu'un géocodeur HTTP : c'est le seul qui
// dise ce que verront réellement les musiciens abonnés au calendrier. Et il a
// ses lubies — un mauvais épinglage est pire que pas d'épinglage :
//   « Rosey Concert Hall, Rolle, Château du Rosey, 1180 Rolle »  → l'Aude, 400 km
//   « La Grange au Lac, … »                                      → aucun résultat
//   « Grange au Lac, … » (sans l'article)                        → pile dessus
// Le champ `name` de la table sert précisément à neutraliser ces libellés.
//
// Le script géocode la chaîne LOCATION complète de chaque salle du planning et
// la compare aux coordonnées de la table (relevées sur OpenStreetMap) : il
// signale tout écart de plus de 300 m, tout échec de géocodage, et tout lieu du
// planning encore absent de la table.
//
// Usage (macOS uniquement — jamais en CI, qui tourne sous Linux) :
//   node scripts/check-venues.mjs             # data/planning.json local
//   node scripts/check-venues.mjs <url|file>  # un autre planning (ex. gh-pages)
//
// À lancer après tout ajout ou modification d'une salle.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { venue, locationLine } from "./build-ics.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const source = process.argv[2] || join(root, "data", "planning.json")

if (process.platform !== "darwin") {
  console.error("Ce script requiert macOS (géocodeur CoreLocation).")
  process.exit(2)
}

// Géocodeur Apple : une ligne d'entrée = une adresse, une ligne de sortie =
// "lat lon" ou "-" en cas d'échec. Les callbacks de CLGeocoder sont livrés sur
// la file principale : le travail doit donc tourner sur une file de fond.
const SWIFT = `
import Foundation
import CoreLocation

let queries = (try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))
  .split(separator: "\\n").map(String.init)

DispatchQueue.global().async {
  let geocoder = CLGeocoder()
  for query in queries {
    let done = DispatchSemaphore(value: 0)
    geocoder.geocodeAddressString(query) { marks, _ in
      if let loc = marks?.first?.location {
        print("\\(loc.coordinate.latitude) \\(loc.coordinate.longitude)")
      } else {
        print("-")
      }
      fflush(stdout)
      done.signal()
    }
    done.wait()
    Thread.sleep(forTimeInterval: 1.5) // le service d'Apple limite le débit
  }
  exit(0)
}
CFRunLoopRun()
`

// Distance approximative en mètres (suffisante à la latitude de Genève).
const metres = (a, b) =>
  Math.round(Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 76500))

const planning = /^https?:/.test(source)
  ? await fetch(source).then((r) => r.json())
  : JSON.parse(readFileSync(source, "utf8"))

const locations = [...new Set(planning.events.map((e) => e.location))]
  .filter(Boolean)
  .sort()

// Les « à définir » de Dièse ne sont pas des lieux : rien à géocoder.
const unknown = locations.filter((l) => !venue(l) && !/à définir/i.test(l))
const known = locations.filter((l) => venue(l))

const dir = mkdtempSync(join(tmpdir(), "bemol-venues-"))
writeFileSync(join(dir, "check.swift"), SWIFT)
writeFileSync(join(dir, "queries.txt"), known.map(locationLine).join("\n"))

console.log(`Géocodage de ${known.length} lieux (~${known.length * 2} s)…\n`)
const found = execFileSync(
  "swift",
  [join(dir, "check.swift"), join(dir, "queries.txt")],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
)
  .trim()
  .split("\n")
  .map((line) => (line === "-" ? null : line.split(" ").map(Number)))

let problems = 0
for (const [i, loc] of known.entries()) {
  const off = found[i] && metres(found[i], venue(loc).geo)
  const ok = off !== null && off <= 300
  if (!ok) problems++
  const verdict = found[i] ? `${String(off).padStart(5)} m` : "échec  "
  console.log(`${ok ? "✅" : "❌"} ${verdict}  ${locationLine(loc)}`)
}
for (const loc of unknown) {
  problems++
  console.log(`⬜         absent de la table : ${loc}`)
}

console.log(
  problems
    ? `\n${problems} lieu(x) à revoir.`
    : `\n${known.length} lieux, tous géocodés au bon endroit.`,
)
process.exit(problems ? 1 : 0)
