// Bémol · abonnement personnalisé + notifications push — Cloudflare Worker
//
// Les apps d'agenda (iPhone, Google…) vont chercher l'ICS elles-mêmes, côté
// serveur : GitHub Pages (statique) ne peut donc pas filtrer « mes séries » à
// la demande. Ce worker comble ce manque : il relit le calendrier complet
// publié par Bémol (data/planning.ics) et retire au passage les événements
// que l'abonné ne veut pas voir. Il stocke, dans un KV, un profil par
// appareil (jeton opaque généré côté app) associant les filtres des Réglages
// et, le cas échéant, un abonnement push — pour (a) un lien ICS qui suit les
// Réglages dans la durée (au lieu de figer les filtres dans l'URL) et (b) des
// notifications quand le planning ou le mémo de production changent.
//
// URL d'abonnement :
//   https://<worker>/planning.ics?profile=<jeton>          suit les Réglages
//   https://<worker>/planning.ics?listes=Liste 04,Liste 07  ancien format figé
// Paramètres du format figé (tous facultatifs ; sans paramètre → calendrier
// complet) :
//   listes=<noms séparés par des virgules>   ne garder QUE ces listes
//   sans=<clés de catégorie>                 exclure ces catégories
//                                            (concert, generale, italienne,
//                                            enregistrement, repetition,
//                                            concours, autre, resa)
//   annules=0                                exclure les services annulés
//
// Le filtrage s'appuie sur les propriétés X-BEMOL-LISTE / X-BEMOL-CAT que
// scripts/build-ics.mjs écrit dans chaque VEVENT (valeurs brutes, jamais
// pliées car courtes — cf. fold() côté générateur).
//
// POST /feedback { message, name? } dépose un retour libre (issue #125) dans
// le même KV, sous la clé "feedback:<horodatage>-<id>". Pas de route de
// lecture dédiée (cf. discussion de l'issue) : relecture à la main, depuis
// worker/ avec wrangler authentifié :
//   wrangler kv key list --binding=NOTIF_PROFILES --remote --prefix=feedback:
//   wrangler kv key get  --binding=NOTIF_PROFILES --remote <clé>

import { buildPushPayload } from "@block65/webcrypto-web-push"
import {
  DEFAULT_PREFS,
  changesForProfile,
  buildNotificationPayload,
} from "./notify.js"

const UPSTREAM = "https://isc.github.io/bemol-osr/data/planning.ics"
const CHANGES_UPSTREAM = "https://isc.github.io/bemol-osr/data/changes.json"

// Durée de cache de l'ICS complet côté Cloudflare : le planning est régénéré
// toutes les 2 h, et les agendas ne rafraîchissent que quelques fois par jour.
const CACHE_SECONDS = 600

const CORS_HEADERS = { "access-control-allow-origin": "*" }

// Valeur d'une propriété X- dans un bloc VEVENT (non pliée, cf. en-tête).
function prop(block, name) {
  const m = block.match(new RegExp(`^${name}:(.*)$`, "m"))
  return m ? m[1].replace(/\r$/, "") : ""
}

// Un libellé `activity` est-il dans une liste de libellés masqués ? Comparaison
// insensible à la casse/espaces, comme côté app (cf. isActivityHidden
// d'app.js) : Dièse laisse passer des variantes de casse pour un même service
// (« (sans OSR) » / « (Sans OSR) »).
function activityHidden(hidden, activity) {
  if (!hidden || !hidden.length) return false
  const key = activity.trim().toLowerCase()
  return hidden.some((h) => h.trim().toLowerCase() === key)
}

// Filtre le texte ICS complet selon les critères. Exporté pour les tests.
// sansListes est le pendant fin de « sans » : { [catégorie]: [listes à
// exclure] }, seulement exploitable par un profil KV (trop détaillé pour
// tenir dans l'URL du format figé). hiddenActivities (#144) est plus fin
// encore : { [liste]: [libellés `activity` à exclure] } — exclut un service
// précis d'une Liste (ex. une répétition partielle d'un autre pupitre),
// même principe, même limite (profil KV seulement).
export function filterIcs(
  text,
  {
    listes = [],
    sans = [],
    annules = true,
    sansListes = {},
    hiddenActivities = {},
  },
) {
  if (
    !listes.length &&
    !sans.length &&
    annules &&
    !Object.keys(sansListes).length &&
    !Object.keys(hiddenActivities).length
  )
    return text

  const events = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n/g) || []
  const header = text.slice(0, text.indexOf("BEGIN:VEVENT"))
  const kept = events.filter((block) => {
    const liste = prop(block, "X-BEMOL-LISTE")
    const cat = prop(block, "X-BEMOL-CAT")
    const activity = prop(block, "X-BEMOL-ACTIVITY")
    if (listes.length && !listes.includes(liste)) return false
    if (sans.includes(cat)) return false
    if ((sansListes[cat] || []).includes(liste)) return false
    if (activityHidden(hiddenActivities[liste], activity)) return false
    if (!annules && /^STATUS:CANCELLED\r?$/m.test(block)) return false
    return true
  })

  // Nom distinct dans l'app d'agenda, pour ne pas confondre avec l'abonnement
  // complet si on a les deux.
  const personalizedHeader = header
    .replace(/^X-WR-CALNAME:.*$/m, "X-WR-CALNAME:OSR — Mon planning (Bémol)")
    .replace(/^NAME:.*$/m, "NAME:OSR — Mon planning (Bémol)")

  return personalizedHeader + kept.join("") + "END:VCALENDAR\r\n"
}

