#!/usr/bin/env node
// Occupation des salles d'Uni Mail (grande salle Marie Laggé et studios A, B,
// C, P), pour savoir d'un coup d'œil si une salle est libre (#264). Source : le
// « planning des salles » partagé par Dièse (lien `sp-…`, secret Actions
// SALLES_URL, jamais en clair dans le code : il contient un jeton d'accès).
//
// Ce lien ne donne pas de fichier exploitable : il redirige vers une page
// (chdocuments.diesesoftware.com) qui charge le calendrier par un appel AJAX.
// On rejoue cet appel avec les paramètres que la page elle-même utilise, puis
// on lit le tableau HTML renvoyé (une ligne d'en-tête par jour et par salle,
// puis une ligne `panelActivity` par occupation).
//
// N'est publié que ce qui dit si la salle est prise : salle, horaires, type
// d'activité et Liste. Les remarques libres de Dièse (prénoms des musiciens qui
// réservent un studio, prestataires…) restent dans Dièse : data/ est public.
//
// Usage :
//   SALLES_URL=… node scripts/update-salles.mjs   → data/salles.json
//   node scripts/update-salles.mjs reponse.html   → idem, depuis la réponse
//                                                    AJAX enregistrée (test)

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(root, "data/salles.json")
const TIMEOUT = 60_000

// Ordre d'affichage. Dièse range certaines occupations (accords du piano…)
// sous un second nom de la même salle (« ► UM - … ») : on les regroupe.
export const SALLES = [
  "Grande salle",
  "Studio A",
  "Studio B",
  "Studio C",
  "Studio P",
]
export const TOUTES = "Tous les espaces"

export function salleName(raw) {
  const s = raw.replace(/^►\s*/, "").trim()
  if (/tous les espaces/i.test(s)) return TOUTES
  if (/grande salle|marie lagg/i.test(s)) return "Grande salle"
  const studio = s.match(/studio\s+(\w+)/i)
  return studio
    ? `Studio ${studio[1].toUpperCase()}`
    : s.replace(/^(ML|UM)\s*-\s*/, "")
}

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()

// Libellés de Dièse qui ne désignent pas une production : on ne les affiche pas.
const NOT_A_LISTE = /^(Planning_Tech|T_Tech|nd)$/i

export function parseSalles(html) {
  const bookings = []
  const seen = new Set()
  let day = null
  let salle = null
  for (const [, attrs, body] of html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)) {
    if (!attrs.includes("panelActivity")) {
      // En-tête : jour (id="AAAAMMJJ") et salle (en gras, colonne de droite)
      const id = attrs.match(/id="(\d{4})(\d\d)(\d\d)"/)
      if (id) day = `${id[1]}-${id[2]}-${id[3]}`
      const room = body.match(/colspan="3">\s*<p><b>([\s\S]*?)<\/b>/)
      if (room) salle = salleName(decode(room[1]))
      continue
    }
    // Bloc « mobile » : « 13:30 - 17:00 », puis « Activité - Liste ».
    const block = body.match(/mobileActivity"[^>]*>([\s\S]*?)<div rel=/)
    if (!day || !salle || !block) continue
    const time = block[1].match(/(\d\d):(\d\d)\s*-\s*(\d\d):(\d\d)/)
    const what = block[1].match(/<p>([\s\S]*?)<\/p>/)
    if (!what) continue
    const [activity, ...rest] = decode(what[1]).split(/\s+-\s+/)
    const liste = rest.join(" - ").trim()
    const b = {
      start: `${day}T${time ? `${time[1]}:${time[2]}` : "00:00"}`,
      end: `${day}T${time ? `${time[3]}:${time[4]}` : "23:59"}`,
      salle,
      activity: activity.trim(),
      ...(liste && !NOT_A_LISTE.test(liste) ? { liste } : {}),
    }
    const key = JSON.stringify(b)
    if (seen.has(key)) continue
    seen.add(key)
    bookings.push(b)
  }
  bookings.sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      SALLES.indexOf(a.salle) - SALLES.indexOf(b.salle),
  )
  return bookings
}

async function get(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) })
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${new URL(url).host}`)
  return r.text()
}

// Lien partagé → page du calendrier → appel AJAX qui renvoie le tableau.
async function download(shareUrl) {
  const stub = await get(shareUrl)
  const pageUrl = stub.match(/window\.location\.href\s*=\s*'([^']+)'/)?.[1]
  if (!pageUrl) throw new Error("Lien de partage : redirection introuvable")
  const page = await get(pageUrl)

  // Paramètres de l'appel, recopiés du code de la page : ceux de la fonction
  // refreshDiv, puis les productions, lieux et types d'activité de son appel
  // initial (tout coché).
  const block = page.match(
    /ajax_440\.php',[\s\S]*?params:\s*\{([\s\S]*?)\n\s*\},/,
  )
  const init = page.match(
    /^\s*refreshDiv\('([\d,]+)',\s*'([\d,]+)',\s*grouperLieux,\s*'([\d,]+)'\)/m,
  )
  if (!block || !init) throw new Error("Page du calendrier : format inattendu")
  const params = new URLSearchParams()
  for (const [, k, v] of block[1].matchAll(/(\w+):\s*'([^']*)'/g))
    params.set(k, v)
  params.set("idProds", init[1])
  params.set("lieux", init[2])
  params.set("idTAs", init[3])
  params.set("grouperLieux", "true")
  params.set("statutPlanif", "1")
  params.set("params", "null")
  const html = await get(new URL("/files/_ajax/ajax_440.php", pageUrl), {
    method: "POST",
    body: params,
  })
  return {
    html,
    from: params.get("date_from"),
    to: params.get("date_to"),
  }
}

async function main() {
  const file = process.argv[2]
  let src
  if (file) src = { html: readFileSync(file, "utf8") }
  else if (process.env.SALLES_URL) src = await download(process.env.SALLES_URL)
  else {
    console.log("SALLES_URL absent : occupation des salles non actualisée.")
    return
  }
  const bookings = parseSalles(src.html)
  // Garde-fou : un tableau vide trahit un changement de format côté Dièse
  // (la saison compte plusieurs centaines d'occupations) ; on garde alors la
  // version servie plutôt que d'annoncer toutes les salles libres.
  if (bookings.length < 20)
    throw new Error(
      `Seulement ${bookings.length} occupations lues : format changé ?`,
    )
  const days = bookings.map((b) => b.start.slice(0, 10))
  const data = {
    from: src.from || days[0],
    to: src.to || days.at(-1),
    salles: SALLES,
    bookings,
  }
  // Rien de neuf : on ne réécrit pas, pour que le cron ne republie pas
  // data/ à chaque passage juste pour une date de mise à jour.
  let previous = null
  try {
    previous = JSON.parse(readFileSync(OUT, "utf8"))
  } catch {}
  const { updatedAt: _, ...prevData } = previous || {}
  if (JSON.stringify(prevData) === JSON.stringify(data)) {
    console.log(`Occupation des salles inchangée (${bookings.length}).`)
    return
  }
  writeFileSync(
    OUT,
    JSON.stringify({ updatedAt: new Date().toISOString(), ...data }, null, 1) +
      "\n",
  )
  console.log(`${bookings.length} occupations de salles → data/salles.json`)
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((err) => {
    console.error(`Occupation des salles : ${err.message}`)
    process.exit(1)
  })
