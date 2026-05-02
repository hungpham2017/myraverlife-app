// My Raver Life service worker
//
// Offline-first: after first online visit, the app must keep working in
// airplane mode / on weak signal at the festival.
//
// Two caches:
//   SHELL_VERSION = HTML/CSS/JS/config/JSON — bumped on every release
//   IMAGES_VERSION = artist avatars (cross-origin CDN images) — sticky, only
//     bumped when we want to re-fetch all artist avatars.
//
// Resilience:
//   - Install uses per-item add() with allSettled so one bad fetch doesn't
//     break the whole install (resilient on weak signal).
//   - Responses are validated before being cached so captive portals can't
//     poison the cache with their HTML.

const SHELL_VERSION  = 'myraverlife-shell-v109';
const IMAGES_VERSION = 'myraverlife-images-v1';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './festival.config.js',
  './assets/artists.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_VERSION).then(async (cache) => {
      // Per-item add so a single failed fetch doesn't fail the entire install.
      // Critical for users on weak signal — we'd rather have a partial cache
      // than no cache at all.
      await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('myraverlife-shell-') && k !== SHELL_VERSION)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Cacheable: a response that's safe to store. Rejects captive-portal pages,
// 404s, and anything obviously wrong.
function cacheable(response) {
  if (!response) return false;
  // Cross-origin images come back as type 'opaque' (status 0) and we can't
  // inspect them — but they're safe to store.
  if (response.type === 'opaque') return true;
  if (response.status !== 200) return false;
  if (response.type === 'error') return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // ── Same-origin ───────────────────────────────────────────────────────
  if (url.origin === self.location.origin) {
    const isDoc = event.request.mode === 'navigate'
                || event.request.destination === 'document'
                || url.pathname.endsWith('.html')
                || url.pathname === '/' || url.pathname.endsWith('/');

    // HTML: network-first so updates reach users on next page load.
    // Falls back to cache when offline.
    if (isDoc) {
      event.respondWith(
        fetch(event.request)
          .then((response) => {
            if (cacheable(response)) {
              const clone = response.clone();
              caches.open(SHELL_VERSION).then((c) => c.put(event.request, clone));
            }
            return response;
          })
          .catch(() => caches.match(event.request).then(c => c || caches.match('./index.html')))
      );
      return;
    }

    // Static assets (JS, CSS, JSON, images, fonts): cache-first.
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request)
          .then((response) => {
            if (cacheable(response)) {
              const clone = response.clone();
              caches.open(SHELL_VERSION).then((c) => c.put(event.request, clone));
            }
            return response;
          })
          .catch(() => { throw new Error('offline and not in cache'); });
      })
    );
    return;
  }

  // ── Cross-origin images (artist avatars + festival map from CloudFront) ─
  // Cache-first so they keep working offline after first online visit.
  if (event.request.destination === 'image') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request)
          .then((response) => {
            if (cacheable(response)) {
              const clone = response.clone();
              caches.open(IMAGES_VERSION).then((c) => c.put(event.request, clone));
            }
            return response;
          })
          .catch(() => new Response('', { status: 504 }));
      })
    );
    return;
  }

  // Everything else cross-origin (fonts, analytics): default browser handling.
});
