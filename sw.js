// Service worker: deixa o app abrir mesmo sem internet e guarda as capas dos livros.
const CACHE = 'sc2-v9';
const IMG = 'sc2-covers';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './sync.js?v=9'];

self.addEventListener('install', e => {
  // 'reload' ignora o cache do navegador: garante que a versão nova é a que fica guardada
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, {cache:'reload'})))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== IMG).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // capas de livros: guarda depois da primeira vez
  if (req.destination === 'image' && url.origin !== location.origin) {
    e.respondWith(caches.open(IMG).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req, {cache:'no-cache'}).then(res => {   // sempre confere se há versão nova no servidor
        if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
