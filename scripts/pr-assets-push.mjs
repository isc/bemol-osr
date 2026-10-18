#!/usr/bin/env node
// Publie des captures d'écran sur la branche pr-assets en un seul appel
// (fetch, worktree temporaire, copie dans pr/<numéro>/, commit, push,
// nettoyage) et affiche les URL à coller dans la description de la PR. C'est
// la voie des workflows Claude, où `gh … --attach` est refusé : cf. CLAUDE.md,
// « Captures d'écran dans les PRs ».
//
// Usage :  node scripts/pr-assets-push.mjs <numéro-de-PR> <capture>…
//
// - Ne supprime ni ne remplace rien : si une capture du même nom existe déjà
//   dans pr/<numéro>/, rien n'est envoyé (les caches de raw et des
//   navigateurs serviraient l'ancienne). Nouvelle version = nouveau nom.
// - Fetch en --depth 1 seulement si le dépôt est déjà superficiel (checkout
//   des Actions) : sur un clone complet, --depth 1 le rendrait superficiel.
// - Si pr-assets a bougé entre le fetch et le push (autre PR), recommence.

import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = "isc/bemol-osr"
const BRANCH = "pr-assets"
const REF = `refs/remotes/origin/${BRANCH}`
const ROOT = fileURLToPath(new URL("..", import.meta.url))

const [pr, ...files] = process.argv.slice(2)
if (!/^\d+$/.test(pr ?? "") || !files.length) {
  console.error(
    "Usage : node scripts/pr-assets-push.mjs <numéro-de-PR> <capture>…",
  )
  process.exit(2)
}

const git = (args, cwd = ROOT) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

const shallow = git(["rev-parse", "--is-shallow-repository"]) === "true"
const fetchAssets = () =>
  git([
    "fetch",
    "-q",
    ...(shallow ? ["--depth", "1"] : []),
    "origin",
    `+refs/heads/${BRANCH}:${REF}`,
  ])

const worktree = mkdtempSync(join(tmpdir(), "pr-assets-"))
const dest = join(worktree, "pr", pr)

try {
  const names = files.map((f) => basename(f))
  for (const f of files)
    if (!existsSync(f) || !statSync(f).isFile())
      throw new Error(`${f} : fichier introuvable.`)
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) throw new Error(`deux captures s'appellent ${dup}.`)

  fetchAssets()
  git(["worktree", "add", "-q", "--detach", worktree, REF])
  for (let attempt = 1; ; attempt++) {
    const taken = names.filter((n) => existsSync(join(dest, n)))
    if (taken.length)
      throw new Error(
        `déjà sur ${BRANCH}, dans pr/${pr}/ : ${taken.join(", ")}. ` +
          "Rien n'est envoyé : donner un nouveau nom à chaque version.",
      )
    mkdirSync(dest, { recursive: true })
    files.forEach((f, i) => copyFileSync(f, join(dest, names[i])))
    git(["add", "-f", join("pr", pr)], worktree)
    git(
      ["commit", "-q", "--no-verify", "-m", `assets: captures PR #${pr}`],
      worktree,
    )
    try {
      git(["push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`], worktree)
      break
    } catch (e) {
      if (attempt === 3 || !/fetch first|non-fast-forward/.test(e.stderr))
        throw e
      console.error(`${BRANCH} a bougé entre-temps, nouvel essai…`)
      fetchAssets()
      git(["reset", "-q", "--hard", REF], worktree)
    }
  }

  for (const n of names)
    console.log(
      `https://raw.githubusercontent.com/${REPO}/${BRANCH}/pr/${pr}/${encodeURIComponent(n)}?v=1`,
    )
  console.error(
    `✓ Publié sur ${BRANCH}. Une fois la description éditée : ` +
      `node scripts/pr-images-check.mjs ${pr}`,
  )
} catch (e) {
  console.error(`✗ ${e.stderr?.trim() || e.message}`)
  process.exitCode = 1
} finally {
  // Échoue si le worktree n'a pas été créé : rien à retirer, alors.
  try {
    git(["worktree", "remove", "--force", worktree])
  } catch {}
  rmSync(worktree, { recursive: true, force: true })
}
