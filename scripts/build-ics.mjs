#!/usr/bin/env node
// Génère planning.ics : un calendrier ICS complet, à ABONNER depuis n'importe
// quelle app d'agenda (Apple Calendar, Google Agenda, Outlook…). Contrairement à
// l'export brut de Dièse, chaque événement est enrichi avec les infos du « mémo
// de production » (chef, solistes, œuvres + instrumentation, effectif, durée),
// exactement comme la vue Grille de l'app.
//
// Entrées  : data/planning.json (généré par update-data.mjs)
//            productions.json    (généré par update-memo.mjs, facultatif)
// Sortie   : data/planning.ics (servi par GitHub Pages, abonnable)
//
// Usage :
//   node scripts/build-ics.mjs
//
// Le fichier n'est réécrit que si son contenu a changé (pas de commit vide).
// Appelé par update-data.mjs (toutes les 2 h) après régénération du planning,
// pour rester à jour quand le planning OU le mémo de production évolue.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const planningPath = join(root, "data", "planning.json")
const productionsPath = join(root, "productions.json")
const icsPath = join(root, "data", "planning.ics")

// Libellés des catégories, calqués sur ceux de l'app (app.js).
const CATEGORIES = {
  concert: "Concert / Représentation",
  generale: "Générale / Raccord",
  italienne: "Italienne / Scène & orch.",
  enregistrement: "Enregistrement",
  repetition: "Répétition / Lecture",
  concours: "Concours / Auditions",
  autre: "Autre",
  resa: "Résa de salles",
}

// Libellés du détail d'instrumentation d'une œuvre, repris tels quels du mémo
// (mêmes intitulés que WORK_FIELDS dans app.js).
const WORK_FIELDS = [
  ["instrumentation", "Instrumentation"],
  ["remarques", "Remarques"],
  ["percussions", "Percussions"],
  ["claviers", "Claviers"],
  ["extra", "Extra"],
  ["detail", "Détail"],
  ["note", "Note"],
]

// --- Formatage ICS ----------------------------------------------------------

// Échappe une valeur texte pour une propriété ICS (RFC 5545 §3.3.11).
const escapeText = (s) =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")

// Plie une ligne de contenu à 75 octets (RFC 5545 §3.1), sans couper un
// caractère UTF-8 multi-octets : les lignes suivantes commencent par une espace.
function fold(line) {
  const bytes = Buffer.from(line, "utf8")
  if (bytes.length <= 75) return line
  const out = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // Ne pas couper au milieu d'un caractère UTF-8 (octets de continuation 10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    out.push(bytes.subarray(start, end).toString("utf8"))
    start = end
    limit = 74 // les lignes de continuation portent une espace en tête (1 octet)
  }
  return out.join("\r\n ")
}

// "2026-08-11T10:00" → "20260811T100000" ; "2026-08-13" → "20260813"
const toIcsDate = (local) =>
  local.replace(/[-:]/g, "").replace(/T(\d{4})$/, "T$100")

// "2026-07-03T14:34:25.134Z" → "20260703T143425Z" (UTC, pour DTSTAMP)
const toIcsStamp = (iso) =>
  iso.replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z"

// --- Description enrichie (mémo de production) ------------------------------

// Construit le texte de description d'un événement : contexte du service +
// infos du mémo de production (les mêmes que le détail de la vue Grille).
function description(e, prod) {
  const lines = []
  if (e.project) lines.push(`Programme : ${e.project}`)
  if (e.cancelled) lines.push("⚠ Service ANNULÉ")

  if (prod) {
    const solistes = (prod.solistes || []).filter(Boolean)
    const works = (prod.works || []).filter(Boolean)
    lines.push("", "— Mémo de production —")
    if (prod.chef) lines.push(`Direction musicale : ${prod.chef}`)
    if (solistes.length) {
      lines.push(solistes.length > 1 ? "Solistes :" : "Soliste :")
      for (const s of solistes) lines.push(`• ${s}`)
    }
    if (works.length) {
      lines.push("Œuvres au programme :")
      for (const w of works) {
        const title = typeof w === "string" ? w : w.oeuvre
        const dur = typeof w === "object" && w.duree ? ` (${w.duree})` : ""
        lines.push(`• ${title}${dur}`)
        if (typeof w === "object")
          for (const [k, label] of WORK_FIELDS)
            if (w[k])
              // Détail multi-lignes du mémo : chaque ligne reste lisible.
              lines.push(
                `    ${label} : ${String(w[k]).replace(/\s*\n\s*/g, " / ")}`,
              )
      }
    }
    if (prod.effectif)
      lines.push(`Effectif orchestral (max) : ${prod.effectif}`)
    if (prod.duree) lines.push(`Durée totale approximative : ${prod.duree}`)
  }

  lines.push("", "Calendrier Bémol · mis à jour automatiquement")
  return lines.join("\n")
}

