#!/usr/bin/env node
// Test du filtrage anti-bruit et de la mise en forme des notifications push
// (worker/src/notify.js, fonctions pures). Usage : node worker/test-notify.mjs
// — échoue (exit 1) à la moindre incohérence.

import {
  eventMatchesPrefs,
  changesForProfile,
  buildNotificationPayload,
  DEFAULT_PREFS,
} from "./src/notify.js"

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const event = (over = {}) => ({
  uid: "u1",
  start: "2026-08-13T21:15",
  end: "2026-08-13T23:00",
  liste: "Liste 01",
  activity: "concert",
  category: "concert",
  location: "Victoria Hall",
  project: "OGP1",
  cancelled: false,
  ...over,
})

// --- eventMatchesPrefs -------------------------------------------------------

if (!eventMatchesPrefs(event(), DEFAULT_PREFS))
  fail("aucun filtre : tout événement devrait matcher")

if (
  eventMatchesPrefs(event({ liste: "Liste 02" }), {
    ...DEFAULT_PREFS,
    listes: ["Liste 01"],
  })
)
  fail("filtre listes : une autre liste ne devrait pas matcher")

if (
  !eventMatchesPrefs(event({ liste: "Liste 01" }), {
    ...DEFAULT_PREFS,
    listes: ["Liste 01"],
  })
)
  fail("filtre listes : la liste cochée devrait matcher")

if (
  eventMatchesPrefs(event({ category: "resa" }), {
    ...DEFAULT_PREFS,
    hiddenCategories: ["resa"],
  })
)
  fail("catégorie masquée : ne devrait pas matcher")

if (
  eventMatchesPrefs(event({ category: "repetition", liste: "Liste 04" }), {
    ...DEFAULT_PREFS,
    hiddenCatListes: { repetition: ["Liste 04"] },
  })
)
  fail("sous-case liste masquée dans une catégorie : ne devrait pas matcher")

// #144 : un service précis masqué dans une Liste (ex. « partielle (violons
// 1) » dans une Liste dont un musicien ne joue pas ces pupitres).
if (
  eventMatchesPrefs(
    event({ liste: "Liste 28b", activity: "partielle (violons 1)" }),
    {
      ...DEFAULT_PREFS,
      hiddenActivities: { "Liste 28b": ["partielle (violons 1)"] },
    },
  )
)
  fail("service masqué dans une liste : ne devrait pas matcher")

if (
  !eventMatchesPrefs(
    event({ liste: "Liste 28b", activity: "répétition tutti" }),
    {
      ...DEFAULT_PREFS,
      hiddenActivities: { "Liste 28b": ["partielle (violons 1)"] },
    },
  )
)
  fail(
    "service masqué dans une liste : les autres services de la liste devraient matcher",
  )

// Dièse laisse passer des variantes de casse pour un même service (observé
// sur une vraie Liste : « (sans OSR) » / « (Sans OSR) ») : la comparaison
// doit les traiter comme un seul et même service masqué.
if (
  eventMatchesPrefs(
    event({ liste: "Liste 10", activity: "partielle par pupitre (Sans OSR)" }),
    {
      ...DEFAULT_PREFS,
      hiddenActivities: { "Liste 10": ["partielle par pupitre (sans OSR)"] },
    },
  )
)
  fail(
    "service masqué dans une liste : une variante de casse devrait aussi matcher",
  )

// #146 : réplique côté worker le réglage « Afficher les services sans
// orchestre » de l'app — sans lui, ces services continuaient d'être notifiés
// (et de fuiter dans l'ICS abonné) même quand l'app les masque.
if (
  eventMatchesPrefs(event({ activity: "répétition (sans orchestre)" }), {
    ...DEFAULT_PREFS,
    showNoOrchestra: false,
  })
)
  fail(
    "showNoOrchestra désactivé : un service « sans orchestre » ne devrait pas matcher",
  )

if (
  eventMatchesPrefs(event({ activity: "générale piano" }), {
    ...DEFAULT_PREFS,
    showNoOrchestra: false,
  })
)
  fail("showNoOrchestra désactivé : une générale piano ne devrait pas matcher")

