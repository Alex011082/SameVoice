/* Память устройства: не терять вошедшего.
 *
 * Кука — хрупкая: встроенные браузеры мессенджеров (WhatsApp, Telegram)
 * заводят своё хранилище и теряют её постоянно — ровно так тестеров
 * выбрасывало на «введите код» при каждом переходе по ссылке.
 *
 * Поэтому копия сессии живёт ещё и в localStorage, и каждый запрос к
 * нашему API несёт её в заголовке Authorization: сервер принимает любой
 * из двух носителей. Сервер же продлевает сессию на ходу (заголовок
 * x-sv-session) — 30 дней отсчитываются от последнего визита.
 *
 * Файл подключается ПЕРВЫМ и подменяет window.fetch: так покрыты все
 * запросы приложения (main.ts, брони, уведомления) без правки каждого.
 */
(function () {
  var KEY = 'sv-session-token';

  function token() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function remember(t) {
    if (!t || typeof t !== 'string') return;
    try { localStorage.setItem(KEY, t); } catch (e) {}
  }
  function forget() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  function isOurApi(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.indexOf('/api/') === 0;
    } catch (e) { return false; }
  }

  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isOurApi(url)) return origFetch(input, init);

    init = init || {};
    var headers = new Headers(init.headers || (typeof input === 'object' && input.headers) || undefined);
    var t = token();
    if (t && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + t);
    init.headers = headers;
    init.credentials = init.credentials || 'include';

    var path = '';
    try { path = new URL(url, location.href).pathname; } catch (e) {}

    return origFetch(typeof input === 'string' ? input : input.url, init).then(function (res) {
      // сервер продлил сессию на ходу — забираем свежий токен
      var refreshed = res.headers.get('x-sv-session');
      if (refreshed) remember(refreshed);
      // вход любой дверью кладёт токен из тела в память устройства
      if (res.ok && /\/api\/auth\/(register|phone\/verify|passkey\/login\/verify|seeded-login)$/.test(path)) {
        res.clone().json().then(function (body) {
          if (body && body.session && body.session.token) remember(body.session.token);
        }).catch(function () {});
      }
      // выход — забыть везде
      if (res.ok && /\/api\/auth\/logout$/.test(path)) forget();
      return res;
    });
  };

  /* ---- встроенный браузер мессенджера: предупредить и дать выход ---- */
  function inMessengerWebview() {
    var ua = navigator.userAgent || '';
    return /WhatsApp|FBAN|FBAV|Instagram|Telegram|Line\//i.test(ua);
  }
  function mountWebviewBanner() {
    if (!inMessengerWebview() || document.getElementById('sv-webview-note')) return;
    var note = document.createElement('div');
    note.id = 'sv-webview-note';
    note.setAttribute('role', 'note');
    note.innerHTML =
      '<b>Вы внутри мессенджера.</b> Здесь вход не запоминается — откройте в браузере, и код больше не понадобится. ' +
      '<button type="button" id="sv-webview-copy">Скопировать ссылку</button>';
    var style = document.createElement('style');
    style.textContent =
      '#sv-webview-note{position:sticky;top:0;z-index:60;padding:12px 16px;font:400 13px/1.45 system-ui,sans-serif;' +
      'background:#fff7e6;color:#4a3200;border-bottom:1px solid #ffd591}' +
      '#sv-webview-note button{margin-left:8px;padding:6px 12px;border-radius:999px;border:1px solid #d48806;' +
      'background:#fff;color:#874d00;font:600 12px system-ui,sans-serif;cursor:pointer}';
    document.head.appendChild(style);
    document.body.prepend(note);
    var btn = note.querySelector('#sv-webview-copy');
    btn.addEventListener('click', function () {
      var link = location.origin + '/';
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
        .then(function () { btn.textContent = 'Скопировано — вставьте в браузер'; })
        .catch(function () { btn.textContent = link; });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountWebviewBanner);
  else mountWebviewBanner();
})();
