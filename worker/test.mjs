#!/usr/bin/env node
// Test du filtre du worker sur le vrai calendrier généré (data/planning.ics).
// Usage : node worker/test.mjs — échoue (exit 1) à la moindre incohérence.

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  filterIcs,
  sanitizePrefs,
  sanitizeFeedback,
  handleFeedback,
  buildFeedbackEmail,
  vapidSubject,
  workflowsToDispatch,
  dispatchWorkflows,
} from "./src/index.js"

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

// Sous-case « liste dans une catégorie » (sansListes), exploitable seulement
// par un profil KV (trop fin pour l'URL du format figé) : exclut UNE liste
// d'UNE catégorie sans toucher au reste de cette catégorie ni aux autres.
const sansListes = { repetition: ["Liste 01"] }
const expectedSansListes = planning.events.filter(
  (e) => !(e.category === "repetition" && e.liste === "Liste 01"),
).length
const bySansListes = filterIcs(ics, {
  listes: [],
  sans: [],
  annules: true,
  sansListes,
})
if (count(bySansListes) !== expectedSansListes)
  fail(
    `filtre sansListes : ${count(bySansListes)} ≠ ${expectedSansListes} attendus`,
  )

// Sous-case « service précis dans une liste » (hiddenActivities, #144) :
// exclut UN libellé `activity` d'UNE liste sans toucher au reste de cette
// liste ni aux autres — même principe et même limite (profil KV) que
// sansListes ci-dessus.
const hiddenActivities = { "Liste 28b": ["partielle (violons 1)"] }
const expectedHiddenActivities = planning.events.filter(
  (e) => !(e.liste === "Liste 28b" && e.activity === "partielle (violons 1)"),
).length
const byHiddenActivities = filterIcs(ics, {
  listes: [],
  sans: [],
  annules: true,
  hiddenActivities,
})
if (count(byHiddenActivities) !== expectedHiddenActivities)
  fail(
    `filtre hiddenActivities : ${count(byHiddenActivities)} ≠ ${expectedHiddenActivities} attendus`,
  )

// Dièse laisse passer des variantes de casse pour un même service (cas réel
// de Liste 10 : « (sans OSR) » / « (Sans OSR) ») : les deux doivent être
// exclues par un seul libellé masqué, casse insensible.
const hiddenActivitiesCasse = {
  "Liste 10": ["partielle par pupitre (sans osr)"],
}
const expectedHiddenActivitiesCasse = planning.events.filter(
  (e) =>
    !(
      e.liste === "Liste 10" &&
      e.activity.trim().toLowerCase() === "partielle par pupitre (sans osr)"
    ),
).length
const byHiddenActivitiesCasse = filterIcs(ics, {
  listes: [],
  sans: [],
  annules: true,
  hiddenActivities: hiddenActivitiesCasse,
})
if (count(byHiddenActivitiesCasse) !== expectedHiddenActivitiesCasse)
  fail(
    `filtre hiddenActivities (casse) : ${count(byHiddenActivitiesCasse)} ≠ ${expectedHiddenActivitiesCasse} attendus`,
  )

// Filtre « services sans orchestre » (#146) : reprend, pour l'abonnement,
// le réglage « Afficher les services sans orchestre » de l'app (répétitions
// chef+soliste(s)+piano « (sans orchestre) », générales piano, services
// techniques, chœur seul — #169/#171) — sans lui, ces services (masqués dans
// l'agenda personnalisé de l'app) continuaient de fuiter dans le calendrier
// ICS abonné. La regex ci-dessous doit rester synchronisée avec
// isNoOrchestra() de worker/src/index.js (elle-même reprise d'app.js).
const expectedNoOrchestra = planning.events.filter(
  (e) =>
    !(
      /sans orch(estre|\.|,)|sans osr/i.test(e.activity) ||
      /générale piano/i.test(e.activity) ||
      /technique/i.test(e.activity) ||
      (/choeur|chœur/i.test(e.activity) && !/avec/i.test(e.activity))
    ),
).length
const byNoOrchestra = filterIcs(ics, {
  listes: [],
  sans: [],
  annules: true,
  showNoOrchestra: false,
})
if (count(byNoOrchestra) !== expectedNoOrchestra)
  fail(
    `filtre showNoOrchestra : ${count(byNoOrchestra)} ≠ ${expectedNoOrchestra} attendus`,
  )
