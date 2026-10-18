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
//     nouvelle URL = un nouveau téléchargement automatique. Le cache ne garde
//     que la dernière version de chaque fichier.
//
// Seule une réponse valide (200) entre en cache : pendant un build GitHub
// Pages bloqué, la page répond 404 un moment, et cette 404 remplaçait la page
// en cache, que l'app installée affichait ensuite même hors-ligne.
//
// Incrémenter CACHE_VERSION pour purger entièrement les caches d'une ancienne
// version (rarement nécessaire, le versionnage par URL suffit en général).

const CACHE_VERSION = "v1"
const CACHE = `bemol-${CACHE_VERSION}`

// Fichiers pré-chargés dès l'installation pour un premier lancement hors-ligne.
// app.js / style.css (dont l'URL porte un ?v=… qu'on ne veut pas figer ici) et
// les données, déjà chargés par la page à sa première visite, sont mis en
// cache à sa demande (message « cache-urls », cf. app.js).
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

  // Requête qui demande expressément le serveur (checkAppUpdate d'app.js, qui
  // compare la version publiée à celle affichée) : on ne s'interpose pas.
  if (req.cache === "no-cache") return

  if (isData(url)) {
    event.respondWith(networkFirst(req, cacheKey(url)))
    return
  }

  event.respondWith(staleWhileRevalidate(req))
})

const isData = (url) => /\.json$/.test(url.pathname)

// Clé de cache d'une URL. Les données sont rangées sans query string, pour ne
// pas multiplier les copies à cause du « ?t=… » anti-cache d'app.js.
function cacheKey(url) {
  return isData(url) ? url.origin + url.pathname : url.href
}

// Met une réponse en cache sous `key`. Pour un fichier versionné (« ?v=… »
// d'app.js et de style.css, changé à chaque déploiement), on retire les autres
// versions : le cache gagnait sinon ~220 Ko par déploiement.
async function cachePut(cache, key, resp) {
  if (new URL(key, self.location.href).searchParams.has("v"))
    await cache.delete(key, { ignoreSearch: true })
  return cache.put(key, resp)
}

// Navigation : réseau d'abord, repli sur la page en cache. « no-cache » fait
// revalider la page auprès du serveur : GitHub Pages la sert avec
// « max-age=600 », et sans cela le cache HTTP du navigateur renvoyait jusqu'à
// 10 minutes l'ancienne page (donc l'ancien app.js) après une mise à jour.
function navigationHandler(req) {
  return networkFirst(req, req.url, ["./index.html", "./"], {
    cache: "no-cache",
  })
}

// Réseau d'abord : une réponse valide est mise en cache et servie ; sinon
// (hors-ligne, ou 404/5xx), la dernière copie valide (sous `key`, puis sous
// `fallbackKeys`), et l'erreur du serveur seulement en dernier recours.
async function networkFirst(req, key, fallbackKeys = [], init) {
  const cache = await caches.open(CACHE)
  let resp
  try {
    resp = await fetch(req, init)
    if (resp.ok) {
      cachePut(cache, key, resp.clone())
      return resp
    }
  } catch {
    // hors-ligne : repli ci-dessous
  }
  for (const k of [key, ...fallbackKeys]) {
    const cached = await cache.match(k)
    if (cached) return cached
  }
  return resp || Response.error()
}

// Ressources statiques : on sert le cache tout de suite et on rafraîchit après.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(req)
  const network = fetch(req)
    .then((resp) => {
      if (resp.ok) cachePut(cache, req.url, resp.clone())
      return resp
    })
    .catch(() => cached)
  return cached || network
}

// Première visite : la page s'est chargée avant que le service worker ne la
// contrôle, donc sans rien mettre en cache hormis PRECACHE. Le premier
// lancement hors-ligne restait blanc (ni app.js?v=…, ni style.css, ni
// données). La page envoie donc les adresses de ce qu'elle a chargé, que l'on
// range comme si on les avait servies ; le cache HTTP du navigateur les fournit
// sans second téléchargement.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-urls") return
  event.waitUntil(cacheUrls(event.data.urls))
})

async function cacheUrls(urls) {
  const cache = await caches.open(CACHE)
  await Promise.all(
    urls.map(async (u) => {
      const url = new URL(u)
      if (!url.href.startsWith(self.registration.scope)) return
      try {
        const resp = await fetch(url)
        if (resp.ok) await cachePut(cache, cacheKey(url), resp)
      } catch {
        // hors-ligne entre-temps : ce sera pour le prochain passage
      }
    }),
  )
}

// --- Notifications push ------------------------------------------------------
//
// Le worker Cloudflare (worker/src/index.js, cron) envoie une notification
// groupée par abonné concerné, avec pour charge utile { title, body, url }
// (url : lien profond vers la Liste unique concernée, ou racine si plusieurs
// listes sont touchées — cf. worker/src/notify.js:buildNotificationPayload).

self.addEventListener("push", (event) => {
  let payload = { title: "Bémol", body: "Le planning a changé." }
  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    // charge utile absente/illisible : on garde le message générique ci-dessus
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: { url: payload.url || "./" },
    }),
  )
})

// Un clic ramène sur un onglet déjà ouvert de l'app (et le navigue vers le
// lien profond) plutôt que d'en ouvrir un nouveau à chaque fois. Seulement un
// onglet que ce service worker contrôle : isc.github.io sert aussi d'autres
// apps et les previews, et navigate() refuse leurs onglets (rien ne s'ouvrait
// alors). À défaut, on en ouvre un nouveau.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || "./", self.location.href)
    .href
  event.waitUntil(
    (async () => {
      for (const client of await self.clients.matchAll({ type: "window" })) {
        try {
          await client.navigate(url)
          return client.focus()
        } catch {
          // onglet en train de se fermer… : au suivant
        }
      }
      return self.clients.openWindow(url)
    })(),
  )
})
