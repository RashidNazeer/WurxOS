/* WurxOS service worker — push + click + snooze + PWA offline shell.
 *
 * Snooze is handled server-side: on the snooze action we POST the
 * notification's one-time snooze token to the snooze-notification
 * Edge Function, which writes `snoozed_until` on the row. A pg_cron
 * job then re-invokes the push webhook when the timer elapses, so
 * the user sees the notification come back — works even if the SW
 * (and the whole browser) was closed in the meantime.
 *
 * Caching policy:
 *  - Navigation (HTML) → network-first, fall back to cached / (offline shell).
 *  - Same-origin static assets (hashed JS/CSS/img) → stale-while-revalidate.
 *  - Everything cross-origin (Supabase, etc) → pass through untouched.
 */

const SNOOZE_MINUTES = 10;
const CACHE_VERSION  = 'wurxos-v3-cachefix';
const SHELL_CACHE    = `${CACHE_VERSION}-shell`;
const ASSET_CACHE    = `${CACHE_VERSION}-assets`;
const SHELL_URLS     = ['/', '/Logo.png', '/favicon.ico', '/logo.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try { await cache.addAll(SHELL_URLS); } catch (_) { /* offline install — retry on next visit */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k !== SHELL_CACHE && k !== ASSET_CACHE) return caches.delete(k);
      return null;
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // Supabase etc — untouched
  if (url.pathname.startsWith('/sw.js')) return;                  // never cache the SW itself

  // Navigation requests: network-first with offline shell fallback.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('/', fresh.clone()).catch(() => {});
        return fresh;
      } catch (_) {
        const cache  = await caches.open(SHELL_CACHE);
        const cached = await cache.match('/', { ignoreSearch: true });
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Static same-origin assets: stale-while-revalidate.
  event.respondWith((async () => {
    const cache  = await caches.open(ASSET_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }

  const title = data.title || 'WurxOS';
  const options = {
    body:  data.body || '',
    icon:  '/Logo.png',
    badge: '/Logo.png',
    tag:   data.id || ((data.tag || 'wurxos') + '-' + Date.now()),
    requireInteraction: true,
    renotify: true,
    actions: [
      { action: 'markread', title: 'Mark as read' },
      { action: 'snooze',   title: 'Snooze 10 min' },
      { action: 'open',     title: 'Open' },
    ],
    data: {
      link:          data.link || '/notifications',
      id:            data.id,
      title,
      body:          data.body || '',
      origTag:       data.tag || 'wurxos',
      snooze_token:  data.snooze_token    || null,
      snooze_url:    data.snooze_url      || null,
      mark_read_url: data.mark_read_url   || null,
      category:      data.tag             || null,
    },
  };
  // Relay the push to any open app windows so the in-app bell
  // count refreshes immediately — no waiting on the Realtime
  // WebSocket, which can be slow to fire when the tab was in the
  // background.
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) {
        c.postMessage({ type: 'wurxos-notification', id: data.id, category: data.tag });
      }
    } catch (_) { /* noop */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  const data   = event.notification.data || {};

  // Snooze: close the popup and ask the server to re-fire it in 10 minutes.
  if (action === 'snooze') {
    event.notification.close();
    event.waitUntil((async () => {
      if (!data.snooze_token || !data.snooze_url) {
        // Older push (pre-snooze-token) or missing origin — nothing we can
        // do server-side; just drop the request silently.
        return;
      }
      try {
        await fetch(data.snooze_url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: data.snooze_token, minutes: SNOOZE_MINUTES }),
          keepalive: true,
        });
      } catch (_) { /* best effort — no UI here */ }
    })());
    return;
  }

  // Mark as read — same token-auth path as Snooze. Also relays a
  // message to any open app windows so they can flip the row to
  // read without a round-trip.
  if (action === 'markread') {
    event.notification.close();
    event.waitUntil((async () => {
      if (data.snooze_token && data.mark_read_url) {
        try {
          await fetch(data.mark_read_url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ token: data.snooze_token }),
            keepalive: true,
          });
        } catch (_) { /* best effort */ }
      }
      try {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of clients) {
          c.postMessage({ type: 'wurxos-notification-read', id: data.id });
        }
      } catch (_) { /* noop */ }
    })());
    return;
  }

  // Default / 'open' — close and focus the app on the linked page
  event.notification.close();
  const link = data.link || '/notifications';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        // SPA navigation — let React Router handle it, no full reload.
        client.postMessage({ type: 'wurxos-nav', link, id: data.id });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(link);
  })());
});
