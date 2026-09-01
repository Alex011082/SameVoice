'use strict';
/* Тесты расписания уведомлений: запуск `node --test orchestrator/notifications.test.cjs` */
const test = require('node:test');
const assert = require('node:assert');
const { schedule, due, MIN } = require('./notifications.cjs');

const T = (h, m) => Date.UTC(2026, 8, 2, h, m, 0);
const base = (over) => Object.assign({
  id: 'bk1', state: 'confirmed', startsAt: T(19, 0), createdAt: T(10, 0), confirmedAt: T(10, 5),
  initiator: { userId: 'sasha', reminderMinutes: [60, 10], autoCall: false },
  invitee: { userId: 'ronit', reminderMinutes: [30], autoCall: false },
}, over || {});

const kinds = (ev, kind) => ev.filter((e) => e.kind === kind);

test('предложенная бронь: приглашение только приглашённому', () => {
  const ev = schedule(base({ state: 'proposed' }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'invite');
  assert.equal(ev[0].to, 'ronit');
});

test('подтверждение уходит инициатору', () => {
  const ev = schedule(base());
  const c = kinds(ev, 'confirmed');
  assert.equal(c.length, 1);
  assert.equal(c[0].to, 'sasha');
});

test('каждый получает напоминания по СВОЕМУ выбору', () => {
  const ev = schedule(base());
  const sasha = kinds(ev, 'reminder').filter((e) => e.to === 'sasha').map((e) => e.payload.minutesBefore);
  const ronit = kinds(ev, 'reminder').filter((e) => e.to === 'ronit').map((e) => e.payload.minutesBefore);
  assert.deepEqual(sasha, [60, 10]);
  assert.deepEqual(ronit, [30], 'у неё свой выбор, а не общий');
});

test('перед разговором обоим идут сигналы', () => {
  const ev = schedule(base());
  const s = kinds(ev, 'signal');
  assert.equal(s.length, 4, 'по два сигнала каждому (за 2 и за 1 минуту)');
  assert.deepEqual([...new Set(s.map((e) => e.to))].sort(), ['ronit', 'sasha']);
  for (const e of s) assert.ok(e.at < T(19, 0) && e.at >= T(18, 58));
});

test('автосозвон — только когда его выбрали ОБА', () => {
  const оба = schedule(base({
    initiator: { userId: 'sasha', autoCall: true },
    invitee: { userId: 'ronit', autoCall: true },
  }));
  assert.equal(kinds(оба, 'autocall').length, 1, 'сервер сам звонит обоим');
  assert.equal(kinds(оба, 'handoff').length, 0);

  const один = schedule(base({
    initiator: { userId: 'sasha', autoCall: true },
    invitee: { userId: 'ronit', autoCall: false },
  }));
  assert.equal(kinds(один, 'autocall').length, 0, 'нельзя звонить тому, кто не соглашался');
  assert.equal(kinds(один, 'handoff').length, 2, 'вместо этого обоим сигнал «пора»');
});

test('отмена уходит обоим и прямо сейчас', () => {
  const ev = schedule(base({ state: 'cancelled', cancelledAt: T(15, 0) }));
  assert.equal(ev.length, 2);
  for (const e of ev) { assert.equal(e.kind, 'cancelled'); assert.equal(e.at, T(15, 0)); }
});

test('события отсортированы по времени', () => {
  const ev = schedule(base());
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].at >= ev[i - 1].at);
});

test('к отправке — только наступившие, неотправленные и не протухшие', () => {
  const ev = schedule(base());
  const now = T(18, 0);                       // час до разговора
  const d = due(ev, now, []);
  assert.ok(d.some((e) => e.kind === 'reminder' && e.payload.minutesBefore === 60));
  assert.ok(!d.some((e) => e.payload && e.payload.minutesBefore === 10), 'десятиминутное ещё не время');

  const второйРаз = due(ev, now, d.map((e) => e.id));
  assert.equal(второйРаз.length, 0, 'дважды одно и то же не шлём');

  const поздно = due(ev, T(18, 30), []);
  assert.ok(!поздно.some((e) => e.payload && e.payload.minutesBefore === 60),
    'опоздавшее на полчаса напоминание «за час» не отправляем');
});

test('без выбора человека берутся умолчания', () => {
  const ev = schedule(base({ invitee: { userId: 'ronit' } }));
  const r = kinds(ev, 'reminder').filter((e) => e.to === 'ronit').map((e) => e.payload.minutesBefore);
  assert.deepEqual(r, [60, 10]);
});

test('мусор в настройках не ломает расписание', () => {
  const ev = schedule(base({ invitee: { userId: 'ronit', reminderMinutes: [0, -5, NaN] } }));
  const r = kinds(ev, 'reminder').filter((e) => e.to === 'ronit');
  assert.deepEqual(r.map((e) => e.payload.minutesBefore), [60, 10], 'пустой выбор = умолчания');
});
