// Bémol · Planning OSR — logique de l'application (sans dépendance, sans build)

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

// Abréviations de lieux, du plus spécifique au plus générique
const LOCATION_SHORT = [
  ["Victoria Hall", "VH"],
  ["UM - Salle Marie LAGGÉ", "UM-ML"],
  ["UM - Studio", "UM-St."],
  ["Grand Théâtre - fosse", "GTG fosse"],
  ["Grand Théâtre de Genève", "GTG"],
  ["Grand Théâtre", "GTG"],
  ["Bâtiment des Forces Motrices", "BFM"],
  ["Théâtre de Beaulieu, Lausanne", "Beaulieu"],
  ["Arena de Genève", "Arena"],
  ["Genève-Plage", "Gve-Plage"],
  ["Salle Franz Liszt", "S. Liszt"],
  ["Auditorium Florimont", "Florimont"],
  ["Ecole Internationale de Genève", "Ecolint"],
  ["Institut Jaques-Dalcroze", "IJD"],
  ["Théâtre de la Cité Bleue", "Cité Bleue"],
  ["Kultur und Kongresszentrum Luzern", "KKL Luzern"],
  ["Rosey Concert Hall", "Rosey"],
  ["La Grange au Lac, Evian", "Evian"],
  ["Salle de Musique, La-Chaux-de-Fonds", "Chx-de-Fds"],
  ["Casino Bern", "Casino Bern"],
  ["Stadtcasino Basel", "Basel"],
  ["Tonhalle, Zürich", "Tonhalle"],
  ["à définir", "à définir"],
  ["lieu à définir", "à définir"],
]

const FIELD_LABELS = {
  start: "début",
  end: "fin",
  liste: "liste",
  activity: "activité",
  location: "lieu",
  project: "programme",
  cancelled: "statut",
}

const DAY_NAMES = ["Di", "Lu", "Ma", "Me", "Je", "Ve", "Sa"]
const MONTH_NAMES = [
  "janv.",
  "févr.",
  "mars",
  "avr.",
  "mai",
  "juin",
  "juil.",
  "août",
  "sept.",
  "oct.",
  "nov.",
  "déc.",
]
const RECENT_DAYS = 14

const state = {
  events: [],
  changes: [],
  productions: {}, // Liste → { chef, solistes, effectif, duree, works:[{ oeuvre, instrumentation, remarques, percussions, claviers, extra, detail, note, duree }] } (mémo de production, généré par scripts/update-memo.mjs)
  updatedAt: null,
  season: null,
  view: null,
  recentUids: new Map(), // uid → date du dernier changement récent
  recentListes: new Map(), // liste (programme) → date du dernier changement récent du mémo
  prefs: loadPrefs(),
}

function loadPrefs() {
  const defaults = {
    hiddenCategories: ["resa"],
    showCancelled: true,
    // Repères vacances scolaires + jours fériés dans la Grille (GE et France)
    showHolidays: true,
    listes: [], // listes sélectionnées ; vide = toutes les listes
    // Filtre fin « type d'activité → liste » : pour un type NON masqué
    // globalement (absent de hiddenCategories), listes masquées à l'intérieur
    // de ce seul type. { [catégorie]: ["Liste 04", …] }
    hiddenCatListes: {},
  }
  try {
    const stored = JSON.parse(localStorage.getItem("bemol-prefs") || "{}")
    // Migration : l'ancien filtre « liste » (une seule) devient « listes » (plusieurs)
    if (typeof stored.liste === "string" && !("listes" in stored))
      stored.listes = stored.liste ? [stored.liste] : []
    delete stored.liste
    return { ...defaults, ...stored }
  } catch {
    return defaults
  }
}

function savePrefs() {
  localStorage.setItem("bemol-prefs", JSON.stringify(state.prefs))
}

// --- Utilitaires dates -----------------------------------------------------

// Les dates du JSON sont des chaînes locales "2026-08-13T21:15"
const parseDate = (s) => new Date(s)

function localKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function firstMondayOfAugust(year) {
  const d = new Date(year, 7, 1)
  d.setDate(1 + ((8 - d.getDay()) % 7))
  return d
}

// saison d'une date : année N si date ∈ [1er lundi d'août N, 1er lundi d'août N+1)
function seasonYear(date) {
  const y = date.getFullYear()
  return date >= firstMondayOfAugust(y) ? y : y - 1
}

const seasonLabel = (y) => `Saison ${y}-${String(y + 1).slice(2)}`

function addDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function fmtDay(d, withYear = false) {
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}`
}

function fmtTime(s) {
  return s && s.includes("T") ? s.slice(11) : ""
}

function fmtDateStr(s, withTime = true) {
  const d = parseDate(s)
  const base = fmtDay(d, true)
  return withTime && s.includes("T") ? `${base} ${fmtTime(s)}` : base
}

function shortLocation(loc) {
  if (!loc) return ""
  for (const [full, short] of LOCATION_SHORT)
    if (loc.includes(full)) return short
  return loc.length > 18 ? loc.slice(0, 16) + "…" : loc
}

function shortListe(liste) {
  const m = liste.match(/^Liste (.+)$/)
  if (!m) return liste.length > 10 ? liste.slice(0, 9) + "…" : liste
  return /^\d/.test(m[1]) ? "L" + m[1] : m[1]
}

// --- Vacances scolaires & jours fériés (repères de la vue Grille) ------------
// À la demande des musiciens : montrer dans la Grille quand les écoles sont en
// vacances (utile pour caler ses propres congés) et les jours fériés (qui
// décalent souvent les services), pour le canton de Genève ET la France
// voisine (zone A : académies de Lyon, Grenoble, Clermont-Ferrand).
//
// • Les JOURS FÉRIÉS sont CALCULÉS (fêtes fixes + fêtes mobiles dérivées de
//   Pâques) : fiables pour n'importe quelle saison, rien à maintenir.
// • Les VACANCES SCOLAIRES n'obéissent à aucune règle simple : leurs dates
//   sont SAISIES À LA MAIN ci-dessous, à revérifier/compléter chaque saison
//   (sources : DIP Genève / ge.ch et education.gouv.fr pour la zone A).
//
// Une région vaut "GE" (Genève) ou "FR" (France voisine, zone A).
const REGION_LABEL = { GE: "Genève", FR: "France voisine (zone A)" }

// Vacances scolaires, en jours calendaires INCLUS (week-ends compris) : `start`
// = premier jour sans école, `end` = dernier jour sans école (veille de la
// reprise). Format "AAAA-MM-JJ". À vérifier à chaque nouvelle saison.
const VACANCES_SCOLAIRES = [
  // Genève — saison 2026-2027 (source : DIP / ge.ch)
  { region: "GE", nom: "Automne", start: "2026-10-17", end: "2026-10-25" },
  { region: "GE", nom: "Fin d'année", start: "2026-12-24", end: "2027-01-10" },
  { region: "GE", nom: "Février", start: "2027-02-13", end: "2027-02-21" },
  { region: "GE", nom: "Pâques", start: "2027-03-27", end: "2027-04-11" },
  // France voisine, zone A — saison 2026-2027 (source : education.gouv.fr)
  { region: "FR", nom: "Toussaint", start: "2026-10-17", end: "2026-11-01" },
  { region: "FR", nom: "Noël", start: "2026-12-19", end: "2027-01-03" },
  { region: "FR", nom: "Hiver", start: "2027-02-06", end: "2027-02-21" },
  { region: "FR", nom: "Printemps", start: "2027-04-03", end: "2027-04-18" },
]

// Rentrée scolaire = premier jour d'école après les vacances d'été. Un seul
// jour par région, SAISI À LA MAIN comme les vacances (aucune règle simple), à
// revérifier/compléter chaque saison (sources : DIP Genève / ge.ch et
// education.gouv.fr pour la zone A). Format "AAAA-MM-JJ".
const RENTREES = [
  { region: "GE", date: "2026-08-17" }, // Genève — lundi 17 août 2026
  { region: "FR", date: "2026-09-01" }, // France zone A — mardi 1er septembre 2026
]

// Week-ends de repos officiels de l'orchestre, repris du « tableau de service »
// de la saison (en principe un par période). Ils NE se déduisent PAS du
// planning : un week-end de repos peut comporter des services SANS les musiciens
// de l'orchestre (raccords, répétitions techniques…), et à l'inverse un simple
// trou dans le planning n'est pas un week-end de repos officiel. Saisie à la
// main, à revérifier/compléter à chaque saison (source : tableau de service).
// On repère chaque week-end par la date de son SAMEDI, au format "AAAA-MM-JJ".
const WEEKENDS_REPOS = [
  // Saison 2026-2027 (source : tableau de service, mention « repos »)
  "2026-08-22", // Période 1
  "2026-09-12", // Période 2
  "2026-10-03", // Période 3
  "2026-11-14", // Période 4
  "2026-11-28", // Période 5
  "2027-01-02", // Période 6
  "2027-01-23", // Période 7
  "2027-02-20", // Période 8
  "2027-03-27", // Période 9
  "2027-04-24", // Période 10
  "2027-05-15", // Période 11
  "2027-06-26", // Période 12
  // Période 13 : aucun week-end « repos » dans le tableau de service.
]

// Dimanche de Pâques (algorithme de Meeus/Butcher, calendrier grégorien).
function easterSunday(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31) // 3 = mars, 4 = avril
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

// Jeûne genevois : jeudi qui suit le 1er dimanche de septembre.
function jeuneGenevois(year) {
  const d = new Date(year, 8, 1)
  d.setDate(1 + ((7 - d.getDay()) % 7)) // 1er dimanche de septembre
  return addDays(d, 4) // jeudi suivant
}

// Construit une Map localKey → [{ region, nom }] des jours fériés pour les
// années demandées (une saison en couvre deux : août→déc puis janv→juil).
function buildFeries(years) {
  const map = new Map()
  const add = (date, region, nom) => {
    const key = localKey(date)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push({ region, nom })
  }
  for (const y of years) {
    const easter = easterSunday(y)
    const vendrediSaint = addDays(easter, -2)
    const lundiPaques = addDays(easter, 1)
    const ascension = addDays(easter, 39)
    const lundiPentecote = addDays(easter, 50)
    // Genève (fériés officiels du canton)
    add(new Date(y, 0, 1), "GE", "Nouvel An")
    add(vendrediSaint, "GE", "Vendredi Saint")
    add(lundiPaques, "GE", "Lundi de Pâques")
    add(ascension, "GE", "Ascension")
    add(lundiPentecote, "GE", "Lundi de Pentecôte")
    add(new Date(y, 7, 1), "GE", "Fête nationale suisse")
    add(jeuneGenevois(y), "GE", "Jeûne genevois")
    add(new Date(y, 11, 25), "GE", "Noël")
    add(new Date(y, 11, 31), "GE", "Restauration de la République")
    // France (jours fériés nationaux)
    add(new Date(y, 0, 1), "FR", "Jour de l'An")
    add(lundiPaques, "FR", "Lundi de Pâques")
    add(new Date(y, 4, 1), "FR", "Fête du Travail")
    add(new Date(y, 4, 8), "FR", "Victoire 1945")
    add(ascension, "FR", "Ascension")
    add(lundiPentecote, "FR", "Lundi de Pentecôte")
    add(new Date(y, 6, 14), "FR", "Fête nationale")
    add(new Date(y, 7, 15), "FR", "Assomption")
    add(new Date(y, 10, 1), "FR", "Toussaint")
    add(new Date(y, 10, 11), "FR", "Armistice 1918")
    add(new Date(y, 11, 25), "FR", "Noël")
  }
  return map
}

// Nom de la période de vacances d'une région pour un jour donné, sinon null.
// (comparaison lexicographique sur "AAAA-MM-JJ", qui suit l'ordre des dates)
function vacanceNom(region, key) {
  for (const v of VACANCES_SCOLAIRES)
    if (v.region === region && key >= v.start && key <= v.end) return v.nom
  return null
}

// --- Chargement ------------------------------------------------------------

async function loadData() {
  const bust = `?t=${Date.now()}`
  const [planning, changes, productions] = await Promise.all([
    fetch(`data/planning.json${bust}`).then((r) => r.json()),
    fetch(`data/changes.json${bust}`)
      .then((r) => r.json())
      .catch(() => ({ entries: [] })),
    // Mémo de production (œuvres + effectif), généré depuis le mini-site Dièse.
    fetch(`productions.json${bust}`)
      .then((r) => r.json())
      .catch(() => ({})),
  ])
  state.events = planning.events
  state.updatedAt = planning.updatedAt
  state.changes = changes.entries || []
  state.productions = productions || {}

  const cutoff = Date.now() - RECENT_DAYS * 86400e3
  for (const entry of state.changes) {
    if (new Date(entry.at).getTime() < cutoff) continue
    // Relevé du mémo de production : ce sont des programmes (listes) qui bougent.
    if (entry.type === "memo") {
      for (const prog of entry.programs)
        if (!state.recentListes.has(prog.liste))
          state.recentListes.set(prog.liste, entry.at)
      continue
    }
    for (const e of [...entry.added, ...entry.modified.map((m) => m.after)])
      if (!state.recentUids.has(e.uid)) state.recentUids.set(e.uid, entry.at)
  }
}

// --- Fraîcheur des données ---------------------------------------------------

// Le planning est actualisé par un robot toutes les 2 h (update-data.yml).
// Si ce robot est en panne (jeton ICS expiré, changement côté Dièse…), le site
// continue de servir des données de plus en plus vieilles sans que rien ne le
// signale. On date donc le dernier passage RÉUSSI du robot via l'API publique
// de GitHub et on affiche un bandeau au-delà de STALE_HOURS (marge large :
// un incident GitHub de quelques heures ne doit pas crier au loup). En cas
// d'échec de l'appel (hors-ligne, quota API…), on ne montre rien : ce bandeau
// est un filet de sécurité, pas une dépendance.
const STALE_HOURS = 26

async function checkDataFreshness() {
  if (["localhost", "127.0.0.1"].includes(location.hostname)) return
  try {
    const r = await fetch(
      "https://api.github.com/repos/isc/bemol-osr/actions/workflows/update-data.yml/runs?status=success&per_page=1",
    )
    if (!r.ok) return
    const runs = (await r.json()).workflow_runs
    if (!runs?.length) return
    const hours = (Date.now() - new Date(runs[0].updated_at)) / 36e5
    if (!(hours > STALE_HOURS)) return
    const age =
      hours < 48
        ? `${Math.round(hours)} heures`
        : `${Math.round(hours / 24)} jours`
    document
      .querySelector("header")
      .after(
        el(
          "div",
          { class: "stale-banner" },
          `⚠️ Les données n'ont pas pu être actualisées depuis ${age} : ` +
            `le planning affiché n'est peut-être plus à jour.`,
        ),
      )
  } catch {
    // silencieux : simple filet de sécurité
  }
}

// --- Filtres ---------------------------------------------------------------

function visibleEvents() {
  const p = state.prefs
  return state.events.filter(
    (e) =>
      !p.hiddenCategories.includes(e.category) &&
      !(p.hiddenCatListes[e.category] || []).includes(e.liste) &&
      (p.showCancelled || !e.cancelled) &&
      (!p.listes.length || p.listes.includes(e.liste)) &&
      seasonYear(parseDate(e.start)) === state.season,
  )
}

function seasonsInData() {
  const set = new Set(state.events.map((e) => seasonYear(parseDate(e.start))))
  return [...set].sort()
}

function listesInSeason() {
  const set = new Set(
    state.events
      .filter((e) => seasonYear(parseDate(e.start)) === state.season)
      .map((e) => e.liste),
  )
  return [...set].sort((a, b) => a.localeCompare(b, "fr", { numeric: true }))
}

// Pour chaque catégorie, les listes qui ont au moins un service de ce type dans
// la saison courante (triées). Sert aux sous-cases « par liste » du filtre par
// type d'activité.
function listesByCategory() {
  const map = new Map()
  for (const e of state.events) {
    if (seasonYear(parseDate(e.start)) !== state.season) continue
    if (!map.has(e.category)) map.set(e.category, new Set())
    map.get(e.category).add(e.liste)
  }
  const out = {}
  for (const [cat, set] of map)
    out[cat] = [...set].sort((a, b) =>
      a.localeCompare(b, "fr", { numeric: true }),
    )
  return out
}

// --- Rendu : éléments communs ----------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v)
    else if (v !== null && v !== undefined) node.setAttribute(k, v)
  }
  node.append(...children.filter((c) => c !== null && c !== undefined))
  return node
}

