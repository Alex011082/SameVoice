import { describe, expect, it } from 'vitest';
import { authErrorText, callErrorText, contactsErrorText, toFailure } from '../src/errors';

/** Форма ApiRequestError, без загрузки api.ts (там import.meta.env и fetch). */
function apiError(code: string, message: string, status: number): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

describe('errors a tester can act on, in Russian', () => {
  it('tells a mistyped code apart from an expired one', () => {
    expect(authErrorText('code', apiError('invalid_code', 'the confirmation code is incorrect', 400))).toBe(
      'Неверный код. Проверьте шесть цифр из сообщения и введите ещё раз.',
    );
    expect(
      authErrorText('code', apiError('invalid_challenge', 'the confirmation request is missing', 400)),
    ).toContain('Запросите новый.');
  });

  it('says the network is down rather than blaming the code', () => {
    const offline = apiError('network', 'cannot reach the backend at http://x - is it running?', 0);

    expect(authErrorText('code', offline)).toBe(
      'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.',
    );
    expect(contactsErrorText(offline)).toBe('Сервер не отвечает — список контактов не загрузился.');
    expect(callErrorText(offline)).toBe('Сервер не отвечает — звонок не начался.');
  });

  it('reads a gateway answer as the server being down, not as a mystery', () => {
    // Вид с телефона, когда backend лёг за прокси: раньше здесь стояло
    // «Сервер ответил: 502 Bad Gateway», что человеку не говорит ничего.
    expect(authErrorText('code', apiError('internal', '502 Bad Gateway', 502))).toBe(
      'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.',
    );
    expect(contactsErrorText(apiError('internal', '503 Service Unavailable', 503))).toBe(
      'Сервер не отвечает — список контактов не загрузился.',
    );
  });

  it('gives the same code a different sentence on each step', () => {
    const bad = apiError('bad_request', 'enter an Israeli mobile number', 400);

    expect(authErrorText('phone', bad)).toContain('05X XXX XXXX');
    expect(authErrorText('code', bad)).toBe('Код — это шесть цифр. Введите их полностью.');
    expect(authErrorText('profile', bad)).toBe('Заполните имя, язык и голос.');
  });

  it('explains an expired registration token instead of leaving the form dead', () => {
    expect(
      authErrorText('profile', apiError('invalid_verification', 'phone verification is missing', 400)),
    ).toBe('Подтверждение номера истекло. Начните заново — понадобится новый код.');
  });

  it('keeps the raw server sentence when no code matched, so a report is still possible', () => {
    expect(authErrorText('code', apiError('teapot', 'something odd', 418))).toBe(
      'Не получилось. Сервер ответил: something odd',
    );
  });

  it('turns a busy line into an instruction', () => {
    expect(callErrorText(apiError('busy', 'u_alex already has a ringing call', 409))).toContain(
      'Завершите его и попробуйте снова.',
    );
  });

  it('reads a thrown non-error without inventing a code', () => {
    expect(toFailure('boom')).toEqual({ code: 'unknown', status: 0, message: 'boom' });
  });
});
