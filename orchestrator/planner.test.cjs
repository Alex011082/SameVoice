'use strict';
/* Тесты планировщика гнёзд. Запуск: node --test orchestrator/
 * Проверяем ровно те случаи, которые обсуждались в docs/19 и на которых
 * первая (неверная) редакция правила ломалась.
 */
const test = require('node:test');
const assert = require('node:assert');
const { plan, decide, maxConcurrent, MIN } = require('./planner.cjs');

const T = (h, m) => Date.UTC(2026, 8, 2, h, m, 0);   // 2 сентября 2026
const B = (id, h, m, dur) => ({ id, startsAt: T(h, m), durationMinutes: dur || 20 });

test('перекрывающиеся брони — одно гнездо, один прогрев', () => {
  // случай основателя: 13:44 и 13:46
  const w = plan([B('a', 13, 44), B('b', 13, 46)]);
  assert.equal(w.length, 1, 'должно быть одно гнездо');
  assert.equal(w[0].items.length, 2);
  assert.equal(w[0].warmAt, T(13, 40), 'греем за 4 минуты до первой брони');
});

test('разрыв больше порога — два гнезда, два пода', () => {
  // 13:44 (до 14:04) и 14:10 -> разрыв 6 минут при пороге 5
  const w = plan([B('a', 13, 44), B('b', 14, 10)]);
  assert.equal(w.length, 2, 'держать карту дороже, чем поднять новую');
});

test('разрыв в пределах порога — цепляется к горячей карте', () => {
  // 13:44 (до 14:04) и 14:08 -> разрыв 4 минуты при пороге 5
  const w = plan([B('a', 13, 44), B('b', 14, 8)]);
  assert.equal(w.length, 1, 'разогревать заново дороже, чем додержать');
});

test('третья одновременная пара открывает второй под', () => {
  const w = plan([B('a', 13, 0), B('b', 13, 1), B('c', 13, 2)]);
  assert.equal(w.length, 2, 'ёмкость карты — две пары');
  assert.equal(w[0].items.length, 2);
  assert.equal(w[1].items.length, 1);
});

test('новая бронь склеивает два гнезда в одно', () => {
  const far = plan([B('a', 13, 0), B('b', 13, 30)]);
  assert.equal(far.length, 2, 'без промежуточной брони это два гнезда');
  // 13:18 перекрывает хвост первой и подходит вплотную ко второй
  const near = plan([B('a', 13, 0), B('m', 13, 18), B('b', 13, 30)]);
  assert.equal(near.length, 1, 'промежуточная бронь избавляет от второго пода');
  assert.equal(near[0].items.length, 3);
});

test('ёмкость мешает склейке, даже если разрывы малы', () => {
  // четыре брони подряд, все перекрываются — карта не тянет
  const w = plan([B('a', 13, 0), B('b', 13, 1), B('c', 13, 2), B('d', 13, 3)]);
  const total = w.reduce((s, x) => s + x.items.length, 0);
  assert.equal(total, 4, 'ни одна бронь не потеряна');
  for (const x of w) assert.ok(maxConcurrent(x.items) <= 2, 'в гнезде не больше двух пар');
});

test('быстрый прогрев ужимает порог удержания', () => {
  const args = [B('a', 13, 44), B('b', 14, 8)];              // разрыв 4 минуты
  assert.equal(plan(args).length, 1, 'при прогреве 4 мин держим');
  assert.equal(plan(args, { warmMinutes: 1.5 }).length, 2,
    'при прогреве 1.5 мин держать уже дороже, чем разогреть');
});

test('встреча, кончающаяся ровно в начало следующей, не занимает место', () => {
  const w = plan([B('a', 13, 0, 20), B('b', 13, 20, 20), B('c', 13, 20, 20)]);
  assert.equal(w.length, 1, 'две пары в 13:20 — ровно ёмкость карты');
});

test('порядок броней на входе не влияет на раскладку', () => {
  const a = plan([B('a', 13, 0), B('b', 13, 30), B('c', 13, 18)]);
  const b = plan([B('c', 13, 18), B('a', 13, 0), B('b', 13, 30)]);
  assert.deepEqual(a.map((w) => w.items.map((i) => i.id).sort()),
                   b.map((w) => w.items.map((i) => i.id).sort()));
});

test('решение: пора греть, когда подошло время прогрева', () => {
  const w = plan([B('a', 14, 0)]);
  const рано = decide(w, [], T(13, 50));
  assert.equal(рано.warm.length, 0, 'за 10 минут ещё рано');
  const пора = decide(w, [], T(13, 56));
  assert.equal(пора.warm.length, 1, 'за 4 минуты — пора');
});

test('решение: под без гнезда гасится, но не посреди разговора', () => {
  const pods = [{ id: 'p1', windowStart: T(9, 0), state: 'ready', busyUntil: T(14, 30) }];
  const идёт = decide([], pods, T(14, 10));
  assert.equal(идёт.terminate.length, 0, 'живой разговор не выселяем');
  const стих = decide([], pods, T(14, 31));
  assert.equal(стих.terminate.length, 1, 'после разговора гасим');
});

test('решение: под, отвечающий гнезду, остаётся', () => {
  const w = plan([B('a', 14, 0)]);
  const pods = [{ id: 'p1', windowStart: w[0].start, state: 'ready' }];
  const d = decide(w, pods, T(13, 58));
  assert.equal(d.warm.length, 0, 'второй под для того же гнезда не поднимаем');
  assert.equal(d.keep.length, 1);
  assert.equal(d.terminate.length, 0);
});
