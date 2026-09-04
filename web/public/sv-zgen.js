/* Тема ZGen с макета design/zgeneration.html — ЖИВОЙ ДВИЖОК, не перекраска.
 *
 * В ZGen у приложения макетная разметка: главный экран — КОЛЕСО с одним
 * именем-гигантом в центре (список контактов скрыт, но жив), экран звонка —
 * волна во весь экран и СЛОВА, летающие по центру (лента субтитров скрыта,
 * но жива — слова читаются из неё). Родные кнопки продолжают работать:
 * колесо лишь нажимает их программно, как палец.
 *
 * Правила безопасности: скрипт наблюдает DOM и ничего не знает о
 * внутренностях приложения; класс body.zg-on ставится только при живом
 * колесе — упал скрипт, класс не появился, приложение остаётся родным.
 * Активен ТОЛЬКО при data-sv-theme="zgen".
 */
(function () {
  var RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function zgen() { return document.documentElement.getAttribute('data-sv-theme') === 'zgen'; }
  function cssVar(name, fb) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  }
  function colRu() { return cssVar('--voice-1', '#2726FF'); }
  function colHe() { return cssVar('--voice-3', '#FF4D00'); }
  function colMag() { return cssVar('--voice-2', '#FF00B4'); }
  function langColor(lang) { return lang === 'he' ? colHe() : colRu(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function setText(n, t) { if (n.textContent !== t) n.textContent = t; }
  function setVar(n, k, v) { if (n.style.getPropertyValue(k) !== v) n.style.setProperty(k, v); }
  function rgba(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* ================= перелив-переход между экранами ================= */
  var flood = null, sweeping = false;
  function sweep() {
    if (!zgen() || RM || sweeping) return;
    if (!flood) {
      flood = document.createElement('div');
      flood.id = 'sv-zg-flood';
      flood.setAttribute('aria-hidden', 'true');
      document.body.appendChild(flood);
    }
    sweeping = true;
    flood.classList.remove('zg-anim', 'zg-cover', 'zg-up');
    flood.style.transform = 'translateY(103%)';
    void flood.offsetWidth;
    flood.style.transform = '';
    flood.classList.add('zg-anim', 'zg-cover');
    setTimeout(function () {
      flood.classList.add('zg-up');
      flood.classList.remove('zg-cover');
      setTimeout(function () { flood.classList.remove('zg-anim', 'zg-up'); sweeping = false; }, 440);
    }, 440);
  }

  /* ================= буквенный движок (слова и имена) ================= */
  function setWord(el, text, he, color, fsCap) {
    el.dir = he ? 'rtl' : 'ltr';
    if (he) el.setAttribute('lang', 'he'); else el.removeAttribute('lang');
    if (color) el.style.setProperty('--wc', color);
    el.textContent = '';
    var chars = Array.from(text);
    for (var i = 0; i < chars.length; i++) {
      var sp = document.createElement('span');
      sp.className = 'zg-lt';
      /* Обычный пробел в inline-block схлопывается в ноль — фраза слипается */
      sp.textContent = chars[i] === ' ' ? ' ' : chars[i];
      sp.style.setProperty('--i', i);
      sp.style.setProperty('--dx', (Math.random() * 90 - 45).toFixed(0) + 'px');
      sp.style.setProperty('--dy', (30 + Math.random() * 60).toFixed(0) + 'px');
      sp.style.setProperty('--rr', (Math.random() * 50 - 25).toFixed(0) + 'deg');
      el.appendChild(sp);
    }
    /* Кегль — от фактической ширины фразы: макетная формула 560/len лгала на
       узком экране, и длинная фраза заворачивалась на кнопки. */
    var maxW = Math.min(window.innerWidth, 620) - 36;
    el.style.whiteSpace = 'nowrap';
    el.style.fontSize = '100px';
    var w = el.scrollWidth || 1;
    el.style.fontSize = clamp(100 * maxW / w, 20, fsCap || (he ? 60 : 46)) + 'px';
  }
  function assemble(el) {
    el.classList.remove('zg-fade', 'zg-gone', 'zg-settled');
    el.classList.add('zg-enter');
    void el.offsetWidth;
    requestAnimationFrame(function () { el.classList.remove('zg-enter'); });
    /* Фоновая вкладка замораживает переходы; таймер дожимает буквы. */
    setTimeout(function () { el.classList.add('zg-settled'); }, 1400);
  }
  function scatter(el) {
    el.querySelectorAll('.zg-lt').forEach(function (sp) {
      sp.style.setProperty('--dy', (-40 - Math.random() * 110).toFixed(0) + 'px');
    });
    el.classList.remove('zg-settled');
    el.classList.add('zg-gone');
  }

  /* ============================ КОЛЕСО ============================ */
  var wheel = null, dotsEl = null, tagEl = null, pullEl = null, blob = null, trail = null, hintEl = null;
  var slides = [], cur = 0, target = 0, lastRound = -1;
  var STEP = 170;
  var wheelDirty = true;

  function contactsData() {
    var out = [];
    var cards = document.querySelectorAll('#contact-list li.card');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var nm = c.querySelector('.card-name');
      if (!nm) continue;
      var dirEl = c.querySelector('.card-dir');
      var dot = c.querySelector('.presence');
      out.push({
        id: c.dataset.userId || String(i),
        name: (nm.textContent || '').trim(),
        lang: nm.lang || 'ru',
        he: nm.dir === 'rtl',
        dirText: dirEl ? (dirEl.textContent || '').trim() : '',
        direct: !!(dirEl && dirEl.dataset && dirEl.dataset.direct),
        explain: (c.querySelector('.card-explain') || {}).textContent || '',
        state: dot && dot.dataset ? dot.dataset.state : 'unknown',
        callBtn: c.querySelector('.card-acts .btn'),
        bookBtn: c.querySelector('.card-acts .sv-book'),
      });
    }
    return out;
  }

  function sparkSvg(color) {
    return '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="' + color + '" d="M6 0 L7.4 4.6 L12 6 L7.4 7.4 L6 12 L4.6 7.4 L0 6 L4.6 4.6 Z"/></svg>';
  }
  function badgeSvg(c) {
    if (!c.direct) {
      return '<svg class="zg-bdg" viewBox="0 0 64 20" aria-hidden="true">'
        + '<path d="M2 10 Q10 2 18 10 T34 10" fill="none" stroke="' + colRu() + '" stroke-width="3" stroke-linecap="round"/>'
        + '<path d="M30 10 Q38 18 46 10 T62 10" fill="none" stroke="' + langColor(c.lang) + '" stroke-width="3" stroke-linecap="round"/>'
        + '</svg>';
    }
    return '<svg class="zg-bdg" viewBox="0 0 24 20" aria-hidden="true">'
      + '<circle cx="12" cy="10" r="7.5" fill="none" stroke="' + langColor(c.lang) + '" stroke-width="2.2" stroke-dasharray="3 3.6" stroke-linecap="round"/>'
      + '</svg>';
  }

  var data = [];
  function buildWheel() {
    if (!wheel) return;
    data = contactsData();
    wheel.textContent = '';
    dotsEl.textContent = '';
    slides = [];
    for (var i = 0; i < data.length; i++) {
      (function (c, i) {
        var s = document.createElement('div');
        s.className = 'zg-slide';
        var ca = langColor(c.lang);
        s.style.setProperty('--zca', ca);

        /* Перелив = будет перевод; сплошной цвет = один язык. Контур (hollow)
           в системе означает «вовне» — придержан до контура обычных номеров. */
        var nmCls = 'zg-nm ' + (c.direct ? 'zg-solid' : 'zg-duo');
        var chip = c.explain
          ? '<span class="zg-chip' + (c.direct ? ' zg-dash' : '') + '">' + sparkSvg(ca) + c.explain + '</span>' : '';
        s.innerHTML =
          badgeSvg(c)
          + '<div class="' + nmCls + '"' + (c.he ? ' dir="rtl" lang="he"' : '') + '></div>'
          + '<div class="zg-meta">'
          + '<span class="zg-alt">' + c.dirText + '</span>'
          + chip
          + '<div class="zg-ths">'
          + '<button type="button" class="zg-th" data-act="call" style="--tr:-2deg">позвонить ↑</button>'
          + (c.bookBtn ? '<button type="button" class="zg-th" data-act="book" style="--tr:2deg">договориться</button>' : '')
          + '</div></div>';
        s.querySelector('.zg-nm').textContent = c.name;

        s.querySelector('[data-act="call"]').addEventListener('click', function (e) {
          e.stopPropagation(); if (c.callBtn) c.callBtn.click();
        });
        var bb = s.querySelector('[data-act="book"]');
        if (bb) bb.addEventListener('click', function (e) {
          e.stopPropagation(); if (c.bookBtn) c.bookBtn.click();
        });
        s.querySelector('.zg-nm').addEventListener('click', function () {
          if (Math.round(target) === i && c.callBtn) c.callBtn.click();
          else target = i;
        });

        wheel.appendChild(s);
        slides.push(s);

        var d = document.createElement('button');
        d.type = 'button';
        d.className = 'zg-dot';
        d.setAttribute('aria-label', c.name);
        d.style.setProperty('--dotc', ca);
        d.addEventListener('click', function () { target = i; });
        dotsEl.appendChild(d);
      })(data[i], i);
    }
    cur = target = clamp(Math.round(target), 0, Math.max(0, data.length - 1));
    lastRound = -1;
    fitNames();
  }

  function fitNames() {
    var maxW = Math.min(window.innerWidth, 620) - 40;
    slides.forEach(function (s) {
      var nm = s.querySelector('.zg-nm');
      nm.style.fontSize = '100px';
      var w = nm.scrollWidth || 1;
      var cap = nm.dir === 'rtl' ? 190 : 150;
      nm.style.fontSize = clamp(100 * maxW / w, 42, cap) + 'px';
    });
  }

  function syncCurrent() {
    var r = clamp(Math.round(cur), 0, Math.max(0, data.length - 1));
    if (r === lastRound) return;
    lastRound = r;
    var c = data[r];
    if (!c) return;
    var ca = langColor(c.lang);
    if (pullEl) setVar(pullEl, '--zca', ca);
    var dots = dotsEl ? dotsEl.children : [];
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('zg-on', i === r);
  }

  function renderWheel() {
    for (var i = 0; i < slides.length; i++) {
      var off = i - cur, a = Math.abs(off), el = slides[i];
      if (a > 2.2) { el.style.visibility = 'hidden'; continue; }
      el.style.visibility = 'visible';
      el.style.transform = 'translate(-50%,-50%) translateY(' + (off * STEP) + 'px) rotateX(' + (off * -30) + 'deg) scale(' + (1 - Math.min(0.3, a * 0.2)) + ')';
      el.style.opacity = a < 0.5 ? 1 : Math.max(0.1, 0.5 - (a - 0.5) * 0.28);
      el.style.zIndex = a < 0.5 ? 3 : 1;
      var meta = el.querySelector('.zg-meta');
      if (meta) meta.style.opacity = Math.max(0, 1 - a * 2.6);
    }
    syncCurrent();
  }

  /* жесты колеса */
  var drag = null;
  function wheelGestures() {
    wheel.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.zg-th')) return;
      drag = { y0: e.clientY, cur0: cur, lastY: e.clientY, lastT: performance.now(), vy: 0 };
      try { wheel.setPointerCapture(e.pointerId); } catch (err) {}
    });
    wheel.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dy = e.clientY - drag.y0;
      var n = data.length;
      cur = clamp(drag.cur0 - dy / STEP, -0.35, n - 1 + 0.35);
      target = cur;
      var now = performance.now(), dt = now - drag.lastT;
      if (dt > 0) drag.vy = (e.clientY - drag.lastY) / dt;
      drag.lastY = e.clientY; drag.lastT = now;
    });
    function up() {
      if (!drag) return;
      var d = drag; drag = null;
      target = clamp(Math.round(cur - d.vy * 90 / STEP), 0, Math.max(0, data.length - 1));
    }
    wheel.addEventListener('pointerup', up);
    wheel.addEventListener('pointercancel', up);
    wheel.addEventListener('wheel', function (e) {
      e.preventDefault();
      var now = performance.now();
      if (now - (wheel._wl || 0) < 260) return;
      wheel._wl = now;
      target = clamp(Math.round(target) + (e.deltaY > 0 ? 1 : -1), 0, Math.max(0, data.length - 1));
    }, { passive: false });
  }

  /* сгусток: потяни вверх — звонок */
  var pull = null;
  function blobGestures() {
    blob.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      pull = { y0: e.clientY, t0: performance.now(), fired: false };
      blob.classList.remove('zg-spring');
      try { blob.setPointerCapture(e.pointerId); } catch (err) {}
    });
    blob.addEventListener('pointermove', function (e) {
      if (!pull || pull.fired) return;
      var dy = e.clientY - pull.y0;
      var upv = Math.max(0, -dy);
      blob.style.transform = 'translateY(' + Math.min(0, dy * 0.55) + 'px) scaleY(' + (1 + Math.min(0.4, upv / 300)) + ')';
      trail.style.height = (upv * 0.8) + 'px';
      if (upv >= 125) {
        pull.fired = true;
        blob.style.transform = '';
        trail.style.height = '0';
        var c = data[clamp(Math.round(target), 0, data.length - 1)];
        if (c && c.callBtn) c.callBtn.click();
      }
    });
    function done(e) {
      if (!pull) return;
      var p = pull; pull = null;
      blob.classList.add('zg-spring');
      blob.style.transform = '';
      trail.style.height = '0';
      if (p.fired) return;
      var dy = e.clientY - p.y0, dt = performance.now() - p.t0;
      if (Math.abs(dy) < 10 && dt < 400) {
        var c = data[clamp(Math.round(target), 0, data.length - 1)];
        if (c && c.callBtn) c.callBtn.click();
      }
    }
    blob.addEventListener('pointerup', done);
    blob.addEventListener('pointercancel', function () {
      if (pull) { pull = null; blob.classList.add('zg-spring'); blob.style.transform = ''; trail.style.height = '0'; }
    });
  }

  function mountWheel() {
    if (wheel) return;
    var host = document.getElementById('screen-contacts');
    if (!host) return;
    wheel = document.createElement('div');
    wheel.id = 'zg-wheel';
    dotsEl = document.createElement('div');
    dotsEl.id = 'zg-dots';
    dotsEl.setAttribute('aria-hidden', 'true');
    tagEl = document.createElement('div');
    tagEl.id = 'zg-tag';
    tagEl.textContent = 'внутри · samevoice';
    pullEl = document.createElement('div');
    pullEl.id = 'zg-pull';
    trail = document.createElement('div');
    trail.id = 'zg-trail';
    blob = document.createElement('button');
    blob.id = 'zg-blob';
    blob.type = 'button';
    blob.setAttribute('aria-label', 'Позвонить — потяни вверх');
    blob.innerHTML = '<svg width="26" height="16" viewBox="0 0 26 16" fill="none" aria-hidden="true"><path d="M3 13 L13 4 L23 13" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    hintEl = document.createElement('p');
    hintEl.id = 'zg-hint';
    hintEl.textContent = 'вверх — звонок · тап — выбрать';
    pullEl.append(trail, blob, hintEl);
    host.append(wheel, dotsEl, tagEl, pullEl);
    wheelGestures();
    blobGestures();
    buildWheel();
  }
  function unmountWheel() {
    [wheel, dotsEl, tagEl, pullEl].forEach(function (n) { if (n) n.remove(); });
    wheel = dotsEl = tagEl = pullEl = blob = trail = hintEl = null;
    slides = []; data = [];
  }

  /* ==================== ЗВОНОК: волна и слова ==================== */
  var wave = null, wctx = null, srcW = null, dstW = null, guessEl = null, timerEl = null;
  var pulses = [], callT0 = 0, timerInt = null;
  var lastPartialKey = '', lastCommitKey = '', speakLang = null, quietT = null;

  function mountCallFx() {
    var screen = document.getElementById('screen-call');
    if (!screen || wave) return;
    wave = document.createElement('canvas');
    wave.id = 'zg-wave';
    wave.setAttribute('aria-hidden', 'true');
    wctx = wave.getContext('2d');
    srcW = document.createElement('div');
    srcW.id = 'zg-src';
    srcW.className = 'zg-wword';
    dstW = document.createElement('div');
    dstW.id = 'zg-dst';
    dstW.className = 'zg-wword';
    guessEl = document.createElement('p');
    guessEl.id = 'zg-guess';
    guessEl.textContent = 'догадка';
    /* На body, не в экран: у экрана бывает transform (анимация входа, жест
       «трубку вниз»), а fixed-потомок transform-элемента якорится к нему и
       уезжает из вьюпорта. */
    document.body.append(wave, srcW, dstW, guessEl);
    callT0 = performance.now();
    var head = screen.querySelector('.call-head');
    if (head && !timerEl) {
      timerEl = document.createElement('span');
      timerEl.className = 'zg-timer';
      timerEl.textContent = '00:00';
      head.appendChild(timerEl);
    }
    timerInt = setInterval(function () {
      if (!timerEl) return;
      var s = Math.floor((performance.now() - callT0) / 1000);
      setText(timerEl, (s < 600 ? '0' : '') + Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60));
    }, 1000);
    lastPartialKey = ''; lastCommitKey = ''; pulses = [];
  }
  function unmountCallFx() {
    [wave, srcW, dstW, guessEl, timerEl].forEach(function (n) { if (n) n.remove(); });
    wave = wctx = srcW = dstW = guessEl = timerEl = null;
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    var screen = document.getElementById('screen-call');
    if (screen) screen.classList.remove('zg-say-you', 'zg-say-them');
  }

  function peerLang() {
    var chip = document.getElementById('call-peer-lang');
    return (chip && chip.lang) || 'he';
  }

  /* слова из живой (скрытой) ленты субтитров */
  var lastSelfKey = '';
  function watchWords() {
    if (!srcW) return;
    /* моя речь не попадает в субтитры (там перевод ДЛЯ меня) — берём её из
       самоконтроля говорящего, который приложение обновляет всегда */
    var selfSrc = document.getElementById('selfmon-src');
    if (selfSrc) {
      var st = (selfSrc.textContent || '').trim();
      if (st && st !== lastSelfKey) {
        lastSelfKey = st;
        speakLang = peerLang() === 'he' ? 'ru' : 'he';
        onSpeak();
      }
    }
    var partial = document.querySelector('#subtitle-partial .sub-line');
    if (partial) {
      var o = partial.querySelector('.sub-original');
      var txt = o ? (o.textContent || '').trim() : '';
      var key = (o ? o.lang : '') + '|' + txt;
      if (txt && key !== lastPartialKey) {
        lastPartialKey = key;
        speakLang = o.lang || null;
        setWord(srcW, txt, o.lang === 'he', langColor(o.lang || 'ru'));
        srcW.classList.add('zg-ghost');
        guessEl.classList.add('zg-show');
        assemble(srcW);
        onSpeak();
      }
    }
    var lastLine = document.querySelector('#subtitle-committed .sub-line:last-child');
    if (lastLine) {
      var t = lastLine.querySelector('.sub-translation');
      var s2 = lastLine.querySelector('.sub-original');
      var dtxt = t ? (t.textContent || '').trim() : '';
      var key2 = (t ? t.lang : '') + '|' + dtxt;
      if (dtxt && key2 !== lastCommitKey) {
        lastCommitKey = key2;
        /* источник дозрел: показать его целиком без контура, затем рассыпать */
        if (s2) {
          var stxt = (s2.textContent || '').trim();
          if (stxt) {
            setWord(srcW, stxt, s2.lang === 'he', langColor(s2.lang || 'ru'));
            srcW.classList.remove('zg-ghost');
            srcW.classList.add('zg-settled');
          }
        }
        guessEl.classList.remove('zg-show');
        lastPartialKey = '';
        setTimeout(function () { if (srcW) scatter(srcW); }, 900);
        setWord(dstW, dtxt, t.lang === 'he', langColor(t.lang || 'ru'));
        assemble(dstW);
        pulses.push({ t0: performance.now(), dir: t.lang === peerLang() ? 1 : -1, color: langColor(t.lang || 'ru') });
        setTimeout(function () { if (dstW && (dstW.textContent || '').trim() === dtxt) dstW.classList.add('zg-fade'); }, 5200);
      }
    }
  }

  function onSpeak() {
    var screen = document.getElementById('screen-call');
    if (!screen) return;
    var mine = speakLang && speakLang !== peerLang();
    screen.classList.toggle('zg-say-you', !!mine);
    screen.classList.toggle('zg-say-them', !mine && !!speakLang);
    if (chipYou) {
      chipYou.classList.toggle('zg-live', !!mine);
      chipThem.classList.toggle('zg-live', !mine && !!speakLang);
      if (flowEl && speakLang) {
        /* Пунктир окрашен в язык ИСТОЧНИКА речи — как в макете */
        setVar(flowEl, '--zfc', langColor(speakLang));
        flowEl.classList.toggle('zg-you', !!mine);
        flowEl.classList.toggle('zg-them', !mine);
      }
    }
    clearTimeout(quietT);
    quietT = setTimeout(function () {
      if (!screen) return;
      screen.classList.remove('zg-say-you', 'zg-say-them');
      if (chipYou) { chipYou.classList.remove('zg-live'); chipThem.classList.remove('zg-live'); }
    }, 2600);
  }

  /* волна во весь экран — макетные три слоя и пульсы перевода */
  var LAYERS = [
    { a: 1, f1: 0.017, f2: 0.031, sp: 1.6, ph: 0, lw: 2.6, al: 0.95 },
    { a: 0.55, f1: 0.023, f2: 0.041, sp: 2.2, ph: 2.1, lw: 1.8, al: 0.55 },
    { a: 1.1, f1: 0.013, f2: 0.027, sp: 1.1, ph: 4.0, lw: 9, al: 0.10 },
  ];
  function drawWave(t) {
    if (!wave || !wctx) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = wave.clientWidth, H = wave.clientHeight;
    if (!W || !H) return;
    if (wave.width !== Math.round(W * dpr) || wave.height !== Math.round(H * dpr)) {
      wave.width = Math.round(W * dpr); wave.height = Math.round(H * dpr);
    }
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wctx.clearRect(0, 0, W, H);
    var mid = H * 0.47, A0 = 56;
    var env = 0.35 + (+window.__voiceE || 0) * 0.9;
    var pl = peerLang();
    var grad = wctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, colRu());
    grad.addColorStop(0.5, colMag());
    grad.addColorStop(1, langColor(pl));
    wctx.lineCap = 'round';
    wctx.strokeStyle = grad;
    var mine = speakLang && speakLang !== pl;
    for (var L = 0; L < LAYERS.length; L++) {
      var ly = LAYERS[L];
      wctx.globalAlpha = ly.al;
      wctx.lineWidth = ly.lw;
      wctx.beginPath();
      for (var x = 0; x <= W; x += 5) {
        var p = x / W;
        var edge = Math.pow(Math.sin(Math.PI * p), 0.8);
        var bias = mine ? (1.25 - 0.55 * p) : speakLang ? (0.7 + 0.55 * p) : 1;
        var y = mid + env * A0 * ly.a * edge * bias * (
          Math.sin(x * ly.f1 + t * ly.sp + ly.ph) * 0.62
          + Math.sin(x * ly.f2 - t * ly.sp * 1.7) * 0.33
          + Math.sin(x * 0.006 + t * 0.6) * 0.3);
        if (x === 0) wctx.moveTo(x, y); else wctx.lineTo(x, y);
      }
      wctx.stroke();
    }
    var now = performance.now();
    for (var i = pulses.length - 1; i >= 0; i--) {
      var pu = pulses[i];
      var pp = (now - pu.t0) / 650;
      if (pp > 1) { pulses.splice(i, 1); continue; }
      var px = (pu.dir > 0 ? pp : 1 - pp) * W;
      var g = wctx.createRadialGradient(px, mid, 0, px, mid, 26);
      g.addColorStop(0, 'rgba(255,255,255,.95)');
      g.addColorStop(0.4, rgba(pu.color, 0.75));
      g.addColorStop(1, rgba(pu.color, 0));
      wctx.globalAlpha = 1 - pp * 0.6;
      wctx.fillStyle = g;
      wctx.beginPath();
      wctx.arc(px, mid, 26, 0, Math.PI * 2);
      wctx.fill();
    }
    wctx.globalAlpha = 1;
  }

  /* ============== полоса направления в шапке звонка ============== */
  var strip = null, chipYou = null, chipThem = null, flowEl = null;
  function ensureStrip() {
    if (strip && strip.isConnected) return strip;
    var head = document.querySelector('#screen-call .call-head');
    if (!head) return null;
    strip = document.createElement('div');
    strip.className = 'zg-dir';
    strip.setAttribute('aria-hidden', 'true');
    chipYou = document.createElement('span');
    chipYou.className = 'zg-dchip';
    flowEl = document.createElement('span');
    flowEl.className = 'zg-flow zg-you';
    flowEl.appendChild(document.createElement('i'));
    chipThem = document.createElement('span');
    chipThem.className = 'zg-dchip';
    strip.append(chipYou, flowEl, chipThem);
    head.appendChild(strip);
    return strip;
  }
  function paintStrip() {
    if (!ensureStrip()) return;
    var pl = peerLang();
    var peer = document.getElementById('call-peer-name');
    var peerName = peer ? (peer.textContent || '').trim() : '';
    setText(chipThem, (peerName ? peerName.slice(0, 12) + ' · ' : '') + (pl === 'he' ? 'עב' : 'ру'));
    setVar(chipThem, '--zc', langColor(pl));
    var mineLang = pl === 'he' ? 'ru' : 'he';
    setVar(chipYou, '--zc', langColor(mineLang));
    setText(chipYou, 'ты · ' + (mineLang === 'he' ? 'עב' : 'ру'));
  }

  /* имя собеседника — буквами */
  function assembleName() {
    var nm = document.getElementById('call-peer-name');
    if (!nm) return;
    var text = (nm.textContent || '').trim();
    if (!text || nm.dataset.zgDone === text || nm.querySelector('.zg-lt')) return;
    nm.dataset.zgDone = text;
    var he = nm.dir === 'rtl';
    var keepLang = nm.lang, keepDir = nm.dir;
    setWord(nm, text, he, langColor(keepLang === 'he' ? 'he' : 'ru'), he ? 76 : 56);
    nm.lang = keepLang; nm.dir = keepDir;
    nm.style.fontSize = '';
    nm.style.removeProperty('--wc');
    assemble(nm);
  }

  /* ========================= дирижёр ========================= */
  var callWasHidden = true, contactsSig = '';
  function contactsSignature() {
    var cards = document.querySelectorAll('#contact-list li.card');
    var s = '';
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var dot = c.querySelector('.presence');
      s += (c.dataset.userId || '') + ':' + ((dot && dot.dataset.state) || '') + ':' + (c.querySelector('.card-acts .sv-book') ? 'b' : '') + ';';
    }
    return s;
  }

  function tick() {
    if (!zgen()) return;
    var call = document.getElementById('screen-call');
    var contacts = document.getElementById('screen-contacts');
    var callOn = call && !call.hidden;

    if (callOn !== !callWasHidden) { /* состояние сменилось */ }
    if (call && call.hidden !== callWasHidden) {
      callWasHidden = call.hidden;
      sweep();
      if (!call.hidden) mountCallFx();
      else { unmountCallFx(); if (strip) { strip.remove(); strip = null; } }
    }
    if (callOn) {
      assembleName();
      paintStrip();
      watchWords();
    }
    if (contacts && !contacts.hidden) {
      mountWheel();
      var sig = contactsSignature();
      if (sig !== contactsSig) { contactsSig = sig; buildWheel(); }
    } else if (wheel) {
      unmountWheel();
      contactsSig = '';
    }
  }

  function onThemeChange() {
    var on = zgen();
    document.body.classList.toggle('zg-on', on);
    var callScreen = document.getElementById('screen-call');
    callWasHidden = !callScreen || callScreen.hidden;
    if (flood) {
      flood.classList.remove('zg-anim', 'zg-cover', 'zg-up');
      flood.style.transform = '';
      sweeping = false;
    }
    if (!on) {
      unmountWheel();
      unmountCallFx();
      if (strip) { strip.remove(); strip = null; }
      contactsSig = '';
      var nm = document.getElementById('call-peer-name');
      if (nm && nm.querySelector('.zg-lt')) {
        var t = nm.textContent;
        nm.textContent = t;
        nm.removeAttribute('data-zg-done');
        nm.classList.remove('zg-settled', 'zg-enter', 'zg-gone');
      }
    } else {
      tick();
    }
  }

  /* один общий кадр: колесо инерционно едет, волна дышит */
  function frame(ms) {
    if (zgen()) {
      if (slides.length) {
        if (!drag) {
          cur += (target - cur) * (RM ? 1 : 0.16);
          if (Math.abs(target - cur) < 0.002) cur = target;
        }
        renderWheel();
      }
      if (wave) drawWave(ms / 1000);
    }
    requestAnimationFrame(frame);
  }

  function boot() {
    document.body.classList.toggle('zg-on', zgen());
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes' && m.attributeName === 'data-sv-theme') { onThemeChange(); return; }
        /* свои узлы не считаем поводом перечитывать мир */
        if (m.target && m.target.closest &&
            m.target.closest('#zg-wheel, #zg-dots, #zg-pull, .zg-dir, #zg-src, #zg-dst, #sv-zg-flood')) continue;
        tick();
        return;
      }
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sv-theme'] });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-state'] });
    window.addEventListener('resize', function () { if (slides.length) fitNames(); });
    tick();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
