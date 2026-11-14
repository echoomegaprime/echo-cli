/* ECHO Prime service worker.
 *
 * Deliberately lean, and built so it cannot break the live app:
 * - Navigations are network-first; the cache only answers when the network is gone,
 *   and then only with the small offline notice page.
 * - API and dynamic requests are never intercepted and never cached. Neither is
 *   anything non-GET or cross-origin.
 * - Static assets (CSS/JS/images/fonts/the manifest) are stale-while-revalidate.
 * The cache name is versioned; activating a new worker deletes every older cache.
 */
const CACHE = 'echo-prime-static-v1';
const OFFLINE_URL = '/offline.html';
const STATIC_RE = /\.(?:css|js|png|svg|ico|webmanifest|woff2?|ttf)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The worker script itself is never served from this cache; the browser's own
  // update check must always see the network copy.
  if (url.pathname === '/sw.js') return;
  // API and dynamic traffic passes straight through: never cached, never answered offline.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE);
        const offline = await cache.match(OFFLINE_URL);
        return offline || Response.error();
      }
    })());
    return;
  }

  if (STATIC_RE.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const network = fetch(request).then((response) => {
        if (response && response.status === 200) cache.put(request, response.clone());
        return response;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