function eventChip(e, { showDate = false } = {}) {
  const classes = ["evt", `cat-${e.category}`]
  if (e.cancelled) classes.push("cancelled")
  if (state.recentUids.has(e.uid)) classes.push("recent")
  const chip = el(
    "button",
    {
      class: classes.join(" "),
      title: `${e.liste} — ${e.activity}`,
      onclick: () => showDetail(e),
    },
    el("b", {}, `${shortListe(e.liste)} ${fmtTime(e.start)}`),
    " ",
    el("span", { class: "evt-loc" }, shortLocation(e.location)),
    el("br"),
    showDate ? `${fmtDay(parseDate(e.start))} · ` : "",
    e.activity + (e.project ? ` · ${e.project}` : ""),
  )
  return chip
}

function showDetail(e) {
  const dlg = document.getElementById("detail-dialog")
  const box = document.getElementById("detail-content")
  box.replaceChildren(
    el(
      "span",
      { class: `detail-cat evt cat-${e.category}` },
      CATEGORIES[e.category],
    ),
    el(
      "h2",
      {},
      el(
        "button",
        {
          class: "liste-link",
          title: "Voir toute la production de cette liste",
          onclick: () => showListe(e.liste),
        },
        e.liste,
      ),
      ` — ${e.activity}${e.cancelled ? " (ANNULÉ)" : ""}`,
      // Point rouge si le mémo de ce programme a changé récemment (cf. les
      // événements de planning récemment modifiés).
      state.recentListes.has(e.liste)
        ? el(
            "span",
            {
              class: "recent-dot",
              title: "Mémo de production modifié récemment",
            },
            "●",
          )
        : null,
    ),
    el(
      "dl",
      {},
      el("dt", {}, "Date"),
      el("dd", {}, fmtDay(parseDate(e.start), true)),
      el("dt", {}, "Horaire"),
      el("dd", {}, `${fmtTime(e.start)}${e.end ? " – " + fmtTime(e.end) : ""}`),
      el("dt", {}, "Lieu"),
      el("dd", {}, e.location || "—"),
      el("dt", {}, "Programme"),
      el("dd", {}, e.project || "—"),
      state.recentUids.has(e.uid) ? el("dt", {}, "Modifié") : null,
      state.recentUids.has(e.uid)
        ? el(
            "dd",
            {},
            `récemment (${fmtDateStr(state.recentUids.get(e.uid).slice(0, 16), false)})`,
          )
        : null,
      state.recentListes.has(e.liste) ? el("dt", {}, "Mémo") : null,
      state.recentListes.has(e.liste)
        ? el(
            "dd",
            {},
            `modifié récemment (${fmtDateStr(state.recentListes.get(e.liste).slice(0, 16), false)})`,
          )
        : null,
    ),
    ...productionDetail(e.liste),
  )
  dlg.showModal()
}

// Détail d'instrumentation d'une œuvre, repris tel quel du mémo de production
// (abréviations conservées). Les libellés reprennent ceux du mémo, familiers
// aux musiciens.
const WORK_FIELDS = [
  ["instrumentation", "Instrumentation"],
  ["remarques", "Remarques"],
  ["percussions", "Percussions"],
  ["claviers", "Claviers"],
  ["extra", "Extra"],
  ["detail", "Détail"],
  ["note", "Note"],
]

// Libellés lisibles des champs d'œuvre, réutilisés par la vue Modifs (diff du
// mémo de production).
const WORK_FIELD_LABELS = { ...Object.fromEntries(WORK_FIELDS), duree: "durée" }

// Construit le <li> d'une œuvre : le titre (« Compositeur — Titre ») et, si le
// mémo le précise, un bloc de détail (instrumentation, remarques, etc.). Une
// œuvre est soit une chaîne, soit un objet { oeuvre, instrumentation, … }.
function workNode(w) {
  const title = typeof w === "string" ? w : w.oeuvre
  const head = [el("span", { class: "work-title" }, title)]
  if (typeof w === "object" && w.duree) {
    head.push(" ", el("span", { class: "work-dur" }, w.duree))
  }
  const rows =
    typeof w === "object"
      ? WORK_FIELDS.filter(([k]) => w[k]).map(([k, label]) =>
          el(
            "div",
            { class: "wd-row" },
            el("span", { class: "wd-label" }, label),
            el("span", { class: "wd-val" }, w[k]),
          ),
        )
      : []
  return el(
    "li",
    {},
    el("div", { class: "work-head" }, ...head),
    rows.length ? el("div", { class: "work-detail" }, ...rows) : null,
  )
}

// Infos du mémo de production (chef, solistes, œuvres avec leur détail
// d'instrumentation, effectif, durée) pour une Liste donnée. Renvoie []
// si aucune info n'est saisie pour cette Liste dans productions.json.
function productionDetail(liste) {
  const prod = state.productions[liste]
  if (!prod) return []
  const solistes = (prod.solistes || []).filter(Boolean)
  const works = (prod.works || []).filter(Boolean)
  const nodes = []
  if (prod.chef) {
    nodes.push(
      el("h3", { class: "detail-section" }, "Direction musicale"),
      el("p", { class: "chef" }, prod.chef),
    )
  }
  if (solistes.length) {
    nodes.push(
      el(
        "h3",
        { class: "detail-section" },
        solistes.length > 1 ? "Solistes" : "Soliste",
      ),
      el("ul", { class: "solistes" }, ...solistes.map((s) => el("li", {}, s))),
    )
  }
  if (works.length) {
    nodes.push(
      el("h3", { class: "detail-section" }, "Œuvres au programme"),
      el("ul", { class: "works" }, ...works.map(workNode)),
    )
  }
  if (prod.effectif) {
    nodes.push(
      el("h3", { class: "detail-section" }, "Effectif orchestral (max)"),
      el("p", { class: "effectif" }, prod.effectif),
    )
  }
  if (prod.duree) {
    nodes.push(
      el("h3", { class: "detail-section" }, "Durée totale approximative"),
      el("p", { class: "duree" }, prod.duree),
    )
  }
  return nodes
}

// --- Vue par Liste (programme complet d'une production) --------------------

// Champ + bouton « copier » pour une URL donnée (abonnement au calendrier,
// lien partageable d'une Liste…).
function copyLinkRow(url) {
  const field = el("input", {
    class: "subscribe-url",
    type: "text",
    readonly: "",
    value: url,
    onfocus: (ev) => ev.target.select(),
  })
  const btn = el(
    "button",
    {
      type: "button",
      class: "copy-btn",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url)
          btn.textContent = "Lien copié ✓"
        } catch {
          // Presse-papier indisponible (http, navigateur ancien) : on
          // sélectionne le champ pour un copier-coller manuel.
          field.focus()
          field.select()
          btn.textContent = "Sélectionné — copie-le"
        }
        setTimeout(() => (btn.textContent = "Copier le lien"), 2500)
      },
    },
    "Copier le lien",
  )
  return el("div", { class: "subscribe-url-row" }, field, btn)
}

// Identifiant d'URL d'une Liste (fragment de hash), ex. "Liste 04" → "liste-04",
// "Liste 24b" → "liste-24b", "Atelier Découverte 1" → "liste-atelier-decouverte-1".
// Toujours ASCII (accents retirés) pour rester lisible/copiable tel quel
// (ex. dans un groupe WhatsApp de pupitre).
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

// Retrouve la Liste correspondant à un fragment de hash ("liste-04"), parmi
// les Listes présentes dans les données chargées (une seule saison à la fois,
// donc pas d'ambiguïté entre saisons).
function listeFromSlug(slug) {
  const listes = new Set(state.events.map((e) => e.liste))
  for (const liste of listes) if (listeSlug(liste) === slug) return liste
  return null
}

// URL absolue et partageable d'une Liste (chemin relatif à la page courante,
// fonctionne donc aussi bien en production que dans une preview de PR).
function listeUrl(liste) {
  return new URL(`#${listeSlug(liste)}`, location.href).href
}

