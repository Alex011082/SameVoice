/* Подписка приложения на пуш-уведомления SameVoice.
 *
 * Что делает: узнаёт, кто вошёл, спрашивает разрешение на уведомления в
 * ответ на ЖЕСТ человека (браузеры отказывают, если спросить самому при
 * загрузке), регистрирует рабочий процесс и отдаёт подписку оркестратору.
 *
 * Ключ активации кладётся в браузер один раз ссылкой вида
 * https://samevoice.0110.digital/#engine-key=<ключ> — тем же, что у кнопки
 * движка. Без ключа скрипт молчит и ничего не рисует.
 */
(function () {
  try {
    var m = (location.hash || '').match(/engine-key=([a-f0-9]+)/);
    if (m) { localStorage.setItem('sv-engine-key', m[1]); history.replaceState(null, '', location.pathname); }
  } catch (e) {}
  var KEY; try { KEY = localStorage.getItem('sv-engine-key'); } catch (e) {}
  if (!KEY) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  var css = document.createElement('style');
  css.textContent =
    '#sv-push{position:fixed;right:16px;bottom:172px;z-index:9999;padding:10px 14px;border-radius:999px;' +
    'border:1px solid rgba(160,150,255,.4);background:rgba(11,7,34,.92);color:#eae6ff;' +
    'font:500 12px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}' +
    '#sv-push[data-state="on"]{border-color:rgba(34,227,255,.6);color:#22e3ff}' +
    '#sv-push[data-state="off"]{opacity:.75}';
  document.head.appendChild(css);

  var btn = document.createElement('button');
  btn.id = 'sv-push';
  btn.textContent = 'Уведомления';
  document.body.appendChild(btn);

  function api(path, opts) {
    return fetch('/orch' + path, Object.assign({
      headers: { 'x-engine-key': KEY, 'Content-Type': 'application/json' },
    }, opts || {}));
  }

  function b64ToBytes(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function whoAmI() {
    try {
      var r = await fetch('/api/auth/session', { credentials: 'include' });
      if (!r.ok) return null;
      var j = await r.json();
      return (j && j.user && (j.user.id || j.user.userId)) || null;
    } catch (e) { return null; }
  }

  async function state() {
    if (!('Notification' in window)) return 'нет';
    if (Notification.permission === 'denied') return 'off';
    var reg = await navigator.serviceWorker.getRegistration('/sv-push-sw.js');
    var sub = reg && await reg.pushManager.getSubscription();
    return sub ? 'on' : 'idle';
  }

  async function paint() {
    var s = await state();
    btn.dataset.state = s;
    btn.textContent = s === 'on' ? 'Уведомления включены'
      : s === 'off' ? 'Уведомления запрещены'
      : 'Включить уведомления';
  }

  async function enable() {
    btn.textContent = 'Подключаю…';
    try {
      var user = await whoAmI();
      if (!user) { btn.textContent = 'Сначала войдите'; setTimeout(paint, 2500); return; }

      var perm = await Notification.requestPermission();
      if (perm !== 'granted') { await paint(); return; }

      var keyRes = await api('/push/key');
      var key = (await keyRes.json()).key;
      if (!key) { btn.textContent = 'Пуш не настроен'; return; }

      var reg = await navigator.serviceWorker.register('/sv-push-sw.js');
      await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(key),
        });
      }
      var r = await api('/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ userId: user, subscription: sub.toJSON() }),
      });
      if (!r.ok) throw new Error('сервер отказал: ' + r.status);
      await paint();
    } catch (e) {
      btn.textContent = 'Не вышло: ' + (e.message || e);
      setTimeout(paint, 4000);
    }
  }

  btn.addEventListener('click', function () {
    if (btn.dataset.state === 'on') {
      api('/push/test', { method: 'POST', body: JSON.stringify({ userId: null, text: 'Проверка связи' }) });
      return;
    }
    enable();
  });

  navigator.serviceWorker.addEventListener('message', function (ev) {
    // Клик по уведомлению вернул человека в приложение — покажем, куда идти.
    if (ev.data && ev.data.from === 'sv-push') {
      try { location.hash = ''; } catch (e) {}
    }
  });

  paint();
})();
