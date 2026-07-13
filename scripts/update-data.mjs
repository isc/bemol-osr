#!/usr/bin/env node
// Récupère l'export ICS du planning OSR (logiciel Dièse), le convertit en
// data/planning.json et journalise les différences avec la version précédente
// dans data/changes.json.
//
// Usage :
//   ICS_URL=https://… node scripts/update-data.mjs      (production / CI)
//   node scripts/update-data.mjs chemin/vers/export.ics (test local)
//
// Les fichiers de data/ ne sont réécrits que si le contenu des événements a
// réellement changé, pour ne pas générer de commits vides.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildIcs } from "./build-ics.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const planningPath = join(root, "data", "planning.json")
const changesPath = join(root, "data", "changes.json")

const MAX_CHANGE_ENTRIES = 300

async function loadIcs() {
  const fileArg = process.argv[2]
  if (fileArg) return readFileSync(fileArg, "utf8")
  const url = process.env.ICS_URL
  if (!url) {
    console.error(
      "Erreur : définir ICS_URL ou passer un fichier .ics en argument",
    )
    process.exit(1)
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Téléchargement ICS échoué : HTTP ${res.status}`)
  return res.text()
}

// --- Parsing ICS -----------------------------------------------------------

function parseIcs(raw) {
  // Déplie les lignes de continuation (RFC 5545) puis découpe les VEVENT.
  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
  const events = []
  let cur = null
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {}
    else if (line === "END:VEVENT") {
      if (cur) events.push(cur)
      cur = null
    } else if (cur) {
      const i = line.indexOf(":")
      if (i === -1) continue
      const key = line.slice(0, i).split(";")[0]
      if (!(key in cur)) cur[key] = line.slice(i + 1)
    }
  }
  return events
}

const unescapeText = (s) =>
  (s || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")

// 20260813T211500 → "2026-08-13T21:15" ; 20260813 → "2026-08-13"
// Les horaires sont conservés en heure locale (TZID Europe/Paris ≈ Genève).
function toLocal(value) {
  const m = (value || "").match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/)
  if (!m) return null
  return m[4]
    ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`
    : `${m[1]}-${m[2]}-${m[3]}`
}

// Catégorisation calquée sur la légende de la « Bible » de saison.
// L'ordre des tests compte (ex. « répétitions candidats » → concours).
function categorize(liste, activity) {
  const l = liste.toLowerCase()
  const a = activity.toLowerCase()
  if (l.startsWith("résa") || /^(résa|salle résa)/.test(a)) return "resa"
  if (/assemblée|séance|présentation saison|dîner/.test(a)) return "autre"
  if (
    /concours|candidats|audition|titularisation/.test(a) ||
    l.startsWith("concours")
  )
    return "concours"
  if (/concert|cinéconc/.test(a)) return "concert"
  // Les ordinaux désignent les représentations d'opéra/ballet (cf. CLAUDE.md
  // § Vocabulaire métier), à distinguer visuellement des concerts symphoniques
  // même si les deux se trouvent dans le même créneau « Soir »/« Ap-midi » (#83).
  if (
    /première|deuxième|troisième|quatrième|cinquième|sixième|septième|huitième|neuvième|dixième|onzième|douzième/.test(
      a,
    )
  )
    return "representation"
  if (/italienne|scène et orchestre|mise fosse/.test(a)) return "italienne"
  if (/enregistrement|enreg\./.test(a)) return "enregistrement"
  if (
    /répétition|lecture|partielle|musicale|coaching|atelier|rencontre|masterclass|workshop/.test(
      a,
    )
  )
    return "repetition"
  if (/générale|prégénérale|raccord|balance|technique/.test(a))
    return "generale"
  return "autre"
}

function normalize(v) {
  const summary = unescapeText(v.SUMMARY).trim()
  const sep = summary.indexOf(" - ")
  const liste = sep === -1 ? summary : summary.slice(0, sep).trim()
  const activity = sep === -1 ? "" : summary.slice(sep + 3).trim()

  // DESCRIPTION type : " - - - \n\n<activité abrégée> - <projet>\n\n&nbsp"
  // → on extrait le « projet » (Carmen, aboO2, DPL…) après le dernier « - ».
  const middle = (unescapeText(v.DESCRIPTION).split("\n\n")[1] || "").trim()
  const cut = middle.lastIndexOf(" - ")
  const project = (cut === -1 ? "" : middle.slice(cut + 3))
    .replace(/&nbsp;?/g, "")
    .trim()

  return {
    uid: v.UID || `${v.DTSTART}-${summary}`,
    start: toLocal(v.DTSTART),
    end: toLocal(v.DTEND),
    liste,
    activity,
    category: categorize(liste, activity),
    location: (v.LOCATION || "").trim(),
    project,
    cancelled: v.STATUS === "CANCELLED",
  }
}

// --- Filtre de saison ------------------------------------------------------
// La saison OSR va du 1er lundi d'août au dimanche précédant le 1er lundi
// d'août suivant ; on l'identifie par son année de départ N (« Saison N/N+1 »).
// Certaines saisons ne doivent pas figurer dans l'app : cf. issue #1, seule la
// saison 2026/2027 est souhaitée. On ne conserve donc que les événements dont
// l'année de départ de saison vaut ONLY_SEASON.
const ONLY_SEASON = 2026

function firstMondayOfAugust(year) {
  const d = new Date(year, 7, 1)
  d.setDate(1 + ((8 - d.getDay()) % 7))
  return d
}

// Année de saison d'un début local "YYYY-MM-DDTHH:MM" (on lit les composantes
// de la chaîne, sans dépendre du fuseau horaire de la machine).
function seasonYear(localStart) {
  const [y, m, d] = localStart.slice(0, 10).split("-").map(Number)
  return new Date(y, m - 1, d) >= firstMondayOfAugust(y) ? y : y - 1
}

// --- Diff ------------------------------------------------------------------

// "category" est dérivé de liste+activity (cf. categorize()) : il est inclus
// ici pour que la mise à jour de la logique de catégorisation elle-même
// (nouvelle catégorie, heuristique corrigée…) déclenche bien une réécriture de
// planning.json, même quand aucun champ brut de l'ICS n'a changé — sinon
// `changed` (plus bas) reste faux et gh-pages garde indéfiniment les
// anciennes catégories tant que Dièse ne retouche pas l'événement (#83 vécu
// après coup : la distinction concert/représentation n'apparaissait jamais en
// production).
const DIFF_FIELDS = [
  "start",
  "end",
  "liste",
  "activity",
  "location",
  "project",
  "cancelled",
  "category",
]

// Champs réellement journalisés dans changes.json / affichés dans la vue
// Modifications : sans "category", pour qu'une recatégorisation décidée par
// le comité de lecture (ex. #83 : concert → représentation) ne s'affiche pas
// comme un changement fait par l'orchestre, même si elle déclenche bien une
// réécriture de planning.json (cf. DIFF_FIELDS ci-dessus).
const LOGGED_FIELDS = DIFF_FIELDS.filter((f) => f !== "category")

// `changedFields` : tous les DIFF_FIELDS qui diffèrent (sert à décider si
// planning.json doit être réécrit). `fields` : le sous-ensemble LOGGED_FIELDS
// (sert à décider si l'événement doit apparaître dans changes.json).
function diff(oldEvents, newEvents) {
  const oldByUid = new Map(oldEvents.map((e) => [e.uid, e]))
  const newByUid = new Map(newEvents.map((e) => [e.uid, e]))
  const added = newEvents.filter((e) => !oldByUid.has(e.uid))
  const removed = oldEvents.filter((e) => !newByUid.has(e.uid))
  const changedEvents = []
  const modified = []
  for (const [uid, after] of newByUid) {
    const before = oldByUid.get(uid)
    if (!before) continue
    const changedFields = DIFF_FIELDS.filter((f) => before[f] !== after[f])
    if (!changedFields.length) continue
    changedEvents.push({ uid, fields: changedFields, before, after })
    const fields = changedFields.filter((f) => LOGGED_FIELDS.includes(f))
    if (fields.length) modified.push({ uid, fields, before, after })
  }
  return { added, removed, changedEvents, modified }
}

// --- Main ------------------------------------------------------------------

const raw = await loadIcs()
const events = parseIcs(raw)
  .map(normalize)
  .filter((e) => e.start)
  .filter((e) => seasonYear(e.start) === ONLY_SEASON)
  .sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : a.uid < b.uid ? -1 : 1,
  )