if (count(byNoOrchestra) === total)
  fail(
    "filtre showNoOrchestra : le jeu de données de test devrait contenir au moins un service sans orchestre",
  )

// sanitizePrefs ne doit jamais laisser passer autre chose que des tableaux de
// chaînes / un objet de tableaux — entrée du KV, donc pas de confiance.
const dirty = {
  listes: ["Liste 01", 42, null],
  hiddenCategories: "resa", // pas un tableau
  hiddenCatListes: { repetition: ["Liste 01", {}] },
  hiddenActivities: { "Liste 28b": ["partielle (violons 1)", 42] },
  showCancelled: "oui", // seule la valeur booléenne false doit compter
  showNoOrchestra: "oui", // idem
}
const clean = sanitizePrefs(dirty)
if (JSON.stringify(clean.listes) !== JSON.stringify(["Liste 01"]))
  fail(
    "sanitizePrefs : les valeurs non-chaînes de listes devraient être filtrées",
  )
if (
  !Array.isArray(clean.hiddenCategories) ||
  clean.hiddenCategories.length !== 0
)
  fail("sanitizePrefs : une valeur non-tableau devrait devenir un tableau vide")
if (
  JSON.stringify(clean.hiddenCatListes.repetition) !==
  JSON.stringify(["Liste 01"])
)
  fail(
    "sanitizePrefs : hiddenCatListes devrait filtrer les valeurs non-chaînes",
  )
if (
  JSON.stringify(clean.hiddenActivities["Liste 28b"]) !==
  JSON.stringify(["partielle (violons 1)"])
)
  fail(
    "sanitizePrefs : hiddenActivities devrait filtrer les valeurs non-chaînes",
  )
if (clean.showCancelled !== true)
  fail(
    "sanitizePrefs : showCancelled ne doit être false que si explicitement false",
  )
if (clean.showNoOrchestra !== true)
  fail(
    "sanitizePrefs : showNoOrchestra ne doit être false que si explicitement false",
  )

