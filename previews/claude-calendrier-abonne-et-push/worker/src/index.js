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
// Le filtrage s'appuie sur les propriétés X-BEMOL-LISTE / X-BEMOL-CAT /
// X-BEMOL-ACTIVITY que scripts/build-ics.mjs écrit dans chaque VEVENT, comme
// toute propriété : texte échappé (escapeText) et plié à 75 octets (fold) —
// cf. prop().
//
// POST /feedback { message, name? } dépose un retour libre (issue #125) dans
// le même KV, sous la clé "feedback:<horodatage>-<id>", et l'envoie par email
// (cf. sendFeedbackEmail) : sans ça, personne n'était prévenu et les messages
// dormaient dans le KV. Pas de route de lecture dédiée (cf. discussion de
// l'issue) : relecture du KV à la main, depuis worker/ avec wrangler
// authentifié — jamais dans un workflow, dont les journaux sont publics :
//   wrangler kv key list --binding=NOTIF_PROFILES --remote --prefix=feedback:
//   wrangler kv key get  --binding=NOTIF_PROFILES --remote <clé>

import { buildPushPayload } from "@block65/webcrypto-web-push"
import {
  DEFAULT_PREFS,
  eventMatchesPrefs,
  changesForProfile,
  buildNotificationPayload,
  summarizePushResults,
  addToTotals,
} from "./notify.js"

const UPSTREAM = "https://isc.github.io/bemol-osr/data/planning.ics"
const PLANNING_UPSTREAM = "https://isc.github.io/bemol-osr/data/planning.json"
const CHANGES_UPSTREAM = "https://isc.github.io/bemol-osr/data/changes.json"

// Durée de cache de l'ICS complet côté Cloudflare : le planning est régénéré
// toutes les 2 h, et les agendas ne rafraîchissent que quelques fois par jour.
const CACHE_SECONDS = 600

const CORS_HEADERS = { "access-control-allow-origin": "*" }

// Valeur texte d'une propriété X-BEMOL-* d'un bloc VEVENT. build-ics.mjs
// l'écrit comme toute propriété : échappée (« bois\, cuivres ») et pliée à
// 75 octets (lignes de continuation qui commencent par une espace, RFC 5545
// §3.1). Lus tels quels, plusieurs libellés de service (« …percus / sions) »)
// ne correspondaient plus et échappaient à hiddenActivities et
// showNoOrchestra : on capture donc la valeur avec ses continuations, on la
// déplie et on la déséchappe (§3.3.11).
const propRe = (name) => new RegExp(`^${name}:(.*(?:\\r?\\n[ \\t].*)*)`, "m")
const LISTE_RE = propRe("X-BEMOL-LISTE")
const CAT_RE = propRe("X-BEMOL-CAT")
const ACTIVITY_RE = propRe("X-BEMOL-ACTIVITY")

function prop(block, re) {
  const m = block.match(re)
  if (!m) return ""
  return m[1]
    .replace(/\r?\n[ \t]/g, "")
    .replace(/\r$/, "")
    .replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c))
}

