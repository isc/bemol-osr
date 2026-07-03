#!/usr/bin/env node
// Régénère productions.json à partir du « Mémo de Production » du mini-site
// Dièse (template_746), sans navigateur :
//
//   1. store_saisons / store_productions (en-tête Origin obligatoire — c'est la
//      seule « protection » de ces endpoints) → id de saison + ids de productions
//   2. GET template_746.php → URL de rendu avec jeton frais (attribut rel du
//      bouton PDF)
//   3. POST _ajax/genererPdf.php → le serveur rend le mémo complet en PDF
//      (PrinceXML) et répond l'URL du fichier
//   4. téléchargement + pdftotext + parsing → productions.json
//
// Usage :
//   node scripts/update-memo.mjs                (production / CI, nécessite pdftotext)
//   node scripts/update-memo.mjs chemin.txt     (test local sur un texte déjà extrait)
//
// Le fichier n'est réécrit que si le contenu a changé.

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const productionsPath = join(root, "productions.json")
const planningPath = join(root, "data", "planning.json")

const CHDOC = "https://chdocuments.diesesoftware.com"
const OSR = "https://osr.diesesoftware.com"
// Jeton stable de la page « Mémo de Production (Mini-site) » (lien de partage)
const MEMO_PAGE = `${CHDOC}/files/template_746.php?uid=Vm1FRFpRPT0=&doc=BDcHYQU7DwwLVlJZVl9QDwQLCCVSWFRaUgMFbFN0UyI=`
const STORE_HEADERS = { Origin: CHDOC }

// --- Récupération ------------------------------------------------------------

async function fetchText(url, options = {}) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url.slice(0, 80)}…`)
  return res.text()
}

// La saison affichée par l'app = celle du filtre ONLY_SEASON du pipeline planning.
function targetSeasonLabel() {
  const src = readFileSync(join(root, "scripts", "update-data.mjs"), "utf8")
  const m = src.match(/ONLY_SEASON = (\d{4})/)
  if (!m) throw new Error("ONLY_SEASON introuvable dans update-data.mjs")
  const y = parseInt(m[1], 10)
  return `${y}/${String(y + 1).slice(2)}`
}

async function generateMemoPdfText() {
  const label = targetSeasonLabel()
  const saisons = JSON.parse(
    await fetchText(`${OSR}/_app/osr/_datasMysql/store_saisons.php?checkDroitsPlanning=1&idUtilisateur=51`, {
      headers: STORE_HEADERS,
    }),
  )
  const saison = saisons.find((s) => s.intitule === label)
  if (!saison) throw new Error(`Saison ${label} introuvable dans le store Dièse`)

  const productions = JSON.parse(
    await fetchText(`${OSR}/_app/osr/_datasMysql/store_productions.php?idUtilisateur=51`, {
      headers: STORE_HEADERS,
    }),
  )
  const prodIds = productions.filter((p) => p.saison === label).map((p) => p.id)
  if (!prodIds.length) throw new Error(`Aucune production pour la saison ${label}`)

  // Périodes de 4 semaines entre les bornes officielles de la saison
  const periods = []
  const iso = (x) => x.toISOString().slice(0, 10)
  for (let d = new Date(saison.dateDebut + "T12:00:00"); ; ) {
    const end = new Date(d)
    end.setDate(end.getDate() + 27)
    periods.push(`${iso(d)}_${iso(end)}`)
    d = new Date(end)
    d.setDate(d.getDate() + 1)
    if (iso(d) > saison.dateFin) break
  }

  // Page mémo → URL de rendu à jeton frais (les uid sont à usage unique)
  const page = await fetchText(`${MEMO_PAGE}&saison=${saison.id}`)
  const rel = page.match(/rel="(https:[^"]*template_746\.php\?idVersion=1[^"]*)"/)
  if (!rel) throw new Error("URL de rendu introuvable dans la page mémo (structure changée ?)")
  const renderUrl = rel[1]
    .replace("idProduction=&", `idProduction=${encodeURIComponent(prodIds.join(","))}&`)
    .replace("periode=&", `periode=${encodeURIComponent(periods.join(","))}&`)

  const pdfUrl = (
    await fetchText(`${CHDOC}/files/_ajax/genererPdf.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ idClient: "osr", url: renderUrl, prince: "1", nomCustom: "bemol-memo" }),
    })
  ).trim()
  if (!/^https:\/\/.*\.pdf$/.test(pdfUrl)) throw new Error(`Réponse inattendue de genererPdf : ${pdfUrl.slice(0, 120)}`)

  const pdf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer())
  const dir = mkdtempSync(join(tmpdir(), "bemol-memo-"))
  const pdfPath = join(dir, "memo.pdf")
  writeFileSync(pdfPath, pdf)
  execFileSync("pdftotext", [pdfPath, join(dir, "memo.txt")])
  return readFileSync(join(dir, "memo.txt"), "utf8")
}

