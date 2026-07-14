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

// --- Lieux : adresses postales ----------------------------------------------
//
// Dièse ne donne que le nom d'usage interne d'une salle (« UM - Salle Marie
// LAGGÉ », « HUG », « Place Neuve »…). Tel quel, aucune app d'agenda ne sait le
// géocoder : le lieu reste une chaîne inerte, sans carte ni bouton
// « Itinéraire ». On lui adjoint donc son adresse postale complète dans
// LOCATION — c'est elle que les apps géocodent — et ses coordonnées exactes
// dans GEO (RFC 5545 §3.8.1.6). Le libellé de Dièse reste en tête, pour que les
// musiciens reconnaissent la salle (et distinguent les studios d'Uni Mail).
//
// `match`   : testé contre le libellé normalisé (minuscules, sans accents,
//             espaces resserrés — Dièse en produit parfois de doubles).
// `address` : adresse postale, vérifiée sur le site officiel de la salle.
// `geo`     : [lat, lon], relevées sur OpenStreetMap.
// `name`    : remplace le libellé de Dièse en tête de LOCATION. À ne poser que
//             lorsque ce libellé empêche le géocodage : « La Grange au Lac,
//             Evian » (Evian contredit la commune réelle) et « Noda BCVs | WKB,
//             Sion » (la barre verticale) faisaient échouer le géocodeur
//             d'Apple, et « Rosey Concert Hall, Rolle » l'envoyait dans l'Aude,
//             à 400 km. Toute la table est vérifiée contre ce géocodeur —
//             cf. scripts/check-venues.mjs.
//
// Un lieu absent de la table (les « à définir » de Dièse) garde son libellé
// brut, sans adresse ni GEO — comme avant.
const VENUES = [
  {
    match: /^victoria hall/,
    address: "Rue du Général-Dufour 14, 1204 Genève",
    geo: [46.2014, 6.14105],
  },
  // Salle de répétition et studios de l'OSR, tous à Uni Mail : l'OSR publie
  // l'entrée côté Carl-Vogt, pas l'adresse de façade de l'université.
  {
    match: /^um\b/,
    address: "Uni Mail, Boulevard Carl-Vogt 102, 1205 Genève",
    geo: [46.19538, 6.14031],
  },
  {
    match: /^(bfm|batiment des forces motrices)/,
    address: "Place des Volontaires 2, 1204 Genève",
    geo: [46.20456, 6.13686],
  },
  {
    match: /franz liszt|\bcmg\b/,
    address:
      "Conservatoire de musique de Genève, Place de Neuve 5, 1204 Genève",
    geo: [46.20087, 6.1425],
  },
  {
    match: /^hug\b/,
    address:
      "Hôpitaux Universitaires de Genève, Rue Gabrielle-Perret-Gentil 4, 1205 Genève",
    geo: [46.192, 6.14795],
  },
  {
    match: /^place (de )?neuve$/,
    address: "Place de Neuve, 1204 Genève",
    geo: [46.20108, 6.1437],
  },
  {
    match: /florimont/,
    address: "Institut Florimont, Avenue du Petit-Lancy 37, 1213 Petit-Lancy",
    geo: [46.19449, 6.11481],
  },
  {
    match: /beaulieu/,
    address: "Avenue des Bergières 10, 1004 Lausanne",
    geo: [46.52948, 6.62348],
  },
  {
    match: /geneve[ -]plage/,
    address: "Quai de Cologny 5, 1223 Cologny",
    geo: [46.21148, 6.17205],
  },
  {
    match: /jaques[ -]dalcroze/,
    address: "Rue de la Terrassière 44, 1207 Genève",
    geo: [46.20021, 6.15951],
  },
  // L'Ecolint a trois campus ; l'OSR joue au Centre des arts (La Grande
  // Boissière), seul lieu de l'école que citent ses propres pages « salles ».
  {
    match: /ecole internationale/,
    address: "Centre des arts, Chemin Marie-Thérèse Maurette 7, 1208 Genève",
    geo: [46.19808, 6.17132],
  },
  {
    match: /cite bleue/,
    address: "Avenue de Miremont 46, 1206 Genève",
    geo: [46.18694, 6.1588],
  },
  {
    match: /arena de geneve/,
    address: "Route des Batailleux 3, 1218 Le Grand-Saconnex",
    geo: [46.234, 6.11276],
  },
  {
    match: /salle de musique/,
    address: "Avenue Léopold-Robert 27, 2300 La Chaux-de-Fonds",
    geo: [47.10171, 6.82903],
  },
  {
    match: /ella fitzgerald/,
    address: "Parc La Grange, Avenue Alice-et-William-Favre 19, 1207 Genève",
    geo: [46.20662, 6.16809],
  },
  // Administrativement à Neuvecelle, même si tout le monde dit « Evian ». Deux
  // pièges du géocodeur d'Apple ici : « Evian » (qui contredit la commune) le
  // fait échouer… et l'article de « La Grange au Lac » aussi.
  {
    match: /grange au lac/,
    name: "Grange au Lac",
    address: "Avenue des Mélèzes 37, 74500 Neuvecelle, France",
    geo: [46.3948, 6.59305],
  },
  // Le Rosey n'a pas de numéro de rue ; sans « Carnal Hall » ni le pays, le
  // géocodeur part sur un homonyme du sud de la France.
  {
    match: /rosey/,
    name: "Rosey Concert Hall",
    address: "Carnal Hall, Institut Le Rosey, 1180 Rolle, Suisse",
    geo: [46.45981, 6.32863],
  },
  {
    match: /frank martin/,
    address: "Rue Mina-Audemars 3, 1204 Genève",
    geo: [46.20133, 6.15093],
  },
  {
    match: /stadtcasino basel/,
    address: "Steinenberg 14, 4051 Basel",
    geo: [47.55424, 7.59003],
  },
  {
    match: /boniface/,
    address: "Avenue du Mail 14, 1205 Genève",
    geo: [46.19876, 6.13874],
  },
  {
    match: /casino bern/,
    address: "Casinoplatz 1, 3011 Bern",
    geo: [46.94688, 7.44817],
  },
  {
    match: /^noda\b/,
    name: "Noda",
    address: "Avenue de Tourbillon 22, 1950 Sion, Suisse",
    geo: [46.22865, 7.3624],
  },
  {
    match: /^gare cornavin/,
    address: "Place de Cornavin 7, 1201 Genève",
    geo: [46.20817, 6.1425],
  },
  {
    match: /grand theatre|^gtg\b/,
    address: "Boulevard du Théâtre 11, 1204 Genève",
    geo: [46.20183, 6.14258],
  },
  // Salles internes des bureaux de l'OSR (déménagés rue Bovy-Lysberg).
  {
    match: /^administration\b/,
    address: "Administration de l'OSR, Rue Bovy-Lysberg 2, 1204 Genève",
    geo: [46.20134, 6.14058],
  },
]