// Filtre le texte ICS complet selon les critères. Exporté pour les tests.
// sansListes est le pendant fin de « sans » : { [catégorie]: [listes à
// exclure] }, seulement exploitable par un profil KV (trop détaillé pour
// tenir dans l'URL du format figé). hiddenActivities (#144) est plus fin
// encore : { [liste]: [libellés `activity` à exclure] } — exclut un service
// précis d'une Liste (ex. une répétition partielle d'un autre pupitre),
// même principe, même limite (profil KV seulement). showNoOrchestra (#146)
// reprend côté abonnement le réglage « Afficher les services sans orchestre »
// de l'app — sans lui, ces services (masqués dans l'agenda personnalisé de
// l'app) continuaient de fuiter dans le calendrier ICS abonné. Les règles
// sont celles des notifications (eventMatchesPrefs) ; seuls les annulés sont
// traités à part, une annulation devant toujours être notifiée.
export function filterIcs(
  text,
  {
    listes = [],
    sans = [],
    annules = true,
    sansListes = {},
    hiddenActivities = {},
    showNoOrchestra = true,
  },
) {
  if (
    !listes.length &&
    !sans.length &&
    annules &&
    !Object.keys(sansListes).length &&
    !Object.keys(hiddenActivities).length &&
    showNoOrchestra
  )
    return text

  const prefs = {
    listes,
    hiddenCategories: sans,
    hiddenCatListes: sansListes,
    hiddenActivities,
    showNoOrchestra,
  }
  const events = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n/g) || []
  // En-tête : tout ce qui précède le premier VEVENT — ou, s'il n'y en a
  // aucun, la fin du calendrier (sinon indexOf = -1 tronquait le texte).
  const cut = text.search(/^(BEGIN:VEVENT|END:VCALENDAR)/m)
  const header = cut === -1 ? text : text.slice(0, cut)
  const kept = events.filter(
    (block) =>
      eventMatchesPrefs(
        {
          liste: prop(block, LISTE_RE),
          category: prop(block, CAT_RE),
          activity: prop(block, ACTIVITY_RE),
        },
        prefs,
      ) &&
      (annules || !/^STATUS:CANCELLED\r?$/m.test(block)),
  )

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

const isObject = (v) => Boolean(v) && typeof v === "object"

const arrayOfStrings = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : []

// Corps JSON d'une requête s'il s'agit d'un objet, null sinon. `null`, une
// chaîne ou un nombre sont du JSON valide, mais faisaient lever une
// TypeError plus loin (500, sans en-tête CORS).
async function readJsonObject(request) {
  try {
    const body = await request.json()
    return isObject(body) ? body : null
  } catch {
    return null
  }
}

