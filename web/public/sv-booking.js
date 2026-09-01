/* Договориться о разговоре: бронь, контекст, прогрев движка.
 *
 * Это вторая половина продукта из макета booking.html: у контакта появляется
 * действие «договориться», лист выбора времени с ТЁПЛЫМИ слотами, контекст
 * до разговора и попап прогрева с турбиной. Данные берутся у оркестратора
 * (/orch), который знает, где горячая карта и сколько ждать ИМЕННО этой броне.
 *
 * Ключ кладётся в браузер один раз ссылкой /#engine-key=<ключ> — тот же, что
 * у кнопки движка. Без ключа модуль молчит и ничего не рисует.
 */
(function () {
  /* Бронь работает у ЛЮБОГО вошедшего: подтверждением служит его собственный
   * вход в приложение — оркестратор переспрашивает бэкенд, кто это. Наш
   * лабораторный ключ, если он есть, остаётся отдельным входом для отладки. */
  var KEY = null;
  try { KEY = localStorage.getItem('sv-engine-key'); } catch (e) {}

  var RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var me = null;

  function api(path, opts) {
    var headers = { 'Content-Type': 'application/json' };
    if (KEY) headers['x-engine-key'] = KEY;
    return fetch('/orch' + path, Object.assign({ credentials: 'include', headers }, opts || {}));
  }

  var myLang = null;
  fetch('/api/auth/session', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.user) return;
      me = j.user.id || j.user.userId;
      myLang = j.user.lang || null;
    })
    .catch(function () {});

  /* --------------------------------------------------------------- стили */
  var css = document.createElement('style');
  css.textContent = [
    '.sv-book{flex:0 0 auto;min-height:44px;padding:12px 16px;border-radius:var(--pill);',
    '  font:400 11px var(--font);letter-spacing:.14em;color:var(--fg-dim);',
    '  border:1px solid var(--line);background:none;transition:color .2s,border-color .2s}',
    '.sv-book:active{color:var(--fg);border-color:var(--line-strong)}',
    '.sv-sheet{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;',
    '  justify-content:center;background:color-mix(in srgb,var(--bg) 78%,transparent);',
    '  backdrop-filter:blur(12px);animation:sv-fade .25s ease}',
    '@keyframes sv-fade{from{opacity:0}to{opacity:1}}',
    '.sv-sheet-card{width:min(100%,560px);max-height:92vh;overflow:auto;',
    '  border:1px solid var(--line);border-top-left-radius:var(--r-lg);',
    '  border-top-right-radius:var(--r-lg);background:var(--bg-lift);',
    '  padding:24px 22px calc(28px + var(--safe-bottom));',
    '  animation:sv-rise .38s var(--ease)}',
    '@keyframes sv-rise{from{transform:translateY(40px);opacity:0}to{transform:none;opacity:1}}',
    '.sv-sheet h2{font:800 clamp(26px,8vw,34px) var(--font-display);letter-spacing:-.02em;',
    '  background:var(--voice);-webkit-background-clip:text;background-clip:text;color:transparent;margin:0 0 6px}',
    '.sv-sheet .sv-sub{color:var(--fg-dim);font:300 13.5px/1.5 var(--font);margin:0 0 18px}',
    '.sv-row{display:flex;gap:8px;overflow-x:auto;padding:4px 0 10px;scrollbar-width:none}',
    '.sv-row::-webkit-scrollbar{display:none}',
    '.sv-chip{flex:none;padding:10px 14px;border-radius:var(--pill);border:1px solid var(--line);',
    '  font:500 13px var(--font);color:var(--fg-dim);white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.sv-chip.on{color:var(--fg);border-color:transparent;',
    '  background:linear-gradient(var(--bg-lift-2),var(--bg-lift-2)) padding-box,var(--voice) border-box;',
    '  box-shadow:0 0 22px -8px var(--voice-2)}',
    '.sv-chip.warm{border-color:rgba(255,180,80,.5);color:#ffd9a3}',
    '.sv-chip.warm::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;',
    '  margin-right:7px;vertical-align:middle;background:linear-gradient(135deg,#ffca6a,#ff7a3d);',
    '  box-shadow:0 0 8px rgba(255,150,60,.9)}',
    '.sv-note{font:300 12.5px/1.5 var(--font);color:var(--fg-faint);margin:6px 0 14px}',
    '.sv-note.tight{color:var(--warn)}',
    '.sv-exact{display:flex;align-items:center;gap:12px;margin:4px 0 2px}',
    '.sv-exact span{font:300 10px var(--font);letter-spacing:.2em;text-transform:uppercase;',
    '  color:var(--fg-faint);white-space:nowrap}',
    '.sv-exact input{flex:0 0 auto;width:auto;min-height:44px;padding:8px 14px;',
    '  font:600 18px var(--font-display);font-variant-numeric:tabular-nums}',
    '.sv-note.warm{color:#ffd9a3;font-style:italic}',
    '.sv-lbl{font:300 10px var(--font);letter-spacing:.22em;text-transform:uppercase;',
    '  color:var(--fg-faint);display:block;margin:16px 0 8px}',
    '.sv-add{display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:8px}',
    '.sv-add input{flex:1;min-height:44px;font:300 15px var(--font);border:0;background:none;padding:8px 0}',
    '.sv-add input:focus{box-shadow:none}',
    '.sv-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
    '.sv-tag{font:italic 300 12.5px var(--font);color:var(--fg-dim);padding:6px 12px 6px 20px;',
    '  border-radius:var(--pill);background:color-mix(in srgb,var(--voice-1) 12%,transparent);position:relative}',
    '.sv-tag::before{content:"";position:absolute;left:9px;top:calc(50% - 3px);width:6px;height:6px;',
    '  border-radius:50%;background:var(--voice)}',
    '.sv-tag button{color:var(--fg-faint);margin-left:6px}',
    '.sv-switch{display:flex;gap:14px;align-items:flex-start;padding:16px 0;border-top:1px solid var(--line);cursor:pointer}',
    '.sv-knot{flex:none;width:26px;height:26px;border-radius:50%;border:1.5px solid var(--line-strong);',
    '  position:relative;margin-top:2px;transition:all .2s var(--ease)}',
    '.sv-knot::after{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--voice);',
    '  opacity:0;transform:scale(.4);transition:all .2s var(--ease)}',
    '.sv-switch.on .sv-knot{border-color:transparent;box-shadow:0 0 18px -4px var(--voice-2)}',
    '.sv-switch.on .sv-knot::after{opacity:1;transform:none}',
    '.sv-switch b{display:block;font:500 14.5px var(--font);color:var(--fg)}',
    '.sv-switch span{font:300 12.5px/1.5 var(--font);color:var(--fg-dim)}',
    '.sv-acts{display:flex;gap:10px;margin-top:20px}',
    '.sv-acts .btn{flex:1}',
    /* попап прогрева */
    '.sv-warm{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:24px;',
    '  background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(14px);animation:sv-fade .3s ease}',
    '.sv-warm-card{width:min(100%,380px);border:1px solid var(--line);border-radius:var(--r-lg);',
    '  background:var(--bg-lift);text-align:center;overflow:hidden;animation:sv-rise .4s var(--ease)}',
    '.sv-warm canvas{display:block;width:100%;height:260px}',
    '.sv-warm-body{padding:0 24px 24px}',
    '.sv-warm h3{font:600 19px var(--font-display);margin:0 0 8px;min-height:26px}',
    '.sv-warm p{font:300 13.5px/1.5 var(--font);color:var(--fg-dim);margin:0;min-height:60px}',
    '.sv-warm .sv-eta{font:400 11px ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;',
    '  color:var(--fg-faint);margin-top:14px;display:block}',
    '.sv-upcoming{border-top:1px solid var(--line);margin-top:20px;padding-top:16px}',
    '.sv-up{display:flex;align-items:center;gap:12px;padding:12px 2px}',
    '.sv-up-time{font:700 22px var(--font-display);font-variant-numeric:tabular-nums;',
    '  background:var(--voice);-webkit-background-clip:text;background-clip:text;color:transparent}',
    '.sv-up-who{flex:1;font:400 14px var(--font);color:var(--fg-dim);min-width:0}',
    '.sv-up{flex-wrap:wrap}',
    '.sv-up-acts{display:flex;gap:8px;flex:0 0 auto}',
    '.sv-up-btn{min-height:38px;padding:9px 14px;border-radius:var(--pill);',
    '  font:400 11px var(--font);letter-spacing:.12em;color:var(--fg-dim);',
    '  border:1px solid var(--line);background:none;transition:color .2s,border-color .2s}',
    '.sv-up-btn:active{color:var(--fg);border-color:var(--line-strong)}',
    '.sv-up-btn.yes{color:var(--fg);border-color:transparent;',
    '  background:linear-gradient(var(--bg-lift),var(--bg-lift)) padding-box,var(--voice) border-box}',
    '.sv-up-btn:disabled{opacity:.5}',
    '.sv-invite{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:24px;',
    '  background:color-mix(in srgb,var(--bg) 84%,transparent);backdrop-filter:blur(12px);',
    '  animation:sv-fade .25s ease}',
    '.sv-invite-card{width:min(100%,420px);text-align:center;padding:32px 26px;',
    '  border:1px solid var(--line);border-radius:var(--r-lg);background:var(--bg-lift);',
    '  animation:sv-rise .4s var(--ease);display:flex;flex-direction:column;gap:10px;align-items:center}',
    '.sv-invite-eyebrow{font:300 10px var(--font);letter-spacing:.22em;text-transform:uppercase;color:var(--fg-faint)}',
    '.sv-invite-name{font:700 clamp(30px,9vw,40px) var(--font-display);letter-spacing:-.02em;line-height:1.05}',
    '.sv-invite-when{font:600 20px var(--font-display);font-variant-numeric:tabular-nums;',
    '  background:var(--voice);-webkit-background-clip:text;background-clip:text;color:transparent}',
    '.sv-invite-ctx{font:300 13px/1.5 var(--font);color:var(--fg-dim);margin:0}',
    '.sv-invite-acts{display:flex;gap:12px;margin-top:12px;width:100%}',
    '.sv-invite-acts .btn{flex:1}'
  ].join('\n');
  document.head.appendChild(css);

  /* -------------------------------------------------- кнопка у контакта */
  function mountButtons() {
    var list = document.getElementById('contact-list');
    if (!list) return;
    var cards = list.querySelectorAll('li.card');
    for (var i = 0; i < cards.length; i++) {
      (function (card) {
        if (card.querySelector('.sv-book')) return;
        var name = card.querySelector('.card-name');
        // Кнопка живёт РЯДОМ со «позвонить», внутри раскрывающейся части:
        // вставлять её в саму карточку нельзя — там теперь только строка имени.
        var acts = card.querySelector('.card-acts');
        if (!name || !acts) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'sv-book';
        b.textContent = 'договориться';
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          openSheet(card.dataset.userId || '', name.textContent || '');
        });
        acts.appendChild(b);
      })(cards[i]);
    }
  }

  /* ------------------------------------------------------------ лист */
  var names = {};          // userId -> имя, из собственных контактов
  var seenBookings = null; // что мы уже показывали, чтобы не звенеть дважды
  var warmSlots = {};      // 'HH:MM' -> true, если карта уже будет горячей
  var warmLeadMin = 5;     // сколько нужно на подъём карты (спросим у сервера)

  function loadNames() {
    if (!me) return Promise.resolve();
    return fetch('/api/users/' + encodeURIComponent(me) + '/contacts', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        (d && d.contacts ? d.contacts : []).forEach(function (c) {
          names[c.userId] = c.displayName;
        });
      }).catch(function () {});
  }

  function nameOf(id) { return names[id] || 'Собеседник'; }

  /* Если имя ещё не подгрузилось (приглашение пришло раньше контактов),
     доспрашиваем его точечно и вписываем в уже открытую карточку. */
  function ensureName(id, apply) {
    if (names[id]) { apply(names[id]); return; }
    fetch('/api/users/' + encodeURIComponent(id), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var nm = d && d.user && d.user.displayName;
        if (nm) { names[id] = nm; apply(nm); }
      }).catch(function () {});
  }

  /* Звон приглашения: короткий восходящий аккорд. Браузер даёт звучать только
     после того, как человек хоть раз коснулся страницы, поэтому неудача здесь
     нормальна и молча проглатывается. */
  function chime() {
    try {
      var A = window.AudioContext || window.webkitAudioContext;
      if (!A) return;
      var ctx = chime.ctx || (chime.ctx = new A());
      if (ctx.state === 'suspended') ctx.resume();
      var t0 = ctx.currentTime;
      [523, 659, 784].forEach(function (f, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.type = 'sine';
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t0 + i * 0.16);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + i * 0.16 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.5);
        o.start(t0 + i * 0.16); o.stop(t0 + i * 0.16 + 0.55);
      });
    } catch (e) { /* звук — не повод ронять приложение */ }
  }

  /* Карточка приглашения: кто зовёт, когда и о чём. Появляется поверх всего,
     потому что это событие, а не строка в списке. */
  function showInvite(b, ring) {
    if (document.querySelector('.sv-invite[data-id="' + b.id + '"]')) return;
    var wrap = document.createElement('div');
    wrap.className = 'sv-invite';
    wrap.dataset.id = b.id;
    var dt = new Date(b.startsAt);
    var when = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2) +
      ' · ' + dt.getDate() + '.' + ('0' + (dt.getMonth() + 1)).slice(-2);
    var ctxLine = '';
    if (b.context && (b.context.themes || []).length) ctxLine = (b.context.themes || []).join(' · ');
    if (b.context && (b.context.notes || []).length) {
      ctxLine += (ctxLine ? ' — ' : '') + (b.context.notes || []).join('; ');
    }
    wrap.innerHTML =
      '<div class="sv-invite-card">' +
      '  <span class="sv-invite-eyebrow">зовёт поговорить</span>' +
      '  <strong class="sv-invite-name"></strong>' +
      '  <div class="sv-invite-when"></div>' +
      (ctxLine ? '  <p class="sv-invite-ctx"></p>' : '') +
      '  <div class="sv-invite-acts">' +
      '    <button class="btn" data-yes>принять</button>' +
      '    <button class="btn btn-ghost" data-no>отказаться</button>' +
      '  </div></div>';
    var nameEl = wrap.querySelector('.sv-invite-name');
    nameEl.textContent = nameOf(b.byUserId);
    ensureName(b.byUserId, function (nm) { nameEl.textContent = nm; });
    wrap.querySelector('.sv-invite-when').textContent = when;
    if (ctxLine) wrap.querySelector('.sv-invite-ctx').textContent = ctxLine;
    document.body.appendChild(wrap);
    if (ring) chime();

    function answer(kind, btn) {
      btn.disabled = true;
      api('/bookings/' + encodeURIComponent(b.id) + '/' + kind, { method: 'POST' })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status); });
          wrap.remove();
          loadUpcoming();
        })
        .catch(function (e) { btn.disabled = false; btn.textContent = String(e.message || e).slice(0, 22); });
    }
    wrap.querySelector('[data-yes]').addEventListener('click', function () { answer('confirm', this); });
    wrap.querySelector('[data-no]').addEventListener('click', function () { answer('cancel', this); });
  }

  function loadWarm() {
    return api('/plan').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      warmSlots = {};
      if (d && d.params) {
        warmLeadMin = (d.params.warmMinutes || 4) + (d.params.riskMinutes || 1);
      }
      if (!d || !d.windows) return;
      d.windows.forEach(function (w) {
        // окно горячее от начала до конца: слоты внутри не требуют прогрева
        var s = new Date(w.start), e = new Date(w.end);
        for (var t = s.getTime(); t <= e.getTime(); t += 30 * 60000) {
          var d2 = new Date(t);
          warmSlots[('0' + d2.getHours()).slice(-2) + ':' + ('0' + d2.getMinutes()).slice(-2)] = true;
        }
      });
    }).catch(function () {});
  }

  function openSheet(userId, displayName) {
    var state = { day: 0, time: null, notes: [], themes: {}, autoCall: false };

    var wrap = document.createElement('div');
    wrap.className = 'sv-sheet';
    wrap.innerHTML =
      '<div class="sv-sheet-card">' +
      '  <h2>договориться</h2>' +
      '  <p class="sv-sub">' + escapeHtml(displayName) + ' подтвердит — и мы позвоним обоим. ' +
      '     Контекст, который вы оставите, помогает угадывать слова заранее.</p>' +
      '  <span class="sv-lbl">когда</span>' +
      '  <div class="sv-row" data-days></div>' +
      '  <div class="sv-row" data-times></div>' +
      '  <div class="sv-exact"><span>или своё время</span>' +
      '    <input type="time" step="60" data-exact aria-label="произвольное время"></div>' +
      '  <p class="sv-note" data-tz>огонёк — карта уже будет горячей, ждать не придётся</p>' +
      '  <span class="sv-lbl">на каком языке буду говорить я</span>' +
      '  <div class="sv-row" data-langs></div>' +
      '  <p class="sv-note" data-langnote></p>' +
      '  <span class="sv-lbl">о чём</span>' +
      '  <div class="sv-row" data-themes></div>' +
      '  <span class="sv-lbl">кто будет упомянут</span>' +
      '  <div class="sv-add"><input placeholder="Амин — прораб, вопрос по смете" aria-label="заметка"></div>' +
      '  <div class="sv-tags" data-tags></div>' +
      '  <div class="sv-switch" data-auto role="switch" aria-checked="false" tabindex="0">' +
      '    <div class="sv-knot"></div>' +
      '    <div><b>Соединить нас автоматически</b>' +
      '      <span>В назначенное время позвоним обоим сразу. Сработает, только если оба включат.</span></div>' +
      '  </div>' +
      '  <div class="sv-acts">' +
      '    <button class="btn btn-ghost" data-cancel>отмена</button>' +
      '    <button class="btn" data-send disabled>предложить</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    function close() { wrap.remove(); }
    wrap.querySelector('[data-cancel]').addEventListener('click', close);

    var daysEl = wrap.querySelector('[data-days]');
    var timesEl = wrap.querySelector('[data-times]');
    var tzEl = wrap.querySelector('[data-tz]');
    var sendBtn = wrap.querySelector('[data-send]');

    var DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    for (var d = 0; d < 5; d++) {
      (function (off) {
        var dt = new Date(Date.now() + off * 86400000);
        var b = document.createElement('button');
        b.className = 'sv-chip' + (off === state.day ? ' on' : '');
        b.textContent = (off === 0 ? 'сегодня' : off === 1 ? 'завтра' : DAYS[dt.getDay()]) +
          ' ' + dt.getDate() + '.' + ('0' + (dt.getMonth() + 1)).slice(-2);
        b.addEventListener('click', function () {
          state.day = off;
          [].forEach.call(daysEl.children, function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          buildTimes();
        });
        daysEl.appendChild(b);
      })(d);
    }

    var exactEl = wrap.querySelector('[data-exact]');

    /* Время можно назначить любое, минимум — через две минуты от сейчас.
     * Если до встречи меньше, чем нужно на подъём карты, честно говорим об
     * этом: движок догреется уже в начале разговора. Запрещать не за что —
     * пусть человек решает сам. */
    function whenOf(label) {
      var hm = String(label).split(':');
      var dt = new Date(Date.now() + state.day * 86400000);
      dt.setHours(+hm[0], +hm[1], 0, 0);
      return dt;
    }

    function pickTime(label) {
      var dt = whenOf(label);
      var minutesAway = (dt.getTime() - Date.now()) / 60000;
      if (minutesAway < 2) {
        state.time = null;
        sendBtn.disabled = true;
        tzEl.textContent = 'слишком близко: назначайте не раньше чем через две минуты';
        tzEl.className = 'sv-note tight';
        return;
      }
      state.time = label;
      sendBtn.disabled = false;
      if (warmSlots[label]) {
        tzEl.textContent = 'в это время карта уже горячая — позвоним сразу, без ожидания';
        tzEl.className = 'sv-note warm';
      } else if (minutesAway < warmLeadMin) {
        tzEl.textContent = 'до встречи меньше, чем нужно на подъём карты (' +
          warmLeadMin + ' мин): движок догреется уже в начале разговора';
        tzEl.className = 'sv-note tight';
      } else {
        tzEl.textContent = 'движок поднимем заранее, к началу разговора он будет готов';
        tzEl.className = 'sv-note';
      }
    }

    exactEl.addEventListener('input', function () {
      if (!exactEl.value) return;
      [].forEach.call(timesEl.children, function (x) { x.classList.remove('on'); });
      pickTime(exactEl.value);
    });

    function buildTimes() {
      timesEl.replaceChildren();
      state.time = null; sendBtn.disabled = true;
      var now = new Date();
      var startH = state.day === 0 ? now.getHours() + 1 : 8;
      for (var h = Math.max(8, startH); h < 23; h++) {
        [0, 30].forEach(function (m) {
          var label = ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
          var b = document.createElement('button');
          b.className = 'sv-chip' + (warmSlots[label] ? ' warm' : '');
          b.textContent = label;
          b.addEventListener('click', function () {
            [].forEach.call(timesEl.children, function (x) { x.classList.remove('on'); });
            b.classList.add('on');
            exactEl.value = '';
            pickTime(label);
          });
          timesEl.appendChild(b);
        });
      }
      var firstWarm = timesEl.querySelector('.sv-chip.warm');
      if (firstWarm) timesEl.scrollLeft = Math.max(0, firstWarm.offsetLeft - 60);
    }
    buildTimes();

    /* Язык говорящего решает, будет ли перевод вообще: если оба на одном
       языке, переводить нечего. Здесь человек выбирает, на каком языке ОН
       будет говорить в этом разговоре. Выбор меняет язык в его профиле —
       это то же самое поле, которым пользуется движок, и врать ему нельзя. */
    var langsEl = wrap.querySelector('[data-langs]');
    var langNote = wrap.querySelector('[data-langnote]');
    var LANGS = [{ id: 'ru', label: 'Русский' }, { id: 'he', label: 'עברית' }];
    state.lang = myLang || 'ru';
    function paintLangs() {
      langsEl.replaceChildren();
      LANGS.forEach(function (L) {
        var b = document.createElement('button');
        b.className = 'sv-chip' + (state.lang === L.id ? ' on' : '');
        b.textContent = L.label;
        if (L.id === 'he') b.lang = 'he';
        b.addEventListener('click', function () { state.lang = L.id; paintLangs(); });
        langsEl.appendChild(b);
      });
      var changed = myLang && state.lang !== myLang;
      langNote.textContent = changed
        ? 'ваш язык в профиле сменится на этот — иначе движок не будет знать, что переводить'
        : 'если оба говорят на одном языке, перевод не включится: выберите разные';
      langNote.className = 'sv-note' + (changed ? ' tight' : '');
    }
    paintLangs();

    var themesEl = wrap.querySelector('[data-themes]');
    ['работа', 'семья', 'деньги', 'ремонт', 'врач', 'документы', 'дети'].forEach(function (name) {
      var b = document.createElement('button');
      b.className = 'sv-chip';
      b.textContent = name;
      b.addEventListener('click', function () {
        var on = b.classList.toggle('on');
        if (on) state.themes[name] = true; else delete state.themes[name];
      });
      themesEl.appendChild(b);
    });

    var tagsEl = wrap.querySelector('[data-tags]');
    var input = wrap.querySelector('.sv-add input');
    function renderTags() {
      tagsEl.replaceChildren();
      state.notes.forEach(function (n, i) {
        var s = document.createElement('span');
        s.className = 'sv-tag';
        s.textContent = n;
        var x = document.createElement('button');
        x.textContent = '×'; x.setAttribute('aria-label', 'убрать');
        x.addEventListener('click', function () { state.notes.splice(i, 1); renderTags(); });
        s.appendChild(x);
        tagsEl.appendChild(s);
      });
    }
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      state.notes.push(v); input.value = ''; renderTags();
    });

    var sw = wrap.querySelector('[data-auto]');
    function toggleAuto() {
      state.autoCall = sw.classList.toggle('on');
      sw.setAttribute('aria-checked', state.autoCall ? 'true' : 'false');
    }
    sw.addEventListener('click', toggleAuto);
    sw.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleAuto(); }
    });

    sendBtn.addEventListener('click', function () {
      if (!state.time) return;
      var dt = whenOf(state.time);
      sendBtn.disabled = true;
      sendBtn.textContent = 'отправляю…';
      var langStep = (me && state.lang && state.lang !== myLang)
        ? fetch('/api/users/' + encodeURIComponent(me), {
            method: 'PATCH', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang: state.lang }),
          }).then(function (r) {
            if (!r.ok) throw new Error('язык не сменился: ' + r.status);
            myLang = state.lang;
          })
        : Promise.resolve();

      langStep.then(function () { return api('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          startsAt: dt.getTime(),
          withUserId: userId,
          context: { themes: Object.keys(state.themes), notes: state.notes },
          initiator: { autoCall: state.autoCall, lang: state.lang },
          invitee: { userId: userId },
        }),
      }); }).then(function (r) {
        if (!r.ok) throw new Error('сервер отказал: ' + r.status);
        return r.json();
      }).then(function () {
        close();
        loadUpcoming();
      }).catch(function (e) {
        sendBtn.disabled = false;
        sendBtn.textContent = 'не вышло: ' + (e.message || e);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------- список ближайших броней */
  function loadUpcoming() {
    var screen = document.getElementById('screen-contacts');
    if (!screen) return;
    api('/bookings').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var box = screen.querySelector('.sv-upcoming');
      var mine = (d && d.bookings ? d.bookings : []).filter(function (b) {
        return b.state === 'confirmed' || b.state === 'proposed';
      }).filter(function (b) { return b.startsAt > Date.now() - 3600000; })
        .sort(function (a, b) { return a.startsAt - b.startsAt; }).slice(0, 4);
      if (!mine.length) {
        if (box) box.remove();
        seenBookings = [];   // пустота — тоже знание: следующее станет «новым»
        return;
      }
      if (!box) {
        box = document.createElement('div');
        box.className = 'sv-upcoming';
        var list = document.getElementById('contact-list');
        if (list && list.parentNode) list.parentNode.insertBefore(box, list);
        else screen.appendChild(box);
      }
      box.replaceChildren();
      var lbl = document.createElement('span');
      lbl.className = 'sv-lbl';
      lbl.textContent = 'встречи';
      box.appendChild(lbl);
      // Неотвеченное приглашение — всегда карточкой: оно ждёт решения.
      // Звеним только на НОВОЕ, пришедшее при открытой странице: старое при
      // загрузке показываем молча, чтобы не пугать звоном каждое обновление.
      var ids = mine.map(function (b) { return b.id + ':' + b.state; });
      var первыйПроход = seenBookings === null;
      mine.forEach(function (b) {
        if (b.state !== 'proposed' || !me || b.withUserId !== me) return;
        var знакомое = !первыйПроход && seenBookings.indexOf(b.id + ':proposed') >= 0;
        if (знакомое) return;
        showInvite(b, !первыйПроход);
      });
      seenBookings = ids;

      mine.forEach(function (b) {
        var row = document.createElement('div');
        row.className = 'sv-up';
        var dt = new Date(b.startsAt);
        var t = document.createElement('span');
        t.className = 'sv-up-time';
        t.textContent = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);

        var who = document.createElement('span');
        who.className = 'sv-up-who';
        var date = dt.getDate() + '.' + ('0' + (dt.getMonth() + 1)).slice(-2);
        // Чей сейчас ход, видно с первого взгляда: приглашённому — «вас зовут»,
        // инициатору — «ждём ответа». Без этого непонятно, чего ждать.
        var менязовут = b.state === 'proposed' && me && b.withUserId === me;
        who.textContent = b.state === 'confirmed' ? 'договорено · ' + date
          : менязовут ? 'вас зовут поговорить · ' + date
          : 'ждём ответа · ' + date;
        row.append(t, who);

        var acts = document.createElement('div');
        acts.className = 'sv-up-acts';
        function act(label, kind, cls) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'sv-up-btn' + (cls ? ' ' + cls : '');
          btn.textContent = label;
          btn.addEventListener('click', function () {
            btn.disabled = true;
            api('/bookings/' + encodeURIComponent(b.id) + '/' + kind, { method: 'POST' })
              .then(function (r) {
                if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status); });
                loadUpcoming();
              })
              .catch(function (e) { btn.disabled = false; btn.textContent = String(e.message || e).slice(0, 24); });
          });
          acts.appendChild(btn);
        }
        if (менязовут) { act('принять', 'confirm', 'yes'); act('отказаться', 'cancel'); }
        else { act('отменить', 'cancel'); }
        row.appendChild(acts);

        box.appendChild(row);
        watchWarmup(b);
      });
    }).catch(function () {});
  }

  /* -------------------------------------------- попап прогрева с турбиной */
  var warmShownFor = null;
  function watchWarmup(booking) {
    if (booking.state !== 'confirmed') return;
    var until = booking.startsAt - Date.now();
    // Грубый предфильтр — только чтобы не спрашивать про дальние встречи.
    // КОГДА показывать окно, решает не это число, а ответ оркестратора: он
    // один знает, греется ли карта уже и сколько осталось ИМЕННО этой броне.
    if (until > 30 * 60000 || until < -5 * 60000) return;
    if (warmShownFor === booking.id) return;
    api('/readiness?bookingId=' + encodeURIComponent(booking.id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || s.etaSeconds == null) return;
        if (s.state === 'hot') return;              // карта горячая — ждать нечего
        // Показываем, когда прогрев уже идёт или вот-вот начнётся. Висеть
        // на экране за десять минут до начала бессмысленно: ничего не происходит.
        var скороНачнётся = s.state === 'scheduled' && (s.warmStartsInSeconds || 0) <= 60;
        if (!(s.state === 'warming' || s.state === 'starting' || скороНачнётся)) return;
        warmShownFor = booking.id;
        showWarmup(s, booking);
      }).catch(function () {});
  }

  var LESSONS = [
    { t: 'Ваш голос', e: 'На другом языке вы будете звучать собой — тембр ваш, слова понятные собеседнику.' },
    { t: 'Контекст решает', e: 'Тема и заметки, что вы оставили, помогают угадывать слова заранее — так перевод обгоняет речь.' },
    { t: 'Карта под вас', e: 'Видеокарта включается только под ваш разговор и гаснет, когда вы попрощались. Поэтому мы и договариваемся о времени.' },
    { t: 'Почти готово', e: 'Последняя проверка: слышно ли обоих и не рвётся ли звук.' }
  ];

  function showWarmup(status, booking) {
    var eta = Math.max(0, status.etaSeconds || 0);
    var lessons = LESSONS.slice(0, Math.min(LESSONS.length, Math.max(1, Math.floor(eta / 25))));

    var wrap = document.createElement('div');
    wrap.className = 'sv-warm';
    wrap.innerHTML =
      '<div class="sv-warm-card"><canvas></canvas><div class="sv-warm-body">' +
      '<h3></h3><p></p><span class="sv-eta"></span>' +
      '<div class="sv-acts"><button class="btn btn-ghost" data-hide>свернуть</button></div>' +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector('[data-hide]').addEventListener('click', function () { stop(); wrap.remove(); });

    var cv = wrap.querySelector('canvas'), ctx = cv.getContext('2d');
    var h3 = wrap.querySelector('h3'), p = wrap.querySelector('p'), etaEl = wrap.querySelector('.sv-eta');
    var W = 0, H = 0, sparks = [], t0 = 0, cur = -1, raf = null;

    function fit() {
      var r = cv.getBoundingClientRect();
      if (!r.width) return false;
      var d = Math.min(2, devicePixelRatio || 1);
      cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
      ctx.setTransform(d, 0, 0, d, 0, 0); W = r.width; H = r.height;
      return true;
    }

    /* Движок: три кольца турбины разгоняются по мере готовности, ядро
       разгорается, искры летят тем чаще, чем горячее. */
    function engine(t, pr) {
      var cx = W / 2, cy = H / 2, spin = RM ? 0 : t * (0.6 + pr * 9), heat = pr;
      var glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 92);
      glow.addColorStop(0, 'rgba(255,255,255,' + (0.1 + heat * 0.34).toFixed(3) + ')');
      glow.addColorStop(0.3, 'rgba(34,227,255,' + (0.1 + heat * 0.26).toFixed(3) + ')');
      glow.addColorStop(0.7, 'rgba(120,70,255,' + (0.05 + heat * 0.16).toFixed(3) + ')');
      glow.addColorStop(1, 'rgba(120,70,255,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, 92, 0, 6.283); ctx.fill();

      var rings = [{ r: 34, w: 3.2, b: 7, d: 1, s: 1 }, { r: 52, w: 2.2, b: 11, d: -1, s: 0.62 },
                   { r: 70, w: 1.4, b: 15, d: 1, s: 0.38 }];
      for (var k = 0; k < rings.length; k++) {
        var R = rings[k];
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(spin * R.s * R.d);
        for (var b = 0; b < R.b; b++) {
          var a0 = (b / R.b) * 6.283, len = 0.3 + heat * 0.22, hue = 200 + k * 22 + heat * 96;
          ctx.strokeStyle = 'hsla(' + hue + ',100%,' + (58 + heat * 12) + '%,' + (0.3 + heat * 0.55) + ')';
          ctx.lineWidth = R.w; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.arc(0, 0, R.r, a0, a0 + len); ctx.stroke();
        }
        ctx.restore();
      }
      ctx.fillStyle = 'rgba(255,255,255,' + (0.55 + heat * 0.45).toFixed(3) + ')';
      ctx.shadowColor = 'rgba(120,220,255,.9)'; ctx.shadowBlur = 10 + heat * 26;
      ctx.beginPath(); ctx.arc(cx, cy, 5 + heat * 7, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0;

      ctx.strokeStyle = 'rgba(160,150,255,.18)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 86, 0, 6.283); ctx.stroke();
      var g = ctx.createLinearGradient(cx - 86, cy, cx + 86, cy);
      g.addColorStop(0, '#4d5bff'); g.addColorStop(0.5, '#22e3ff'); g.addColorStop(1, '#ff3df2');
      ctx.strokeStyle = g; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, cy, 86, -Math.PI / 2, -Math.PI / 2 + 6.283 * Math.min(1, pr)); ctx.stroke();

      if (!RM && Math.random() < heat * 0.5) {
        var ang = Math.random() * 6.283;
        sparks.push({ x: cx + Math.cos(ang) * 34, y: cy + Math.sin(ang) * 34,
          vx: Math.cos(ang) * (26 + Math.random() * 50), vy: Math.sin(ang) * (26 + Math.random() * 50), life: 0 });
      }
      for (var s = sparks.length - 1; s >= 0; s--) {
        var sp = sparks[s];
        sp.life += 0.016; sp.x += sp.vx * 0.016; sp.y += sp.vy * 0.016;
        var f = Math.max(0, 1 - sp.life / 0.9);
        if (f <= 0) { sparks.splice(s, 1); continue; }
        ctx.fillStyle = 'rgba(160,230,255,' + (f * 0.75).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(sp.x, sp.y, 1.5 * f + 0.5, 0, 6.283); ctx.fill();
      }
    }

    function texts(pr, left) {
      var i = Math.min(lessons.length - 1, Math.floor(pr * lessons.length));
      if (i !== cur) {
        cur = i;
        h3.style.opacity = 0; p.style.opacity = 0;
        setTimeout(function () {
          h3.textContent = lessons[i].t; p.textContent = lessons[i].e;
          h3.style.opacity = 1; p.style.opacity = 1;
        }, 160);
      }
      etaEl.textContent = pr >= 1
        ? 'движок готов · ждём времени'
        : 'готов через ' + Math.floor(left / 60) + ':' + ('0' + Math.round(left % 60)).slice(-2);
    }
    h3.style.transition = p.style.transition = 'opacity .16s ease';

    function frame(ms) {
      if (!W && !fit()) { raf = requestAnimationFrame(frame); return; }
      var t = ms / 1000;
      if (!t0) t0 = t;
      var elapsed = t - t0;
      var left = Math.max(0, eta - elapsed);
      var pr = eta ? Math.min(1, elapsed / eta) : 1;
      ctx.clearRect(0, 0, W, H);
      engine(t, pr);
      texts(pr, left);
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
      if (poll) { clearInterval(poll); poll = null; }
    }

    // Окно не гадает: раз в 20 секунд переспрашивает оркестратор. Если карта
    // прогрелась раньше срока или встреча отменилась — окно честно закроется.
    var poll = booking ? setInterval(function () {
      api('/readiness?bookingId=' + encodeURIComponent(booking.id))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (!s) return;
          if (s.state === 'hot' || s.state === 'not-confirmed') {
            stop(); wrap.remove(); warmShownFor = null;
            return;
          }
          if (typeof s.etaSeconds === 'number') { eta = Math.max(0, s.etaSeconds); t0 = 0; }
        }).catch(function () {});
    }, 20000) : null;

    raf = requestAnimationFrame(frame);
  }

  /* -------------------------------------------------------------- запуск */
  function boot() {
    loadNames().then(loadWarm).then(function () { mountButtons(); loadUpcoming(); });
    new MutationObserver(function () { mountButtons(); }).observe(document.body, { childList: true, subtree: true });
    // Раз в двадцать секунд: приглашение должно догонять человека быстро.
    setInterval(function () { loadNames(); loadWarm(); loadUpcoming(); }, 20000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
