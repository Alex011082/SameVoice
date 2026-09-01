'use strict';
/* Планировщик гнёзд: раскладывает брони по подам так, чтобы карта не грелась
 * лишний раз и не висела горячей вхолостую.
 *
 * Правило порога выведено арифметикой (docs/19): держать карту между
 * бронями имеет смысл, только если разрыв меньше времени прогрева — иначе
 * дешевле погасить и разогреть заново. Плюс минута на риск битого хоста.
 *
 * Модуль ЧИСТЫЙ: никаких сетевых вызовов и часов внутри — только вход и
 * выход. Поэтому его можно прогонять тестами, что и делает planner.test.js.
 */

const DEFAULTS = {
  warmMinutes: 4,      // сколько занимает прогрев пода целиком
  riskMinutes: 1,      // запас на битый хост и пересоздание
  capacity: 2,         // сколько пар одновременно тянет одна карта (замер эксп. 1)
  durationMinutes: 20, // сколько закладываем на разговор, если длина не задана
};

const MIN = 60 * 1000;

function opts(o) {
  const p = Object.assign({}, DEFAULTS, o || {});
  p.holdMs = (p.warmMinutes + p.riskMinutes) * MIN;
  return p;
}

/** Максимум одновременных разговоров в наборе (заметание по событиям). */
function maxConcurrent(items) {
  const edges = [];
  for (const b of items) {
    edges.push([b.start, 1]);
    edges.push([b.end, -1]);
  }
  // Конец раньше начала при равном времени: встреча, кончающаяся в 14:00,
  // не занимает место у той, что начинается в 14:00.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0;
  for (const [, d] of edges) { cur += d; if (cur > max) max = cur; }
  return max;
}

function normalize(bookings, p) {
  return bookings.map((b) => {
    const start = typeof b.startsAt === 'number' ? b.startsAt : Date.parse(b.startsAt);
    const dur = (b.durationMinutes || p.durationMinutes) * MIN;
    return { id: b.id, start, end: start + dur, raw: b };
  }).sort((a, b) => a.start - b.start);
}

function windowOf(items) {
  return {
    start: Math.min(...items.map((i) => i.start)),
    end: Math.max(...items.map((i) => i.end)),
    items,
  };
}

/** Можно ли объединить два гнезда: и разрыв мал, и ёмкость выдерживает. */
function mergeable(a, b, p) {
  const gap = Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));
  if (gap > p.holdMs) return false;
  return maxConcurrent(a.items.concat(b.items)) <= p.capacity;
}

/**
 * Разложить брони по гнёздам.
 * @returns [{start, end, warmAt, items:[{id,start,end,raw}]}] — по времени.
 */
function plan(bookings, options) {
  const p = opts(options);
  const items = normalize(bookings, p);
  const windows = [];

  for (const it of items) {
    let placed = null;
    for (const w of windows) {
      const gap = it.start - w.end;               // <0 значит перекрытие
      if (gap > p.holdMs) continue;                // слишком далеко — не наше гнездо
      if (maxConcurrent(w.items.concat([it])) > p.capacity) continue;  // карта не тянет
      placed = w;
      break;
    }
    if (placed) {
      placed.items.push(it);
      placed.start = Math.min(placed.start, it.start);
      placed.end = Math.max(placed.end, it.end);
    } else {
      windows.push(windowOf([it]));
    }
  }

  // Слияние: новая бронь могла встать между двумя гнёздами и стянуть их в одно.
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        if (!mergeable(windows[i], windows[j], p)) continue;
        const w = windowOf(windows[i].items.concat(windows[j].items));
        windows.splice(j, 1); windows.splice(i, 1, w);
        merged = true;
        break outer;
      }
    }
  }

  windows.sort((a, b) => a.start - b.start);
  for (const w of windows) {
    w.items.sort((a, b) => a.start - b.start);
    w.warmAt = w.start - p.warmMinutes * MIN;   // когда начинать поднимать под
  }
  return windows;
}

/**
 * Что делать прямо сейчас: какие гнёзда пора греть, какие поды пора гасить.
 * Отдаёт НАМЕРЕНИЯ, а не действия — исполняет их служба.
 */
function decide(windows, pods, now, options) {
  const p = opts(options);
  const acts = { warm: [], keep: [], terminate: [] };
  const seen = new Set();

  for (const w of windows) {
    const key = String(w.start);
    const pod = pods.find((x) => String(x.windowStart) === key && x.state !== 'gone');
    if (pod) { seen.add(pod.id); acts.keep.push({ podId: pod.id, windowStart: w.start }); continue; }
    if (now >= w.warmAt && now < w.end) acts.warm.push({ windowStart: w.start, items: w.items.map((i) => i.id) });
  }

  for (const pod of pods) {
    if (pod.state === 'gone' || seen.has(pod.id)) continue;
    // Под без гнезда: гасим, но не раньше, чем стихнет разговор на нём.
    const busyUntil = pod.busyUntil || 0;
    if (now >= busyUntil) acts.terminate.push({ podId: pod.id, reason: busyUntil ? 'разговор кончился' : 'гнездо ушло' });
  }
  return acts;
}

module.exports = { plan, decide, maxConcurrent, DEFAULTS, MIN };
