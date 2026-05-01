// My Raver Life service worker
// Cache-first strategy: works fully offline after first load.
// Bump CACHE_VERSION whenever index.html or artists.json changes
// so old caches get evicted on next visit.

const CACHE_VERSION = 'myraverlife-v4';
const APP_SHELL = [
  './',
  './index.html',
  './festival.config.js',
  './assets/artists.json',
  './assets/map.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Only handle same-origin requests
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline + uncached: for navigation requests, fall back to index.html
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          throw new Error('offline and not in cache');
        });
    })
  );
});
