'use strict';
/* Оркестратор SameVoice: брони -> гнёзда -> поды.
 *
 * Что делает: хранит брони, раскладывает их планировщиком (planner.cjs),
 * поднимает под к началу каждого гнезда, переключает боевого агента на
 * готовый под, гасит поды, когда гнездо кончилось и разговор стих.
 *
 * Уведомления: пуш в браузер обоим участникам (приглашение, подтверждение,
 * напоминания по личному выбору каждого, 2-3 сигнала перед разговором) и
 * автосозвон — если ОБА его включили, сервер сам создаёт звонок и соединяет
 * их, как телефонистка. Если хоть один не включил — обоим уходит сигнал
 * «пора», и человек нажимает сам: звонить тому, кто на это не соглашался,
 * нельзя.
 *
 * Разводка по звонкам: агент перед каждым звонком спрашивает
 * `GET /engine-for?a=&b=` — какой под обслуживает ЭТУ пару. Поэтому
 * одновременно живых гнёзд может быть сколько угодно, и соседние разговоры
 * идут на разные поды. Ответ даётся только про ГОТОВЫЙ под активного
 * гнезда: греющийся звонку не поможет, а адрес мёртвого хуже молчания.
 * Глобальное переключение агента осталось подстраховкой на случай, если
 * у агента не задан ORCHESTRATOR_URL.
 *
 * Слушает 127.0.0.1:9098, наружу — через Caddy на /orch/*, ключ x-engine-key.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { plan, decide, MIN } = require('./planner.cjs');
const { schedule, due } = require('./notifications.cjs');

const DIR = process.env.ORCH_DIR || '/opt/samevoice/orchestrator';
const DATA = path.join(DIR, 'data');
const DIST = process.env.ORCH_DIST || '/opt/samevoice/web/dist/eng';
const SWITCH = process.env.ORCH_SWITCH || '/opt/samevoice/engine-switch.sh';
const BASE_URL = process.env.ORCH_BASE_URL || 'https://samevoice.0110.digital';
const PORT = Number(process.env.ORCH_PORT || 9098);
const TICK_MS = 30 * 1000;

const PARAMS = {
  warmMinutes: Number(process.env.ORCH_WARM_MIN || 4),
  riskMinutes: Number(process.env.ORCH_RISK_MIN || 1),
  capacity: Number(process.env.ORCH_CAPACITY || 2),
  durationMinutes: Number(process.env.ORCH_DURATION_MIN || 20),
};

const env = {};
try {
  for (const line of fs.readFileSync(path.join(DIR, 'engine.env'), 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1).trim();
  }
} catch (e) { console.error('нет engine.env:', e.message); }

/* ---------------------------------------------------------------- хранение */

function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); }
  catch (e) { return fallback; }
}
function save(name, value) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = path.join(DATA, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, path.join(DATA, name));   // подмена целиком: файл не бывает полупустым
}

let bookings = load('bookings.json', []);
let subs = load('subscriptions.json', {});      // userId -> [подписки браузеров]
let sent = new Set(load('sent.json', []));      // id уже отправленных событий
let pods = load('pods.json', []);
const log = [];
function note(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  log.push(line); if (log.length > 300) log.shift();
  console.log(line);
}

/* ------------------------------------------------------------------ RunPod */

