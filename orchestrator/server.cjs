'use strict';
/* Оркестратор SameVoice: брони -> гнёзда -> поды.
 *
 * Что делает: хранит брони, раскладывает их планировщиком (planner.cjs),
 * поднимает под к началу каждого гнезда, переключает боевого агента на
 * готовый под, гасит поды, когда гнездо кончилось и разговор стих.
 *
 * Чего НЕ делает и почему: не рассылает уведомления (нет канала — СМС
 * подключается отдельно) и не умеет одновременно обслуживать два пода
 * ЖИВЫМИ звонками. Причина честная: агент берёт адрес движка из глобальных
 * переменных окружения (RUNPOD_STT_URL/RUNPOD_MT_URL), то есть в каждый
 * момент говорит с одним подом. Пока это так, оркестратор переключает агента
 * на под ближайшего активного гнезда и пишет предупреждение, если активных
 * гнёзд оказалось больше одного. Разводка по звонкам — следующая работа в
 * agent/src/speakeasy_agent/providers.
 *
 * Слушает 127.0.0.1:9098, наружу — через Caddy на /orch/*, ключ x-engine-key.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { plan, decide, MIN } = require('./planner.cjs');

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

    // Кого слушает агент: под ближайшего активного гнезда.
    const activeWindows = windows.filter((w) => now >= w.start - MIN && now < w.end + 5 * MIN);
    if (activeWindows.length > 1) {
      note(`ВНИМАНИЕ: активных гнёзд ${activeWindows.length}, а агент умеет один под — разводка по звонкам ещё не сделана`);
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
      save('bookings.json', bookings);
      note(`бронь ${rec.id}: ${rec.state}`);
      reconcile();
      return send(res, 200, { booking: rec });
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