// --- Parsing -------------------------------------------------------------------
// L'ordre des blocs (distribution, compositeurs, œuvres) varie selon les fiches
// (linéarisation de colonnes par pdftotext) : chaque type de ligne est reconnu
// par sa FORME, indépendamment de sa position. La frontière fiable entre œuvres
// est le label « Instrumentation (hors extra) : » ; le titre d'une œuvre est le
// texte libre accumulé juste avant.

// « Instrumentation » ouvre une nouvelle œuvre ; les autres labels s'y ajoutent.
const WORK_BOUNDARY = "Instrumentation (hors extra) :"
const FIELD_LABELS = [
  [WORK_BOUNDARY, "instrumentation"],
  ["Remarques :", "remarques"],
  ["Remarques cordes :", "remarques"],
  ["Percussions (detail) :", "percussions"],
  ["Percussions (détail) :", "percussions"],
  ["Claviers (detail) :", "claviers"],
  ["Claviers (détail) :", "claviers"],
  ["Extra :", "extra"],
  ["Détail :", "detail"],
  ["Note :", "note"],
]

// Rôles reconnus dans la distribution ("Prénom NOM, rôle")
const ROLE_WORDS =
  /soprano|mezzo|contralto|ténor|tenor|baryton|basse|récitant|violon|alto\b|violoncelle|contrebasse|flûte|hautbois|clarinette|basson|\bcor\b|trompette|trombone|tuba|harpe|piano|percussion|orgue|saxophone|chœur|choeur|clavecin|guitare|accordéon|voice|voix|vocalist|keyboard|bass|drums|chant|comédien|narrat|solo|direction/i
// Rôles techniques exclus de la liste des solistes (conventions du fichier existant)
const TECH_ROLES = /chef·?fe de chant|conseiller artistique|ingénieur du son|direction artistique|assistant·?e?$/i
// Rôles de production/staff : ni solistes, ni titre d'œuvre (la ligne est jetée)
const NONSOLIST_ROLES =
  /^(présentation|mise en (scène|espace)|chorégraph|conseiller artistique|direction artistique|ingénieur du son|chef·?fe de chant|texte\b|arrangements?\b|orchestration|vidéo|image et son|intervenant artistique|raccord|décors|costumes|lumières|scénographie|dramaturgie)/i