// Fiche d'un lieu (adresse, coordonnées), ou null s'il n'est pas dans la table.
export function venue(loc) {
  if (!loc) return null
  const key = loc
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
  return VENUES.find((v) => v.match.test(key)) || null
}

// Valeur de la propriété LOCATION : nom de la salle, complété de son adresse
// postale quand on la connaît (c'est elle que les apps d'agenda géocodent).
export const locationLine = (loc) => {
  const v = venue(loc)
  return v ? `${v.name || loc}, ${v.address}` : loc
}

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
  // Adresse postale quand on la connaît ; sinon, repli sur le libellé brut, en
  // lui ajoutant la ville s'il n'en mentionne aucune (ambigu hors du contexte
  // genevois).
  const query = /,|genève/i.test(locationLine(loc))
    ? locationLine(loc)
    : `${loc}, Genève`
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`
}

// --- Description enrichie (mémo de production) ------------------------------

// Construit le texte de description d'un événement : contexte du service +
// infos du mémo de production (les mêmes que le détail de la vue Grille).
function description(e, prod) {
  const lines = []
  if (e.project) lines.push(`Programme : ${e.project}`)
  if (e.cancelled) lines.push("⚠ Service ANNULÉ")

  // Liens utiles (issue #88), repris de la fiche de l'app : lieu sur Google
  // Maps, portail partitions Dièse, série complète de la Liste sur Bémol.
  const maps = mapsUrl(e.location)
  if (maps) lines.push(`📍 Lieu (Google Maps) : ${maps}`)
  lines.push(`🎼 Portail partitions (Dièse) : ${SCORE_PORTAL_URL}`)
  lines.push(`📋 Série complète de ${e.liste} (Bémol) : ${listeUrl(e.liste)}`)

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
  if (e.location) {
    rows.push(`LOCATION:${escapeText(locationLine(e.location))}`)
    // GEO donne au client d'agenda le point exact, sans dépendre de la qualité
    // de son géocodage de l'adresse.
    const geo = venue(e.location)?.geo
    if (geo) rows.push(`GEO:${geo[0]};${geo[1]}`)
  }
  // Certaines apps d'agenda (Apple Calendar…) affichent la propriété URL comme
  // un lien cliquable distinct : on y pointe vers la série complète, aussi
  // reprise en clair dans DESCRIPTION pour les apps qui l'ignorent.
  rows.push(`URL:${listeUrl(e.liste)}`)
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