export function sanitizePrefs(p) {
  if (!isObject(p)) return DEFAULT_PREFS
  const hiddenCatListes = {}
  if (isObject(p.hiddenCatListes))
    for (const [cat, listes] of Object.entries(p.hiddenCatListes))
      hiddenCatListes[cat] = arrayOfStrings(listes)
  const hiddenActivities = {}
  if (isObject(p.hiddenActivities))
    for (const [liste, activities] of Object.entries(p.hiddenActivities))
      hiddenActivities[liste] = arrayOfStrings(activities)
  return {
    listes: arrayOfStrings(p.listes),
    hiddenCategories: arrayOfStrings(p.hiddenCategories),
    hiddenCatListes,
    hiddenActivities,
    showCancelled: p.showCancelled !== false,
    showNoOrchestra: p.showNoOrchestra !== false,
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
// toutes les 60 s, largement suffisant pour un musicien mais pas pour un
// script. 60 est aussi le plancher imposé par Cloudflare KV pour
// expirationTtl : une valeur en dessous (30 à l'origine, issue #157) faisait
// échouer le PUT de la clé de limitation de débit avec une exception non
// interceptée, donc un échec d'envoi 500 côté formulaire — alors même que le
// message, écrit juste avant dans le KV, avait bien été enregistré.
const FEEDBACK_RATE_LIMIT_SECONDS = 60
// Plafond global, toutes adresses confondues : chaque message part par email
// (FEEDBACK_TO), et une rafale venue de nombreuses adresses passerait la
// limite par adresse. Une vingtaine par heure laisse une large marge (une
// quinzaine de messages en tout les premiers mois).
const FEEDBACK_HOURLY_MAX = 20

// Clé de la limite par adresse. En IPv6, un seul abonnement reçoit en général
// tout un préfixe /64 (2^64 adresses) : limiter l'adresse exacte ne retenait
// personne. On limite donc le /64, et l'adresse exacte en IPv4.
export function rateLimitKey(ip) {
  if (!ip.includes(":")) return ip
  const [head, tail = ""] = ip.toLowerCase().split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const zeros = Array(Math.max(0, 8 - left.length - right.length)).fill("0")
  return `${[...left, ...zeros, ...right].slice(0, 4).join(":")}::/64`
}

export function sanitizeFeedback(body) {
  if (!isObject(body)) return null
  if (typeof body.message !== "string") return null
  const message = body.message.trim()
  if (!message || message.length > FEEDBACK_MESSAGE_MAX) return null
  const name =
    typeof body.name === "string"
      ? body.name.trim().slice(0, FEEDBACK_NAME_MAX)
      : ""
  return { message, name }
}

// --- Envoi des retours par email (Resend) -----------------------------------
//
// Chaque retour enregistré part aussi par email à FEEDBACK_TO (secret : une
// ou plusieurs adresses séparées par des virgules — jamais dans le dépôt, qui
// est public), via l'API HTTP de Resend (secret RESEND_API_KEY), depuis
// FEEDBACK_FROM (wrangler.toml : domaine d'Arabesque, déjà vérifié chez
// Resend). Sans l'un des trois, rien n'est envoyé : le message reste dans le
// KV, et le Diagnostic le signale.

// Renvoie la requête à poster à Resend, ou null si l'envoi n'est pas configuré.
export function buildFeedbackEmail({ message, name, at }, env) {
  const to = (env.FEEDBACK_TO || "")
    .split(",")
    .map((adresse) => adresse.trim())
    .filter(Boolean)
  if (!env.RESEND_API_KEY || !env.FEEDBACK_FROM || !to.length) return null
  const quand = new Date(at).toLocaleString("fr-CH", {
    timeZone: "Europe/Zurich",
    dateStyle: "full",
    timeStyle: "short",
  })
  // Le nom vient d'un champ libre : aplati sur une ligne pour l'objet.
  const auteur = name.replace(/\s+/g, " ").slice(0, 80) || "anonyme"
  return {
    from: env.FEEDBACK_FROM,
    to,
    subject: `Bémol · nouveau retour (${auteur})`,
    text: [
      `Nouveau message envoyé depuis le formulaire « Donner un avis » de Bémol, le ${quand}.`,
      "",
      `De : ${name || "anonyme (aucun nom indiqué)"}`,
      "",
      message,
      "",
      "—",
      "Envoyé automatiquement par Bémol : ne pas répondre à cet email.",
    ].join("\n"),
  }
}

// Même principe que sendPush() : un verdict par envoi, jamais d'exception.
async function sendFeedbackEmail(env, entry) {
  const email = buildFeedbackEmail(entry, env)
  if (!email) return { kind: "skipped" }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(email),
    })
    if (res.ok) return { kind: "sent", status: res.status }
    let reason = ""
    try {
      reason = (await res.text()).slice(0, 300)
    } catch {}
    console.error(
      `email du retour : HTTP ${res.status}${reason ? ` — ${reason}` : ""}`,
    )
    return { kind: "failed", status: res.status, reason: reason || undefined }
  } catch (err) {
    console.error("email du retour en échec :", err)
    return { kind: "failed", error: err?.name || "exception" }
  }
}

// Verdict relu par le workflow « Diagnostic notifications » : une panne
// d'envoi ne doit pas rester invisible, comme l'a été celle des
// notifications push (#158 → #196).
async function recordFeedbackMail(env, outcome) {
  const at = new Date().toISOString()
  await env.NOTIF_PROFILES.put(
    "feedback-mail:last",
    JSON.stringify({ at, ...outcome }),
  )
  const totals = (await env.NOTIF_PROFILES.get(
    "feedback-mail:totals",
    "json",
  )) || { sent: 0, failed: 0, skipped: 0, since: at }
  totals[outcome.kind] = (totals[outcome.kind] || 0) + 1
  await env.NOTIF_PROFILES.put("feedback-mail:totals", JSON.stringify(totals))
}