// Un nom de personne (suite de ≥2 capitales) ou d'ensemble (Motet, Chœur…)
const NAME_LIKE = (name) =>
  /(^|[ '’-])\p{Lu}{2,}/u.test(name) || /\b(Chœur|Choeur|Ensemble|Orchestre|Maîtrise|Motet|Chorus|Choir)\b/.test(name)

function fmtWorkDuration(s) {
  const [h, m] = s.split(".").map(Number)
  if (h === 0 && m === 0) return null
  return h > 0 ? `≈ ${h} h ${String(m).padStart(2, "0")}` : `≈ ${m} min`
}

function fmtTotalDuration(s) {
  const [h, m] = s.split(":").map(Number)
  if (h === 0 && m === 0) return null
  return h > 0 ? `≈ ${h} h ${String(m).padStart(2, "0")}` : `≈ ${m} min`
}

// "1 Claude DEBUSSY" ou "2 FINALISTE 1 DU CONCOURS 3 FINALISTE 2 DU CONCOURS…"
// (plusieurs entrées peuvent être fusionnées sur une ligne par la mise en colonnes)
function parseComposerRun(line) {
  const m = line.match(/^(\d+) (.*)$/)
  if (!m) return null
  let n = parseInt(m[1], 10)
  let rest = m[2]
  const out = []
  for (;;) {
    const sep = ` ${n + 1} `
    const idx = rest.indexOf(sep)
    if (idx === -1) {
      out.push([n, rest.trim()])
      break
    }
    out.push([n, rest.slice(0, idx).trim()])
    rest = rest.slice(idx + sep.length)
    n += 1
  }
  const valid = out.every(
    ([, name]) =>
      name.length >= 2 &&
      name.length <= 60 &&
      // nom en capitales (CILEA) ou placeholder compositeur non défini (N.N.)
      (/\p{Lu}{2,}/u.test(name) || /^N\.?N\.?\d*$/.test(name.trim())) &&
      !name.includes(" : "),
  )
  return valid ? out : null
}

function parseSection(body) {
  const prod = {}
  const composerByNum = new Map() // n° de position programme → compositeur
  const works = []
  const solistes = []
  let titleBuffer = [] // texte libre : titre de la prochaine œuvre (ou programme MDC)
  let cur = null
  let curField = null

  const pushWork = () => {
    if (cur && (cur.titre || Object.keys(cur).length > 1)) works.push(cur)
    cur = null
    curField = null
  }

  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    if (!line) {
      curField = null
      continue
    }
    // artefacts de mise en page et rappels sans valeur ajoutée
    if (/^\d+$/.test(line)) continue
    if (/^Edité le \d{2}\/\d{2}\/\d{4}/.test(line)) continue
    if (/^Page \d+ sur \d+$/.test(line)) continue
    if (/^Période \d+ du .* au .*$/.test(line)) continue
    if (/^Saison \d{4}\/\d{2}$/.test(line)) continue
    if (/\d{2}-\d{2}-\d{4} \d{2}:\d{2}/.test(line)) continue // lignes horaires (OGP, abo, représentations…)
    if (/^[\d\s\/.\-]+$/.test(line) && !/^\d{2}\.\d{2}$/.test(line)) continue // artefacts numériques de colonnes (mais pas les durées "NN.NN")
    if (/^Entracte$/i.test(line)) continue
    if (/^Bis$/i.test(line)) continue // annotation « Bis » (rappel) sans valeur de titre
    if (/^[,:]/.test(line)) continue // fragment de distribution à nom vide ("… : NOM", ", rôle")
    if (/^(Arrangement|Orchestration|Adaptation|Transcription|Réduction|Mention obligatoire)[^:]{0,40} ?:/.test(line)) continue
    if (/^(Solistes?|Chœur|Choeur|Récitant)[^:]{0,40} : \S/.test(line)) continue // rappels de distribution
    if (/^[a-zàâäéèêëîïôöûüç][^:]{1,40} : \S/.test(line)) continue // "saxophone alto : Valentine MICHAUD"
    if (/(^| - )[a-zàâäéèêëîïôöûüç][^:]{0,30} : \p{Lu}/u.test(line)) continue // fragments de distribution repliés

    // fin de la partie programme
    const eff = line.match(/^Effectif max (\d+) musiciens : (.+)$/)
    if (eff) {
      pushWork()
      if (eff[1] !== "0") prod.effectif = `${eff[2].trim()} (${eff[1]} musiciens)`
      continue
    }
    const tot = line.match(/^Durée totale approximative : (\d{2}:\d{2}) h$/)
    if (tot) {
      const d = fmtTotalDuration(tot[1])
      if (d) prod.duree = d
      continue
    }
    if (line === "DATE") {
      pushWork()
      break // table des services : rien d'utile ensuite dans cette fiche
    }
    // mot isolé tout en capitales : fragment de nom scindé par la mise en colonnes
    // (ex. « Lucas HENRY » coupé → « HENRY ») ; jamais un titre d'œuvre.
    if (/^[A-ZÀ-Ý][A-ZÀ-Ý'’-]{2,}$/.test(line)) continue

    // blocs d'information générale (avec leurs lignes de continuation, jusqu'à
    // une ligne vide ou une ligne clairement structurée)
    if (/^(Information générale|Services annuels|Services :|Tenue :|Disposition|Set-list)/.test(line)) {
      curField = null
      let j = i + 1
      while (
        j < body.length &&
        body[j] &&
        !/^(Services|Tenue :|Disposition)/.test(body[j]) &&
        !FIELD_LABELS.some(([label]) => body[j].startsWith(label)) &&
        !parseComposerRun(body[j])
      )
        j++
      i = j - 1
      continue
    }
    if (/^du \d/.test(line) && /\d{4}$/.test(line)) continue // "du 15 au 27 août 2026"

    // chef (n'importe où dans la fiche)
    const dir = line.match(/^(.{2,60}?), direction musicale(.*)$/)
    if (dir) {
      // suffixe de colonnes " - 2" et annotation parenthétique " (et présentation)"
      // retirés (le fichier de référence ne conserve que le nom)
      if (!prod.chef)
        prod.chef = (dir[1] + (dir[2] || ""))
          .replace(/\s+-\s+[\d ]+$/, "")
          .replace(/\s*\([^)]*\)\s*$/, "")
          .trim()
      continue
    }

    // compositeurs numérotés
    const run = parseComposerRun(line)
    if (run) {
      for (const [n, name] of run) if (!composerByNum.has(n)) composerByNum.set(n, name)
      continue
    }

    // labels de champ d'une œuvre
    const field = FIELD_LABELS.find(([label]) => line.startsWith(label))
    if (field) {
      // Seule « Instrumentation » ouvre une œuvre. Un champ secondaire (Note,
      // Détail…) rencontré alors qu'aucune œuvre n'est ouverte est un orphelin
      // (continuation d'une œuvre déjà close) : on l'ignore plutôt que de créer
      // une œuvre fantôme à partir du texte libre resté en buffer.
      if (line.startsWith(WORK_BOUNDARY)) {
        pushWork()
        cur = { titre: titleBuffer.join(" ").trim() }
        titleBuffer = []
      } else if (!cur) {
        continue
      }
      const val = line.slice(field[0].length).trim()
      if (!(field[1] === "instrumentation" && /^[0.\/ ]+$/.test(val))) cur[field[1]] = val
      curField = field[1]
      continue
    }

    // durée d'œuvre "02.50"
    if (/^\d{2}\.\d{2}$/.test(line)) {
      const d = fmtWorkDuration(line)
      const target = cur || works.find((w) => !w.duree)
      if (target && d) target.duree = d
      if (cur) pushWork()
      titleBuffer = [] // les orphelins précédant la prochaine œuvre sont jetés
      continue
    }

    // distribution : "Prénom NOM, rôle" (le rôle appartient au vocabulaire musical)
    const sol = line.match(/^([^:]{2,60}), ([^:]{2,80})$/)
    if (sol && NAME_LIKE(sol[1])) {
      // lignes de production (mise en scène, texte, vidéo…) : ni soliste ni titre
      if (NONSOLIST_ROLES.test(sol[2])) continue
      if (ROLE_WORDS.test(sol[2]) && !TECH_ROLES.test(sol[2])) {
        // suffixe de colonnes " - 1 3 5" (n° de mouvements) retiré
        solistes.push(line.replace(/\s+-\s+[\d ]+$/, "").trim())
        continue
      }
    }

    // continuation d'un champ multiligne (jamais une ligne qui ressemble à un
    // titre : les continuations commencent par un tiret, une minuscule, etc.)
    if (
      cur &&
      curField &&
      ["detail", "note", "remarques", "percussions", "extra"].includes(curField) &&
      /^[-•(/a-zàâäéèêëîïôöûüç0-9«"']/.test(line)
    ) {
      cur[curField] += "\n" + line
      continue
    }

    // sinon : texte libre → titre de la prochaine œuvre (ou programme MDC).
    // Les annotations orphelines restent dans le buffer et sont jetées en fin
    // de fiche si aucune œuvre ne les réclame.
    titleBuffer.push(line)
    curField = null
  }
  pushWork()

  // fiches sans blocs d'œuvres labellisés (MDC…) : le texte libre devient l'œuvre
  if (!works.length && titleBuffer.length) works.push({ titre: titleBuffer.join(" ").trim() })

  // Compositeurs triés par n° de position programme (les entractes portent un
  // n° nu sans nom → absents de la Map, donc pas de décalage) puis appariés aux
  // œuvres dans l'ordre du document.
  const composersByOrder = [...composerByNum.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
  prod.works = works.map((w, idx) => {
    const out = {}
    out.oeuvre = composersByOrder[idx] ? `${composersByOrder[idx]} — ${w.titre}` : w.titre
    for (const f of ["instrumentation", "remarques", "percussions", "claviers", "extra", "detail", "note", "duree"])
      if (w[f]) out[f] = w[f]
    return out
  })
  if (solistes.length) prod.solistes = solistes
  return prod
}

function parseMemoText(text) {
  const knownListes = new Set(JSON.parse(readFileSync(planningPath, "utf8")).events.map((e) => e.liste))
  // Canonicalise un titre de fiche du PDF vers le nom de liste du planning.
  const canonicalKey = (line) => {
    const l = line.trim()
    if (knownListes.has(l)) return l
    const mdc = l.match(/^MDC(\d+)\b/)
    if (mdc) return `Musique De Chambre ${mdc[1]}`
    const short = l.match(
      /^(Liste \S+|Concours à définir|Doudou Concert \d+|Concerts pour Petites Oreilles \d+|Projet \d+|Accueil \d+|Atelier Découverte \S+)/,
    )
    if (short && knownListes.has(short[1])) return short[1]
    return null
  }

  const lines = text.split("\n").map((l) => l.trim())

  // Découpage en fiches : un titre canonicalisable qui suit une ligne "Saison 20xx/xx"
  const sections = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^Saison \d{4}\/\d{2}$/.test(lines[i])) continue
    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      if (!lines[j]) continue
      const key = canonicalKey(lines[j])
      if (key) sections.push({ key, start: j + 1 })
      break // seule la première ligne non vide compte
    }
  }

  const result = {}
  for (let s = 0; s < sections.length; s++) {
    const end = s + 1 < sections.length ? sections[s + 1].start - 3 : lines.length
    const prod = parseSection(lines.slice(sections[s].start, end))
    const hasContent =
      prod.chef || prod.effectif || (prod.works && prod.works.length) || (prod.solistes && prod.solistes.length)
    if (!hasContent) continue
    if (result[sections[s].key]) continue
    result[sections[s].key] = prod
  }
  return result
}

// --- Main ------------------------------------------------------------------------

const textArg = process.argv[2]
const memoText = textArg ? readFileSync(textArg, "utf8") : await generateMemoPdfText()
const parsed = parseMemoText(memoText)

if (Object.keys(parsed).length < 20)
  throw new Error(`Seulement ${Object.keys(parsed).length} fiches parsées — mémo incomplet ou structure changée ?`)

const previous = existsSync(productionsPath) ? JSON.parse(readFileSync(productionsPath, "utf8")) : {}
const output = {
  _lisezmoi:
    "Ce fichier est GÉNÉRÉ par scripts/update-memo.mjs à partir du « Mémo de Production » du mini-site Dièse (ne pas éditer à la main). Il complète le planning avec les infos absentes de l'export ICS : chef, solistes, œuvres au programme et détail d'instrumentation (abréviations du mémo conservées telles quelles). Une entrée par programme ; la clé est le nom exact du champ « liste » du planning (ex. « Liste 01 », « Musique De Chambre 1 »). Champs, tous optionnels : « chef », « solistes » ([« Nom, rôle »]), « effectif », « duree », et « works » ([{ oeuvre : « Compositeur — Titre », instrumentation, remarques, percussions, claviers, extra, detail, note, duree }]). Les clés commençant par « _ » sont ignorées par l'app.",
}
for (const [k, v] of Object.entries(parsed)) output[k] = v

const withoutMeta = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== "_lisezmoi")))
const changed = withoutMeta(previous) !== withoutMeta(output)

if (!changed) {
  console.log(`Aucun changement du mémo (${Object.keys(parsed).length} fiches). Fichier inchangé.`)
  process.exit(0)
}

writeFileSync(productionsPath, JSON.stringify(output, null, 1) + "\n")
console.log(`productions.json mis à jour : ${Object.keys(parsed).length} fiches.`)
