#!/usr/bin/env node
// Génère planning.ics : un calendrier ICS complet, à ABONNER depuis n'importe
// quelle app d'agenda (Apple Calendar, Google Agenda, Outlook…). Contrairement à
// l'export brut de Dièse, chaque événement est enrichi avec les infos du « mémo
// de production » (chef, solistes, œuvres + instrumentation, effectif, durée),
// exactement comme la vue Grille de l'app, ainsi qu'avec les liens utiles de la
// fiche (lieu sur Google Maps, portail partitions, série complète — issue #88).
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
  concert: "Concert",
  representation: "Représentation (opéra/ballet)",
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

// URL de production (GitHub Pages) : les liens embarqués dans l'ICS sont
// ouverts depuis une app d'agenda externe, jamais depuis une page Bémol —
// toujours une URL absolue vers le site publié, jamais une preview de PR
// (même convention que UPSTREAM dans worker/src/index.js).
const SITE_URL = "https://isc.github.io/bemol-osr/"

// Portail partitions Dièse (issue #79), même lien que scorePortalLink() dans
// app.js.
const SCORE_PORTAL_URL = "https://osr.opas-online.com/documents.php"

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

// --- Liens (issue #88) -------------------------------------------------------
//
// Duplique deux petits helpers de app.js (listeSlug, mapsUrl) : ce script Node
// ne peut pas importer app.js, qui a des effets de bord navigateur dès son
// chargement (window.matchMedia…).

// Identifiant d'URL d'une Liste (fragment de hash), ex. "Liste 04" → "liste-04".
// Toujours ASCII (accents retirés) pour rester lisible tel quel.
function listeSlug(liste) {
  const slug = liste
    .replace(/^Liste\s+/i, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `liste-${slug}`
}

// Lien vers la fiche complète d'une Liste sur Bémol (mémo de production +
// tous les services de la série, cf. renderListeDialog dans app.js).
const listeUrl = (liste) => `${SITE_URL}#${listeSlug(liste)}`

// Lien Google Maps du lieu, ou null si pas encore connu (placeholders "à
// définir" utilisés par Dièse en attendant confirmation).
function mapsUrl(loc) {
  if (!loc || /^(lieu )?à définir/i.test(loc.trim())) return null
  // La plupart des lieux n'indiquent pas la ville (ambigu hors du contexte
  // genevois) ; ceux qui précisent déjà une ville (virgule, ou "Genève"
  // explicite) sont laissés tels quels.
  const query = /,|genève/i.test(loc) ? loc : `${loc}, Genève`
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`
}

// --- Description enrichie (mémo de production) ------------------------------

// Construit le contenu d'un événement sous forme de lignes neutres : contexte
// du service + liens utiles + infos du mémo de production (les mêmes que le
// détail de la vue Grille). Une ligne est soit du texte simple ({ text }),
// soit un lien ({ icon, label, href }) — les deux rendus ci-dessous (texte
// brut pour DESCRIPTION, HTML pour X-ALT-DESC) partagent cette même source
// pour ne jamais diverger.
function contentLines(e, prod) {
  const lines = []
  if (e.project) lines.push({ text: `Programme : ${e.project}` })
  if (e.cancelled) lines.push({ text: "⚠ Service ANNULÉ" })

  // Liens utiles (issue #88), repris de la fiche de l'app : lieu sur Google
  // Maps, portail partitions Dièse, série complète de la Liste sur Bémol.
  const maps = mapsUrl(e.location)
  if (maps) lines.push({ icon: "📍", label: "Lieu (Google Maps)", href: maps })
  lines.push({
    icon: "🎼",
    label: "Portail partitions (Dièse)",
    href: SCORE_PORTAL_URL,
  })
  lines.push({
    icon: "📋",
    label: `Série complète de ${e.liste} (Bémol)`,
    href: listeUrl(e.liste),
  })

  if (prod) {
    const solistes = (prod.solistes || []).filter(Boolean)
    const works = (prod.works || []).filter(Boolean)
    lines.push({ text: "" }, { text: "— Mémo de production —" })
    if (prod.chef) lines.push({ text: `Direction musicale : ${prod.chef}` })
    if (solistes.length) {
      lines.push({ text: solistes.length > 1 ? "Solistes :" : "Soliste :" })
      for (const s of solistes) lines.push({ text: `• ${s}` })
    }
    if (works.length) {
      lines.push({ text: "Œuvres au programme :" })
      for (const w of works) {
        const title = typeof w === "string" ? w : w.oeuvre
        const dur = typeof w === "object" && w.duree ? ` (${w.duree})` : ""
        lines.push({ text: `• ${title}${dur}` })
        if (typeof w === "object")
          for (const [k, label] of WORK_FIELDS)
            if (w[k])
              // Détail multi-lignes du mémo : chaque ligne reste lisible.
              lines.push({
                text: `    ${label} : ${String(w[k]).replace(/\s*\n\s*/g, " / ")}`,
              })
      }
    }
    if (prod.effectif)
      lines.push({ text: `Effectif orchestral (max) : ${prod.effectif}` })
    if (prod.duree)
      lines.push({ text: `Durée totale approximative : ${prod.duree}` })
  }

  lines.push(
    { text: "" },
    { text: "Calendrier Bémol · mis à jour automatiquement" },
  )
  return lines
}

// Rendu texte brut des lignes : un lien s'affiche avec son URL en clair
// (pour les apps qui ignorent X-ALT-DESC, cf. descriptionHtml ci-dessous).
function description(lines) {
  return lines
    .map((l) => (l.href ? `${l.icon} ${l.label} : ${l.href}` : l.text))
    .join("\n")
}

// Échappe une valeur pour l'insérer comme texte HTML.
const htmlEscape = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

// Rendu HTML des lignes, pour X-ALT-DESC (issue #88 retour) : un lien
// s'affiche comme un bouton/texte cliquable (label court), sans exposer
// l'URL — c'est ce que rendent les apps qui savent lire cette propriété
// (Apple Calendar notamment, cf. capture d'écran de la demande).
function descriptionHtml(lines) {
  const body = lines
    .map((l) =>
      l.href
        ? `${l.icon} <a href="${htmlEscape(l.href)}">${htmlEscape(l.label)}</a>`
        : htmlEscape(l.text),
    )
    .join("<br>")
  return `<html><body>${body}</body></html>`
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
  // Certaines apps d'agenda (Apple Calendar…) affichent la propriété URL comme
  // un lien cliquable distinct : on y pointe vers la série complète, aussi
  // reprise en clair dans DESCRIPTION pour les apps qui l'ignorent.
  rows.push(`URL:${listeUrl(e.liste)}`)
  const lines = contentLines(e, prod)
  rows.push(`DESCRIPTION:${escapeText(description(lines))}`)
  // Version HTML de la description (retour #88) : les apps qui la
  // supportent (Apple Calendar…) affichent les liens comme des boutons à
  // texte court plutôt que l'URL en clair ; les autres retombent sur
  // DESCRIPTION ci-dessus, inchangée.
  rows.push(
    `X-ALT-DESC;FMTTYPE=text/html:${escapeText(descriptionHtml(lines))}`,
  )
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
