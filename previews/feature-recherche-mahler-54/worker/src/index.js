// Bémol · abonnement personnalisé — Cloudflare Worker
//
// Les apps d'agenda (iPhone, Google…) vont chercher l'ICS elles-mêmes, côté
// serveur : GitHub Pages (statique) ne peut donc pas filtrer « mes séries » à
// la demande. Ce worker minuscule comble ce manque : il relit le calendrier
// complet publié par Bémol (data/planning.ics) et retire au passage les
// événements que l'abonné ne veut pas voir. Il ne stocke rien, ne calcule
// rien d'autre — les données restent produites par le dépôt Bémol.
//
// URL d'abonnement :  https://<worker>/planning.ics?listes=Liste 04,Liste 07
// Paramètres (tous facultatifs ; sans paramètre → calendrier complet) :
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

const UPSTREAM = "https://isc.github.io/bemol-osr/data/planning.ics"

// Durée de cache de l'ICS complet côté Cloudflare : le planning est régénéré
// toutes les 2 h, et les agendas ne rafraîchissent que quelques fois par jour.
const CACHE_SECONDS = 600

// Valeur d'une propriété X- dans un bloc VEVENT (non pliée, cf. en-tête).
function prop(block, name) {
  const m = block.match(new RegExp(`^${name}:(.*)$`, "m"))
  return m ? m[1].replace(/\r$/, "") : ""
}

// Filtre le texte ICS complet selon les critères. Exporté pour les tests.
export function filterIcs(text, { listes = [], sans = [], annules = true }) {
  if (!listes.length && !sans.length && annules) return text

  const events = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n/g) || []
  const header = text.slice(0, text.indexOf("BEGIN:VEVENT"))
  const kept = events.filter((block) => {
    if (listes.length && !listes.includes(prop(block, "X-BEMOL-LISTE")))
      return false
    if (sans.includes(prop(block, "X-BEMOL-CAT"))) return false
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

export default {
  async fetch(request) {
    const url = new URL(request.url)

    const upstream = await fetch(UPSTREAM, {
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    })
    if (!upstream.ok)
      return new Response("Calendrier source indisponible.", { status: 502 })

    const filtered = filterIcs(await upstream.text(), {
      listes: list(url.searchParams.get("listes")),
      sans: list(url.searchParams.get("sans")),
      annules: url.searchParams.get("annules") !== "0",
    })

    return new Response(filtered, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="bemol-osr.ics"',
        "cache-control": `public, max-age=${CACHE_SECONDS}`,
        "access-control-allow-origin": "*",
      },
    })
  },
}
