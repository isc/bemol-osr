#!/usr/bin/env node
// Captures d'écran de l'app (état du dépôt local), pour illustrer les PRs.
//
// Sert le dépôt sur un port local puis capture, dans un vrai navigateur :
//   <prefixe>-mobile-grille.png / -mobile-agenda.png   (390×844)
//   <prefixe>-desktop-grille.png                        (1280×900)
//
// Usage :  node scripts/screenshots.mjs [dossier-de-sortie] [prefixe]
//          (par défaut : ./screenshots, « app »)
// Prérequis : `npm install --no-save playwright` (comme le smoke test).
//
// Voir la section « Captures d'écran dans les PRs » de CLAUDE.md pour la
// publication sur la branche `pr-assets` et l'intégration en description.

import { createServer } from "node:http"
import { mkdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const outDir = process.argv[2] || join(ROOT, "screenshots")
const prefix = process.argv[3] || "app"

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ics": "text/calendar; charset=utf-8",
}

// Même mini serveur statique zéro dépendance que scripts/smoke-test.mjs.
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

const { chromium } = await import("playwright")
const server = await startServer()
const base = `http://127.0.0.1:${server.address().port}/`
const browser = await chromium
  .launch({ channel: "chrome" })
  .catch(() => chromium.launch())

mkdirSync(outDir, { recursive: true })
const shots = []

for (const [device, viewport] of [
  ["mobile", { width: 390, height: 844 }],
  ["desktop", { width: 1280, height: 900 }],
]) {
  const page = await browser.newPage({ viewport })
  await page.goto(base, { waitUntil: "load" })
  await page.waitForSelector("#loading", { state: "detached", timeout: 15000 })
  const views = device === "mobile" ? ["grille", "agenda"] : ["grille"]
  for (const view of views) {
    await page.click(`#view-nav button[data-view="${view}"]`)
    await page.waitForTimeout(400)
    const file = join(outDir, `${prefix}-${device}-${view}.png`)
    await page.screenshot({ path: file })
    shots.push(file)
  }
  await page.close()
}

await browser.close()
server.close()
console.log(shots.join("\n"))