async function runpod(query, variables) {
  const r = await fetch('https://api.runpod.io/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RUNPOD_API_KEY },
    body: JSON.stringify(variables ? { query, variables } : { query }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await r.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}

async function createPod(windowStart) {
  const token = 'rd-' + crypto.randomBytes(8).toString('hex');
  const dir = path.join(DIST, token);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(DIR, 'payload.tgz'), path.join(dir, 'payload.tgz'));
  const boot = fs.readFileSync(path.join(DIR, 'bootstrap-template.sh'), 'utf8').replaceAll('RD_TOKEN', token);
  fs.writeFileSync(path.join(dir, 'bootstrap.sh'), boot);

  const check = await fetch(`${BASE_URL}/eng/${token}/bootstrap.sh`, { signal: AbortSignal.timeout(10000) });
  const head = await check.text();
  if (!check.ok || !head.startsWith('#!/bin/bash')) {
    throw new Error('раздача bootstrap не работает: ' + check.status);
  }

  const url = `${BASE_URL}/eng/${token}/bootstrap.sh`;
  const cmd = `bash -c 'curl -fsSL ${url} -o /tmp/b.sh || wget -qO /tmp/b.sh ${url}; bash /tmp/b.sh'`;
  const input = {
    cloudType: 'ALL', gpuCount: 1, volumeInGb: 0, containerDiskInGb: 80,
    minMemoryInGb: 24, minVcpuCount: 8, gpuTypeId: 'NVIDIA GeForce RTX 4090',
    name: `samevoice-engine-${token.slice(-6)}`,
    imageName: 'runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04',
    /* ОДИН порт: с тремя http-портами контейнер не стартует вовсе (01.09) */
    ports: '8000/http', dockerArgs: cmd,
    env: [{ key: 'HF_HOME', value: '/workspace/hf' }],
  };
  const d = await runpod(
    'mutation ($input: PodFindAndDeployOnDemandInput) { podFindAndDeployOnDemand(input: $input) { id machineId } }',
    { input });
  const p = d.podFindAndDeployOnDemand;
  if (!p) throw new Error('под не вернулся');
  return { id: p.id, machineId: p.machineId, token };
}

async function terminatePod(pod) {
  try { await runpod(`mutation { podTerminate(input: {podId: "${pod.id}"}) }`); } catch (e) { /* уже нет */ }
  if (pod.token) { try { fs.rmSync(path.join(DIST, pod.token), { recursive: true, force: true }); } catch (e) {} }
}

function switchAgent(args) {
  return new Promise((res, rej) => execFile('sudo', [SWITCH, ...args], { timeout: 60000 },
    (e, out, err) => e ? rej(new Error((err || '').trim() || String(e))) : res(out)));
}

async function podReady(pod) {
  try {
    const r = await fetch(`https://${pod.id}-8000.proxy.runpod.net/engine/healthz`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.service === 'engine';
  } catch (e) { return false; }
}

/* -------------------------------------------------------------- уведомления */

let push = null;
try {
  push = require('web-push');
  if (env.VAPID_PUBLIC && env.VAPID_PRIVATE) {
    push.setVapidDetails(env.VAPID_SUBJECT || 'mailto:hello@samevoice.0110.digital',
      env.VAPID_PUBLIC, env.VAPID_PRIVATE);
  } else { push = null; note('пуш выключен: нет ключей VAPID'); }
} catch (e) { note('пуш выключен: нет библиотеки web-push'); }

const TEXTS = {
  invite: (e) => ({ title: 'Предлагают поговорить', body: hhmm(e.payload.startsAt) + ' — подтвердить?' }),
  confirmed: (e) => ({ title: 'Договорились', body: 'Разговор в ' + hhmm(e.payload.startsAt) }),
  reminder: (e) => ({ title: 'Скоро разговор',
    body: 'через ' + e.payload.minutesBefore + ' мин · в ' + hhmm(e.payload.startsAt) }),
  signal: (e) => ({ title: 'Через ' + e.payload.minutesBefore + ' мин', body: 'Готовьтесь, сейчас начнём' }),
  handoff: (e) => ({ title: 'Пора звонить', body: 'Нажмите, чтобы соединиться' }),
  cancelled: (e) => ({ title: 'Встреча отменена', body: 'Разговор в ' + hhmm(e.payload.startsAt) + ' не состоится' }),
};

function hhmm(ms) {
  const d = new Date(ms);
  return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' UTC';
}

async function sendPush(userId, message) {
  const list = subs[userId] || [];
  if (!push || !list.length) return 0;
  let ok = 0;
  const alive = [];
  for (const s of list) {
    try {
      await push.sendNotification(s, JSON.stringify(message));
      ok++; alive.push(s);
    } catch (e) {
      // 404/410 — подписка мертва (браузер снесён, разрешение отозвано)
      if (e.statusCode === 404 || e.statusCode === 410) note(`подписка ${userId} протухла — убираю`);
      else { alive.push(s); note(`пуш ${userId} не ушёл: ${e.statusCode || e.message}`); }
    }
  }
  if (alive.length !== list.length) { subs[userId] = alive; save('subscriptions.json', subs); }
  return ok;
}

/** Автосозвон: сервер сам создаёт звонок обоим — как телефонистка. */
async function autoCall(payload) {
  const r = await fetch('http://127.0.0.1:8787/api/calls', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callerId: payload.callerId, calleeId: payload.calleeId, ring: true }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body && body.error && body.error.message) || ('HTTP ' + r.status));
  return body;
}

