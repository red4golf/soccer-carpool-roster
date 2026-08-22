// Service worker: makes the board installable and survivable on a bad signal.
//
// PRIVACY DECISION: API responses are never cached. The shell (HTML, CSS, JS,
// icons) is cached so the app opens instantly and still renders without a
// connection, but roster data — children's names, pickup areas, who is in
// whose car — is deliberately left in memory only. Writing it into the Cache
// API would persist other families' details on the device after the tab is
// closed, which is not a trade a carpool board should make silently.

const VERSION = 'carpool-shell-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/api.js',
  './js/util.js',
  './js/ui.js',
  './js/coordinator.js',
  './manifest.webmanifest',
  './icon.svg',
  './offline.html',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch the API or the auth provider — always straight to network,
  // and never stored.
  if (url.pathname.startsWith('/api/') || url.hostname.endsWith('googleapis.com')) return;

  // Navigations: network first so a deployed update is picked up promptly,
  // falling back to the cached shell and then to a plain offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(VERSION).then(cache => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then(hit => hit || caches.match('./offline.html'))),
    );
    return;
  }

  // Application code (JS/CSS): network first, cache only as an offline
  // fallback.
  //
  // Cache-first is wrong here. It served a stale app.js for a full load after
  // a deploy — caught in testing, where the UI kept rendering the previous
  // build against an already-updated API. A parent would have run last week's
  // code until they happened to open the app twice. Freshness of the app
  // itself is worth one network round trip; offline still works because we
  // fall back to the cached copy.
  const isAppCode = /\.(?:js|css)$/.test(url.pathname) && url.origin === self.location.origin;
  if (isAppCode) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Everything else (icons, manifest, fonts): cache first, refresh behind.
  event.respondWith(
    caches.match(request).then(hit => {
      const network = fetch(request)
        .then(response => {
          if (response.ok && url.origin === self.location.origin) {
            const copy = response.clone();
            caches.open(VERSION).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
