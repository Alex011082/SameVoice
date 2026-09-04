/* Рабочий процесс браузера для пуш-уведомлений SameVoice.
 * Живёт отдельно от приложения и работает, даже когда вкладка закрыта —
 * иначе напоминание за час до разговора никого не догонит.
 *
 * Отдаётся с корня сайта (/sv-push-sw.js): рабочий процесс видит только те
 * страницы, что лежат не выше его самого.
 */
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'SameVoice';
  const options = {
    body: data.body || '',
    tag: data.tag || 'samevoice',
    renotify: true,
    // Сигналы перед разговором и автосозвон должны пробиться сквозь тишину:
    // это то, ради чего человек и договаривался о времени.
    requireInteraction: data.kind === 'autocall' || data.kind === 'handoff',
    vibrate: data.kind === 'autocall' ? [200, 100, 200, 100, 200] : [120],
    data: { kind: data.kind || null, bookingId: data.bookingId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        c.postMessage({ from: 'sv-push', data: event.notification.data });
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
