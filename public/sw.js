const CACHE = 'bt-v2';
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

// ---- Web push: order status, approvals, warranty updates ----
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = {}; }
  e.waitUntil(self.registration.showNotification(data.title || 'Built Trailers', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    tag: data.tag || undefined,
    renotify: !!data.tag,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
    for (const w of wins) { if ('focus' in w) { w.focus(); if ('navigate' in w) w.navigate(url); return; } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
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

      // Network-first for the app shell (so deploys reach installed PWAs immediately)
      // and public pages; cache-first only for static assets like icons.
      const isNavigation = e.request.mode === 'navigate' || e.request.destination === 'document';
      const networkFirst = isNavigation || url.pathname === '/' || url.pathname.endsWith('.html') || ['/optin', '/privacy', '/terms', '/t&cs'].includes(url.pathname);
      if (networkFirst) {
        return (await networkFetch) || cached || new Response('Offline', { status: 503 });
      }
      return cached || networkFetch || new Response('Offline', { status: 503 });
    })
  );
});