// Construit le contenu du dialogue « Liste » : mémo de production complet
// (chef, solistes, œuvres, effectif, durée — réutilise productionDetail) et
// tous les services de cette Liste, triés chronologiquement (réutilise
// eventChip). Les services annulés et toutes les catégories sont inclus,
// indépendamment des filtres de la vue courante : c'est le programme complet
// de la production qu'on veut voir ici.
function renderListeDialog(liste) {
  const box = document.getElementById("liste-content")
  const events = state.events
    .filter((e) => e.liste === liste)
    .sort((a, b) => a.start.localeCompare(b.start))

  box.replaceChildren(
    el(
      "h2",
      {},
      liste,
      state.recentListes.has(liste)
        ? el(
            "span",
            {
              class: "recent-dot",
              title: "Mémo de production modifié récemment",
            },
            "●",
          )
        : null,
    ),
    ...productionDetail(liste),
    el("h3", { class: "detail-section" }, `Services (${events.length})`),
    events.length
      ? el(
          "div",
          { class: "liste-events" },
          ...events.map((e) => eventChip(e, { showDate: true })),
        )
      : el(
          "p",
          { class: "empty-msg" },
          "Aucun service trouvé pour cette liste.",
        ),
    el("h3", { class: "detail-section" }, "Lien partageable"),
    copyLinkRow(listeUrl(liste)),
  )
}

// Ouvre le dialogue « Liste » pour la Liste donnée, et met à jour l'URL
// (fragment #liste-04) pour permettre de la partager (ex. dans un groupe
// WhatsApp de pupitre).
function showListe(liste) {
  const detailDlg = document.getElementById("detail-dialog")
  if (detailDlg.open) detailDlg.close()
  renderListeDialog(liste)
  const slug = listeSlug(liste)
  if (location.hash.slice(1) !== slug) history.pushState(null, "", `#${slug}`)
  document.getElementById("liste-dialog").showModal()
}

// Synchronise le dialogue « Liste » avec le hash de l'URL courante : l'ouvre
// si le hash pointe vers une Liste connue (lien partagé, rechargement de
// page…), le referme si on navigue ailleurs (bouton précédent du navigateur).
function syncListeFromHash() {
  const slug = location.hash.slice(1)
  const liste = slug.startsWith("liste-") ? listeFromSlug(slug) : null
  if (liste) showListe(liste)
  else {
    const dlg = document.getElementById("liste-dialog")
    if (dlg.open) dlg.close()
  }
}

// --- Repères vacances / fériés dans la Grille --------------------------------

// Petites pastilles "GE"/"FR" (une par région fériée ce jour) posées dans
// l'en-tête de colonne du jour, cliquables pour afficher le détail.
function feriesTags(date, feries) {
  return el(
    "div",
    { class: "ferie-tags" },
    ...feries.map((f) =>
      el(
        "button",
        {
          class: `ferie-tag ferie-${f.region.toLowerCase()}`,
          title: `Jour férié · ${REGION_LABEL[f.region]} : ${f.nom}`,
          onclick: () => showFeries(date, feries),
        },
        f.region,
      ),
    ),
  )
}

// Ligne de bandeaux "vacances" d'une région pour une semaine (7 jours). Les
// jours contigus d'une même période sont fusionnés (colspan) et portent le nom
// de la période ; la rentrée scolaire y figure comme un bandeau « Rentrée » d'un
// seul jour. Renvoie null si la semaine ne contient ni vacances ni rentrée.
function vacancesRow(region, days) {
  const noms = days.map((d) => vacanceNom(region, localKey(d)))
  const isRentree = days.map((d) =>
    RENTREES.some((r) => r.region === region && r.date === localKey(d)),
  )
  if (noms.every((n) => !n) && isRentree.every((r) => !r)) return null
  const row = el(
    "tr",
    { class: "vac-row" },
    el("td", { class: "vac-label" }, region),
  )
  let i = 0
  while (i < days.length) {
    // La rentrée est un jour isolé : bandeau « Rentrée » d'une seule colonne.
    if (isRentree[i]) {
      row.append(
        el(
          "td",
          { class: `vac vac-${region.toLowerCase()}` },
          el(
            "button",
            {
              class: "vac-band rentree-band",
              title: `Rentrée scolaire · ${REGION_LABEL[region]}`,
              onclick: () => showRentree(region, days[i]),
            },
            `Rentrée ${region}`,
          ),
        ),
      )
      i++
      continue
    }
    let j = i + 1
    while (j < days.length && !isRentree[j] && noms[j] === noms[i]) j++
    const span = j - i
    if (noms[i]) {
      row.append(
        el(
          "td",
          { class: `vac vac-${region.toLowerCase()}`, colspan: span },
          el(
            "button",
            {
              class: "vac-band",
              title: `Vacances scolaires · ${REGION_LABEL[region]} : ${noms[i]}`,
              onclick: () => showVacance(region, noms[i]),
            },
            noms[i],
          ),
        ),
      )
    } else {
      row.append(el("td", { class: "vac-empty", colspan: span }))
    }
    i = j
  }
  return row
}

// Réutilise le dialogue de détail pour présenter un férié / des vacances.
function showHolidayDialog(tag, ...content) {
  const dlg = document.getElementById("detail-dialog")
  const box = document.getElementById("detail-content")
  box.replaceChildren(
    el("span", { class: "detail-cat evt cat-autre" }, tag),
    ...content.filter((c) => c !== null && c !== undefined),
  )
  dlg.showModal()
}

function showFeries(date, feries) {
  showHolidayDialog(
    feries.length > 1 ? "Jours fériés" : "Jour férié",
    el("h2", {}, fmtDay(date, true)),
    el(
      "ul",
      { class: "holiday-list" },
      ...feries.map((f) =>
        el("li", {}, `${REGION_LABEL[f.region]} — ${f.nom}`),
      ),
    ),
  )
}

// Pastille « Repos » posée dans l'en-tête du samedi et du dimanche d'un
// week-end de repos (tableau de service) ; cliquable pour rappeler ce que ça
// signifie (public = musiciens, pas devs).
function reposTag(sat, sun) {
  return el(
    "button",
    {
      class: "repos-tag",
      title: "Week-end de repos de l'orchestre (tableau de service)",
      onclick: () => showRepos(sat, sun),
    },
    "Repos",
  )
}

function showRepos(sat, sun) {
  showHolidayDialog(
    "Repos",
    el("h2", {}, "Week-end de repos"),
    el("p", {}, `Du ${fmtDay(sat)} au ${fmtDay(sun)}.`),
    el(
      "p",
      {},
      "Week-end de repos de l'orchestre, tel qu'indiqué au tableau de service. " +
        "Des services techniques peuvent y figurer, mais sans les musicien·nes de l'orchestre.",
    ),
  )
}

function showVacance(region, nom) {
  const v = VACANCES_SCOLAIRES.find((x) => x.region === region && x.nom === nom)
  showHolidayDialog(
    "Vacances scolaires",
    el("h2", {}, `${nom} — ${REGION_LABEL[region]}`),
    v
      ? el(
          "p",
          {},
          `Du ${fmtDateStr(v.start, false)} au ${fmtDateStr(v.end, false)}`,
        )
      : null,
  )
}

function showRentree(region, date) {
  showHolidayDialog(
    "Rentrée scolaire",
    el("h2", {}, `Rentrée — ${REGION_LABEL[region]}`),
    el("p", {}, `Premier jour d'école : ${fmtDay(date, true)}.`),
  )
}

// --- Vue grille (Bible) ------------------------------------------------------

function slotOf(e) {
  const h = parseInt(fmtTime(e.start).slice(0, 2) || "0", 10)
  return h < 12 ? 0 : h < 18 ? 1 : 2
}

const SLOT_NAMES = ["Matin", "Ap-midi", "Soir"]

