// 离线外壳：联网时总取最新版，断网用缓存。每次改动任何预缓存文件都要改 CACHE_NAME。
const CACHE_NAME = 'drum-metronome-v42';
const PRECACHE = [
  './',
  'index.html',
  'css/app.css',
  'js/metronome.js',
  'js/sync.js',
  'js/song.js',
  'vendor/alphatab/alphaTab.min.js',
  'vendor/alphatab/font/Bravura.woff2',
  'vendor/alphatab/soundfont/sonivox.sf2',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' 绕过浏览器的 HTTP 缓存（GitHub Pages 会让文件缓存 10 分钟），否则新版本可能装进旧文件
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(PRECACHE.map((u) =>
        fetch(new Request(u, { cache: 'reload' })).then((res) => { if (!res.ok) throw new Error(u); return cache.put(u, res); }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// 页面、脚本、样式：联网就取最新（3.5 秒没回应才用缓存，弱网也能开）；大文件（播放器库、音色库）不变，缓存优先
const cacheFirst = async (req) => {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
};
const networkFirst = async (req) => {
  const cache = await caches.open(CACHE_NAME);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    // 导航请求不能带 init 再次 fetch，所以用 URL
    const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin', signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
    return Response.error();
  }
};
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // GitHub 接口等外部请求不经过缓存
  event.respondWith(url.pathname.includes('/vendor/') ? cacheFirst(req) : networkFirst(req));
});
