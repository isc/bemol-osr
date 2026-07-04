#!/usr/bin/env node
// Smoke test de l'application : charge la page dans un vrai navigateur et
// vérifie que les trois vues s'affichent sans aucune erreur JavaScript.
//
// C'est le garde-fou de la CI : le site n'a pas de build ni de tests unitaires,
// donc la seule façon de casser la prod est de merger un app.js/index.html
// défectueux — exactement ce que ce script détecte en ~15 secondes.
//
// Usage : node scripts/smoke-test.mjs
// Prérequis : le paquet npm `playwright` résolvable depuis le dépôt
// (en CI : `npm install --no-save playwright`). Le script utilise le Chrome
// installé sur la machine (channel "chrome"), et se rabat sur le Chromium
// bundlé de Playwright s'il n'y en a pas.

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ics": "text/calendar; charset=utf-8",
}

// Mini serveur statique zéro dépendance (le projet n'a pas de package.json).
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, "http://x").pathname)
      if (path.endsWith("/")) path += "index.html"
      const file = normalize(join(ROOT, path))
      if (!file.startsWith(ROOT)) throw new Error("hors racine")
      const body = await readFile(file)
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end("introuvable")
    }
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

async function launchBrowser(chromium) {
  try {
    // Chrome de la machine (préinstallé sur les runners GitHub) : évite de
    // télécharger un navigateur à chaque run de CI.
    return await chromium.launch({ channel: "chrome" })
  } catch {
    return await chromium.launch()
  }
}

const { chromium } = await import("playwright")
const server = await startServer()
const base = `http://127.0.0.1:${server.address().port}/`
const browser = await launchBrowser(chromium)
const page = await browser.newPage()

// La moindre erreur JavaScript (exception ou console.error) fait échouer le
// test : sur un site sans build, c'est le symptôme d'une prod cassée.
const errors = []
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`))
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`)
})

let failed = false
try {
  await page.goto(base, { waitUntil: "load" })

  // Le chargement des données remplace le paragraphe « Chargement… ».
  await page.waitForSelector("#loading", { state: "detached", timeout: 15000 })

  for (const view of ["grille", "agenda", "modifs"]) {
    await page.click(`#view-nav button[data-view="${view}"]`)
    // Chaque vue doit produire du contenu dans <main>.
    await page.waitForFunction(
      () => document.getElementById("main").children.length > 0,
      { timeout: 5000 },
    )
    console.log(`✓ vue ${view} affichée`)
  }
} catch (err) {
  failed = true
  console.error(`✗ ${err.message}`)
}

await browser.close()
server.close()

if (errors.length) {
  failed = true
  console.error(`✗ ${errors.length} erreur(s) JavaScript détectée(s) :`)
  for (const e of errors) console.error(`  - ${e}`)
}

if (failed) process.exit(1)
console.log("✓ Smoke test réussi : aucune erreur JavaScript")