// --- Construction du VEVENT -------------------------------------------------

function vevent(e, prod, stamp) {
  const timed = e.start.includes("T")
  const rows = []
  rows.push("BEGIN:VEVENT")
  rows.push(`UID:${escapeText(e.uid)}@bemol-osr`)
  rows.push(`DTSTAMP:${stamp}`)
  if (timed) {
    rows.push(`DTSTART;TZID=Europe/Zurich:${toIcsDate(e.start)}`)
    if (e.end && e.end.includes("T"))
      rows.push(`DTEND;TZID=Europe/Zurich:${toIcsDate(e.end)}`)
  } else {
    rows.push(`DTSTART;VALUE=DATE:${toIcsDate(e.start)}`)
    if (e.end) rows.push(`DTEND;VALUE=DATE:${toIcsDate(e.end)}`)
  }
  const prefix = e.cancelled ? "ANNULÉ · " : ""
  rows.push(`SUMMARY:${escapeText(`${prefix}${e.liste} — ${e.activity}`)}`)
  if (e.location) rows.push(`LOCATION:${escapeText(e.location)}`)
  rows.push(`DESCRIPTION:${escapeText(description(e, prod))}`)
  rows.push(
    `CATEGORIES:${escapeText(CATEGORIES[e.category] || CATEGORIES.autre)}`,
  )
  // Propriétés machine-lisibles pour le filtrage à la volée par le worker
  // d'abonnement personnalisé (worker/) : liste et clé de catégorie brutes.
  rows.push(`X-BEMOL-LISTE:${escapeText(e.liste)}`)
  rows.push(`X-BEMOL-CAT:${escapeText(e.category)}`)
  rows.push(`STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`)
  rows.push(`TRANSP:${e.cancelled ? "TRANSPARENT" : "OPAQUE"}`)
  rows.push("END:VEVENT")
  return rows.map(fold).join("\r\n")
}

// Définition de fuseau Europe/Zurich (Genève) — CET/CEST, règles UE (dernier
// dimanche de mars → dernier dimanche d'octobre). Nécessaire pour que les
// horaires locaux s'affichent correctement chez les abonnés.
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Zurich",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n")

// --- Génération -------------------------------------------------------------

// Régénère data/planning.ics depuis data/planning.json + productions.json.
// N'écrit (et ne journalise) que si le contenu change. Renvoie true si le
// fichier a été réécrit. Importable depuis update-data.mjs, ou exécutable seul.
export function buildIcs() {
  const planning = JSON.parse(readFileSync(planningPath, "utf8"))
  const productions = existsSync(productionsPath)
    ? JSON.parse(readFileSync(productionsPath, "utf8"))
    : {}

  // DTSTAMP figé sur l'horodatage des données : le fichier reste déterministe
  // (mêmes entrées ⇒ même sortie), donc pas de diff Git inutile.
  const stamp = toIcsStamp(planning.updatedAt || new Date().toISOString())

  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Bémol//Planning OSR//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    fold("X-WR-CALNAME:OSR — Planning (Bémol)"),
    "X-WR-TIMEZONE:Europe/Zurich",
    fold("NAME:OSR — Planning (Bémol)"),
    // Fréquence de rafraîchissement suggérée aux apps d'agenda (le planning est
    // régénéré toutes les 2 h côté serveur).
    "REFRESH-INTERVAL;VALUE=DURATION:PT2H",
    "X-PUBLISHED-TTL:PT2H",
    VTIMEZONE,
    ...planning.events.map((e) => vevent(e, productions[e.liste], stamp)),
    "END:VCALENDAR",
  ].join("\r\n")

  const output = body + "\r\n"

  const previous = existsSync(icsPath) ? readFileSync(icsPath, "utf8") : null
  if (previous === output) {
    console.log(
      `Calendrier ICS inchangé (${planning.events.length} événements).`,
    )
    return false
  }

  writeFileSync(icsPath, output)
  console.log(
    `data/planning.ics généré : ${planning.events.length} événements.`,
  )
  return true
}

// Exécution directe : node scripts/build-ics.mjs
if (import.meta.url === `file://${process.argv[1]}`) buildIcs()