if (events.length === 0)
  throw new Error("Aucun événement trouvé dans l'ICS — export vide ?")

mkdirSync(join(root, "data"), { recursive: true })

const previous = existsSync(planningPath)
  ? JSON.parse(readFileSync(planningPath, "utf8"))
  : null

const { added, removed, changedEvents, modified } = diff(
  previous?.events ?? [],
  events,
)
const changed = added.length + removed.length + changedEvents.length > 0

if (previous && !changed) {
  console.log(`Aucun changement de planning (${events.length} événements).`)
  // Le planning n'a pas bougé, mais le mémo de production (productions.json) a
  // pu changer depuis : on régénère le calendrier ICS, réécrit seulement s'il
  // diffère (data/planning.ics est committé par `git add data/` du workflow).
  buildIcs()
  process.exit(0)
}

const now = new Date().toISOString()
writeFileSync(
  planningPath,
  JSON.stringify({ updatedAt: now, count: events.length, events }, null, 1) +
    "\n",
)

const loggable = added.length + removed.length + modified.length > 0

if (previous && loggable) {
  const changes = existsSync(changesPath)
    ? JSON.parse(readFileSync(changesPath, "utf8"))
    : { entries: [] }
  changes.entries.unshift({ at: now, added, removed, modified })
  changes.entries = changes.entries.slice(0, MAX_CHANGE_ENTRIES)
  writeFileSync(changesPath, JSON.stringify(changes, null, 1) + "\n")
  console.log(
    `Mise à jour : ${events.length} événements (+${added.length} / -${removed.length} / ~${modified.length})`,
  )
} else if (previous) {
  // Rien à journaliser (ex. recatégorisation seule, cf. LOGGED_FIELDS
  // ci-dessus) : planning.json est réécrit, mais pas d'entrée dans
  // changes.json pour ne pas afficher un faux « modifié » aux musicien·ne·s.
  console.log(
    `Mise à jour silencieuse : ${events.length} événements (recatégorisation sans changement journalisé).`,
  )
} else {
  if (!existsSync(changesPath))
    writeFileSync(changesPath, JSON.stringify({ entries: [] }, null, 1) + "\n")
  console.log(`Initialisation : ${events.length} événements.`)
}

// Planning réécrit : régénère le calendrier ICS abonnable (data/planning.ics),
// enrichi des infos du mémo de production.
buildIcs()