// "a, b ,," → ["a", "b"]
const list = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  })
}

// Un jeton de profil est un UUID généré côté app (crypto.randomUUID()).
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

const arrayOfStrings = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : []

export function sanitizePrefs(p) {
  if (!p || typeof p !== "object") return DEFAULT_PREFS
  const hiddenCatListes = {}
  if (p.hiddenCatListes && typeof p.hiddenCatListes === "object")
    for (const [cat, listes] of Object.entries(p.hiddenCatListes))
      hiddenCatListes[cat] = arrayOfStrings(listes)
  const hiddenActivities = {}
  if (p.hiddenActivities && typeof p.hiddenActivities === "object")
    for (const [liste, activities] of Object.entries(p.hiddenActivities))
      hiddenActivities[liste] = arrayOfStrings(activities)
  return {
    listes: arrayOfStrings(p.listes),
    hiddenCategories: arrayOfStrings(p.hiddenCategories),
    hiddenCatListes,
    hiddenActivities,
    showCancelled: p.showCancelled !== false,
  }
}

function sanitizeSubscription(s) {
  if (!s) return null
  if (
    typeof s.endpoint !== "string" ||
    !s.keys ||
    typeof s.keys.p256dh !== "string" ||
    typeof s.keys.auth !== "string"
  )
    return null
  return {
    endpoint: s.endpoint,
    expirationTime: s.expirationTime ?? null,
    keys: { p256dh: s.keys.p256dh, auth: s.keys.auth },
  }
}

// Retour libre (issue #125) : taille plafonnée, nom facultatif. Pas de
// collecte au-delà de ce que la personne tape elle-même (l'IP ne sert qu'à la
// limitation de débit ci-dessous, jamais stockée dans l'entrée elle-même).
const FEEDBACK_MESSAGE_MAX = 4000
const FEEDBACK_NAME_MAX = 200
// Anti-rafale minimal (formulaire public, sans compte) : un envoi par IP
// toutes les 30 s, largement suffisant pour un musicien mais pas pour un
// script.
const FEEDBACK_RATE_LIMIT_SECONDS = 30

export function sanitizeFeedback(body) {
  if (!body || typeof body !== "object") return null
  if (typeof body.message !== "string") return null
  const message = body.message.trim()
  if (!message || message.length > FEEDBACK_MESSAGE_MAX) return null
  const name =
    typeof body.name === "string"
      ? body.name.trim().slice(0, FEEDBACK_NAME_MAX)
      : ""
  return { message, name }
}

// POST /feedback { message, name?, url? } — url est un piège à robots : champ
// invisible côté app, qu'un humain ne remplit jamais. On répond succès sans
// rien stocker si le formulaire arrive rempli, pour ne pas indiquer à un
// robot qu'il a été repéré.
async function handleFeedback(request, env) {
  if (request.method !== "POST")
    return new Response("Méthode non supportée", {
      status: 405,
      headers: CORS_HEADERS,
    })

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: "JSON invalide" }, 400)
  }

  if (typeof body.url === "string" && body.url.trim()) return json({ ok: true })

  const clean = sanitizeFeedback(body)
  if (!clean) return json({ error: "message manquant, vide ou trop long" }, 400)

  const ip = request.headers.get("cf-connecting-ip") || "inconnue"
  const rateKey = `feedback-rl:${ip}`
  if (await env.NOTIF_PROFILES.get(rateKey))
    return json(
      {
        error:
          "un message a déjà été envoyé récemment depuis cet appareil, réessaie dans une minute",
      },
      429,
    )

  const at = new Date().toISOString()
  const key = `feedback:${at}-${crypto.randomUUID().slice(0, 8)}`
  // TTL généreux (1 an) : filet de sécurité contre l'accumulation si personne
  // ne relit plus jamais, pas une purge active — la relecture reste manuelle
  // (cf. commentaire d'en-tête).
  await env.NOTIF_PROFILES.put(
    key,
    JSON.stringify({ message: clean.message, name: clean.name, at }),
    { expirationTtl: 60 * 60 * 24 * 365 },
  )
  await env.NOTIF_PROFILES.put(rateKey, "1", {
    expirationTtl: FEEDBACK_RATE_LIMIT_SECONDS,
  })

  return json({ ok: true })
}