function renderGrille(main) {
  const events = visibleEvents()
  const showHolidays = state.prefs.showHolidays
  const feriesMap = (state.holidays && state.holidays.feries) || new Map()
  const byDay = new Map()
  for (const e of events) {
    const key = e.start.slice(0, 10)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(e)
  }

  // Week-ends de repos officiels (repris du tableau de service, cf.
  // WEEKENDS_REPOS), repérés par la date de leur samedi. Ne se déduisent pas du
  // planning : un week-end de repos peut comporter des services sans les
  // musiciens de l'orchestre.
  const reposSaturdays = new Set(WEEKENDS_REPOS)

  const start = firstMondayOfAugust(state.season)
  const end = firstMondayOfAugust(state.season + 1)
  const todayKey = localKey(new Date())

  const nWeeks = Math.round((end - start) / (7 * 86400e3))
  const nPeriodes = Math.ceil(nWeeks / 4)

  for (let p = 0; p < nPeriodes; p++) {
    const pStart = addDays(start, p * 28)
    const pEndExcl = p === nPeriodes - 1 ? end : addDays(pStart, 28)
    const pEnd = addDays(pEndExcl, -1)
    const weeksInPeriode = Math.round((pEndExcl - pStart) / (7 * 86400e3))

    const section = el("section", { class: "periode", id: `periode-${p + 1}` })
    section.append(
      el(
        "h2",
        {},
        `Période ${p + 1} — du ${pStart.getDate()} ${MONTH_NAMES[pStart.getMonth()]} au ${pEnd.getDate()} ${MONTH_NAMES[pEnd.getMonth()]} ${pEnd.getFullYear()}`,
      ),
    )

    for (let w = 0; w < weeksInPeriode; w++) {
      const monday = addDays(pStart, w * 7)
      const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
      const hasToday = days.some((d) => localKey(d) === todayKey)
      // Week-end « repos » : week-end signalé « repos » dans le tableau de
      // service (repéré par la date de son samedi, days[5]). Les deux jours sont
      // alors teintés et portent chacun une pastille « Repos ».
      const [sat, sun] = [days[5], days[6]]
      const reposWeekend = reposSaturdays.has(localKey(sat))

      const table = el("table", { class: "week" })
      if (hasToday) table.id = "current-week"
      const headRow = el(
        "tr",
        {},
        el("th", { class: "week-label" }, `S${w + 1}`),
      )
      for (const d of days) {
        const key = localKey(d)
        const feries = showHolidays ? feriesMap.get(key) || [] : []
        const isWeekend = d.getDay() === 0 || d.getDay() === 6
        const cls = [
          key === todayKey ? "today" : "",
          feries.length ? "ferie" : "",
          reposWeekend && isWeekend ? "repos" : "",
        ]
          .filter(Boolean)
          .join(" ")
        const th = el("th", { class: cls }, fmtDay(d))
        if (feries.length) th.append(feriesTags(d, feries))
        if (reposWeekend && isWeekend) th.append(reposTag(sat, sun))
        headRow.append(th)
      }
      const thead = el("thead", {}, headRow)
      if (showHolidays)
        for (const region of ["GE", "FR"]) {
          const vacRow = vacancesRow(region, days)
          if (vacRow) thead.append(vacRow)
        }
      table.append(thead)

      const tbody = el("tbody")
      for (let slot = 0; slot < 3; slot++) {
        const row = el(
          "tr",
          {},
          el("td", { class: "slot-name" }, SLOT_NAMES[slot]),
        )
        for (const d of days) {
          const isWeekend = d.getDay() === 0 || d.getDay() === 6
          const cls = [
            localKey(d) === todayKey ? "today" : "",
            reposWeekend && isWeekend ? "repos" : "",
          ]
            .filter(Boolean)
            .join(" ")
          const cell = el("td", { class: cls })
          const dayEvents = (byDay.get(localKey(d)) || []).filter(
            (e) => slotOf(e) === slot,
          )
          for (const e of dayEvents) cell.append(eventChip(e))
          row.append(cell)
        }
        tbody.append(row)
      }
      table.append(tbody)
      section.append(el("div", { class: "week-scroll" }, table))
    }
    main.append(section)
  }
}

// --- Vue agenda --------------------------------------------------------------

function renderAgenda(main) {
  const events = visibleEvents()
  const todayKey = localKey(new Date())
  const upcoming = events.filter((e) => e.start.slice(0, 10) >= todayKey)
  const list = upcoming.length ? upcoming : events

  if (!list.length) {
    main.append(
      el("p", { class: "empty-msg" }, "Aucun événement pour cette sélection."),
    )
    return
  }

  let currentDay = null
  let dayBox = null
  for (const e of list) {
    const key = e.start.slice(0, 10)
    if (key !== currentDay) {
      currentDay = key
      dayBox = el("div", {
        class: "agenda-day" + (key === todayKey ? " today" : ""),
      })
      dayBox.append(el("h3", {}, fmtDay(parseDate(e.start), true)))
      main.append(dayBox)
    }
    dayBox.append(eventChip(e))
  }
}

// --- Vue modifications --------------------------------------------------------

function changeLine(e) {
  return `${fmtDateStr(e.start)} · ${e.liste} ${e.activity} · ${shortLocation(e.location)}`
}

