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
  "janv.", "févr.", "mars", "avr.", "mai", "juin",
  "juil.", "août", "sept.", "oct.", "nov.", "déc.",
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
  for (const [full, short] of LOCATION_SHORT) if (loc.includes(full)) return short
  return loc.length > 18 ? loc.slice(0, 16) + "…" : loc
}

function shortListe(liste) {
  const m = liste.match(/^Liste (.+)$/)
  if (!m) return liste.length > 10 ? liste.slice(0, 9) + "…" : liste
  return /^\d/.test(m[1]) ? "L" + m[1] : m[1]
}

// --- Chargement ------------------------------------------------------------

async function loadData() {
  const bust = `?t=${Date.now()}`
  const [planning, changes, productions] = await Promise.all([
    fetch(`data/planning.json${bust}`).then((r) => r.json()),
    fetch(`data/changes.json${bust}`).then((r) => r.json()).catch(() => ({ entries: [] })),
    // Mémo de production (œuvres + effectif), généré depuis le mini-site Dièse.
    fetch(`productions.json${bust}`).then((r) => r.json()).catch(() => ({})),
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
        if (!state.recentListes.has(prog.liste)) state.recentListes.set(prog.liste, entry.at)
      continue
    }
    for (const e of [...entry.added, ...entry.modified.map((m) => m.after)])
      if (!state.recentUids.has(e.uid)) state.recentUids.set(e.uid, entry.at)
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
    out[cat] = [...set].sort((a, b) => a.localeCompare(b, "fr", { numeric: true }))
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
    { class: classes.join(" "), title: `${e.liste} — ${e.activity}`, onclick: () => showDetail(e) },
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
    el("span", { class: `detail-cat evt cat-${e.category}` }, CATEGORIES[e.category]),
    el(
      "h2",
      {},
      `${e.liste} — ${e.activity}${e.cancelled ? " (ANNULÉ)" : ""}`,
      // Point rouge si le mémo de ce programme a changé récemment (cf. les
      // événements de planning récemment modifiés).
      state.recentListes.has(e.liste)
        ? el("span", { class: "recent-dot", title: "Mémo de production modifié récemment" }, "●")
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
        ? el("dd", {}, `récemment (${fmtDateStr(state.recentUids.get(e.uid).slice(0, 16), false)})`)
        : null,
      state.recentListes.has(e.liste) ? el("dt", {}, "Mémo") : null,
      state.recentListes.has(e.liste)
        ? el("dd", {}, `modifié récemment (${fmtDateStr(state.recentListes.get(e.liste).slice(0, 16), false)})`)
        : null,
    ),
    ...productionDetail(e),
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
// d'instrumentation, effectif, durée) pour la Liste de l'événement. Renvoie []
// si aucune info n'est saisie pour cette Liste dans productions.json.
function productionDetail(e) {
  const prod = state.productions[e.liste]
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
      el("h3", { class: "detail-section" }, solistes.length > 1 ? "Solistes" : "Soliste"),
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

// --- Vue grille (Bible) ------------------------------------------------------

function slotOf(e) {
  const h = parseInt(fmtTime(e.start).slice(0, 2) || "0", 10)
  return h < 12 ? 0 : h < 18 ? 1 : 2
}

const SLOT_NAMES = ["Matin", "Ap-midi", "Soir"]

function renderGrille(main) {
  const events = visibleEvents()
  const byDay = new Map()
  for (const e of events) {
    const key = e.start.slice(0, 10)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(e)
  }

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
      el("h2", {}, `Période ${p + 1} — du ${pStart.getDate()} ${MONTH_NAMES[pStart.getMonth()]} au ${pEnd.getDate()} ${MONTH_NAMES[pEnd.getMonth()]} ${pEnd.getFullYear()}`),
    )

    for (let w = 0; w < weeksInPeriode; w++) {
      const monday = addDays(pStart, w * 7)
      const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i))
      const hasToday = days.some((d) => localKey(d) === todayKey)

      const table = el("table", { class: "week" })
      if (hasToday) table.id = "current-week"
      const headRow = el("tr", {}, el("th", { class: "week-label" }, `S${w + 1}`))
      for (const d of days)
        headRow.append(el("th", { class: localKey(d) === todayKey ? "today" : "" }, fmtDay(d)))
      table.append(el("thead", {}, headRow))

      const tbody = el("tbody")
      for (let slot = 0; slot < 3; slot++) {
        const row = el("tr", {}, el("td", { class: "slot-name" }, SLOT_NAMES[slot]))
        for (const d of days) {
          const cell = el("td", { class: localKey(d) === todayKey ? "today" : "" })
          const dayEvents = (byDay.get(localKey(d)) || []).filter((e) => slotOf(e) === slot)
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
    main.append(el("p", { class: "empty-msg" }, "Aucun événement pour cette sélection."))
    return
  }

  let currentDay = null
  let dayBox = null
  for (const e of list) {
    const key = e.start.slice(0, 10)
    if (key !== currentDay) {
      currentDay = key
      dayBox = el("div", { class: "agenda-day" + (key === todayKey ? " today" : "") })
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
const MEMO_FIELD_LABELS = { chef: "chef", effectif: "effectif", duree: "durée", solistes: "solistes" }

// Boîte d'un relevé de changements de planning (ajouts / modifs / suppressions).
function planningEntryBox(entry) {
  const box = el("div", { class: "change-entry" })
  box.append(el("h3", {}, changeEntryHeading(entry.at)))

  for (const e of entry.added)
    box.append(el("div", { class: "change-item added", onclick: () => showDetail(e) }, `➕ Ajouté : ${changeLine(e)}`))

  for (const m of entry.modified) {
    const item = el("div", { class: "change-item modified", onclick: () => showDetail(m.after) }, `✏️ Modifié : ${changeLine(m.after)}`)
    for (const f of m.fields) {
      const fmt = (v) =>
        f === "cancelled" ? (v ? "annulé" : "confirmé") : f === "start" || f === "end" ? fmtDateStr(String(v)) : String(v || "—")
      item.append(
        el("div", { class: "field-diff" },
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
    box.append(el("div", { class: "change-item removed" }, `➖ Supprimé : ${changeLine(e)}`))

  return box
}

// Un programme dans un relevé de mémo : champs modifiés (chef, effectif, durée,
// solistes) et œuvres ajoutées / retirées / modifiées.
function memoProgramItem(p) {
  const tag = el("span", { class: "change-tag" }, "Mémo de production")
  if (p.status === "added")
    return el("div", { class: "change-item memo added" }, tag, ` ${p.liste} : nouveau programme au mémo`)
  if (p.status === "removed")
    return el("div", { class: "change-item memo removed" }, tag, ` ${p.liste} : programme retiré du mémo`)

  const item = el("div", { class: "change-item memo modified" }, tag, ` ${p.liste}`)
  for (const f of p.fields || [])
    item.append(
      el("div", { class: "field-diff" },
        `${MEMO_FIELD_LABELS[f.field] || f.field} : `,
        el("span", { class: "old" }, f.before || "—"),
        " → ",
        el("span", { class: "new" }, f.after || "—"),
      ),
    )
  for (const oeuvre of p.worksAdded || [])
    item.append(el("div", { class: "field-diff" }, "œuvre ajoutée : ", el("span", { class: "new" }, oeuvre)))
  for (const oeuvre of p.worksRemoved || [])
    item.append(el("div", { class: "field-diff" }, "œuvre retirée : ", el("span", { class: "old" }, oeuvre)))
  for (const w of p.worksModified || [])
    item.append(
      el("div", { class: "field-diff" },
        "œuvre modifiée : ",
        el("span", { class: "new" }, w.oeuvre),
        w.fields && w.fields.length ? ` (${w.fields.map((k) => WORK_FIELD_LABELS[k] || k).join(", ")})` : "",
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
    main.append(entry.type === "memo" ? memoEntryBox(entry) : planningEntryBox(entry))
}

// --- Légende / préférences ---------------------------------------------------

function renderLegend() {
  const legend = document.getElementById("legend")
  legend.replaceChildren(
    ...Object.entries(CATEGORIES).map(([cat, label]) => {
      const off = state.prefs.hiddenCategories.includes(cat)
      return el(
        "span",
        {
          class: `legend-item cat-${cat}${off ? " off" : ""}`,
          onclick: () => {
            const hidden = state.prefs.hiddenCategories
            state.prefs.hiddenCategories = off ? hidden.filter((c) => c !== cat) : [...hidden, cat]
            savePrefs()
            render()
          },
        },
        label,
      )
    }),
  )
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
          el("button", { type: "button", onclick: () => setAll(false) }, "Tout décocher"),
          el("button", { type: "button", onclick: () => setAll(true) }, "Tout cocher"),
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
    const partial = shown.filter((c) => (state.prefs.hiddenCatListes[c] || []).length).length
    catNote.textContent =
      (shown.length === cats.length
        ? "Tous les types d'activité sont affichés."
        : `${shown.length} type${shown.length > 1 ? "s" : ""} d'activité affiché${shown.length > 1 ? "s" : ""} sur ${cats.length}.`) +
      (partial ? ` (dont ${partial} filtré${partial > 1 ? "s" : ""} par liste)` : "")
  }

  // Met à jour, en place, la case générale (cochée / indéterminée) et ses
  // sous-cases d'après les préférences courantes.
  const refreshCat = (cat) => {
    const listes = catListesMap[cat] || []
    const fullyHidden = state.prefs.hiddenCategories.includes(cat)
    const hid = new Set(fullyHidden ? listes : state.prefs.hiddenCatListes[cat] || [])
    const shown = listes.filter((l) => !hid.has(l)).length
    const parent = catParentCb.get(cat)
    parent.checked = listes.length ? shown === listes.length : !fullyHidden
    parent.indeterminate = listes.length > 0 && shown > 0 && shown < listes.length
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
        return el("label", { class: "liste-option sous-liste-option" }, cb, " ", l)
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
    return el("div", { class: "activite-groupe" }, el("div", { class: "activite-tete" }, row, caret), subList)
  })

  const catBox = el(
    "div",
    { class: "liste-filter" },
    el(
      "div",
      { class: "liste-filter-actions" },
      el("button", { type: "button", onclick: () => setAllCategories(false) }, "Tout décocher"),
      el("button", { type: "button", onclick: () => setAllCategories(true) }, "Tout cocher"),
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
      "p",
      { class: "prefs-note" },
      "Astuce : la légende sous le titre permet de masquer/afficher chaque catégorie d'un simple clic. Les préférences sont mémorisées sur cet appareil.",
    ),
  )
}

// --- Navigation / rendu global -------------------------------------------------

function setView(view) {
  state.view = view
  localStorage.setItem("bemol-view", view)
  for (const btn of document.querySelectorAll("#view-nav button"))
    btn.classList.toggle("active", btn.dataset.view === view)
  render()
}

const VIEW_LABELS = { grille: "Grille", agenda: "Agenda", modifs: "Modifications" }

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
      el("p", {}, `${seasonLabel(state.season)} · vue ${VIEW_LABELS[state.view] || ""}`),
    ),
  )
  if (state.view === "grille") renderGrille(main)
  else if (state.view === "agenda") renderAgenda(main)
  else renderModifs(main)
}

function scrollToToday() {
  const target = document.getElementById("current-week") || document.querySelector(".agenda-day.today")
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

  // Les données ne contiennent qu'une saison (filtre ONLY_SEASON du pipeline) :
  // on l'adopte directement, sans sélecteur.
  state.season = seasonsInData()[0]

  for (const btn of document.querySelectorAll("#view-nav button"))
    btn.addEventListener("click", () => setView(btn.dataset.view))

  document.getElementById("today-btn").addEventListener("click", scrollToToday)

  document.getElementById("prefs-btn").addEventListener("click", () => {
    renderPrefs()
    document.getElementById("prefs-dialog").showModal()
  })

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

  const defaultView = window.matchMedia("(max-width: 700px)").matches ? "agenda" : "grille"
  setView(localStorage.getItem("bemol-view") || defaultView)
  scrollToToday()
}

init()