// POST /feedback { message, name?, url? } — url est un piège à robots : champ
// invisible côté app, qu'un humain ne remplit jamais. On répond succès sans
// rien stocker si le formulaire arrive rempli, pour ne pas indiquer à un
// robot qu'il a été repéré.
export async function handleFeedback(request, env) {
  if (request.method !== "POST")
    return new Response("Méthode non supportée", {
      status: 405,
      headers: CORS_HEADERS,
    })

  const body = await readJsonObject(request)
  if (!body) return json({ error: "JSON invalide" }, 400)

  if (typeof body.url === "string" && body.url.trim()) return json({ ok: true })

  const clean = sanitizeFeedback(body)
  if (!clean) return json({ error: "message manquant, vide ou trop long" }, 400)

  const ip = request.headers.get("cf-connecting-ip") || "inconnue"
  const rateKey = `feedback-rl:${rateLimitKey(ip)}`
  if (await env.NOTIF_PROFILES.get(rateKey))
    return json(
      {
        error:
          "un message a déjà été envoyé récemment depuis cet appareil, réessaie dans une minute",
      },
      429,
    )

  const at = new Date().toISOString()
  const hourKey = `feedback-rl:heure:${at.slice(0, 13)}`
  const thisHour = Number(await env.NOTIF_PROFILES.get(hourKey)) || 0
  if (thisHour >= FEEDBACK_HOURLY_MAX)
    return json(
      {
        error:
          "beaucoup de messages reçus en ce moment, réessaie dans une heure",
      },
      429,
    )

  const key = `feedback:${at}-${crypto.randomUUID().slice(0, 8)}`
  // TTL généreux (1 an) : filet de sécurité contre l'accumulation, pas une
  // purge active — le KV garde une trace même si l'email se perd.
  await env.NOTIF_PROFILES.put(
    key,
    JSON.stringify({ message: clean.message, name: clean.name, at }),
    { expirationTtl: 60 * 60 * 24 * 365 },
  )
  await env.NOTIF_PROFILES.put(rateKey, "1", {
    expirationTtl: FEEDBACK_RATE_LIMIT_SECONDS,
  })
  await env.NOTIF_PROFILES.put(hourKey, String(thisHour + 1), {
    expirationTtl: 2 * 3600,
  })

  // Après l'enregistrement : si l'email échoue, le message est déjà sauvé et
  // l'échec compté pour le Diagnostic — jamais une erreur pour le musicien.
  try {
    await recordFeedbackMail(
      env,
      await sendFeedbackEmail(env, { ...clean, at }),
    )
  } catch (err) {
    console.error("suivi de l'email du retour en échec :", err)
  }

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

  const body = await readJsonObject(request)
  if (!body) return json({ error: "JSON invalide" }, 400)

  const key = `profile:${token}`
  const existing = (await env.NOTIF_PROFILES.get(key, "json")) || {}
  await putProfile(env, key, {
    prefs:
      "prefs" in body
        ? sanitizePrefs(body.prefs)
        : existing.prefs || DEFAULT_PREFS,
    subscription:
      "subscription" in body
        ? sanitizeSubscription(body.subscription)
        : (existing.subscription ?? null),
    updatedAt: new Date().toISOString(),
  })
  return json({ ok: true })
}

// TTL généreux (200 j, bien au-delà d'une saison) plutôt que permanent : un
// appareil abandonné finit par disparaître du KV au lieu de s'y accumuler
// sans fin. Tout PUT doit le reposer : sans expirationTtl, Cloudflare rend
// la clé permanente.
export const PROFILE_TTL_SECONDS = 60 * 60 * 24 * 200

function putProfile(env, key, profile) {
  return env.NOTIF_PROFILES.put(key, JSON.stringify(profile), {
    expirationTtl: PROFILE_TTL_SECONDS,
  })
}

// Un profil encore servi (calendrier lu par un agenda abonné, notification
// acceptée) est vivant, même si l'app n'est plus rouverte : on repousse son
// expiration, au plus une fois par mois. Sans ça, il expirait au bout de
// 200 j sans visite des Réglages : l'agenda abonné revenait au calendrier
// complet et les notifications cessaient, l'app affichant « Activées ».
const PROFILE_REFRESH_MS = 30 * 24 * 3600 * 1000

