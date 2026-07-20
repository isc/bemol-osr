// Bémol · notifications push — filtrage anti-bruit et mise en forme.
//
// Fonctions pures (aucun accès réseau/KV), testées par worker/test-notify.mjs.
// Prennent en entrée des entrées de data/changes.json (cf. CLAUDE.md pour le
// format exact) et le profil de filtres d'un abonné (mêmes champs que
// state.prefs côté app : listes, hiddenCategories, hiddenCatListes).

// Champs dont la modification fait rater quelque chose à un musicien :
// horaire, lieu, annulation. Les autres changements (activité, programme…)
// n'y sont volontairement pas notifiés (bruit).
const NOTABLE_FIELDS = new Set(["start", "end", "location", "cancelled"])

export const DEFAULT_PREFS = {
  listes: [],
  hiddenCategories: [],
  hiddenCatListes: {},
  showCancelled: true,
}

// Un événement du planning concerne-t-il ce profil ? Mêmes règles que le
// filtre de l'abonnement ICS (cf. filterIcs), à une exception près : on
// ignore volontairement showCancelled — une annulation doit être notifiée
// même si les services annulés sont masqués de l'affichage.
export function eventMatchesPrefs(event, prefs) {
  const listes = prefs.listes || []
  const hiddenCategories = prefs.hiddenCategories || []
  const hiddenCatListes = prefs.hiddenCatListes || {}
  if (listes.length && !listes.includes(event.liste)) return false
  if (hiddenCategories.includes(event.category)) return false
  if ((hiddenCatListes[event.category] || []).includes(event.liste))
    return false
  return true
}

// Changements de planning notables d'une entrée de changes.json, pour un profil.
function planningChangesFor(entry, prefs) {
  const items = []
  for (const event of entry.added || [])
    if (eventMatchesPrefs(event, prefs))
      items.push({
        liste: event.liste,
        text: describePlanningChange("added", event),
      })
  for (const event of entry.removed || [])
    if (eventMatchesPrefs(event, prefs))
      items.push({
        liste: event.liste,
        text: describePlanningChange("removed", event),
      })
  for (const mod of entry.modified || []) {
    if (!mod.fields.some((f) => NOTABLE_FIELDS.has(f))) continue
    if (!eventMatchesPrefs(mod.after, prefs)) continue
    items.push({
      liste: mod.after.liste,
      text: describePlanningChange(
        "modified",
        mod.after,
        mod.fields,
        mod.before,
      ),
    })
  }
  return items
}

// Changements de mémo (programme) notables pour un profil : tout changement
// de programme compte (chef, œuvres, solistes…), filtré seulement par liste —
// un changement de mémo n'est pas rattaché à un type d'activité.
function memoChangesFor(entry, prefs) {
  const listes = prefs.listes || []
  return (entry.programs || [])
    .filter((p) => !listes.length || listes.includes(p.liste))
    .map((p) => ({ liste: p.liste, text: describeMemoProgram(p) }))
}

// "2026-08-13T21:15" → "13/08 21h15"
function shortDate(iso) {
  const [datePart, timePart] = iso.split("T")
  const [, m, d] = datePart.split("-")
  const [h, mi] = (timePart || "00:00").split(":")
  return `${d}/${m} ${h}h${mi}`
}

function describePlanningChange(kind, event, fields, before) {
  const when = shortDate(event.start)
  if (kind === "added")
    return `${event.liste} : nouveau service — ${event.activity} le ${when}`
  if (kind === "removed")
    return `${event.liste} : service supprimé — ${event.activity} du ${when}`
  // modified
  if (fields.includes("cancelled"))
    return event.cancelled
      ? `${event.liste} : ${event.activity} du ${shortDate(before.start)} annulé`
      : `${event.liste} : ${event.activity} du ${when} — annulation levée`
  if (fields.includes("start") || fields.includes("end"))
    return `${event.liste} : ${event.activity} du ${shortDate(before.start)} déplacé → ${when}`
  if (fields.includes("location"))
    return `${event.liste} : ${event.activity} du ${when} change de lieu → ${event.location}`
  return `${event.liste} : ${event.activity} du ${when} modifié`
}

function describeMemoProgram(p) {
  if (p.status === "added") return `${p.liste} : nouveau programme au mémo`
  if (p.status === "removed") return `${p.liste} : programme retiré du mémo`
  const bits = []
  const chef = (p.fields || []).find((f) => f.field === "chef")
  if (chef) bits.push(`chef : ${chef.after || "à définir"}`)
  if (p.worksAdded?.length) bits.push(`+ ${p.worksAdded.join(", ")}`)
  if (p.worksRemoved?.length) bits.push(`− ${p.worksRemoved.join(", ")}`)
  if (!bits.length) bits.push("détails mis à jour")
  return `${p.liste} : programme modifié — ${bits.join(" · ")}`
}

// Reprise de listeSlug() (app.js) : même transformation, dupliquée ici car le
// worker n'a pas accès au code de la page statique.
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

// Tous les changements notables d'un lot d'entrées (déjà triées du plus
// ancien au plus récent), pour un profil donné.
export function changesForProfile(entries, prefs) {
  const items = []
  for (const entry of entries) {
    if (entry.type === "memo") items.push(...memoChangesFor(entry, prefs))
    else items.push(...planningChangesFor(entry, prefs))
  }
  return items
}

// Regroupe les changements en une seule notification (jamais de rafale).
const MAX_LINES = 5

export function buildNotificationPayload(items) {
  const n = items.length
  const listes = [...new Set(items.map((i) => i.liste))]
  const listesLabel = listes.length === 1 ? listes[0] : "tes listes"
  const title =
    n === 1
      ? `Bémol — 1 changement dans ${listesLabel}`
      : `Bémol — ${n} changements dans ${listesLabel}`
  const lines = items.slice(0, MAX_LINES).map((i) => i.text)
  if (n > MAX_LINES) lines.push(`… et ${n - MAX_LINES} de plus.`)
  return {
    title,
    body: lines.join("\n"),
    url: listes.length === 1 ? `./#${listeSlug(listes[0])}` : "./",
  }
}
