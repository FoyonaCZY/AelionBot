// The service worker. Registered at / it keeps the app shell for when the network is slow; registered at
// /p/<room>/ (one per paired computer) it receives that computer's push notifications. Built on its own as a classic
// script, without imports.

interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}
interface WorkerScope {
  registration: ServiceWorkerRegistration;
  location: Location;
  clients: {
    claim(): Promise<void>;
    matchAll(options: {
      type: 'window';
      includeUncontrolled: boolean;
    }): Promise<Array<{ url: string; focus(): Promise<unknown>; postMessage(message: unknown): void }>>;
    openWindow(url: string): Promise<unknown>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: any) => void): void;
}
const worker = self as unknown as WorkerScope;
const CACHE = 'aelion-app-v1';
const scope = new URL(worker.registration.scope);
/** The computer this registration receives pushes for; empty for the app's own registration. */
const room = /^\/p\/([^/]+)\/$/.exec(scope.pathname)?.[1] || '';

worker.addEventListener('install', () => void worker.skipWaiting());
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request as Request;
  const url = new URL(request.url);
  if (room || request.method !== 'GET' || url.origin !== worker.location.origin) return;
  if (request.mode === 'navigate')
    // The page itself: the network first so updates arrive, the cached copy when offline.
    return event.respondWith(
      fetch(request)
        .then(async (response) => {
          const cache = await caches.open(CACHE);
          await cache.put('/', response.clone());
          return response;
        })
        .catch(async () => (await caches.match('/')) || Response.error()),
    );
  if (url.pathname.startsWith('/assets/'))
    // Hashed assets never change: the cache first.
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then(async (response) => {
            if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
            return response;
          }),
      ),
    );
});

worker.addEventListener('push', (event) => {
  let payload: PushPayload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    worker.registration.showNotification(payload.title || 'AelionBot', {
      body: payload.body,
      tag: payload.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: payload.url },
    }),
  );
});

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', worker.location.origin);
  if (room) target.searchParams.set('c', room);
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        open.postMessage({ type: 'open', url: target.href });
        return open.focus();
      }
      return worker.clients.openWindow(target.href);
    })(),
  );
});
