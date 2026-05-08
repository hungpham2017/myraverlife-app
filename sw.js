// My Raver Life service worker
//
// Offline-first: after first online visit, the app must keep working in
// airplane mode / on weak signal at the festival.
//
// Two caches:
//   SHELL_VERSION  = HTML/CSS/JS/config/JSON/icons — small (~500 KB), bumped
//     on every release. The version-bump cost is just this small set.
//   STICKY_VERSION = heavy festival imagery (~10 MB). Survives shell bumps
//     so a release doesn't re-download megabytes. Only bump STICKY_VERSION
//     when one of these files actually changes.
//
// Resilience:
//   - Install uses per-item add() with allSettled so one bad fetch doesn't
//     break the whole install (resilient on weak signal).
//   - Sticky cache fills in the activate phase's background, so install
//     activation is fast (small SHELL) and pages get the new SW quickly.
//   - Responses are validated before being cached so captive portals can't
//     poison the cache with their HTML.

// IMPORTANT: keep this version literal in sync with version.js.
// Browsers detect new SWs by sw.js byte changes, so the version MUST
// be a literal in this file (not imported) — otherwise the browser
// won't see the SW as "changed" and won't install the update.
const SHELL_VERSION  = 'myraverlife-shell-v318';
const STICKY_VERSION = 'myraverlife-sticky-v5';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './festival.config.js',
  './findfriend.js',
  './version.js',
  './vendor/qrcode.min.js',
  './vendor/qr-scanner.min.js',
  './vendor/qr-scanner-worker.min.js',
  './vendor/firebase/firebase-app.js',
  './vendor/firebase/firebase-auth.js',
  './vendor/firebase/firebase-database.js',
  './assets/artists.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
  './assets/avatars-coords.json',
];

// Heavy assets cached separately so version bumps don't re-fetch them.
const STICKY_ASSETS = [
  './assets/schedule-all.png',
  './assets/avatars-sprite.jpg',
  './assets/map2026.jpg',
];

const STICKY_PATHS = new Set(STICKY_ASSETS.map((p) => p.replace(/^\./, '')));

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
  event.waitUntil((async () => {
    // Failure-tolerant: if any step throws, we still try to claim clients
    // so the new SW takes effect. Worst case the user re-fetches a heavy
    // asset from network, which matches pre-migration behavior anyway.
    try {
      const keys = await caches.keys();
      const stickyCache = await caches.open(STICKY_VERSION);

      // Migrate heavy assets from any old shell cache into the sticky cache
      // BEFORE deleting the old shell — otherwise upgrading users would
      // re-download ~10 MB. Only fills slots not already in sticky; never
      // overwrites. Each step is wrapped so one bad entry can't abort the
      // whole migration (or activation).
      const oldShells = keys.filter((k) =>
        k.startsWith('myraverlife-shell-') && k !== SHELL_VERSION
      );
      for (const name of oldShells) {
        let oldCache;
        try { oldCache = await caches.open(name); } catch (e) { continue; }
        for (const url of STICKY_ASSETS) {
          try {
            if (await stickyCache.match(url)) continue;
            const hit = await oldCache.match(url);
            if (hit) await stickyCache.put(url, hit.clone());
          } catch (e) { /* skip this asset, fallback below will fetch */ }
        }
      }

      // Drop old shell + sticky caches that don't match current versions.
      await Promise.all(
        keys
          .filter((k) =>
            (k.startsWith('myraverlife-shell-')  && k !== SHELL_VERSION) ||
            (k.startsWith('myraverlife-sticky-') && k !== STICKY_VERSION)
          )
          .map((k) => caches.delete(k).catch(() => {}))
      );

      await self.clients.claim();

      // Fill any sticky slots still missing (fresh install, or items not
      // recovered above). Network fetch in background — claim already
      // took effect so pages aren't blocked. Per-item match-check makes
      // this a noop when sticky is already complete.
      await Promise.allSettled(STICKY_ASSETS.map(async (url) => {
        try {
          if (await stickyCache.match(url)) return;
          return await stickyCache.add(new Request(url, { cache: 'reload' }));
        } catch (e) { /* offline or 404; runtime fetch handler will retry */ }
      }));
    } catch (e) {
      try { await self.clients.claim(); } catch (e2) {}
    }
  })());
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

    // Static assets (JS, CSS, JSON, images, fonts): cache-first. New
    // entries land in STICKY for the heavy festival imagery, SHELL for
    // everything else — same routing as the install/activate phase.
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request)
          .then((response) => {
            if (cacheable(response)) {
              const cacheName = STICKY_PATHS.has(url.pathname) ? STICKY_VERSION : SHELL_VERSION;
              const clone = response.clone();
              caches.open(cacheName).then((c) => c.put(event.request, clone));
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
