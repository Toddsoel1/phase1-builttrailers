const CACHE = 'bt-v1';
const SHELL  = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

// Install: cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

// Activate: drop old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   /api/*        → network only (always fresh data)
//   /webhooks/*   → network only
//   /optin /privacy /terms → network first, cache fallback
//   everything else → cache first, update in background
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) {
    return; // let the browser handle it normally
  }

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') cache.put(e.request, res.clone());
        return res;
      }).catch(() => null);

      // Network-first for public pages, cache-first for app shell
      const networkFirst = ['/optin', '/privacy', '/terms', '/t&cs'].includes(url.pathname);
      if (networkFirst) {
        return (await networkFetch) || cached || new Response('Offline', { status: 503 });
      }
      return cached || networkFetch || new Response('Offline', { status: 503 });
    })
  );
});