async function touchProfile(env, key, profile) {
  const age = Date.now() - Date.parse(profile.updatedAt)
  if (age < PROFILE_REFRESH_MS) return // NaN (pas de date) : à reposer
  try {
    await putProfile(env, key, {
      ...profile,
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error("TTL du profil non reposé :", err)
  }
}

async function handleIcs(request, env, url, ctx) {
  const token = url.searchParams.get("profile")
  let opts
  if (token) {
    const key = `profile:${token}`
    const stored = await env.NOTIF_PROFILES.get(key, "json")
    if (stored) ctx.waitUntil(touchProfile(env, key, stored))
    const prefs = stored?.prefs || DEFAULT_PREFS
    opts = {
      listes: prefs.listes,
      sans: prefs.hiddenCategories,
      annules: prefs.showCancelled !== false,
      sansListes: prefs.hiddenCatListes,
      hiddenActivities: prefs.hiddenActivities,
      showNoOrchestra: prefs.showNoOrchestra !== false,
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
  async fetch(request, env, ctx) {
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
    return handleIcs(request, env, url, ctx)
  },

  // Cron Cloudflare (cf. wrangler.toml [triggers]), deux tâches
  // indépendantes (l'échec de l'une n'empêche pas l'autre) :
  // - compare la dernière entrée traitée de data/changes.json aux profils
  //   enregistrés et envoie une notification groupée (jamais de rafale) par
  //   abonné concerné ;
  // - lance à l'heure les crons de données de GitHub (cf. dispatchWorkflows).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.allSettled([
        runScheduled(env),
        dispatchWorkflows(env, event.scheduledTime),
      ]),
    )
  },
}

// --- Déclenchement des crons de données GitHub ------------------------------
//
// GitHub ne tient pas ses horaires : programmé toutes les 2 h (12 passages
// par jour), update-data.yml ne passait plus que 3 ou 4 fois par jour début
// octobre 2026 (6,9 h d'écart en moyenne, jusqu'à 8,8 h ; cf. revue #203).
// Un service déplacé pouvait donc mettre 9 h à atteindre l'app, l'agenda
// abonné et les notifications. Le cron de ce worker, lui, est ponctuel : il
// lance donc lui-même les workflows par l'API GitHub. Les `schedule` de
// GitHub restent en place comme filet de sécurité ; un passage en double ne
// coûte rien (file `queue: max` du groupe gh-pages, cf. CLAUDE.md).
//
// Jeton : secret GH_DISPATCH_TOKEN, jeton GitHub « fine-grained » limité au
// dépôt, avec la seule permission Actions en lecture/écriture (lancer un
// workflow ; aucun accès au code ni aux secrets). Sans lui, rien n'est lancé.

const GITHUB_REPO = "isc/bemol-osr"

// Workflows à lancer pour un réveil du cron (toutes les 15 min, à :00, :15,
// :30, :45). En heure UTC, comme les `schedule` de GitHub.
export function workflowsToDispatch(time) {
  const d = new Date(time)
  const h = d.getUTCHours()
  const m = d.getUTCMinutes()
  const due = []
  // Toutes les 2 h, au premier réveil de chaque heure paire.
  if (h % 2 === 0 && m < 15) due.push("update-data.yml")
  // Le mémo une fois par nuit, au réveil de 4 h 45 UTC (même créneau que le
  // `schedule` de update-memo.yml) : on reste courtois avec le mini-site
  // Dièse, qui génère le PDF côté serveur.
  if (h === 4 && m >= 45) due.push("update-memo.yml")
  return due
}

// Renvoie les verdicts des lancements tentés (aussi enregistrés dans le KV
// pour le Diagnostic). Jamais d'exception : le cron des notifications tourne
// à côté.
export async function dispatchWorkflows(env, time) {
  if (!env.GH_DISPATCH_TOKEN) return []
  const outcomes = []
  for (const workflow of workflowsToDispatch(time))
    outcomes.push({ workflow, ...(await dispatchWorkflow(env, workflow)) })
  if (outcomes.length) await recordDispatch(env, outcomes)
  return outcomes
}

async function dispatchWorkflow(env, workflow) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          // L'API GitHub refuse toute requête sans User-Agent.
          "user-agent": "bemol-calendrier (worker Cloudflare)",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    )
    // Succès : 204 No Content.
    if (res.ok) return { kind: "sent", status: res.status }
    let reason = ""
    try {
      reason = (await res.text()).slice(0, 300)
    } catch {}
    console.error(
      `lancement de ${workflow} : HTTP ${res.status}${reason ? ` — ${reason}` : ""}`,
    )
    return { kind: "failed", status: res.status, reason: reason || undefined }
  } catch (err) {
    console.error(`lancement de ${workflow} en échec :`, err)
    return { kind: "failed", error: err?.name || "exception" }
  }
}