// En-tête d'un relevé (date + heure), commun aux changements de planning et de mémo.
function changeEntryHeading(at) {
  const d = new Date(at)
  return `Relevé du ${fmtDay(d, true)} à ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

// Nombre de changements « atomiques » d'un relevé (planning ou mémo), pour le badge.
function countChanges(entry) {
  if (entry.type === "memo")
    return entry.programs.reduce(
      (n, p) =>
        p.status === "modified"
          ? n +
            (p.fields ? p.fields.length : 0) +
            (p.worksAdded ? p.worksAdded.length : 0) +
            (p.worksRemoved ? p.worksRemoved.length : 0) +
            (p.worksModified ? p.worksModified.length : 0)
          : n + 1,
      0,
    )
  return entry.added.length + entry.removed.length + entry.modified.length
}

// Libellés des champs d'un programme dans le diff du mémo de production.
const MEMO_FIELD_LABELS = {
  chef: "chef",
  effectif: "effectif",
  duree: "durée",
  solistes: "solistes",
}

// Boîte d'un relevé de changements de planning (ajouts / modifs / suppressions).
function planningEntryBox(entry) {
  const box = el("div", { class: "change-entry" })
  box.append(el("h3", {}, changeEntryHeading(entry.at)))

  for (const e of entry.added)
    box.append(
      el(
        "div",
        { class: "change-item added", onclick: () => showDetail(e) },
        `➕ Ajouté : ${changeLine(e)}`,
      ),
    )

  for (const m of entry.modified) {
    const item = el(
      "div",
      { class: "change-item modified", onclick: () => showDetail(m.after) },
      `✏️ Modifié : ${changeLine(m.after)}`,
    )
    for (const f of m.fields) {
      const fmt = (v) =>
        f === "cancelled"
          ? v
            ? "annulé"
            : "confirmé"
          : f === "start" || f === "end"
            ? fmtDateStr(String(v))
            : String(v || "—")
      item.append(
        el(
          "div",
          { class: "field-diff" },
          `${FIELD_LABELS[f] || f} : `,
          el("span", { class: "old" }, fmt(m.before[f])),
          " → ",
          el("span", { class: "new" }, fmt(m.after[f])),
        ),
      )
    }
    box.append(item)
  }

  for (const e of entry.removed)
    box.append(
      el(
        "div",
        { class: "change-item removed" },
        `➖ Supprimé : ${changeLine(e)}`,
      ),
    )

  return box
}

// Un programme dans un relevé de mémo : champs modifiés (chef, effectif, durée,
// solistes) et œuvres ajoutées / retirées / modifiées.
function memoProgramItem(p) {
  const tag = el("span", { class: "change-tag" }, "Mémo de production")
  if (p.status === "added")
    return el(
      "div",
      { class: "change-item memo added" },
      tag,
      ` ${p.liste} : nouveau programme au mémo`,
    )
  if (p.status === "removed")
    return el(
      "div",
      { class: "change-item memo removed" },
      tag,
      ` ${p.liste} : programme retiré du mémo`,
    )

  const item = el(
    "div",
    { class: "change-item memo modified" },
    tag,
    ` ${p.liste}`,
  )
  for (const f of p.fields || [])
    item.append(
      el(
        "div",
        { class: "field-diff" },
        `${MEMO_FIELD_LABELS[f.field] || f.field} : `,
        el("span", { class: "old" }, f.before || "—"),
        " → ",
        el("span", { class: "new" }, f.after || "—"),
      ),
    )
  for (const oeuvre of p.worksAdded || [])
    item.append(
      el(
        "div",
        { class: "field-diff" },
        "œuvre ajoutée : ",
        el("span", { class: "new" }, oeuvre),
      ),
    )
  for (const oeuvre of p.worksRemoved || [])
    item.append(
      el(
        "div",
        { class: "field-diff" },
        "œuvre retirée : ",
        el("span", { class: "old" }, oeuvre),
      ),
    )
  for (const w of p.worksModified || [])
    item.append(
      el(
        "div",
        { class: "field-diff" },
        "œuvre modifiée : ",
        el("span", { class: "new" }, w.oeuvre),
        w.fields && w.fields.length
          ? ` (${w.fields.map((k) => WORK_FIELD_LABELS[k] || k).join(", ")})`
          : "",
      ),
    )
  return item
}

// Boîte d'un relevé de changements du mémo de production.
function memoEntryBox(entry) {
  const box = el("div", { class: "change-entry" })
  box.append(el("h3", {}, changeEntryHeading(entry.at)))
  for (const p of entry.programs) box.append(memoProgramItem(p))
  return box
}

function renderModifs(main) {
  if (!state.changes.length) {
    main.append(
      el(
        "p",
        { class: "empty-msg" },
        "Aucune modification détectée pour l'instant. Cette page liste les changements de planning et du mémo de production au fil des mises à jour.",
      ),
    )
    return
  }

  for (const entry of state.changes)
    main.append(
      entry.type === "memo" ? memoEntryBox(entry) : planningEntryBox(entry),
    )
}

// --- Légende / préférences ---------------------------------------------------

function renderLegend() {
  const legend = document.getElementById("legend")
  const items = Object.entries(CATEGORIES).map(([cat, label]) => {
    const off = state.prefs.hiddenCategories.includes(cat)
    return el(
      "span",
      {
        class: `legend-item cat-${cat}${off ? " off" : ""}`,
        onclick: () => {
          const hidden = state.prefs.hiddenCategories
          state.prefs.hiddenCategories = off
            ? hidden.filter((c) => c !== cat)
            : [...hidden, cat]
          savePrefs()
          render()
        },
      },
      label,
    )
  })

  // Repère « Vacances / fériés » : uniquement en vue Grille (ces repères n'y
  // apparaissent que là), cliquable comme les catégories pour masquer/afficher.
  if (state.view === "grille") {
    const off = !state.prefs.showHolidays
    items.push(
      el(
        "span",
        {
          class: `legend-item legend-holidays${off ? " off" : ""}`,
          title: "Vacances scolaires et jours fériés (Genève + France voisine)",
          onclick: () => {
            state.prefs.showHolidays = !state.prefs.showHolidays
            savePrefs()
            render()
          },
        },
        "Vacances / fériés",
      ),
    )
  }

  legend.replaceChildren(...items)
}

function renderPrefs() {
  const box = document.getElementById("prefs-content")
  const listes = listesInSeason()

  // Note récapitulative mise à jour en place (sans reconstruire le panneau,
  // pour ne pas faire remonter la liste des cases au début à chaque coche).
  const note = el("p", { class: "prefs-note" })
  const updateNote = () => {
    const n = state.prefs.listes.length
    note.textContent = n
      ? `${n} liste${n > 1 ? "s" : ""} affichée${n > 1 ? "s" : ""}. Coche les productions sur lesquelles tu joues.`
      : "Aucune coche : toutes les listes sont affichées. Coche les productions sur lesquelles tu joues pour ne garder que celles-là."
  }

  const checkboxes = new Map() // liste → <input>

  // Coche/décoche une liste, sans doublon. On ne re-render que le contenu
  // (agenda/grille) : le panneau des réglages reste en place, la liste ne
  // remonte pas, on peut cocher plusieurs cases à la suite.
  const toggleListe = (liste, on) => {
    const set = new Set(state.prefs.listes)
    if (on) set.add(liste)
    else set.delete(liste)
    state.prefs.listes = [...set]
    savePrefs()
    updateNote()
    renderContent()
  }

  const setAll = (all) => {
    state.prefs.listes = all ? [...listes] : []
    savePrefs()
    for (const cb of checkboxes.values()) cb.checked = all
    updateNote()
    renderContent()
  }

  const listeOptions = listes.map((l) => {
    const cb = el("input", {
      type: "checkbox",
      onchange: (ev) => toggleListe(l, ev.target.checked),
    })
    cb.checked = state.prefs.listes.includes(l)
    checkboxes.set(l, cb)
    return el("label", { class: "liste-option" }, cb, " ", l)
  })

  const filterBox = listeOptions.length
    ? el(
        "div",
        { class: "liste-filter" },
        el(
          "div",
          { class: "liste-filter-actions" },
          el(
            "button",
            { type: "button", onclick: () => setAll(false) },
            "Tout décocher",
          ),
          el(
            "button",
            { type: "button", onclick: () => setAll(true) },
            "Tout cocher",
          ),
        ),
        el("div", { class: "liste-options" }, ...listeOptions),
      )
    : el("p", { class: "prefs-note" }, "Aucune liste dans cette saison.")

  // --- Filtre par type d'activité (catégorie → liste) ---------------------
  // Une « case générale » par type d'activité. Cochée = ce type est affiché,
  // décochée = masqué (piloté par hiddenCategories, partagé avec la légende).
  // Chaque type dépliable (▸) révèle une sous-case par liste : on peut n'afficher
  // qu'une partie des listes d'un type (piloté par hiddenCatListes). La case
  // générale devient « indéterminée » quand seules certaines listes sont cochées.
  // Comme les cases de liste, cocher/décocher ne reconstruit pas le panneau :
  // on met à jour les cases en place et on ne re-render que le contenu.
  const cats = Object.keys(CATEGORIES)
  const catListesMap = listesByCategory()
  const catParentCb = new Map() // catégorie → <input> général
  const catChildCb = new Map() // catégorie → Map(liste → <input>)

  const catNote = el("p", { class: "prefs-note" })
  const updateCatNote = () => {
    const shown = cats.filter((c) => !state.prefs.hiddenCategories.includes(c))
    const partial = shown.filter(
      (c) => (state.prefs.hiddenCatListes[c] || []).length,
    ).length
    catNote.textContent =
      (shown.length === cats.length
        ? "Tous les types d'activité sont affichés."
        : `${shown.length} type${shown.length > 1 ? "s" : ""} d'activité affiché${shown.length > 1 ? "s" : ""} sur ${cats.length}.`) +
      (partial
        ? ` (dont ${partial} filtré${partial > 1 ? "s" : ""} par liste)`
        : "")
  }

  // Met à jour, en place, la case générale (cochée / indéterminée) et ses
  // sous-cases d'après les préférences courantes.
  const refreshCat = (cat) => {
    const listes = catListesMap[cat] || []
    const fullyHidden = state.prefs.hiddenCategories.includes(cat)
    const hid = new Set(
      fullyHidden ? listes : state.prefs.hiddenCatListes[cat] || [],
    )
    const shown = listes.filter((l) => !hid.has(l)).length
    const parent = catParentCb.get(cat)
    parent.checked = listes.length ? shown === listes.length : !fullyHidden
    parent.indeterminate =
      listes.length > 0 && shown > 0 && shown < listes.length
    const children = catChildCb.get(cat)
    if (children) for (const [l, cb] of children) cb.checked = !hid.has(l)
  }

  const applyCat = (cat) => {
    savePrefs()
    refreshCat(cat)
    updateCatNote()
    renderContent()
  }

  // Case générale : coche → tout le type affiché ; décoche → tout masqué.
  const toggleCategory = (cat, on) => {
    const hidden = new Set(state.prefs.hiddenCategories)
    const map = { ...state.prefs.hiddenCatListes }
    delete map[cat]
    if (on) hidden.delete(cat)
    else hidden.add(cat)
    state.prefs.hiddenCategories = [...hidden]
    state.prefs.hiddenCatListes = map
    applyCat(cat)
  }

  // Sous-case « liste dans ce type ». Normalise : tout masqué ⇒ type masqué
  // globalement ; rien masqué ⇒ entrée supprimée.
  const toggleCatListe = (cat, liste, on) => {
    const listes = catListesMap[cat] || []
    const hidden = new Set(state.prefs.hiddenCategories)
    const map = { ...state.prefs.hiddenCatListes }
    // Si le type était masqué en bloc, on le réactive en ne gardant que cette liste.
    let hid = hidden.has(cat) ? new Set(listes) : new Set(map[cat] || [])
    hidden.delete(cat)
    if (on) hid.delete(liste)
    else hid.add(liste)
    if (listes.every((l) => hid.has(l))) {
      hidden.add(cat)
      delete map[cat]
    } else if (hid.size === 0) {
      delete map[cat]
    } else {
      map[cat] = [...hid]
    }
    state.prefs.hiddenCategories = [...hidden]
    state.prefs.hiddenCatListes = map
    applyCat(cat)
  }

  const setAllCategories = (all) => {
    state.prefs.hiddenCategories = all ? [] : [...cats]
    state.prefs.hiddenCatListes = {}
    savePrefs()
    for (const cat of cats) refreshCat(cat)
    updateCatNote()
    renderContent()
  }

  const catOptions = cats.map((cat) => {
    const parent = el("input", {
      type: "checkbox",
      onchange: (ev) => toggleCategory(cat, ev.target.checked),
    })
    catParentCb.set(cat, parent)
    const row = el(
      "label",
      { class: "liste-option activite-option" },
      parent,
      el("span", { class: `cat-swatch cat-${cat}` }),
      CATEGORIES[cat],
    )

    const listes = catListesMap[cat] || []
    if (!listes.length) return row // type sans service cette saison : pas de sous-cases

    const children = new Map()
    catChildCb.set(cat, children)
    const subList = el(
      "div",
      { class: "activite-sous-listes", hidden: "" },
      ...listes.map((l) => {
        const cb = el("input", {
          type: "checkbox",
          onchange: (ev) => toggleCatListe(cat, l, ev.target.checked),
        })
        children.set(l, cb)
        return el(
          "label",
          { class: "liste-option sous-liste-option" },
          cb,
          " ",
          l,
        )
      }),
    )
    const caret = el(
      "button",
      {
        type: "button",
        class: "activite-toggle",
        "aria-label": "Afficher/masquer les listes de ce type",
        onclick: () => {
          const open = subList.hasAttribute("hidden")
          if (open) subList.removeAttribute("hidden")
          else subList.setAttribute("hidden", "")
          caret.textContent = open ? "▾" : "▸"
        },
      },
      "▸",
    )
    // La case + le libellé restent dans le <label> ; le chevron est à part pour
    // ne pas cocher la case quand on déplie.
    return el(
      "div",
      { class: "activite-groupe" },
      el("div", { class: "activite-tete" }, row, caret),
      subList,
    )
  })

  const catBox = el(
    "div",
    { class: "liste-filter" },
    el(
      "div",
      { class: "liste-filter-actions" },
      el(
        "button",
        { type: "button", onclick: () => setAllCategories(false) },
        "Tout décocher",
      ),
      el(
        "button",
        { type: "button", onclick: () => setAllCategories(true) },
        "Tout cocher",
      ),
    ),
    el("div", { class: "liste-options" }, ...catOptions),
  )

  const cancelledCheckbox = el("input", {
    type: "checkbox",
    onchange: (ev) => {
      state.prefs.showCancelled = ev.target.checked
      savePrefs()
      renderContent()
    },
  })
  cancelledCheckbox.checked = state.prefs.showCancelled

  const holidaysCheckbox = el("input", {
    type: "checkbox",
    onchange: (ev) => {
      state.prefs.showHolidays = ev.target.checked
      savePrefs()
      renderContent()
    },
  })
  holidaysCheckbox.checked = state.prefs.showHolidays

  updateNote()
  for (const cat of cats) refreshCat(cat)
  updateCatNote()

  box.replaceChildren(
    el(
      "div",
      { class: "prefs-section" },
      el("div", { class: "prefs-label" }, "Filtrer par liste (production) :"),
      filterBox,
      note,
    ),
    el(
      "div",
      { class: "prefs-section" },
      el("div", { class: "prefs-label" }, "Filtrer par type d'activité :"),
      el(
        "p",
        { class: "prefs-note prefs-note-top" },
        "Déplie un type (▸) pour n'afficher que certaines listes de ce type.",
      ),
      catBox,
      catNote,
    ),
    el(
      "label",
      { class: "prefs-cancelled" },
      cancelledCheckbox,
      " Afficher les événements annulés (barrés)",
    ),
    el(
      "label",
      { class: "prefs-cancelled" },
      holidaysCheckbox,
      " Afficher les vacances scolaires et jours fériés (Grille)",
    ),
    el(
      "p",
      { class: "prefs-note" },
      "Astuce : la légende sous le titre permet de masquer/afficher chaque catégorie d'un simple clic. Les préférences sont mémorisées sur cet appareil.",
    ),
  )
}

