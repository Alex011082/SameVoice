'use strict';
/* Расписание уведомлений для брони.
 *
 * Требование основателя (01.09): оба получают пуш в приложении; напоминание
 * за выбранное каждым время; перед самым разговором 2-3 сигнала; если ОБА
 * выбрали «автосозвон» — сервер звонит обоим и соединяет, как телефонистка
 * сто лет назад. Если хотя бы один не выбрал — обычный сценарий: приходит
 * сигнал «пора», человек нажимает сам.
 *
 * Модуль ЧИСТЫЙ: считает, ЧТО и КОГДА отправить. Отправкой занимается
 * server.cjs. Поэтому расписание можно прогонять тестами, не трогая ни сеть,
 * ни часы.
 */

const MIN = 60 * 1000;

const DEFAULTS = {
  reminderMinutes: [60, 10],   // за сколько напоминать, если человек не выбрал
  signalOffsets: [2, 1, 0],    // сигналы прямо перед разговором, в минутах
};

/** Настройки участника с подставленными умолчаниями. */
function person(p) {
  const raw = Array.isArray(p && p.reminderMinutes) ? p.reminderMinutes : [];
  // Сначала отсев, и только ПОТОМ решение о умолчаниях: список из мусора
  // (нули, отрицательные, NaN) — это не «человек отказался от напоминаний»,
  // а сломанный ввод. Оставить его пустым значило бы тихо лишить человека
  // напоминаний вовсе.
  const clean = raw.filter((m) => Number.isFinite(m) && m > 0);
  const rem = clean.length ? clean : DEFAULTS.reminderMinutes.slice();
  return {
    userId: (p && p.userId) || null,
    reminderMinutes: rem.sort((a, b) => b - a),
    autoCall: !!(p && p.autoCall),
  };
}

function key(kind, userId, at) { return `${kind}:${userId || '-'}:${at}`; }

/**
 * Полное расписание событий брони.
 * @returns [{at, kind, to, payload}] по возрастанию времени.
 *   kind: invite | confirmed | reminder | signal | autocall | handoff | cancelled
 *   to: userId, кому шлём (null = обоим/системное)
 */
function schedule(booking, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const start = typeof booking.startsAt === 'number' ? booking.startsAt : Date.parse(booking.startsAt);
  const a = person(booking.initiator || { userId: booking.byUserId });
  const b = person(booking.invitee || { userId: booking.withUserId });
  const events = [];

  if (booking.state === 'cancelled') {
    // Отмена — единственное, что отправляется задним числом:人 должен узнать.
    const at = booking.cancelledAt || Date.now();
    for (const p of [a, b]) events.push({ at, kind: 'cancelled', to: p.userId, payload: { startsAt: start } });
    return sort(events);
  }

  if (booking.state === 'proposed') {
    events.push({ at: booking.createdAt || start, kind: 'invite', to: b.userId,
      payload: { from: a.userId, startsAt: start } });
    return sort(events);   // пока не подтвердили — ничего больше не шлём
  }

  if (booking.state !== 'confirmed') return [];

  events.push({ at: booking.confirmedAt || booking.createdAt || start, kind: 'confirmed', to: a.userId,
    payload: { by: b.userId, startsAt: start } });

  for (const p of [a, b]) {
    for (const m of p.reminderMinutes) {
      events.push({ at: start - m * MIN, kind: 'reminder', to: p.userId,
        payload: { startsAt: start, minutesBefore: m } });
    }
    for (const m of o.signalOffsets) {
      if (m === 0) continue;   // нулевой момент — это уже звонок, ниже
      events.push({ at: start - m * MIN, kind: 'signal', to: p.userId,
        payload: { startsAt: start, minutesBefore: m } });
    }
  }

  // Момент разговора. Автосозвон — только если ОБА его выбрали: звонить
  // человеку, который на это не соглашался, нельзя.
  const both = a.autoCall && b.autoCall;
  if (both) {
    events.push({ at: start, kind: 'autocall', to: null,
      payload: { callerId: a.userId, calleeId: b.userId, startsAt: start } });
  } else {
    for (const p of [a, b]) {
      events.push({ at: start, kind: 'handoff', to: p.userId,
        payload: { startsAt: start, with: p === a ? b.userId : a.userId,
          reason: p.autoCall ? 'собеседник не включил автосозвон' : 'автосозвон выключен' } });
    }
  }
  return sort(events);
}

function sort(events) {
  return events
    .filter((e) => Number.isFinite(e.at))
    .map((e) => Object.assign({ id: key(e.kind, e.to, e.at) }, e))
    .sort((x, y) => x.at - y.at || x.kind.localeCompare(y.kind));
}

/**
 * Что пора отправить прямо сейчас: события, чьё время наступило, ещё не
 * отправленные и не протухшие (позже окна опоздание не шлём — напоминание
 * «за час», пришедшее через час после разговора, только злит).
 */
function due(events, now, sentIds, staleMs) {
  const stale = staleMs == null ? 5 * MIN : staleMs;
  const sent = sentIds instanceof Set ? sentIds : new Set(sentIds || []);
  return events.filter((e) => !sent.has(e.id) && e.at <= now && now - e.at <= stale);
}

module.exports = { schedule, due, person, DEFAULTS, MIN };
