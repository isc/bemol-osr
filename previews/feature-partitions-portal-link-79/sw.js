// Bémol · Planning OSR — service worker
//
// Rôle : rendre l'app installable (écran d'accueil) et consultable même sans
// connexion, sans jamais masquer les nouveautés quand on est en ligne.
//
// Stratégies selon le type de requête :
//   - Navigation (la page) → réseau d'abord, repli sur la version en cache.
//     Ainsi une nouvelle version d'index.html (nouveau ?v=…) est prise en
//     compte dès qu'on a du réseau ; hors-ligne, on ouvre la dernière connue.
//   - Données JSON (data/*.json, productions.json) → réseau d'abord, repli sur
//     le dernier JSON téléchargé. Le planning reste donc frais en ligne et
//     reste consultable hors-ligne. On ignore le suffixe anti-cache « ?t=… »
//     ajouté par app.js pour ne garder qu'une seule copie par fichier.
//   - Ressources statiques (app.js, style.css, icônes, manifeste) → cache
//     immédiat puis rafraîchissement en tâche de fond. Ces fichiers sont
//     versionnés par « ?v=… » dans index.html : un changement de version = une
//     nouvelle URL = un nouveau téléchargement automatique.
//
// Incrémenter CACHE_VERSION pour purger entièrement les caches d'une ancienne
// version (rarement nécessaire, le versionnage par URL suffit en général).

const CACHE_VERSION = "v1"
const CACHE = `bemol-${CACHE_VERSION}`

// Fichiers pré-chargés dès l'installation pour un premier lancement hors-ligne.
// app.js / style.css sont mis en cache au premier passage en ligne (leur URL
// porte un ?v=… qu'on ne veut pas figer ici).
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  if (req.method !== "GET") return

  const url = new URL(req.url)
  // On ne gère que les requêtes de notre propre site (jamais les liens externes).
  if (url.origin !== self.location.origin) return

  if (req.mode === "navigate") {
    event.respondWith(navigationHandler(req))
    return
  }

  if (/\.json$/.test(url.pathname)) {
    event.respondWith(dataHandler(req, url))
    return
  }

  event.respondWith(staleWhileRevalidate(req))
})

// Navigation : réseau d'abord, repli sur la page en cache.
async function navigationHandler(req) {
  const cache = await caches.open(CACHE)
  try {
    const resp = await fetch(req)
    cache.put(req, resp.clone())
    return resp
  } catch {
    return (
      (await cache.match(req)) ||
      (await cache.match("./index.html")) ||
      (await cache.match("./")) ||
      Response.error()
    )
  }
}

// Données : réseau d'abord, repli sur la dernière copie. Clé normalisée sans
// query string pour ne pas multiplier les copies à cause du « ?t=… ».
async function dataHandler(req, url) {
  const cache = await caches.open(CACHE)
  const key = url.origin + url.pathname
  try {
    const resp = await fetch(req)
    if (resp.ok) cache.put(key, resp.clone())
    return resp
  } catch {
    const cached = await cache.match(key)
    if (cached) return cached
    return Response.error()
  }
}

// Ressources statiques : on sert le cache tout de suite et on rafraîchit après.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(req)
  const network = fetch(req)
    .then((resp) => {
      if (resp.ok) cache.put(req, resp.clone())
      return resp
    })
    .catch(() => cached)
  return cached || network
}
