// 오프라인에서도 열리도록: 엔진·OCR 파일은 캐시 우선, 화면 파일은 네트워크 우선
const VERSION = 'v3';
const SHELL = `shell-${VERSION}`;
const HEAVY = `heavy-${VERSION}`;
const SHELL_FILES = ['./', 'index.html', 'manifest.webmanifest', 'icon-180.png',
  'engine/worker.js', 'engine/pdf-swap.js', 'engine/pdf-lexer.js', 'engine/pdf-fonts.js', 'engine/pdf-pages.js',
  'engine/classify.js', 'engine/subset.js', 'engine/ocr-format.js', 'engine/fontmeta.js', 'engine/office.js',
  'vendor/jszip/jszip.min.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, HEAVY].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const heavy = /\/(vendor|ocr|fonts)\//.test(url.pathname);
  if (heavy) {
    e.respondWith(caches.open(HEAVY).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // 화면·엔진 코드는 항상 새로 확인 (브라우저에 남은 옛 파일 안 쓰기)
  e.respondWith((req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' })).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
});