async function deliver() {
  const now = Date.now();
  for (const b of bookings) {
    let events;
    try { events = schedule(b); } catch (e) { note(`расписание ${b.id}: ${e.message}`); continue; }
    for (const e of due(events, now, sent)) {
      const stamp = b.id + '/' + e.id;
      if (sent.has(stamp)) continue;
      try {
        if (e.kind === 'autocall') {
          const res = await autoCall(e.payload);
          note(`автосозвон по ${b.id}: звонок ${res.call ? res.call.id : '?'} создан, звоним обоим`);
          for (const u of [e.payload.callerId, e.payload.calleeId]) {
            await sendPush(u, { title: 'Соединяю', body: 'Снимите трубку', tag: b.id, kind: 'autocall' });
          }
        } else {
          const make = TEXTS[e.kind];
          if (make && e.to) {
            const n = await sendPush(e.to, Object.assign(make(e), { tag: b.id, kind: e.kind, bookingId: b.id }));
            if (!n) note(`некому доставить ${e.kind} для ${e.to} (нет подписки)`);
          }
        }
        sent.add(stamp);
      } catch (err) {
        note(`событие ${e.kind} по ${b.id} не отправлено: ${err.message}`);
        sent.add(stamp);   // не долбим бесконечно: одна попытка на событие
      }
    }
  }
  if (sent.size > 5000) sent = new Set([...sent].slice(-2000));
  save('sent.json', [...sent]);
}

/* ------------------------------------------------------------- согласование */

let ticking = false;

