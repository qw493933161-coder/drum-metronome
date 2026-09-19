// Cache-first offline shell. Bump CACHE_NAME whenever any precached file changes
// so clients pick up the new version instead of serving stale JS forever.
const CACHE_NAME = 'drum-metronome-v4';
const PRECACHE = [
  './',
  'data/rhythm-value-chart.json',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/rhythmMath.js',
  'js/db.js',
  'js/storage.js',
  'js/audio.js',
  'js/engine.js',
  'js/wakelock.js',
  'js/ui.js',
  'js/app.js',
  'js/views/metronome.js',
  'js/views/plans.js',
  'js/views/patterns.js',
  'js/views/materials.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        // opportunistically cache same-origin GETs we didn't precache
        if (res.ok && event.request.url.startsWith(self.location.origin)) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
