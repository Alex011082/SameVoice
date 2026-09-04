/* Две шкуры SameVoice и живой космос под интерфейсом.
 *
 * Живёт отдельным файлом, а не внутри приложения, намеренно: тема — это
 * оформление, и она не должна путаться с логикой звонка. Отсюда же правило —
 * скрипт ничего не знает о внутренностях приложения и работает только с
 * атрибутом на корне и собственным холстом.
 *
 * Темы (design/DESIGN-SYSTEM.md):
 *   тишина  — тьма, космос под интерфейсом, свет = голос (по умолчанию)
 *   zgen    — светлый холст, поп-арт: язык = цвет
 */
(function () {
  var KEY = 'sv-theme';
  var THEMES = ['тишина', 'zgen'];
  var root = document.documentElement;

  function current() {
    try {
      var v = localStorage.getItem(KEY);
      return THEMES.indexOf(v) >= 0 ? v : 'тишина';
    } catch (e) { return 'тишина'; }
  }

  function apply(name) {
    root.setAttribute('data-sv-theme', name);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', name === 'zgen' ? '#F3F3F7' : '#05030e');
    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', name === 'zgen' ? 'light' : 'dark');
    try { localStorage.setItem(KEY, name); } catch (e) {}
    var btn = document.getElementById('sv-theme-btn');
    if (btn) btn.textContent = name === 'zgen' ? 'ZGen' : 'Тишина';
    if (window.__svCosmos) window.__svCosmos.setActive(name !== 'zgen');
  }

  apply(current());

  /* Настройки приложения тоже переключают тему — наружу отдаём ровно два
     крючка, внутренности остаются здесь. */
  window.__svTheme = { current: current, apply: apply };

  /* ---------------------------------------------------------------- космос */
  var cv = document.createElement('canvas');
  cv.id = 'sv-cosmos';
  cv.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(cv, document.body.firstChild);

  var ctx = cv.getContext('2d');
  var RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 0, H = 0, DPR = 1, stars = [], neb = null, shoot = null, nextShoot = 6, drift = 0;
  var active = true, raf = null;

  function nebula() {
    var c = document.createElement('canvas');
    c.width = 180;
    c.height = Math.max(60, Math.round(180 * H / (W || 1)));
    var g = c.getContext('2d');
    var blobs = [
      { x: .80, y: .05, r: .85, col: '120,70,255' },
      { x: .02, y: .62, r: .75, col: '0,170,235' },
      { x: .62, y: .95, r: .80, col: '255,60,230' },
      { x: .28, y: .34, r: .55, col: '90,120,255' }
    ];
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i], R = b.r * c.width;
      var gr = g.createRadialGradient(b.x * c.width, b.y * c.height, 0, b.x * c.width, b.y * c.height, R);
      gr.addColorStop(0, 'rgba(' + b.col + ',.30)');
      gr.addColorStop(.45, 'rgba(' + b.col + ',.10)');
      gr.addColorStop(1, 'rgba(' + b.col + ',0)');
      g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
    }
    return c;
  }

  function build() {
    var w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return;
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = w; H = h;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    stars = [];
    var n = Math.min(220, Math.round(W * H / 2600));
    for (var i = 0; i < n; i++) {
      var d = Math.random(), L = d < .55 ? 0 : (d < .86 ? 1 : 2), tint = Math.random();
      stars.push({
        x: Math.random() * W, y: Math.random() * H, L: L,
        r: L === 0 ? .55 + Math.random() * .45 : L === 1 ? .85 + Math.random() * .6 : 1.25 + Math.random() * 1.1,
        a: L === 0 ? .24 + Math.random() * .16 : L === 1 ? .36 + Math.random() * .26 : .52 + Math.random() * .32,
        tw: Math.random() * 6.283, tws: .35 + Math.random() * 1.5,
        hue: tint < .14 ? 195 : (tint < .24 ? 292 : null)
      });
    }
    neb = nebula();
  }

  function draw(t, dt) {
    if (!W) return;
    /* Громкость голоса поднимает яркость: во время разговора космос дышит.
       Значение пишет экран звонка, если умеет; нет — просто спокойный фон. */
    var e = +window.__voiceE || 0;
    ctx.clearRect(0, 0, W, H);
    if (neb) {
      ctx.globalCompositeOperation = 'lighter';
      var s1 = Math.sin(t * .045), s2 = Math.cos(t * .031);
      ctx.globalAlpha = .5 + e * .35;
      ctx.drawImage(neb, s1 * 14 - 10, s2 * 10 - 6, W * 1.14, H * 1.10);
      ctx.globalAlpha = .3 + e * .25;
      ctx.drawImage(neb, -s2 * 22 - 30, -s1 * 16 - 40, W * 1.32, H * 1.28);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    drift += dt * (RM ? 0 : 1);
    for (var i = 0; i < stars.length; i++) {
      var st = stars[i], y = st.y - drift * (2.5 + st.L * 4.5) * .35;
      y = ((y % (H + 40)) + (H + 40)) % (H + 40) - 20;
      var tw = RM ? .85 : (.62 + .38 * Math.sin(t * st.tws + st.tw));
      var a = st.a * tw * (1 + e * .5), rr = st.r * (1 + e * .22);
      ctx.fillStyle = st.hue !== null
        ? 'hsla(' + st.hue + ',100%,' + (st.hue === 195 ? 78 : 74) + '%,' + a.toFixed(3) + ')'
        : 'rgba(232,236,255,' + a.toFixed(3) + ')';
      if (st.L === 2) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 6 + e * 10; }
      ctx.beginPath(); ctx.arc(st.x, y, rr, 0, 6.283); ctx.fill();
      ctx.shadowBlur = 0;
    }
    if (!RM) {
      nextShoot -= dt;
      if (!shoot && nextShoot <= 0) {
        shoot = { x: W * (.15 + Math.random() * .7), y: -20, vx: -(60 + Math.random() * 70),
          vy: 210 + Math.random() * 130, life: 0, len: 90 + Math.random() * 70 };
        nextShoot = 9 + Math.random() * 14;
      }
      if (shoot) {
        shoot.life += dt; shoot.x += shoot.vx * dt; shoot.y += shoot.vy * dt;
        var f = Math.max(0, 1 - shoot.life / 1.5);
        var gx = shoot.x - shoot.vx * .0045 * shoot.len, gy = shoot.y - shoot.vy * .0045 * shoot.len;
        var g2 = ctx.createLinearGradient(shoot.x, shoot.y, gx, gy);
        g2.addColorStop(0, 'rgba(255,255,255,' + (.7 * f).toFixed(3) + ')');
        g2.addColorStop(.35, 'rgba(120,225,255,' + (.32 * f).toFixed(3) + ')');
        g2.addColorStop(1, 'rgba(120,225,255,0)');
        ctx.strokeStyle = g2; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(shoot.x, shoot.y); ctx.lineTo(gx, gy); ctx.stroke();
        if (shoot.y > H + 60 || f <= 0) shoot = null;
      }
    }
  }

  var last = 0;
  function loop(ms) {
    var t = ms / 1000, dt = last ? Math.min(.05, t - last) : 0;
    last = t;
    draw(t, dt);
    raf = requestAnimationFrame(loop);
  }

  window.__svCosmos = {
    setActive: function (on) {
      active = on;
      cv.style.display = on ? 'block' : 'none';
      if (on && raf === null) { last = 0; raf = requestAnimationFrame(loop); }
      if (!on && raf !== null) { cancelAnimationFrame(raf); raf = null; }
    }
  };

  build();
  window.addEventListener('resize', function () { build(); if (RM && active) draw(0, 0); });
  /* Вкладка в фоне: браузер и так тормозит кадры, но лишний расход батареи
     на телефоне во время разговора нам не нужен. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && raf !== null) { cancelAnimationFrame(raf); raf = null; }
    else if (!document.hidden && active && raf === null) { last = 0; raf = requestAnimationFrame(loop); }
  });
  if (RM) { draw(0, 0); } else { raf = requestAnimationFrame(loop); }
  window.__svCosmos.setActive(current() !== 'zgen');

  /* ------------------------------------------------------- переключатель */
  function mountButton() {
    var bar = document.getElementById('topbar');
    if (!bar || document.getElementById('sv-theme-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'sv-theme-btn';
    btn.type = 'button';
    btn.title = 'Сменить тему';
    btn.textContent = current() === 'zgen' ? 'ZGen' : 'Тишина';
    btn.addEventListener('click', function () {
      var next = current() === 'zgen' ? 'тишина' : 'zgen';
      apply(next);
    });
    bar.appendChild(btn);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton);
  } else {
    mountButton();
  }
})();