async function reconcile() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const live = bookings.filter((b) => b.state === 'confirmed' && b.startsAt + (b.durationMinutes || PARAMS.durationMinutes) * MIN > now - 5 * MIN);
    const windows = plan(live, PARAMS);
    const acts = decide(windows, pods, now, PARAMS);

    for (const w of acts.warm) {
      if (pods.some((p) => String(p.windowStart) === String(w.windowStart) && p.state !== 'gone')) continue;
      note(`гнездо ${new Date(w.windowStart).toISOString().slice(11, 16)} — поднимаю под (${w.items.length} брони)`);
      const rec = { id: null, token: null, windowStart: w.windowStart, state: 'creating', createdAt: now, busyUntil: 0 };
      pods.push(rec); save('pods.json', pods);
      try {
        const p = await createPod(w.windowStart);
        Object.assign(rec, { id: p.id, token: p.token, machineId: p.machineId, state: 'warming' });
        note(`под ${p.id} создан на машине ${p.machineId}`);
      } catch (e) {
        rec.state = 'gone'; rec.error = String(e.message || e);
        note(`под не создался: ${rec.error}`);
      }
      save('pods.json', pods);
    }

    for (const pod of pods) {
      if (pod.state === 'warming' && pod.id) {
        if (await podReady(pod)) {
          pod.state = 'ready'; pod.readyAt = Date.now();
          note(`под ${pod.id} готов (${Math.round((pod.readyAt - pod.createdAt) / 1000)} с)`);
          save('pods.json', pods);
        } else if (now - pod.createdAt > 15 * MIN) {
          note(`под ${pod.id || '—'} не прогрелся за 15 минут — гашу и пробую заново`);
          await terminatePod(pod); pod.state = 'gone'; pod.error = 'таймаут прогрева';
          save('pods.json', pods);
        }
      }
    }

    // Агент спрашивает движок сам, для каждого звонка (GET /engine-for),
    // поэтому активных гнёзд может быть сколько угодно. Глобальное
    // переключение осталось как подстраховка: если разводка выключена
    // (у агента нет ORCHESTRATOR_URL), звонки всё равно попадут на под.
    const activeWindows = windows.filter((w) => now >= w.start - MIN && now < w.end + 5 * MIN);
    for (const w of activeWindows) {
      const pod = pods.find((x) => String(x.windowStart) === String(w.start) && x.state === 'ready');
      if (pod) pod.busyUntil = Math.max(pod.busyUntil || 0, w.end + 5 * MIN);
    }
    const target = activeWindows.length
      ? pods.find((p) => String(p.windowStart) === String(activeWindows[0].start) && p.state === 'ready')
      : null;
    const currentTarget = pods.find((p) => p.attached);
    if (target && (!currentTarget || currentTarget.id !== target.id)) {
      try {
        await switchAgent(['pod', target.id]);
        pods.forEach((p) => { p.attached = p.id === target.id; });
        target.busyUntil = Math.max(target.busyUntil || 0, activeWindows[0].end + 5 * MIN);
        note(`агент переключён на под ${target.id}`);
        save('pods.json', pods);
      } catch (e) { note(`не смог переключить агента: ${e.message}`); }
    } else if (!target && currentTarget) {
      try {
        await switchAgent(['cloud']);
        pods.forEach((p) => { p.attached = false; });
        note('активных гнёзд нет — агент вернулся в облако');
        save('pods.json', pods);
      } catch (e) { note(`не смог вернуть облако: ${e.message}`); }
    }

    for (const t of acts.terminate) {
      const pod = pods.find((p) => p.id === t.podId || (!p.id && p.state === 'creating'));
      if (!pod || pod.state === 'gone' || pod.attached) continue;
      note(`гашу под ${pod.id || '—'}: ${t.reason}`);
      await terminatePod(pod);
      pod.state = 'gone'; pod.goneAt = Date.now();
      save('pods.json', pods);
    }

    pods = pods.filter((p) => p.state !== 'gone' || Date.now() - (p.goneAt || 0) < 30 * MIN);
    save('pods.json', pods);
    await deliver();
  } catch (e) {
    note('сбой согласования: ' + (e.message || e));
  } finally {
    ticking = false;
  }
}

setInterval(reconcile, TICK_MS);
setTimeout(reconcile, 2000);

/* ---------------------------------------------------------------------- API */

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj, null, 1));
}
function body(req) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e5) { req.destroy(); rej(new Error('слишком большой запрос')); } });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(new Error('не разобрал JSON')); } });
  });
}

