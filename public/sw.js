/* PaperDesk service worker: keeps the app itself on the phone so it opens instantly and offline.
   Prices always come from the network (the relay is never cached here). */
const VERSION = '643ec4df427a';
const FILES = ["./","fonts/Inter.woff2","fonts/LICENSE-Inter.txt","icons/apple-touch-icon.png","icons/favicon-32.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","index.html","js/api.js","js/app.js","js/chart.js","js/confirm.js","js/engine.js","js/fx.js","js/glossary.js","js/icons.js","js/learn-data.js","js/learn.js","js/lesson.js","js/phone-boot.js","js/phone.js","js/quiz-data.js","js/quiz.js","js/sound.js","js/theme.js","js/top.js","manifest.webmanifest","phone.css","styles.css","themes.css","vendor/LICENSE-lightweight-charts.txt","vendor/lightweight-charts.standalone.production.js"];
const CACHE = 'paperdesk-' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('paperdesk-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('/relay') || url.pathname.includes('/sync/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html', { cacheName: CACHE }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((r) => r || fetch(req)));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow ? self.clients.openWindow('./') : null;
  }));
});
