// My Raver Life service worker
//
// Offline-first: after first online visit, the app must keep working in
// airplane mode / on weak signal at the festival.
//
// Two caches:
//   SHELL_VERSION = HTML/CSS/JS/config/JSON/sprites — bumped on every
//     release. Includes assets/avatars-sprite.jpg (all DJ avatars in one
//     file) for atomic 100% offline reliability.
//   IMAGES_VERSION = the festival map (the only cross-origin CDN image we
//     still hot-link). Sticky — only bumped to force a refresh.
//
// Resilience:
//   - Install uses per-item add() with allSettled so one bad fetch doesn't
//     break the whole install (resilient on weak signal).
//   - Responses are validated before being cached so captive portals can't
//     poison the cache with their HTML.

const SHELL_VERSION  = 'myraverlife-shell-v149';
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
  './assets/schedule-all.png',
  './assets/avatars-sprite.jpg',
  './assets/avatars-coords.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_VERSION).then(async (cache) => {
      // Per-item add with cache: 'reload' so each fetch BYPASSES the
      // browser's HTTP cache and gets fresh bytes from the server. Without
      // this, an install triggered by a new SW could re-cache the OLD HTML
      // that's still in the browser cache — and with cache-first HTML
      // strategy, the user would then be stuck on the stale version
      // forever (until another SW bump).
      // allSettled lets one failure not break the whole install (resilient
      // on weak signal).
      await Promise.allSettled(APP_SHELL.map((url) =>
        cache.add(new Request(url, { cache: 'reload' }))
      ));
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

    // HTML: cache-first, identical to all other static assets. Online and
    // offline ALWAYS serve the same cached HTML, so the app behaves the
    // same regardless of network state. New HTML only lands when the SW
    // shell version bumps (which we do every push) — the new SW installs
    // in background, atomically replaces the cache on activation, and the
    // user picks it up on next page load.
    if (isDoc) {
      event.respondWith(
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // First-ever visit: nothing cached yet, fall through to network.
          return fetch(event.request)
            .then((response) => {
              if (cacheable(response)) {
                const clone = response.clone();
                caches.open(SHELL_VERSION).then((c) => c.put(event.request, clone));
              }
              return response;
            })
            .catch(() => caches.match('./index.html'));
        })
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
  // Serve from cache if present (works offline). Otherwise, do NOT intercept
  // — let the browser handle the request natively. This is critical because:
  //   1. SW context lacks Origin header → CloudFront doesn't send CORS
  //      headers → page's CORS check on the SW-returned response fails.
  //   2. The page-side prewarmer is the sole writer to the images cache,
  //      using fetch() with cors mode from page context (Origin sent).
  // For <img> tags at runtime (no-cors), browser handles normally; if offline
  // and not yet cached, image breaks gracefully into a placeholder.
  const isImageUrl = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(url.pathname);
  if (event.request.destination === 'image' || isImageUrl) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      // Fall through: do our own fetch but don't cache — page is in charge.
      try { return await fetch(event.request); }
      catch (e) { return new Response('', { status: 504 }); }
    })());
    return;
  }

  // Everything else cross-origin (fonts, analytics): default browser handling.
});
