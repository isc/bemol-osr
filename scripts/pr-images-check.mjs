#!/usr/bin/env node
// Vérifie que les images d'une description de PR s'affichent réellement en
// entier sur GitHub — et les répare sinon.
//
// Les images des descriptions (hébergées sur la branche pr-assets, servies
// par raw.githubusercontent.com) peuvent être servies tronquées ou périmées :
// le CDN de raw met en cache ~5 min (et ignore la query string dans sa clé —
// impossible de le contourner par l'URL), et le cache d'images du NAVIGATEUR
// du relecteur peut garder une version cassée bien plus longtemps (persiste
// au rechargement ; le clic sur l'image, lui, revalide — d'où le symptôme
// « tronquée en ligne, complète au clic »). Ce script compare, pour chaque
// image de la PR, ce que sert l'URL affichée avec la taille réelle du fichier
// (API GitHub contents) : au moindre écart, il ré-écrit l'URL avec un suffixe
// ?v=N+1 dans la description (nouvelle URL → les navigateurs re-téléchargent)
// et attend que le CDN converge.
//
// Usage :  node scripts/pr-images-check.mjs <numéro-de-PR>
// Prérequis : gh authentifié (pour gh pr view/edit). Jusqu'à 5 tours.

import { execFileSync } from "node:child_process"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pr = process.argv[2]
if (!pr) {
  console.error("Usage : node scripts/pr-images-check.mjs <numéro-de-PR>")
  process.exit(2)
}

const REPO = "isc/bemol-osr"
const gh = (...args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1e8 })

const fetchBytes = async (url) => {
  const r = await fetch(url, { redirect: "follow" })
  if (!r.ok) return null
  return (await r.arrayBuffer()).byteLength
}

// Taille de référence : l'API contents (source de vérité, hors CDN — le CDN
// de raw ignore la query string dans sa clé de cache, impossible de le
// contourner par l'URL).
const realBytes = async (rawUrl) => {
  const path = rawUrl.split("/pr-assets/")[1].split("?")[0]
  try {
    return Number(
      gh(
        "api",
        `repos/${REPO}/contents/${path}?ref=pr-assets`,
        "--jq",
        ".size",
      ),
    )
  } catch {
    return null
  }
}

// URLs d'images telles que rendues dans la page publique de la PR (raw
// direct pour les assets du dépôt, Camo pour les hôtes externes).
async function imageUrls() {
  const html = await (
    await fetch(`https://github.com/${REPO}/pull/${pr}`)
  ).text()
  return [
    ...html.matchAll(
      /<img src="(https:\/\/(?:raw|camo)\.githubusercontent\.com\/[^"]+)"/g,
    ),
  ]
    .map(([, u]) => u.replace(/&amp;/g, "&"))
    .filter((u) => u.includes("pr-assets") || u.includes("camo"))
}

for (let round = 1; round <= 5; round++) {
  const urls = await imageUrls()
  if (!urls.length) {
    console.log("Aucune image trouvée dans la description.")
    process.exit(0)
  }

  const broken = []
  for (const url of urls) {
    const name = url.split("/").pop().split("?")[0]
    // Ce que sert le CDN (comme un navigateur) vs la vraie taille du fichier.
    const [served, real] = await Promise.all([fetchBytes(url), realBytes(url)])
    if (real !== null && served === real)
      console.log(`  ✓ ${name} (${real} octets)`)
    else {
      console.log(
        `  ✗ ${name} — servie=${served ?? "404"} / réelle=${real ?? "?"}`,
      )
      broken.push(url)
    }
  }
  if (!broken.length) {
    console.log(`✓ PR #${pr} : toutes les images s'affichent en entier.`)
    process.exit(0)
  }

  // Le cache CDN expire tout seul (max-age 300 s) ; le bump ?v=N+1 corrige les
  // caches NAVIGATEUR des relecteurs (qui, eux, n'expirent pas forcément).
  // On ne bump qu'au premier tour, puis on attend l'expiration CDN.
  if (round === 1) {
    console.log(
      `${broken.length} image(s) désynchronisée(s) — bump ?v dans la description…`,
    )
    let body = gh(
      "pr",
      "view",
      pr,
      "-R",
      REPO,
      "--json",
      "body",
      "--jq",
      ".body",
    )
    for (const url of broken) {
      const base = url.split("?")[0]
      const next = ((Number(url.match(/[?&]v=(\d+)/)?.[1]) || 1) + 1).toString()
      body = body.replaceAll(
        new RegExp(
          `${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\?v=\\d+)?`,
          "g",
        ),
        `${base}?v=${next}`,
      )
    }
    const tmp = join(mkdtempSync(join(tmpdir(), "pr-img-")), "body.md")
    writeFileSync(tmp, body)
    gh("pr", "edit", pr, "-R", REPO, "--body-file", tmp)
  }
  console.log(`Tour ${round} : attente de l'expiration du cache CDN (60 s)…`)
  await new Promise((r) => setTimeout(r, 60000))
}

console.error(
  "✗ Des images restent désynchronisées après ~5 min — vérifier à la main.",
)
process.exit(1)
