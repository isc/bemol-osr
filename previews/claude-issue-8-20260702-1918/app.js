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
  productions: {}, // Liste → { works, effectif } (mémo de production, saisi à la main)
  updatedAt: null,
  season: null,
  view: null,
  recentUids: new Map(), // uid → date du dernier changement récent
  prefs: loadPrefs(),
}

function loadPrefs() {
  const defaults = {
    hiddenCategories: ["resa"],
    showCancelled: true,
    liste: "",
  }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem("bemol-prefs") || "{}") }
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
    // Mémo de production (œuvres + effectif), saisi à la main et optionnel.
    fetch(`productions.json${bust}`).then((r) => r.json()).catch(() => ({})),
  ])
  state.events = planning.events
  state.updatedAt = planning.updatedAt
  state.changes = changes.entries || []
  state.productions = productions || {}

  const cutoff = Date.now() - RECENT_DAYS * 86400e3
  for (const entry of state.changes) {
    if (new Date(entry.at).getTime() < cutoff) continue
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
      (p.showCancelled || !e.cancelled) &&
      (!p.liste || e.liste === p.liste) &&
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
    el("h2", {}, `${e.liste} — ${e.activity}${e.cancelled ? " (ANNULÉ)" : ""}`),
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
    ),
    ...productionDetail(e),
  )
  dlg.showModal()
}

// Infos du mémo de production (œuvres + effectif) pour la Liste de l'événement.
// Renvoie [] si aucune info n'est saisie pour cette Liste dans productions.json.
function productionDetail(e) {
  const prod = state.productions[e.liste]
  if (!prod) return []
  const works = (prod.works || []).filter(Boolean)
  const nodes = []
  if (works.length) {
    nodes.push(
      el("h3", { class: "detail-section" }, "Œuvres au programme"),
      el("ul", { class: "works" }, ...works.map((w) => el("li", {}, w))),
    )
  }
  if (prod.effectif) {
    nodes.push(
      el("h3", { class: "detail-section" }, "Effectif orchestral"),
      el("p", { class: "effectif" }, prod.effectif),
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

function renderModifs(main) {
  if (!state.changes.length) {
    main.append(
      el(
        "p",
        { class: "empty-msg" },
        "Aucune modification détectée pour l'instant. Cette page listera les changements de planning au fil des mises à jour de l'export ICS.",
      ),
    )
    return
  }

  for (const entry of state.changes) {
    const box = el("div", { class: "change-entry" })
    const d = new Date(entry.at)
    box.append(el("h3", {}, `Relevé du ${fmtDay(d, true)} à ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`))

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

    main.append(box)
  }
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
  const listeSelect = el(
    "select",
    {
      onchange: (ev) => {
        state.prefs.liste = ev.target.value
        savePrefs()
        render()
      },
    },
    el("option", { value: "" }, "Toutes les listes"),
    ...listesInSeason().map((l) =>
      el("option", { value: l, selected: state.prefs.liste === l ? "" : null }, l),
    ),
  )
  const cancelledCheckbox = el("input", {
    type: "checkbox",
    onchange: (ev) => {
      state.prefs.showCancelled = ev.target.checked
      savePrefs()
      render()
    },
  })
  cancelledCheckbox.checked = state.prefs.showCancelled

  box.replaceChildren(
    el("label", {}, "Filtrer par liste :", listeSelect),
    el("label", {}, cancelledCheckbox, " Afficher les événements annulés (barrés)"),
    el(
      "p",
      { style: "font-size: 0.8em; color: #778" },
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
  renderLegend()
  renderPrefs()
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

  const seasons = seasonsInData()
  const currentSeason = seasonYear(new Date())
  state.season = seasons.includes(currentSeason) ? currentSeason : seasons[0]

  const seasonSelect = document.getElementById("season-select")
  for (const y of seasons)
    seasonSelect.append(el("option", { value: y, selected: y === state.season ? "" : null }, seasonLabel(y)))
  seasonSelect.addEventListener("change", () => {
    state.season = parseInt(seasonSelect.value, 10)
    if (state.prefs.liste && !listesInSeason().includes(state.prefs.liste)) {
      state.prefs.liste = ""
      savePrefs()
    }
    render()
  })

  for (const btn of document.querySelectorAll("#view-nav button"))
    btn.addEventListener("click", () => setView(btn.dataset.view))

  document.getElementById("today-btn").addEventListener("click", () => {
    if (state.season !== currentSeason && seasons.includes(currentSeason)) {
      state.season = currentSeason
      seasonSelect.value = currentSeason
      render()
    }
    scrollToToday()
  })

  document.getElementById("prefs-btn").addEventListener("click", () => {
    renderPrefs()
    document.getElementById("prefs-dialog").showModal()
  })

  // Badge « modifs » : nombre de changements depuis la dernière visite
  const lastVisit = localStorage.getItem("bemol-last-visit")
  const newChanges = state.changes.filter((c) => !lastVisit || c.at > lastVisit)
  const badge = document.getElementById("modifs-badge")
  if (newChanges.length) {
    const count = newChanges.reduce(
      (n, c) => n + c.added.length + c.removed.length + c.modified.length,
      0,
    )
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
