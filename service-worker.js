// Build-time hashed, allowlisted assets only. No runtime caching of arbitrary URLs or QR data.
const CACHE = '__CACHE_ID__';
const CORE = __PRECACHE_ASSETS__;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('kagura-qr-') && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  // No runtime cache.put: storage cannot grow through user-controlled query parameters.
  event.respondWith(caches.match(event.request, {ignoreSearch: true}).then(hit => hit || fetch(event.request)));
});