// PUT /profile/<jeton> { prefs?, subscription? } — fusionne dans le KV. Un
// champ absent du corps conserve la valeur précédente ; `subscription: null`
// efface explicitement l'abonnement push (désactivation).
async function handleProfile(request, env, token) {
  if (!TOKEN_RE.test(token)) return json({ error: "jeton invalide" }, 400)
  if (request.method !== "PUT")
    return new Response("Méthode non supportée", {
      status: 405,
      headers: CORS_HEADERS,
    })

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: "JSON invalide" }, 400)
  }

  const key = `profile:${token}`
  const existing = (await env.NOTIF_PROFILES.get(key, "json")) || {}
  const next = {
    prefs:
      "prefs" in body
        ? sanitizePrefs(body.prefs)
        : existing.prefs || DEFAULT_PREFS,
    subscription:
      "subscription" in body
        ? sanitizeSubscription(body.subscription)
        : (existing.subscription ?? null),
    updatedAt: new Date().toISOString(),
  }
  // TTL généreux (200 j, bien au-delà d'une saison) plutôt que permanent : un
  // appareil qui resynchronise régulièrement ne l'atteint jamais, un appareil
  // abandonné finit par disparaître du KV au lieu de s'y accumuler sans fin.
  await env.NOTIF_PROFILES.put(key, JSON.stringify(next), {
    expirationTtl: 60 * 60 * 24 * 200,
  })
  return json({ ok: true })
}

async function handleIcs(request, env, url) {
  const token = url.searchParams.get("profile")
  let opts
  if (token) {
    const stored = await env.NOTIF_PROFILES.get(`profile:${token}`, "json")
    const prefs = stored?.prefs || DEFAULT_PREFS
    opts = {
      listes: prefs.listes,
      sans: prefs.hiddenCategories,
      annules: prefs.showCancelled !== false,
      sansListes: prefs.hiddenCatListes,
      hiddenActivities: prefs.hiddenActivities,
    }
  } else {
    opts = {
      listes: list(url.searchParams.get("listes")),
      sans: list(url.searchParams.get("sans")),
      annules: url.searchParams.get("annules") !== "0",
    }
  }

  const upstream = await fetch(UPSTREAM, {
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  })
  if (!upstream.ok)
    return new Response("Calendrier source indisponible.", { status: 502 })

  const filtered = filterIcs(await upstream.text(), opts)

  return new Response(filtered, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="bemol-osr.ics"',
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      ...CORS_HEADERS,
    },
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      })

    if (url.pathname === "/vapid-public-key") {
      if (!env.VAPID_PUBLIC_KEY)
        return json({ error: "notifications non configurées" }, 503)
      return json({ publicKey: env.VAPID_PUBLIC_KEY })
    }

    if (url.pathname.startsWith("/profile/"))
      return handleProfile(request, env, url.pathname.slice("/profile/".length))

    if (url.pathname === "/feedback") return handleFeedback(request, env)

    // Tout le reste (dont /planning.ics) : calendrier filtré, comme avant.
    return handleIcs(request, env, url)
  },

  // Cron Cloudflare (cf. wrangler.toml [triggers]) : compare la dernière
  // entrée traitée de data/changes.json aux profils enregistrés et envoie une
  // notification groupée (jamais de rafale) par abonné concerné.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env))
  },
}

async function runScheduled(env) {
  const res = await fetch(CHANGES_UPSTREAM, { cf: { cacheTtl: 0 } })
  if (!res.ok) return
  const data = await res.json()
  const entries = data.entries || []

  const cursor = await env.NOTIF_PROFILES.get("cursor")
  if (!cursor) {
    // Premier passage : pas de référence fiable, on évite un envoi massif de
    // rattrapage. Le prochain cycle comparera à partir de maintenant.
    if (entries[0]) await env.NOTIF_PROFILES.put("cursor", entries[0].at)
    return
  }

  const fresh = entries.filter((e) => e.at > cursor)
  if (!fresh.length) return
  fresh.reverse() // du plus ancien au plus récent (entries est le plus récent d'abord)

  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  }

  let cursorParam
  do {
    const page = await env.NOTIF_PROFILES.list({
      prefix: "profile:",
      cursor: cursorParam,
    })
    for (const { name } of page.keys) {
      const profile = await env.NOTIF_PROFILES.get(name, "json")
      if (!profile?.subscription) continue
      const items = changesForProfile(fresh, profile.prefs || DEFAULT_PREFS)
      if (!items.length) continue
      await sendPush(env, name, profile, buildNotificationPayload(items), vapid)
    }
    cursorParam = page.list_complete ? undefined : page.cursor
  } while (cursorParam)

  await env.NOTIF_PROFILES.put("cursor", fresh[fresh.length - 1].at)
}

async function sendPush(env, key, profile, notification, vapid) {
  try {
    const message = {
      data: JSON.stringify(notification),
      options: { ttl: 3600, urgency: "normal", topic: "bemol-changes" },
    }
    const payload = await buildPushPayload(message, profile.subscription, vapid)
    const res = await fetch(profile.subscription.endpoint, payload)
    if (res.status === 404 || res.status === 410)
      await env.NOTIF_PROFILES.put(
        key,
        JSON.stringify({ ...profile, subscription: null }),
      )
    else if (!res.ok) console.error(`push ${key} : HTTP ${res.status}`)
  } catch (err) {
    console.error(`push ${key} en échec :`, err)
  }
}