// La structure reste un VCALENDAR équilibré et terminé proprement.
for (const [name, out] of [
  ["listes", byListe],
  ["catégories", byCat],
  ["sansListes", bySansListes],
  ["hiddenActivities", byHiddenActivities],
  ["showNoOrchestra", byNoOrchestra],
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

// --- sanitizeFeedback (formulaire de retour, issue #125) --------------------

if (sanitizeFeedback(null) !== null)
  fail("sanitizeFeedback : corps absent devrait être rejeté")
if (sanitizeFeedback({}) !== null)
  fail("sanitizeFeedback : message manquant devrait être rejeté")
if (sanitizeFeedback({ message: "   " }) !== null)
  fail("sanitizeFeedback : message vide (une fois trimé) devrait être rejeté")
if (sanitizeFeedback({ message: "x".repeat(4001) }) !== null)
  fail("sanitizeFeedback : message trop long devrait être rejeté")

const okFeedback = sanitizeFeedback({
  message: "  Merci pour l'app, une suggestion : ...  ",
  name: "  Alto, pupitre 2  ",
})
if (
  !okFeedback ||
  okFeedback.message !== "Merci pour l'app, une suggestion : ..."
)
  fail("sanitizeFeedback : le message valide devrait être conservé, trimé")
if (okFeedback.name !== "Alto, pupitre 2")
  fail("sanitizeFeedback : le nom valide devrait être conservé, trimé")

const anonFeedback = sanitizeFeedback({ message: "Un souci sur la Liste 12" })
if (anonFeedback.name !== "")
  fail(
    "sanitizeFeedback : sans nom fourni, le champ devrait être une chaîne vide",
  )

const longName = sanitizeFeedback({ message: "ok", name: "x".repeat(300) })
if (longName.name.length !== 200)
  fail("sanitizeFeedback : un nom trop long devrait être tronqué, pas rejeté")

console.log("✓ sanitizeFeedback OK")

// --- handleFeedback : Cloudflare KV refuse tout expirationTtl < 60 s -------
// (le PUT lève une exception non interceptée) : une régression ici a fait
// échouer silencieusement TOUT envoi de retour en production (issue #157,
// FEEDBACK_RATE_LIMIT_SECONDS valait 30). Ce mock reproduit cette contrainte
// de Cloudflare KV pour que le test rejoue vraiment le bug.
function makeMockKv() {
  const store = new Map()
  return {
    async get(key, type) {
      const value = store.has(key) ? store.get(key) : null
      return value !== null && type === "json" ? JSON.parse(value) : value
    },
    async put(key, value, opts) {
      const ttl = opts?.expirationTtl
      if (ttl !== undefined && ttl < 60)
        throw new Error(
          `KV PUT failed: 400 Invalid expiration_ttl of ${ttl}. Expiration TTL must be at least 60.`,
        )
      store.set(key, value)
    },
  }
}

const feedbackRequest = (body) => ({
  method: "POST",
  headers: { get: () => "203.0.113.1" },
  async json() {
    return body
  },
})

const feedbackEnv = { NOTIF_PROFILES: makeMockKv() }
try {
  const feedbackRes = await handleFeedback(
    feedbackRequest({ message: "Un souci sur la Liste 12" }),
    feedbackEnv,
  )
  if (feedbackRes.status !== 200)
    fail(
      `handleFeedback : un message valide devrait réussir (HTTP ${feedbackRes.status}) — ` +
        "vérifier FEEDBACK_RATE_LIMIT_SECONDS (plancher de 60 s côté Cloudflare KV)",
    )
} catch (err) {
  fail(
    `handleFeedback : ne devrait jamais lever d'exception (${err.message}) — ` +
      "vérifier FEEDBACK_RATE_LIMIT_SECONDS (plancher de 60 s côté Cloudflare KV)",
  )
}

console.log("✓ handleFeedback OK")

// --- Envoi des retours par email (Resend) -----------------------------------
// Sans ça, les messages dormaient dans le KV sans que personne soit prévenu.

const mailEnv = (kv) => ({
  NOTIF_PROFILES: kv,
  RESEND_API_KEY: "re_test",
  FEEDBACK_FROM: "Bémol <bemol@arabesque.app>",
  FEEDBACK_TO: " loic@example.org , ivan@example.org ",
})
const entree = {
  message: "Pouvoir filtrer par pupitre",
  name: "Marie\n(altos)",
  at: "2026-09-29T11:05:00.000Z",
}

const mail = buildFeedbackEmail(entree, mailEnv(null))
if (mail?.to?.join() !== "loic@example.org,ivan@example.org")
  fail(
    "buildFeedbackEmail : FEEDBACK_TO doit donner la liste des adresses, espaces retirés",
  )
if (mail.from !== "Bémol <bemol@arabesque.app>")
  fail("buildFeedbackEmail : l'expéditeur doit venir de FEEDBACK_FROM")
if (mail.subject !== "Bémol · nouveau retour (Marie (altos))")
  fail(
    `buildFeedbackEmail : objet inattendu (${mail.subject}) — nom aplati sur une ligne`,
  )
if (
  !mail.text.includes("Pouvoir filtrer par pupitre") ||
  !mail.text.includes("13:05")
)
  fail(
    "buildFeedbackEmail : le texte doit contenir le message et l'heure de Genève",
  )
if (
  !buildFeedbackEmail({ ...entree, name: "" }, mailEnv(null)).subject.endsWith(
    "(anonyme)",
  )
)
  fail("buildFeedbackEmail : sans nom, l'objet doit dire « anonyme »")
for (const manquant of ["RESEND_API_KEY", "FEEDBACK_FROM", "FEEDBACK_TO"])
  if (buildFeedbackEmail(entree, { ...mailEnv(null), [manquant]: "" }) !== null)
    fail(`buildFeedbackEmail : sans ${manquant}, rien ne doit partir`)

// handleFeedback avec un faux fetch : envoi réussi, échec, puis envoi non
// configuré. Dans tous les cas le musicien reçoit un succès, le message est
// dans le KV, et le verdict est compté pour le Diagnostic.
const vraiFetch = globalThis.fetch
const appels = []
const retourAvecFetch = async (env, reponse) => {
  globalThis.fetch = async (url, init) => {
    appels.push({ url, init })
    return reponse
  }
  try {
    return await handleFeedback(feedbackRequest({ message: "Test" }), env)
  } finally {
    globalThis.fetch = vraiFetch
  }
}
const kvMail = makeMockKv()
const mailRes = await retourAvecFetch(
  mailEnv(kvMail),
  new Response('{"id":"x"}', { status: 200 }),
)
if (mailRes.status !== 200)
  fail("handleFeedback : l'envoi par email ne doit pas changer la réponse")
const appel = appels.at(-1)
if (appel?.url !== "https://api.resend.com/emails")
  fail("handleFeedback : l'email doit partir par l'API de Resend")
if (appel.init.headers.authorization !== "Bearer re_test")
  fail("handleFeedback : la clé RESEND_API_KEY doit être envoyée")
if (JSON.parse(appel.init.body).to.length !== 2)
  fail(
    "handleFeedback : l'email doit partir à toutes les adresses de FEEDBACK_TO",
  )
let totaux = await kvMail.get("feedback-mail:totals", "json")
if (totaux?.sent !== 1)
  fail("handleFeedback : un envoi réussi doit être compté")

// Nouvelle IP implicite : la clé anti-rafale est par IP, on vide donc le KV.
const kvEchec = makeMockKv()
await retourAvecFetch(
  mailEnv(kvEchec),
  new Response('{"message":"The arabesque.app domain is not verified"}', {
    status: 403,
  }),
)
const dernier = await kvEchec.get("feedback-mail:last", "json")
if (
  dernier?.kind !== "failed" ||
  dernier.status !== 403 ||
  !dernier.reason?.includes("not verified")
)
  fail(
    "handleFeedback : un refus de Resend doit être gardé avec son code et sa raison",
  )

const kvSansConfig = makeMockKv()
const avant = appels.length
await retourAvecFetch(
  { NOTIF_PROFILES: kvSansConfig },
  new Response("", { status: 200 }),
)
if (appels.length !== avant)
  fail("handleFeedback : sans configuration, aucun appel à Resend")
totaux = await kvSansConfig.get("feedback-mail:totals", "json")
if (totaux?.skipped !== 1)
  fail("handleFeedback : un envoi non configuré doit être compté")
if (!(await kvSansConfig.get("feedback-rl:203.0.113.1")))
  fail("handleFeedback : le retour doit être enregistré même sans email")

console.log("✓ envoi des retours par email OK")

// #158 : le `sub` du JWT VAPID doit être un URI (mailto:/https:) pour Apple —
// erreur de config plausible (secret posé comme simple adresse e-mail) et
// invisible sans lire le corps de la réponse (cf. sendPush).
if (vapidSubject("contact@example.org") !== "mailto:contact@example.org")
  fail("vapidSubject : une adresse nue devrait être préfixée de mailto:")
if (vapidSubject("mailto:contact@example.org") !== "mailto:contact@example.org")
  fail("vapidSubject : un sujet déjà valide ne devrait pas être modifié")
if (vapidSubject("https://bemol-osr.example") !== "https://bemol-osr.example")
  fail("vapidSubject : un sujet https: ne devrait pas être modifié")
if (vapidSubject(undefined) !== undefined)
  fail(
    'vapidSubject : un sujet absent doit rester absent (pas de "mailto:undefined")',
  )

console.log("✓ vapidSubject OK")

// --- Lancement des crons de données GitHub (revue #203, point 1) -----------
// Le `schedule` de update-data.yml ne passait que 3 ou 4 fois par jour au
// lieu de 12 : le cron du worker les lance lui-même.

const aHeure = (hhmm) => Date.parse(`2026-10-09T${hhmm}:00Z`)
const attendus = {
  "00:00": ["update-data.yml"],
  "10:00": ["update-data.yml"],
  "10:15": [],
  "11:00": [],
  "04:00": ["update-data.yml"],
  "04:30": [],
  "04:45": ["update-memo.yml"],
  "22:00": ["update-data.yml"],
}
for (const [hhmm, attendu] of Object.entries(attendus))
  if (workflowsToDispatch(aHeure(hhmm)).join() !== attendu.join())
    fail(
      `workflowsToDispatch ${hhmm} UTC : ${workflowsToDispatch(aHeure(hhmm))} au lieu de ${attendu}`,
    )
// Sur une journée de réveils toutes les 15 min : 12 planning, 1 mémo.
const parJour = {}
for (let t = aHeure("00:00"); t < aHeure("00:00") + 86_400_000; t += 900_000)
  for (const w of workflowsToDispatch(t)) parJour[w] = (parJour[w] || 0) + 1
if (parJour["update-data.yml"] !== 12 || parJour["update-memo.yml"] !== 1)
  fail(
    `workflowsToDispatch : ${JSON.stringify(parJour)} par jour au lieu de 12 planning + 1 mémo`,
  )

const lancements = []
const lancerAvec = async (env, time, reponse) => {
  globalThis.fetch = async (url, init) => {
    lancements.push({ url, init })
    if (reponse instanceof Error) throw reponse
    return reponse
  }
  try {
    return await dispatchWorkflows(env, time)
  } finally {
    globalThis.fetch = vraiFetch
  }
}

// Sans jeton : rien n'est lancé, rien n'est écrit.
const kvSansJeton = makeMockKv()
const sansJeton = await lancerAvec(
  { NOTIF_PROFILES: kvSansJeton },
  aHeure("10:00"),
  new Response(null, { status: 204 }),
)
if (sansJeton.length || lancements.length)
  fail("dispatchWorkflows : sans GH_DISPATCH_TOKEN, aucun appel à GitHub")
if (await kvSansJeton.get("dispatch-stats:totals"))
  fail("dispatchWorkflows : sans jeton, rien ne doit être compté")

// Hors créneau : aucun appel, aucune écriture (le KV n'est pas sollicité
// pour rien à chaque réveil).
const kvLancement = makeMockKv()
const envLancement = { NOTIF_PROFILES: kvLancement, GH_DISPATCH_TOKEN: "jeton" }
await lancerAvec(
  envLancement,
  aHeure("10:15"),
  new Response(null, { status: 204 }),
)
if (lancements.length || (await kvLancement.get("dispatch-stats:last")))
  fail("dispatchWorkflows : hors créneau, ni appel ni écriture")

// Lancement réussi : la bonne requête, comptée.
await lancerAvec(
  envLancement,
  aHeure("10:00"),
  new Response(null, { status: 204 }),
)
const lancement = lancements.at(-1)
if (
  lancement?.url !==
  "https://api.github.com/repos/isc/bemol-osr/actions/workflows/update-data.yml/dispatches"
)
  fail(`dispatchWorkflows : URL inattendue (${lancement?.url})`)
if (lancement.init.method !== "POST")
  fail("dispatchWorkflows : le lancement doit être un POST")
if (lancement.init.headers.authorization !== "Bearer jeton")
  fail("dispatchWorkflows : le jeton GH_DISPATCH_TOKEN doit être envoyé")
if (!lancement.init.headers["user-agent"])
  fail("dispatchWorkflows : l'API GitHub refuse une requête sans User-Agent")
if (JSON.parse(lancement.init.body).ref !== "main")
  fail("dispatchWorkflows : le workflow doit être lancé sur main")
let stats = await kvLancement.get("dispatch-stats:totals", "json")
if (stats?.sent !== 1)
  fail("dispatchWorkflows : un lancement réussi doit être compté")

// Refus de GitHub (jeton expiré…) : gardé avec son code et sa raison.
await lancerAvec(
  envLancement,
  aHeure("04:45"),
  new Response('{"message":"Bad credentials"}', { status: 401 }),
)
const dernierLancement = await kvLancement.get("dispatch-stats:last", "json")
const refus = dernierLancement?.outcomes?.[0]
if (
  refus?.workflow !== "update-memo.yml" ||
  refus.kind !== "failed" ||
  refus.status !== 401 ||
  !refus.reason?.includes("Bad credentials")
)
  fail(
    "dispatchWorkflows : un refus doit être gardé avec le workflow, le code et la raison",
  )
stats = await kvLancement.get("dispatch-stats:totals", "json")
if (stats.sent !== 1 || stats.failed !== 1)
  fail("dispatchWorkflows : le cumul doit additionner réussites et échecs")

// Panne réseau : un verdict, jamais d'exception (le cron des notifications
// tourne à côté).
try {
  const panne = await lancerAvec(
    envLancement,
    aHeure("12:00"),
    new TypeError("réseau"),
  )
  if (panne[0]?.kind !== "failed")
    fail("dispatchWorkflows : une panne réseau doit donner un échec compté")
} catch (err) {
  fail(
    `dispatchWorkflows : ne devrait jamais lever d'exception (${err.message})`,
  )
}

console.log("✓ lancement des crons GitHub OK")
