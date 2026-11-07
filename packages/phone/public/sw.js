// Bytelight phone — push service worker, scope /phone/.
//
// Notifications only. It never intercepts fetches and never forwards push
// events to the page: an earlier web-push worker was pulled because the app
// misread its events as live activity. The one message it sends is on a
// tap, `bytelight:open-thread`, which the app only uses to jump.
//
// Main's payload is { title, body, threadId?, url?, tag? } (routes/push-routes.ts,
// services/push.ts). Its `url` points at the Svelte client (/chat), so taps
// open this app's own scope instead.

importScripts('push-target.js');

const SCOPE = self.registration.scope; // e.g. https://host/phone/
const { pushTarget, pushTargetUrl } = self.bytelightPushTarget;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const target = pushTarget(data);
  event.waitUntil(
    self.registration.showNotification(data.title || 'Bytelight', {
      body: data.body || '',
      icon: new URL('icon-192.png', SCOPE).href,
      badge: new URL('icon-192.png', SCOPE).href,
      data: target,
      tag: data.tag || 'bytelight-message',
      renotify: true,
    }),
  );
});

// Focus an open window and tell it where to go; otherwise open one at a URL
// that carries the thread (and message) for the app to jump to on load.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = pushTarget(event.notification.data);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(SCOPE) && 'focus' in client) {
          return client.focus().then((focused) => {
            if (target.threadId) {
              (focused || client).postMessage({ type: 'bytelight:open-thread', ...target });
            }
            return focused;
          });
        }
      }
      return self.clients.openWindow(pushTargetUrl(SCOPE, target));
    }),
  );
});
