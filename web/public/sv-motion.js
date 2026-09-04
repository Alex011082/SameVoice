/* Живая часть утверждённого дизайна: нить голоса, жесты, волна разговора.
 *
 * Живёт отдельно от логики приложения и работает через наблюдение за DOM:
 * ни одна функция звонка отсюда не вызывается напрямую, жест лишь нажимает
 * ту же кнопку, что и палец. Значит оформление можно выключить целиком, и
 * приложение останется работоспособным.
 *
 * Одно отступление от макета, сделанное намеренно. В макете звонок начинался
 * свайпом ВВЕРХ по контакту — там список был короткий и не прокручивался. В
 * живом приложении вертикальный свайп это прокрутка, и такой жест воровал бы
 * её, приводя к случайным звонкам. Поэтому здесь протяжка ВБОК: то же
 * ощущение «тянешь и отпускаешь», но без конфликта со скроллом.
 */
(function () {
  var RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var threads = [];          // нити контактов
  var pull = {};             // сколько протянут каждый контакт: 0..1
  var callWave = null;       // волна экрана разговора

  /* ------------------------------------------------- цвет пары из ТЕМЫ */
  /* Нить не имеет своей палитры: она берёт цвета голоса у активной темы
     (--voice-1/2/3). В «тишине» это электрик-циан-маджента, в ZGen —
     ультрамарин русского, перелив и оранжевый иврита. Компонент не должен
     знать, какого цвета язык: это решает тема. */
  function themeVoice() {
    var cs = getComputedStyle(document.documentElement);
    var a = cs.getPropertyValue('--voice-1').trim() || '#4d5bff';
    var b = cs.getPropertyValue('--voice-2').trim() || '#22e3ff';
    var c = cs.getPropertyValue('--voice-3').trim() || '#ff3df2';
    return [a, b, c];
  }
  /* Различие пар — не в цвете, а в ритме: свой сдвиг фазы и своя доля
     перелива. Так все нити остаются в палитре темы и всё равно различимы. */
  function seedOf(seed) {
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
    return h;
  }

  function dpr() { return Math.min(2, window.devicePixelRatio || 1); }

  function fit(cv) {
    var r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var d = dpr();
    cv.width = Math.round(r.width * d);
    cv.height = Math.round(r.height * d);
    cv.getContext('2d').setTransform(d, 0, 0, d, 0, 0);
    cv._w = r.width; cv._h = r.height;
    return true;
  }

  /* Нить рождается ИЗ имени и уходит вправо — голос выходит из человека,
     а не перечёркивает его. x0 — правый край имени. */
  function strand(cv, t, amp, h1, h2, x0, alpha, yc, x1) {
    if (!cv._w && !fit(cv)) return;
    var x = cv.getContext('2d'), w = cv._w, h = cv._h;
    var mid = yc == null ? h / 2 : yc;
    var end = x1 == null ? w : Math.min(w, x1);
    x.clearRect(0, 0, w, h);
    var s = Math.max(0, Math.min(x0 || 0, end - 30)), span = Math.max(1, end - s);
    for (var k = 0; k < 3; k++) {
      var a = [.95, .5, .3][k] * (alpha == null ? 1 : alpha);
      var lw = [1.8, 1.2, .8][k], ph = k * 2.1, f = .021 + k * .006, spd = .9 + k * .35;
      x.beginPath();
      for (var px = s; px <= end; px += 3) {
        var u = (px - s) / span;
        var env = Math.sin(Math.PI * u) * Math.min(1, u * 7);
        var y = mid + env * (Math.sin(px * f + t * spd + ph) * amp
              + Math.sin(px * .052 - t * 1.7 + ph * 1.7) * amp * .45);
        if (px === s) x.moveTo(px, y); else x.lineTo(px, y);
      }
      var v = themeVoice();
      var g = x.createLinearGradient(s, 0, end, 0);
      // mix — доля перелива у этой пары: 0 ближе к первому цвету, 1 к третьему
      var mix = (h1 % 100) / 100;
      g.addColorStop(0, v[0]);
      g.addColorStop(Math.max(.15, Math.min(.85, .35 + mix * .3)), v[1]);
      g.addColorStop(1, v[2]);
      x.globalAlpha = a;
      x.strokeStyle = g; x.lineWidth = lw;
      if (k === 0 && !RM) { x.shadowColor = v[1]; x.shadowBlur = 8; }
      else x.shadowBlur = 0;
      x.stroke();
      x.globalAlpha = 1;
    }
    x.shadowBlur = 0;
  }

  /* ------------------------------------------------- нити у контактов */
  function attachThreads() {
    var list = document.getElementById('contact-list');
    if (!list) return;
    threads = [];
    var cards = list.querySelectorAll('li.card');
    for (var i = 0; i < cards.length; i++) {
      (function (card) {
        var head = card.querySelector('.card-head') || card;
        var name = card.querySelector('.card-name');
        if (!name) return;
        var cv = card.querySelector('canvas.sv-thread');
        if (!cv) {
          cv = document.createElement('canvas');
          cv.className = 'sv-thread';
          cv.setAttribute('aria-hidden', 'true');
          // Полотно — на строку с именем: нить идёт от имени до подписи
          // направления, как в макете.
          head.style.position = 'relative';
          head.appendChild(cv);
        }
        var id = card.dataset.userId || name.textContent || '?';
        var sd = seedOf(id);
        // Внешний номер (перевод не нужен) звучит тише: обесцвеченная нить.
        var dirEl = card.querySelector('.card-dir');
        var direct = !!(dirEl && dirEl.dataset && dirEl.dataset.direct);
        threads.push({ cv: cv, name: name, card: card, h1: sd, h2: sd, id: id,
          direct: direct, btn: card.querySelector('.card-dir'),
          dot: card.querySelector('.presence'), ph: (sd % 17) * .37 });
      })(cards[i]);
    }
  }

  /* --------------------------------------------- протяжка вбок = звонок */
  function gestures() {
    var list = document.getElementById('contact-list');
    if (!list || list._svGest) return;
    list._svGest = true;
    var start = null, card = null, id = null, decided = null;

    function reset(animate) {
      if (card) {
        card.style.transition = animate ? 'transform .35s cubic-bezier(.3,.85,.25,1)' : '';
        card.style.transform = '';
        card.classList.remove('sv-armed');
        var c = card;
        setTimeout(function () { c.style.transition = ''; }, 380);
      }
      if (id) pull[id] = 0;
      start = null; card = null; id = null; decided = null;
    }

    list.addEventListener('touchstart', function (e) {
      var el = e.target.closest ? e.target.closest('li.card') : null;
      if (!el || e.touches.length !== 1) return;
      if (e.target.closest('button, input, label, a')) return;   // кнопки живут своей жизнью
      card = el; id = el.dataset.userId || 'x';
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      decided = null;
    }, { passive: true });

    list.addEventListener('touchmove', function (e) {
      if (!start || !card) return;
      var dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
      if (decided === null) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // Прокрутка важнее жеста: при вертикальном намерении отходим сразу.
        decided = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'pull' : 'scroll';
        if (decided === 'scroll') { reset(false); return; }
      }
      if (decided !== 'pull') return;
      var d = Math.max(0, Math.min(dx, 120));
      pull[id] = d / 100;
      card.style.transform = 'translateX(' + (d * .55) + 'px)';
      card.classList.toggle('sv-armed', d >= 100);
    }, { passive: true });

    list.addEventListener('touchend', function (e) {
      if (!card || decided !== 'pull') { reset(true); return; }
      var armed = card.classList.contains('sv-armed');
      var btn = card.querySelector('button.btn');
      reset(true);
      if (armed && btn) btn.click();
    }, { passive: true });

    list.addEventListener('touchcancel', function () { reset(true); }, { passive: true });
  }

  /* ------------------------------------------- волна на экране разговора */
  function attachCall() {
    var screen = document.getElementById('screen-call');
    if (!screen) return;
    var cv = screen.querySelector('canvas.sv-callwave');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.className = 'sv-callwave';
      cv.setAttribute('aria-hidden', 'true');
      var head = screen.querySelector('.call-head');
      if (head && head.nextSibling) screen.insertBefore(cv, head.nextSibling);
      else screen.insertBefore(cv, screen.firstChild);
    }
    var peer = document.getElementById('call-peer-name');
    var sd = seedOf((peer && peer.textContent) || 'peer');
    callWave = { cv: cv, h1: sd, h2: sd };

    // Жест «положить трубку»: протяжка вниз по шапке разговора. Субтитры
    // ниже прокручиваются, поэтому жест берётся только с неподвижной части.
    var head = screen.querySelector('.call-head');
    if (head && !head._svGest) {
      head._svGest = true;
      var y0 = null;
      head.addEventListener('touchstart', function (e) { y0 = e.touches[0].clientY; }, { passive: true });
      head.addEventListener('touchmove', function (e) {
        if (y0 === null) return;
        var dy = Math.max(0, e.touches[0].clientY - y0);
        screen.style.transform = 'translateY(' + Math.min(dy * .4, 90) + 'px)';
        screen.classList.toggle('sv-armed', dy > 140);
      }, { passive: true });
      head.addEventListener('touchend', function (e) {
        var armed = screen.classList.contains('sv-armed');
        screen.style.transition = 'transform .35s cubic-bezier(.3,.85,.25,1)';
        screen.style.transform = ''; screen.classList.remove('sv-armed');
        setTimeout(function () { screen.style.transition = ''; }, 380);
        y0 = null;
        if (armed) { var b = document.getElementById('btn-hangup'); if (b) b.click(); }
      }, { passive: true });
    }
  }

  /* -------------------------------------- громкость собеседника из звука */
  var analyser = null, audioCtx = null, buf = null;
  function listenToAudio() {
    var sink = document.getElementById('audio-sink');
    if (!sink || analyser) return;
    var el = sink.querySelector('audio');
    if (!el || !el.srcObject) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaStreamSource(el.srcObject);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      buf = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);           // только анализ: в выход не подаём,
                                       // иначе голос зазвучит дважды
    } catch (e) { analyser = null; }
  }
  function level() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
  }

  /* ------------------------------------------------------------- кадр */
  var smooth = 0;
  function frame(ms) {
    var t = ms / 1000;
    var callVisible = (function () {
      var s = document.getElementById('screen-call');
      return s && !s.hidden;
    })();

    if (callVisible) {
      listenToAudio();
      var raw = level();
      smooth += (raw - smooth) * .25;
      window.__voiceE = smooth;                  // космос дышит от голоса
      if (callWave) {
        var cv = callWave.cv;
        if (cv._w || fit(cv)) {
          var amp = 14 + smooth * 62;
          strand(cv, t, RM ? 10 : amp, callWave.h1, callWave.h2, 0, 1);
        }
      }
    } else {
      window.__voiceE = 0;
      for (var i = 0; i < threads.length; i++) {
        var th = threads[i];
        if (!th.cv.isConnected) continue;
        var p = pull[th.id] || 0;
        var amp = 9 + p * 30 + (RM ? 0 : Math.sin(t * 1.3 + th.ph) * 2.6);
        var cr = th.cv.getBoundingClientRect(), nr = th.name.getBoundingClientRect();
        if (!cr.width) continue;
        var x0 = (nr.right - cr.left) + 14;       // нить рождается из имени
        var yc = (nr.top + nr.height / 2) - cr.top;
        // Правый край: нить не должна нырять под кнопку звонка.
        var x1 = cr.width;
        if (th.btn) {
          var br = th.btn.getBoundingClientRect();
          if (br.width) x1 = Math.max(x0 + 30, (br.left - cr.left) - 12);
        }
        // Человек в сети — нить живее; не в сети — почти спокойная.
        var state = th.dot && th.dot.dataset ? th.dot.dataset.state : 'unknown';
        var life = state === 'online' ? 1 : state === 'offline' ? .45 : .7;
        strand(th.cv, t * .9 + th.ph, amp * life, th.h1, th.h2, x0,
          (th.direct ? .32 : 1) * (state === 'offline' ? .55 : 1), yc, x1);
      }
    }
    requestAnimationFrame(frame);
  }

  /* Список перерисовывается приложением — следим и переприцепляемся. */
  function watch() {
    var mo = new MutationObserver(function () { attachThreads(); gestures(); attachCall(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    attachThreads(); gestures(); attachCall(); watch();
    window.addEventListener('resize', function () {
      threads.forEach(function (t) { t.cv._w = 0; });
      if (callWave) callWave.cv._w = 0;
    });
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