function planView() {
  const now = Date.now();
  const live = bookings.filter((b) => b.state === 'confirmed');
  const windows = plan(live, PARAMS).map((w) => ({
    start: new Date(w.start).toISOString(),
    warmAt: new Date(w.warmAt).toISOString(),
    end: new Date(w.end).toISOString(),
    bookings: w.items.map((i) => i.id),
    pod: (pods.find((p) => String(p.windowStart) === String(w.start) && p.state !== 'gone') || {}).id || null,
  }));
  return { now: new Date(now).toISOString(), params: PARAMS, windows,
    pods: pods.map((p) => ({ id: p.id, state: p.state, attached: !!p.attached,
      windowStart: p.windowStart ? new Date(p.windowStart).toISOString() : null, error: p.error || null })) };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname.replace(/^\/orch/, '') || '/';
  if ((req.headers['x-engine-key'] || '') !== env.ENGINE_KEY) return send(res, 403, { error: 'нет ключа' });
  try {
    if (p === '/bookings' && req.method === 'GET') return send(res, 200, { bookings });
    if (p === '/bookings' && req.method === 'POST') {
      const b = await body(req);
      const startsAt = typeof b.startsAt === 'number' ? b.startsAt : Date.parse(b.startsAt);
      if (!startsAt || Number.isNaN(startsAt)) return send(res, 400, { error: 'нужно startsAt' });
      const rec = {
        id: 'bk_' + crypto.randomBytes(5).toString('hex'),
        createdAt: Date.now(), startsAt,
        durationMinutes: b.durationMinutes || PARAMS.durationMinutes,
        byUserId: b.byUserId || null, withUserId: b.withUserId || null,
        initiator: Object.assign({ userId: b.byUserId || null }, b.initiator || {}),
        invitee: Object.assign({ userId: b.withUserId || null }, b.invitee || {}),
        context: { themes: (b.context && b.context.themes) || [], notes: (b.context && b.context.notes) || [] },
        state: b.autoConfirm ? 'confirmed' : 'proposed',
      };
      bookings.push(rec); save('bookings.json', bookings);
      note(`бронь ${rec.id} на ${new Date(startsAt).toISOString().slice(11, 16)} — ${rec.state}`);
      reconcile();
      return send(res, 201, { booking: rec });
    }
    const m = p.match(/^\/bookings\/([\w]+)\/(confirm|cancel)$/);
    if (m && req.method === 'POST') {
      const rec = bookings.find((b) => b.id === m[1]);
      if (!rec) return send(res, 404, { error: 'нет такой брони' });
      rec.state = m[2] === 'confirm' ? 'confirmed' : 'cancelled';
      if (rec.state === 'confirmed') rec.confirmedAt = Date.now(); else rec.cancelledAt = Date.now();
      save('bookings.json', bookings);
      note(`бронь ${rec.id}: ${rec.state}`);
      reconcile();
      return send(res, 200, { booking: rec });
    }
    if (p === '/engine-for' && req.method === 'GET') {
      /* Кто обслуживает ЭТУ пару прямо сейчас. Отвечаем только про готовый
       * под активного гнезда: греющийся под звонку не поможет, а адрес
       * мёртвого пода хуже отсутствия ответа — агент останется без движка. */
      const a = u.searchParams.get('a'), b = u.searchParams.get('b');
      const now = Date.now();
      const live = bookings.filter((x) => x.state === 'confirmed');
      const windows = plan(live, PARAMS);
      const pair = (bk) => {
        const set = new Set([bk.byUserId, bk.withUserId].filter(Boolean));
        return set.has(a) && set.has(b);
      };
      for (const w of windows) {
        if (now < w.start - 2 * MIN || now > w.end + 5 * MIN) continue;
        const mine = w.items.some((i) => {
          const bk = live.find((x) => x.id === i.id);
          return bk && pair(bk);
        });
        if (!mine) continue;
        const pod = pods.find((x) => String(x.windowStart) === String(w.start) && x.state === 'ready');
        if (!pod) continue;
        const host = `${pod.id}-8000.proxy.runpod.net`;
        return send(res, 200, { podId: pod.id, engine: {
          sttUrl: `wss://${host}/stt/v1/stream`,
          mtUrl: `https://${host}/mt/v1/translate`,
        } });
      }
      return send(res, 200, { podId: null, engine: null });
    }
    if (p === '/push/key' && req.method === 'GET') return send(res, 200, { key: env.VAPID_PUBLIC || null });
    if (p === '/push/subscribe' && req.method === 'POST') {
      const b = await body(req);
      if (!b.userId || !b.subscription || !b.subscription.endpoint) {
        return send(res, 400, { error: 'нужны userId и subscription' });
      }
      const list = subs[b.userId] || [];
      if (!list.some((s) => s.endpoint === b.subscription.endpoint)) list.push(b.subscription);
      subs[b.userId] = list; save('subscriptions.json', subs);
      note(`подписка на пуш: ${b.userId} (всего ${list.length})`);
      return send(res, 200, { ok: true, count: list.length });
    }
    if (p === '/push/test' && req.method === 'POST') {
      const b = await body(req);
      const n = await sendPush(b.userId, { title: 'SameVoice', body: b.text || 'Проверка связи', kind: 'test' });
      return send(res, 200, { delivered: n });
    }
    if (p === '/plan' && req.method === 'GET') return send(res, 200, planView());
    if (p === '/status' && req.method === 'GET') {
      return send(res, 200, Object.assign(planView(), { log: log.slice(-40) }));
    }
    if (p === '/reconcile' && req.method === 'POST') { await reconcile(); return send(res, 200, planView()); }
    return send(res, 404, { error: 'нет такого' });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => note(`оркестратор слушает ${PORT}, параметры ${JSON.stringify(PARAMS)}`));
