// Кнопка «Старт» GPU-движка на главном экране SameVoice.
// Видна только там, где в браузере лежит ключ (sv-engine-key):
// первый раз открыть страницу по ссылке с #engine-key=<ключ> — он сохранится.
// Красная — движок выключен; нажатие запускает. Пульсирует — греется.
// Зелёная + сигнал — готов, можно звонить. Нажатие по зелёной — выключить.
(function () {
  try {
    var m = (location.hash || "").match(/engine-key=([a-f0-9]+)/);
    if (m) { localStorage.setItem("sv-engine-key", m[1]); history.replaceState(null, "", location.pathname); }
  } catch (e) {}
  var KEY; try { KEY = localStorage.getItem("sv-engine-key"); } catch (e) {}
  if (!KEY) return;

  var css = document.createElement("style");
  css.textContent = "#sv-eng{position:fixed;right:16px;bottom:88px;z-index:9999;width:74px;height:74px;" +
    "border-radius:50%;border:none;cursor:pointer;color:#fff;font:600 12px/1.25 system-ui,sans-serif;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.35);transition:background .3s}" +
    "#sv-eng.off{background:#C62828}#sv-eng.err{background:#C62828;outline:3px solid #FFD54F}" +
    "#sv-eng.starting{background:#C62828;animation:svp 1.1s infinite}" +
    "#sv-eng.ready{background:#2E7D32}" +
    "@keyframes svp{0%,100%{transform:scale(1)}50%{transform:scale(1.09)}}";
  document.head.appendChild(css);
  var b = document.createElement("button");
  b.id = "sv-eng"; b.className = "off"; b.textContent = "Старт";
  (function () {
    var host = document.querySelector('.sv-lab');
    if (!host) {
      host = document.createElement('div');
      host.className = 'sv-lab';
      var app = document.getElementById('app') || document.body;
      app.appendChild(host);
    }
    host.appendChild(b);
  })();

  var audioCtx = null, wasReady = false, state = "off";

  function beep() {
    if (!audioCtx) return;
    try {
      var t = audioCtx.currentTime;
      [523, 659, 784].forEach(function (f, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.0001, t + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.17);
        o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.2);
      });
    } catch (e) {}
  }

  function render(s) {
    state = s.state;
    if (s.state === "ready") {
      b.className = "ready"; b.textContent = "Движок\nготов";
      if (!wasReady) { wasReady = true; beep(); }
    } else if (s.state === "starting") {
      wasReady = false; b.className = "starting";
      var min = s.warmingSeconds ? Math.floor(s.warmingSeconds / 60) : 0;
      b.textContent = "Греется\n" + min + " мин";
    } else if (s.state === "error") {
      wasReady = false; b.className = "err"; b.textContent = "Ошибка";
      b.title = s.note || "";
    } else if (s.state === "stopping") {
      wasReady = false; b.className = "starting"; b.textContent = "Гашу…";
    } else { wasReady = false; b.className = "off"; b.textContent = "Старт"; }
  }

  function api(path, method) {
    return fetch("/engine/" + path, { method: method || "GET", headers: { "x-engine-key": KEY } })
      .then(function (r) { if (r.status === 403) throw new Error("ключ не подошёл"); return r.json(); });
  }

  function poll() { api("status").then(render).catch(function () {}); }
  setInterval(poll, 8000); poll();

  b.addEventListener("click", function () {
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume && audioCtx.resume(); } catch (e) {}
    if (state === "ready") {
      if (confirm("Выключить движок? (вернётся облачная цепочка)")) api("stop", "POST").then(render);
    } else if (state === "off" || state === "error") {
      render({ state: "starting", warmingSeconds: 0 });
      api("start", "POST").then(render).catch(function (e) { render({ state: "error", note: String(e) }); });
    }
  });
})();
