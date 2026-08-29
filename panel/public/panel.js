/* SameVoice dev panel — browser side.
 *
 * Plain script, no modules and no build step, for the same reason the rest of
 * this repo's tooling is plain node: one less thing that can be stale while you
 * are debugging something else. The formatters that matter (handoff, prompt)
 * live on the server in panel/lib/handoff.mjs and are unit-tested there; this
 * file only renders and copies what the server produced.
 */
(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };
  var state = { origin: "prod", origins: {}, users: [], tasks: [], selected: null, env: [] };

  // ------------------------------------------------------------------ utils

  function api(path, options) {
    return fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options))
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); });
  }

  function text(el, value) { el.textContent = value == null ? "" : String(value); }

  /** Clipboard, with an honest failure label: a silent "Скопировано" that did
   *  nothing is worse than a visible refusal. */
  function copy(button, value) {
    var done = function (label) {
      var was = button.dataset.label || button.textContent;
      button.dataset.label = was;
      button.textContent = label;
      setTimeout(function () { button.textContent = was; }, 1600);
    };
    if (!navigator.clipboard) { done("Не скопировано"); return; }
    navigator.clipboard.writeText(value).then(
      function () { done("Скопировано"); },
      function () { done("Не скопировано"); },
    );
  }

  // ---------------------------------------------------------------- preview

  function appOrigin() {
    return state.origin === "prod" ? state.origins.prod : state.origins.localApp;
  }

  function previewUrl() {
    var who = $("#identity").value;
    var base = appOrigin() || "";
    // No identity yet means the users list has not arrived. Loading the app
    // with an empty `me` shows its "unknown user" screen, which looked like a
    // broken panel on first paint; wait instead.
    if (!base || !who) return "";
    return base + "/?me=" + encodeURIComponent(who);
  }

  function renderPreview() {
    var url = previewUrl();
    var frame = $("#app");
    if (url && frame.getAttribute("src") !== url) frame.setAttribute("src", url);
  }

  // ------------------------------------------------------------------ state

  function renderHealth(health) {
    var set = function (el, probe, label) {
      el.textContent = label + " " + (probe && probe.ok ? probe.ms + " мс" : "—");
      el.className = "pill " + (probe && probe.ok ? "ok" : "bad");
    };
    set($("#health-prod"), health.prod, "прод");
    set($("#health-local"), health.local, "локально");
  }

  var GROUPS = [
    ["Распознавание", ["STT_PROVIDER", "DEEPGRAM_API_KEY", "DEEPGRAM_MODEL", "DEEPGRAM_BASE_URL"]],
    ["Перевод", ["MT_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL"]],
    ["Синтез", ["CARTESIA_API_KEY", "CARTESIA_MODEL", "CARTESIA_VOICE_RU", "CARTESIA_VOICE_HE", "TTS_PROVIDER"]],
    ["Транспорт", ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "PUBLIC_WEB_ORIGIN", "AGENT_SHARED_SECRET"]],
  ];

  function renderEnv(env) {
    state.env = env;
    var byName = {};
    env.forEach(function (item) { byName[item.name] = item; });

    var host = $("#env-groups");
    host.innerHTML = "";

    GROUPS.forEach(function (pair) {
      var box = document.createElement("div");
      box.className = "group";
      var h = document.createElement("h3");
      h.textContent = pair[0];
      box.appendChild(h);

      pair[1].forEach(function (name) {
        var item = byName[name];
        if (!item) return;
        var row = document.createElement("div");
        row.className = "field";

        var label = document.createElement("label");
        label.textContent = name;
        label.setAttribute("for", "f-" + name);

        var input = document.createElement("input");
        input.id = "f-" + name;
        input.type = item.secret ? "password" : "text";
        input.value = item.secret ? "" : (item.value || "");
        input.placeholder = item.secret
          ? (item.set ? item.masked + " — введите новый, чтобы заменить" : "не задан")
          : "не задан";
        input.addEventListener("change", function () { save(name, input.value); });

        var st = document.createElement("span");
        st.className = "state " + (item.set ? "set" : "unset");
        st.textContent = item.set ? "задан" : "пусто";

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(st);
        box.appendChild(row);
      });

      host.appendChild(box);
    });
  }

  function save(name, value) {
    if (value === "") return; // empty means "leave it alone", not "erase it"
    var patch = {};
    patch[name] = value;
    api("/api/env", { method: "POST", body: JSON.stringify({ patch: patch }) }).then(function (r) {
      var note = $("#env-note");
      if (!r.ok) { note.className = "note bad"; text(note, r.body.error || "не сохранено"); return; }
      note.className = "note ok";
      text(note, r.body.note + " Изменено: " + r.body.changed.join(", "));
      renderEnv(r.body.env);
    });
  }

  function renderProgress(data) {
    var git = data.git || {};
    var host = $("#progress-body");
    host.innerHTML = "";

    var dl = document.createElement("dl");
    dl.className = "stat";
    var add = function (k, v) {
      var dt = document.createElement("dt"); dt.textContent = k;
      var dd = document.createElement("dd"); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    };
    add("Ветка", git.branch || "—");
    add("Не закоммичено", git.dirty ? git.dirty + " файл(ов)" : "чисто");
    var agent = data.health && data.health.prod && data.health.prod.body;
    add("Прод бэкенд", data.health.prod.ok ? "жив, " + data.health.prod.ms + " мс" : "недоступен");
    add("Провайдеры", agent && agent.providers ? JSON.stringify(agent.providers) : "—");
    host.appendChild(dl);

    var h = document.createElement("h3");
    h.textContent = "Последние коммиты";
    h.style.fontSize = "13px";
    host.appendChild(h);

    var ul = document.createElement("ul");
    ul.className = "commits";
    (git.commits || []).forEach(function (c) {
      var li = document.createElement("li");
      var a = document.createElement("span"); a.className = "h"; a.textContent = c.hash;
      var b = document.createElement("span"); b.className = "d"; b.textContent = c.date;
      var s = document.createElement("span"); s.textContent = c.subject;
      li.appendChild(a); li.appendChild(b); li.appendChild(s);
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }

  function loadState() {
    return api("/api/state").then(function (r) {
      if (!r.ok) return;
      state.origins = r.body.origins || {};
      renderHealth(r.body.health || {});
      renderEnv(r.body.env || []);
      renderProgress(r.body);
      renderPreview();
    });
  }

  function loadUsers() {
    return api("/api/users").then(function (r) {
      var sel = $("#identity");
      sel.innerHTML = "";
      var users = (r.body && r.body.users) || [];
      state.users = users;
      if (!users.length) {
        sel.innerHTML = '<option value="">нет данных</option>';
        return;
      }
      users.forEach(function (u) {
        var o = document.createElement("option");
        o.value = u.id;
        o.textContent = u.displayName + " · " + u.lang + " · " + u.gender;
        sel.appendChild(o);
      });
      renderPreview();
    });
  }

  function loadDocs() {
    return api("/api/docs").then(function (r) {
      var sel = $("#doc-list");
      sel.innerHTML = '<option value="">— документ из репозитория —</option>';
      ((r.body && r.body.docs) || []).forEach(function (d) {
        var o = document.createElement("option");
        o.value = d.path;
        o.textContent = d.path;
        sel.appendChild(o);
      });
    });
  }

  // ------------------------------------------------------------------ tasks

  function renderTasks() {
    var ul = $("#task-list");
    ul.innerHTML = "";
    state.tasks.forEach(function (task) {
      var li = document.createElement("li");
      li.dataset.id = task.id;
      if (state.selected && state.selected.id === task.id) li.className = "is-on";
      var t = document.createElement("div"); t.className = "t"; t.textContent = task.title;
      var g = document.createElement("div"); g.className = "g"; g.textContent = task.goal;
      li.appendChild(t); li.appendChild(g);
      li.addEventListener("click", function () { select(task); });
      ul.appendChild(li);
    });
  }

  function select(task) {
    state.selected = task;
    renderTasks();
    $("#task-detail").hidden = false;
    text($("#d-title"), task.title);
    text($("#d-goal"), task.goal);
    text($("#d-handoff"), task.handoff);
    text($("#d-prompt"), task.prompt);
  }

  function loadDoc() {
    var path = $("#doc-list").value;
    var note = $("#doc-note");
    if (!path) { note.className = "note"; text(note, "Выберите документ."); return; }
    api("/api/doc?path=" + encodeURIComponent(path)).then(function (r) {
      if (!r.ok) { note.className = "note bad"; text(note, r.body.error || "не прочитан"); return; }
      state.tasks = r.body.tasks || [];
      state.selected = null;
      $("#task-detail").hidden = true;
      note.className = "note";
      text(note, state.tasks.length
        ? "Найдено разделов: " + state.tasks.length + ". Выберите один."
        : "В документе нет заголовков ## — разбирать нечего.");
      renderTasks();
    });
  }

  // ------------------------------------------------------------------- init

  function initTabs() {
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("is-on"); });
        document.querySelectorAll(".tabpane").forEach(function (p) { p.classList.remove("is-on"); });
        tab.classList.add("is-on");
        document.querySelector('[data-pane="' + tab.dataset.tab + '"]').classList.add("is-on");
      });
    });
  }

  function initSplit() {
    var gutter = $("#gutter");
    var dragging = false;
    var apply = function (clientX) {
      var pct = Math.min(80, Math.max(20, (clientX / window.innerWidth) * 100));
      document.documentElement.style.setProperty("--split", pct + "%");
    };
    gutter.addEventListener("mousedown", function () { dragging = true; document.body.style.userSelect = "none"; });
    window.addEventListener("mousemove", function (e) { if (dragging) apply(e.clientX); });
    window.addEventListener("mouseup", function () { dragging = false; document.body.style.userSelect = ""; });
    // Keyboard, so the split is reachable without a pointer.
    gutter.addEventListener("keydown", function (e) {
      var cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--split")) || 52;
      if (e.key === "ArrowLeft") apply(((cur - 4) / 100) * window.innerWidth);
      if (e.key === "ArrowRight") apply(((cur + 4) / 100) * window.innerWidth);
    });
  }

  function init() {
    initTabs();
    initSplit();

    document.querySelectorAll(".seg-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".seg-btn").forEach(function (b) { b.classList.remove("is-on"); });
        btn.classList.add("is-on");
        state.origin = btn.dataset.origin;
        renderPreview();
      });
    });

    $("#identity").addEventListener("change", renderPreview);
    $("#open-tab").addEventListener("click", function () {
      var url = previewUrl();
      if (url) window.open(url, "_blank", "noopener");
    });
    $("#hint-close").addEventListener("click", function () { $("#frame-hint").hidden = true; });
    $("#refresh").addEventListener("click", function () { loadState(); loadUsers(); loadDocs(); });
    $("#doc-load").addEventListener("click", loadDoc);
    $("#copy-handoff").addEventListener("click", function () {
      if (state.selected) copy(this, state.selected.handoff);
    });
    $("#copy-prompt").addEventListener("click", function () {
      if (state.selected) copy(this, state.selected.prompt);
    });

    loadState();
    loadUsers();
    loadDocs();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