if (
  !eventMatchesPrefs(
    event({ activity: "répétition (sans orchestre)" }),
    DEFAULT_PREFS,
  )
)
  fail(
    "showNoOrchestra par défaut (affiché) : un service « sans orchestre » devrait matcher",
  )

// --- anti-bruit : planning ---------------------------------------------------

const planningEntry = (over = {}) => ({
  added: [],
  removed: [],
  modified: [],
  ...over,
})

// Ajout / suppression : toujours notable.
{
  const items = changesForProfile(
    [planningEntry({ added: [event()], removed: [event({ uid: "u2" })] })],
    DEFAULT_PREFS,
  )
  if (items.length !== 2) fail(`ajout+suppression : ${items.length} ≠ 2 items`)
}

// Modification d'horaire : notable.
{
  const before = event({ start: "2026-08-13T20:00" })
  const after = event()
  const items = changesForProfile(
    [
      planningEntry({
        modified: [{ uid: "u1", fields: ["start"], before, after }],
      }),
    ],
    DEFAULT_PREFS,
  )
  if (items.length !== 1) fail("modification d'horaire : devrait être notable")
}

// Modification de simple activité (texte) : pas notable, silence.
{
  const before = event({ activity: "répétition" })
  const after = event({ activity: "répétition (+balance)" })
  const items = changesForProfile(
    [
      planningEntry({
        modified: [{ uid: "u1", fields: ["activity"], before, after }],
      }),
    ],
    DEFAULT_PREFS,
  )
  if (items.length !== 0)
    fail("modification d'activité seule : ne devrait pas notifier")
}

// Modification hors du profil (catégorie masquée) : filtrée.
{
  const before = event({ category: "resa", start: "2026-08-13T20:00" })
  const after = event({ category: "resa" })
  const items = changesForProfile(
    [
      planningEntry({
        modified: [{ uid: "u1", fields: ["start"], before, after }],
      }),
    ],
    { ...DEFAULT_PREFS, hiddenCategories: ["resa"] },
  )
  if (items.length !== 0)
    fail("catégorie masquée : la modification ne devrait pas notifier")
}

// --- anti-bruit : mémo --------------------------------------------------------

{
  const memoEntry = {
    type: "memo",
    programs: [
      {
        liste: "Liste 01",
        status: "modified",
        fields: [{ field: "chef", before: "", after: "X" }],
        worksAdded: [],
        worksRemoved: [],
      },
      { liste: "Liste 02", status: "added" },
    ],
  }
  const all = changesForProfile([memoEntry], DEFAULT_PREFS)
  if (all.length !== 2) fail(`mémo sans filtre : ${all.length} ≠ 2 items`)

  const filtered = changesForProfile([memoEntry], {
    ...DEFAULT_PREFS,
    listes: ["Liste 01"],
  })
  if (filtered.length !== 1)
    fail(`mémo filtré par liste : ${filtered.length} ≠ 1 item`)

  // Une catégorie masquée ne doit pas filtrer un changement de mémo (pas lié
  // à une catégorie de service).
  const withHiddenCat = changesForProfile([memoEntry], {
    ...DEFAULT_PREFS,
    hiddenCategories: ["concert"],
  })
  if (withHiddenCat.length !== 2)
    fail(
      "mémo : une catégorie masquée ne devrait pas filtrer les changements de programme",
    )
}

// --- buildNotificationPayload -------------------------------------------------

{
  const p = buildNotificationPayload([{ liste: "Liste 01", text: "a" }])
  if (!p.title.includes("1 changement")) fail("titre au singulier incorrect")
  if (!p.url.includes("#liste-01")) fail(`lien profond incorrect : ${p.url}`)
}

{
  const p = buildNotificationPayload([
    { liste: "Liste 01", text: "a" },
    { liste: "Liste 02", text: "b" },
  ])
  if (!p.title.includes("2 changements")) fail("titre au pluriel incorrect")
  if (p.url !== "./")
    fail("plusieurs listes : le lien devrait pointer vers la racine")
}

{
  const items = Array.from({ length: 8 }, (_, i) => ({
    liste: "Liste 01",
    text: `item ${i}`,
  }))
  const p = buildNotificationPayload(items)
  if (!p.body.includes("de plus"))
    fail("troncature manquante au-delà de MAX_LINES")
}

console.log("✓ notify.js OK — filtrage anti-bruit et mise en forme conformes")