// Verdicts relus par le workflow « Diagnostic notifications » : un jeton
// expiré ou révoqué ne doit pas faire retomber en silence sur les seuls
// `schedule` de GitHub.
async function recordDispatch(env, outcomes) {
  const at = new Date().toISOString()
  await env.NOTIF_PROFILES.put(
    "dispatch-stats:last",
    JSON.stringify({ at, outcomes }),
  )
  const totals = (await env.NOTIF_PROFILES.get(
    "dispatch-stats:totals",
    "json",
  )) || { sent: 0, failed: 0, since: at }
  for (const { kind } of outcomes) totals[kind] = (totals[kind] || 0) + 1
  await env.NOTIF_PROFILES.put("dispatch-stats:totals", JSON.stringify(totals))
}

export async function runScheduled(env) {
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
    subject: vapidSubject(env.VAPID_SUBJECT),
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  }

  // Événements du planning, pour ne pas notifier une série déjà terminée.
  // Indisponible : on notifie quand même (cf. isListeFinished).
  const planning = await fetch(PLANNING_UPSTREAM, { cf: { cacheTtl: 0 } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d?.events || null)
    .catch(() => null)

  // Curseur avancé AVANT les envois : un cycle interrompu en route (KV en
  // panne, worker arrêté) fait au pire manquer cette notification aux
  // abonnés restants. Écrit après la boucle, il la faisait renvoyer toutes
  // les 15 min à ceux déjà servis.
  await env.NOTIF_PROFILES.put("cursor", fresh[fresh.length - 1].at)

  const outcomes = []
  const retries = []
  try {
    let cursorParam
    do {
      const page = await env.NOTIF_PROFILES.list({
        prefix: "profile:",
        cursor: cursorParam,
      })
      for (const { name } of page.keys) {
        // Un profil illisible (lecture KV en échec, données corrompues) ne
        // prive pas les suivants de leur notification.
        const outcome = await notifyProfile(
          env,
          name,
          fresh,
          planning,
          vapid,
        ).catch((err) => {
          console.error(`profil ${name} :`, err)
          return { kind: "failed", error: err?.name || "exception" }
        })
        if (outcome?.retry) retries.push(outcome)
        else if (outcome) outcomes.push(outcome)
      }
      cursorParam = page.list_complete ? undefined : page.cursor
    } while (cursorParam)

    // Refus passagers (cf. sendPush) : une seule attente pour tout le cycle,
    // la plus longue demandée, puis une seconde et dernière tentative.
    if (retries.length) {
      const waitMs = Math.max(...retries.map((r) => r.waitMs))
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      for (const { retry } of retries) outcomes.push(await retry())
    }
  } finally {
    await recordPushStats(env, outcomes, fresh.length)
  }
}

// Notifie un abonné des changements qui le concernent ; null s'il n'y a
// rien à lui envoyer.
async function notifyProfile(env, name, fresh, planning, vapid) {
  const profile = await env.NOTIF_PROFILES.get(name, "json")
  if (!profile?.subscription) return null
  const items = changesForProfile(fresh, profile.prefs || DEFAULT_PREFS, {
    planning,
  })
  if (!items.length) return null
  return sendPush(env, name, profile, buildNotificationPayload(items), vapid)
}

// RFC 8292 §2 : le `sub` du JWT VAPID doit être un URI de contact (mailto:
// ou https:), sans quoi Apple/Google rejettent l'envoi en 400 — une erreur de
// configuration facile à faire (coller juste l'adresse e-mail) et impossible
// à distinguer d'une autre cause de 400 sans lire le corps de la réponse
// (cf. sendPush ci-dessous). On normalise donc plutôt que de partir d'une
// hypothèse non vérifiable sur le contenu du secret.
export function vapidSubject(subject) {
  if (!subject || /^(mailto:|https?:)/i.test(subject)) return subject
  return `mailto:${subject}`
}