// --- Abonnement au calendrier (ICS) ------------------------------------------

// URL du worker Cloudflare qui filtre le calendrier à la volée (abonnement
// personnalisé par listes/catégories — voir worker/). La vider masque la
// fonctionnalité (le dialogue ne propose alors que l'abonnement complet).
const PERSONAL_CALENDAR_URL =
  "https://bemol-calendrier.ivan-schneider.workers.dev/planning.ics"

// URL du calendrier ICS, calculée par rapport à la page courante : fonctionne
// aussi bien en production que dans les previews de PR (sous-dossier). `webcal:`
// fait ouvrir directement l'app d'agenda sur la plupart des appareils.
function subscribeUrls() {
  const ics = new URL("data/planning.ics", location.href).href
  return { ics, webcal: ics.replace(/^https?:/, "webcal:") }
}

// URL d'abonnement personnalisée reflétant les Réglages actuels (listes
// sélectionnées, catégories masquées, annulés), ou null si aucun filtre n'est
// actif ou si le worker n'est pas déployé. Les sous-cases « par liste » d'une
// catégorie ne sont pas transposables dans l'abonnement (trop fin pour une
// URL) — c'est dit dans la note du dialogue.
function personalSubscribeUrls() {
  if (!PERSONAL_CALENDAR_URL) return null
  const p = state.prefs
  const params = new URLSearchParams()
  if (p.listes.length) params.set("listes", p.listes.join(","))
  if (p.hiddenCategories.length)
    params.set("sans", p.hiddenCategories.join(","))
  if (!p.showCancelled) params.set("annules", "0")
  if (![...params.keys()].length) return null
  const ics = `${PERSONAL_CALENDAR_URL}?${params}`
  return { ics, webcal: ics.replace(/^https?:/, "webcal:") }
}

function renderSubscribe() {
  const box = document.getElementById("subscribe-content")
  const { ics, webcal } = subscribeUrls()
  const personal = personalSubscribeUrls()

  // Abonnement personnalisé : reflète les Réglages actuels, si le worker de
  // filtrage est déployé. Sinon (ou sans filtre actif), section absente.
  const personalSection = personal
    ? [
        el("h3", { class: "subscribe-h" }, "Mon planning (selon mes Réglages)"),
        el(
          "p",
          { class: "subscribe-intro" },
          "Reprend les filtres actifs en ce moment dans ⚙ Réglages " +
            "(listes cochées, catégories masquées" +
            (state.prefs.showCancelled ? "" : ", sans les annulés") +
            "). Se met à jour tout seul, comme le calendrier complet.",
        ),
        el(
          "a",
          { class: "subscribe-add", href: personal.webcal },
          "📅 Ajouter mon planning à mon agenda",
        ),
        el(
          "p",
          { class: "subscribe-or" },
          "…ou copie ce lien pour l'ajouter à la main :",
        ),
        copyLinkRow(personal.ics),
        el("h3", { class: "subscribe-h" }, "Calendrier complet"),
      ]
    : PERSONAL_CALENDAR_URL
      ? [
          el(
            "p",
            { class: "subscribe-intro" },
            "Astuce : coche tes listes ou masque des catégories dans " +
              "⚙ Réglages, et ce dialogue te proposera aussi un abonnement " +
              "personnalisé ne contenant que ça.",
          ),
        ]
      : []

  box.replaceChildren(
    ...personalSection,
    el(
      "p",
      { class: "subscribe-intro" },
      "Ajoute le planning de l'OSR à ton agenda habituel (iPhone, Google Agenda, " +
        "Outlook…). Il se met à jour tout seul et reprend toutes les infos de la " +
        "Grille : chef, solistes, œuvres, instrumentation, effectif.",
    ),
    el(
      "a",
      { class: "subscribe-add", href: webcal },
      "📅 Ajouter à mon agenda",
    ),
    el(
      "p",
      { class: "subscribe-or" },
      "…ou copie ce lien pour l'ajouter à la main :",
    ),
    copyLinkRow(ics),
    el(
      "details",
      { class: "subscribe-help" },
      el("summary", {}, "Comment faire selon l'appareil ?"),
      el(
        "ul",
        {},
        el(
          "li",
          {},
          el("b", {}, "iPhone / iPad : "),
          "touche « Ajouter à mon agenda », puis confirme l'abonnement dans l'app Calendrier.",
        ),
        el(
          "li",
          {},
          el("b", {}, "Mac : "),
          "« Ajouter à mon agenda » ouvre l'app Calendrier ; valide l'abonnement.",
        ),
        el(
          "li",
          {},
          el("b", {}, "Google Agenda : "),
          "sur ordinateur, « Autres agendas » → « À partir d'une URL », puis colle le lien copié.",
        ),
        el(
          "li",
          {},
          el("b", {}, "Outlook : "),
          "« Ajouter un calendrier » → « S'abonner à partir du Web », puis colle le lien.",
        ),
      ),
    ),
    el(
      "p",
      { class: "subscribe-note" },
      (personal
        ? "« Mon planning » fige les filtres au moment de l'abonnement : si tu changes " +
          "tes Réglages plus tard, réabonne-toi avec le nouveau lien. Les sous-cases " +
          "« par liste » d'une catégorie ne s'y appliquent pas. "
        : "Le calendrier complet contient tous les services de la saison (les filtres et " +
          "catégories masquées de l'app ne s'y appliquent pas). ") +
        "Selon l'agenda, les mises à jour peuvent mettre quelques heures à apparaître.",
    ),
  )
}

