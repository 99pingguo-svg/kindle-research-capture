// Service worker: app shell works offline (photos queue in IndexedDB until the Mac is reachable).
const SHELL = 'daicho-shell-v2';
const THUMBS = 'daicho-thumbs-v1';
const SHELL_FILES = [
  '/', '/index.html', '/app.css', '/manifest.webmanifest',
  '/js/main.js', '/js/api.js', '/js/state.js', '/js/ui.js', '/js/list.js', '/js/detail.js', '/js/camera.js', '/js/images.js', '/js/uploads.js', '/js/pages.js', '/js/calendar.js',
  '/icons/icon-180.png', '/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, THUMBS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return;
  // Thumbnails are immutable: cache-first so the list works offline.
  if (url.pathname.startsWith('/files/products/') && url.pathname.includes('.thumb.')) {
    e.respondWith(
      caches.open(THUMBS).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }
  if (url.pathname.startsWith('/files/')) return;
  // Shell: network first (always fresh when the Mac is reachable), cache as fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