// Trace du dernier cycle ayant réellement tenté des envois, plus un cumul
// depuis toujours (cf. summarizePushResults). Sans ça, un push qui échoue
// systématiquement — clé VAPID invalide, endpoint refusé — est indétectable :
// l'abonné voit « Activées » et ne reçoit rien, la CI reste verte.
//
// On n'écrit rien quand aucun envoi n'a été tenté : la plupart des cycles ne
// concernent personne, et ça écraserait la dernière trace utile.
async function recordPushStats(env, outcomes, changeCount) {
  if (!outcomes.length) return
  const summary = summarizePushResults(outcomes)
  await env.NOTIF_PROFILES.put(
    "push-stats:last",
    JSON.stringify({
      at: new Date().toISOString(),
      changes: changeCount,
      ...summary,
    }),
  )
  const totals = await env.NOTIF_PROFILES.get("push-stats:totals", "json")
  await env.NOTIF_PROFILES.put(
    "push-stats:totals",
    JSON.stringify(addToTotals(totals, summary)),
  )
}

const PUSH_TTL_SECONDS = 24 * 3600

// Renvoie le verdict de l'envoi, agrégé par recordPushStats() — jamais rien
// d'identifiant, seulement un genre et un code HTTP. Ou, pour un refus
// passager, de quoi retenter l'envoi en fin de cycle (cf. runScheduled).
async function sendPush(
  env,
  key,
  profile,
  notification,
  vapid,
  canRetry = true,
) {
  try {
    // Surtout pas d'option `topic` : le service push d'Apple refuse tout
    // envoi qui porte un en-tête Topic (`400 {"reason":"BadWebPushTopic"}`),
    // ce qui a bloqué 100 % des notifications jusqu'à fin septembre 2026
    // (Diagnostic du 28/09 : 0 accepté sur 126, cf. revue #194).
    // TTL d'un jour : le service push garde la notification tant que le
    // téléphone est injoignable. Une heure ne couvrait pas un téléphone
    // éteint pendant un concert ou un service de 2 h 30.
    const message = {
      data: JSON.stringify(notification),
      options: { ttl: PUSH_TTL_SECONDS, urgency: "normal" },
    }
    const payload = await buildPushPayload(message, profile.subscription, vapid)
    const res = await fetch(profile.subscription.endpoint, payload)
    // Refus passager (429 trop de requêtes, 5xx panne du service push) :
    // retenté une fois, sans quoi la notification était perdue. Délai : le
    // Retry-After demandé, plafonné à 3 s pour ne pas bloquer le cron, 1 s
    // à défaut.
    if (canRetry && (res.status === 429 || res.status >= 500)) {
      const seconds = parseFloat(res.headers.get("retry-after"))
      return {
        waitMs: seconds >= 0 ? Math.min(seconds, 3) * 1000 : 1000,
        retry: () => sendPush(env, key, profile, notification, vapid, false),
      }
    }
    if (res.status === 404 || res.status === 410) {
      await putProfile(env, key, { ...profile, subscription: null })
      return { kind: "expired", status: res.status }
    }
    if (!res.ok) {
      // Le corps de la réponse (texte générique du service push, jamais de
      // donnée d'appareil) est le seul moyen de distinguer un vrai incident
      // ponctuel d'une config cassée (VAPID invalide, sujet mal formé…) —
      // sans lui, `400` seul ne dit pas pourquoi (cf. issue #158).
      let reason = ""
      try {
        reason = (await res.text()).slice(0, 300)
      } catch {}
      console.error(
        `push ${key} : HTTP ${res.status}${reason ? ` — ${reason}` : ""}`,
      )
      return { kind: "failed", status: res.status, reason: reason || undefined }
    }
    await touchProfile(env, key, profile)
    return { kind: "sent", status: res.status }
  } catch (err) {
    console.error(`push ${key} en échec :`, err)
    return { kind: "failed", error: err?.name || "exception" }
  }
}