// --- Installation de l'application (PWA) -----------------------------------

// Invite d'installation native mémorisée (Chrome / Android) pour la déclencher
// au bon moment. iOS ne la fournit pas : on affiche alors une aide manuelle.
let deferredInstallPrompt = null

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  )
}

function isIOS() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPad récent se présente comme un Mac tactile
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

// Affiche le bouton « Installer » de l'en-tête, sauf si l'app est déjà lancée
// depuis l'écran d'accueil (mode « standalone »).
function updateInstallButton() {
  const btn = document.getElementById("install-btn")
  if (btn) btn.hidden = isStandalone()
}

function renderInstall() {
  const box = document.getElementById("install-content")
  const steps = isIOS()
    ? [
        el("li", {}, "Ouvre Bémol dans ", el("b", {}, "Safari"), "."),
        el(
          "li",
          {},
          "Touche le bouton ",
          el("b", {}, "Partager"),
          " (le carré avec une flèche vers le haut).",
        ),
        el(
          "li",
          {},
          "Choisis ",
          el("b", {}, "« Sur l'écran d'accueil »"),
          ", puis ",
          el("b", {}, "« Ajouter »"),
          ".",
        ),
      ]
    : [
        el("li", {}, "Ouvre Bémol dans ", el("b", {}, "Chrome"), "."),
        el("li", {}, "Touche le menu ", el("b", {}, "⋮"), " en haut à droite."),
        el(
          "li",
          {},
          "Choisis ",
          el("b", {}, "« Installer l'application »"),
          " (ou « Ajouter à l'écran d'accueil »).",
        ),
      ]

  const children = [
    el(
      "p",
      { class: "install-intro" },
      "Ajoute Bémol à ton écran d'accueil pour l'ouvrir comme une vraie " +
        "application : en plein écran, d'un seul geste, et consultable même " +
        "sans connexion.",
    ),
  ]

  // Bouton d'installation natif quand le navigateur le propose (Android / Chrome).
  if (deferredInstallPrompt) {
    children.push(
      el(
        "button",
        {
          type: "button",
          class: "install-now",
          onclick: async () => {
            const prompt = deferredInstallPrompt
            deferredInstallPrompt = null
            document.getElementById("install-dialog").close()
            prompt.prompt()
            await prompt.userChoice
            updateInstallButton()
          },
        },
        "📲 Installer maintenant",
      ),
      el("p", { class: "install-or" }, "…ou à la main :"),
    )
  }

  children.push(
    el("ol", { class: "install-steps" }, ...steps),
    el(
      "p",
      { class: "install-note" },
      "Une fois installée, l'application se met à jour toute seule quand tu " +
        "l'ouvres avec une connexion.",
    ),
  )

  box.replaceChildren(...children)
}

// --- Navigation / rendu global -------------------------------------------------

function setView(view) {
  state.view = view
  localStorage.setItem("bemol-view", view)
  for (const btn of document.querySelectorAll("#view-nav button"))
    btn.classList.toggle("active", btn.dataset.view === view)
  render()
}

const VIEW_LABELS = {
  grille: "Grille",
  agenda: "Agenda",
  modifs: "Modifications",
}

function render() {
  renderPrefs()
  renderContent()
}

// Rendu du contenu affiché (légende + vue courante), sans toucher au panneau
// des réglages : appelé quand on coche/décoche une liste pour ne pas
// reconstruire les cases (et donc ne pas faire remonter la liste).
function renderContent() {
  renderLegend()
  const main = document.getElementById("main")
  main.replaceChildren()
  // Titre affiché uniquement à l'impression (l'en-tête de navigation est masqué)
  main.append(
    el(
      "div",
      { class: "print-title" },
      el("h1", {}, `♭ Bémol — Planning OSR`),
      el(
        "p",
        {},
        `${seasonLabel(state.season)} · vue ${VIEW_LABELS[state.view] || ""}`,
      ),
    ),
  )
  if (state.view === "grille") renderGrille(main)
  else if (state.view === "agenda") renderAgenda(main)
  else renderModifs(main)
}

function scrollToToday() {
  const target =
    document.getElementById("current-week") ||
    document.querySelector(".agenda-day.today")
  if (target) target.scrollIntoView({ behavior: "smooth", block: "center" })
}

async function init() {
  try {
    await loadData()
  } catch (err) {
    document.getElementById("loading").textContent =
      "Impossible de charger les données du planning. Réessaie plus tard."
    console.error(err)
    return
  }

  checkDataFreshness()

  // Les données ne contiennent qu'une saison (filtre ONLY_SEASON du pipeline) :
  // on l'adopte directement, sans sélecteur.
  state.season = seasonsInData()[0]
  // Jours fériés de la saison (elle chevauche deux années civiles)
  state.holidays = { feries: buildFeries([state.season, state.season + 1]) }

  for (const btn of document.querySelectorAll("#view-nav button"))
    btn.addEventListener("click", () => setView(btn.dataset.view))

  document.getElementById("today-btn").addEventListener("click", scrollToToday)

  document.getElementById("prefs-btn").addEventListener("click", () => {
    renderPrefs()
    document.getElementById("prefs-dialog").showModal()
  })

  document.getElementById("subscribe-btn").addEventListener("click", () => {
    renderSubscribe()
    document.getElementById("subscribe-dialog").showModal()
  })

  document.getElementById("install-btn").addEventListener("click", () => {
    renderInstall()
    document.getElementById("install-dialog").showModal()
  })
  updateInstallButton()

  // Vue par Liste : le lien partageable (#liste-04) rouvre le dialogue.
  // En quittant le dialogue (Fermer/Echap), on nettoie le hash sans laisser
  // d'entrée d'historique, pour pouvoir rouvrir le même lien plus tard.
  document.getElementById("liste-dialog").addEventListener("close", () => {
    if (location.hash)
      history.replaceState(null, "", location.pathname + location.search)
  })
  window.addEventListener("hashchange", syncListeFromHash)

  // Badge « modifs » : nombre de changements depuis la dernière visite
  const lastVisit = localStorage.getItem("bemol-last-visit")
  const newChanges = state.changes.filter((c) => !lastVisit || c.at > lastVisit)
  const badge = document.getElementById("modifs-badge")
  if (newChanges.length) {
    const count = newChanges.reduce((n, c) => n + countChanges(c), 0)
    badge.textContent = count
    badge.hidden = false
  }
  localStorage.setItem("bemol-last-visit", new Date().toISOString())

  if (state.updatedAt)
    document.getElementById("update-info").textContent =
      `Dernière évolution des données : ${fmtDateStr(state.updatedAt.slice(0, 16))} · ${state.events.length} événements`

  const defaultView = window.matchMedia("(max-width: 700px)").matches
    ? "agenda"
    : "grille"
  setView(localStorage.getItem("bemol-view") || defaultView)
  scrollToToday()
  syncListeFromHash()
}

init()

// Installation « écran d'accueil » : on intercepte l'invite native (Android /
// Chrome) pour la déclencher depuis notre propre bouton, plus lisible.
window.addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault()
  deferredInstallPrompt = ev
  updateInstallButton()
})

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null
  updateInstallButton()
})

// Service worker : rend l'app installable et consultable hors-ligne.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("Service worker non enregistré :", err)
    })
  })
}
