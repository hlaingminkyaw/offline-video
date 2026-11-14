/* Dhamma Player service worker – caches the app shell so the app opens with no internet.
   Media files are NOT cached here; they live in IndexedDB (see index.html). */
const VERSION = 'v16';
const SHELL_CACHE = 'dhamma-shell-' + VERSION;
const FONT_CACHE = 'dhamma-fonts-v1';
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
const SHELL_PATHS = new Set(SHELL.map(p => new URL(p, self.location).pathname));
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Myanmar:wght@400;700&display=swap';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL))                    // fails loudly if any shell file is missing
      .then(() => precacheFont().catch(() => {}))    // best effort: never blocks install
      .then(() => self.skipWaiting())
  );
});

// Burmese font CSS + its font files, so the first offline launch already has proper Myanmar text.
async function precacheFont() {
  const cache = await caches.open(FONT_CACHE);
  if (await cache.match(FONT_CSS, { ignoreVary: true })) return;
  const res = await fetch(FONT_CSS);
  if (!res.ok) return;
  const css = await res.clone().text();
  const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]);
  await Promise.all(urls.map(u => fetch(u).then(r => r.ok && cache.put(u, r))));
  await cache.put(FONT_CSS, res);
}

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith('dhamma-') && k !== SHELL_CACHE && k !== FONT_CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/api/')) return;                 // API: network only
    if (req.mode === 'navigate') {                               // any page -> cached index.html
      e.respondWith(staleWhileRevalidate(e, req, './index.html'));
      return;
    }
    if (SHELL_PATHS.has(url.pathname)) {
      e.respondWith(staleWhileRevalidate(e, req, req));
    }
    return;
  }

  // Burmese web font (so text renders correctly even on Zawgyi phones)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, FONT_CACHE));
  }
  // Everything else (YouTube etc.) goes straight to the network.
});

// Serve from cache instantly (works offline); refresh the cache in the background.
async function staleWhileRevalidate(event, req, key) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(key, { ignoreSearch: true });
  const update = fetch(req)
    .then(res => {
      if (res && res.ok && res.type === 'basic') return cache.put(key, res.clone()).then(() => res);
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  const res = await update;
  return res || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response('', { status: 504 });
  }
}
