import { describe, expect, it } from 'vitest';
import { phoneAuthInitial, reducePhoneAuth } from '../src/phone-auth';

describe('phone confirmation flow', () => {
  it('accepts a challenge with no code shown, because the server usually withholds it', () => {
    // Сервер по умолчанию НЕ кладёт код в ответ (AUTH_DEV_CODE_IN_RESPONSE
    // выключён) — иначе любой подтверждает чужой номер. Экран ввода кода при
    // этом обязан открыться: код придёт человеку другим путём.
    const state = reducePhoneAuth(phoneAuthInitial(), {
      type: 'code_sent',
      challengeId: 'pv_0123456789abcdef01234567',
      phone: '+972501234567',
      devCode: null,
    });

    expect(state.phase).toBe('code');
    if (state.phase !== 'code') throw new Error('the code screen must open without a code');
    expect(state.devCode).toBeNull();
    expect(state.challengeId).toBe('pv_0123456789abcdef01234567');
  });

  it('moves from phone entry to code entry with the displayed development code', () => {
    const state = reducePhoneAuth(phoneAuthInitial(), {
      type: 'code_sent',
      challengeId: 'pv_0123456789abcdef01234567',
      phone: '+972501234567',
      devCode: '481205',
    });

    expect(state).toEqual({
      phase: 'code',
      challengeId: 'pv_0123456789abcdef01234567',
      phone: '+972501234567',
      devCode: '481205',
      error: null,
    });
  });

  it('keeps the challenge available after a wrong code so the user can retry', () => {
    const codeState = reducePhoneAuth(phoneAuthInitial(), {
      type: 'code_sent',
      challengeId: 'pv_0123456789abcdef01234567',
      phone: '+972501234567',
      devCode: '481205',
    });
    const failed = reducePhoneAuth(codeState, { type: 'failed', message: 'Неверный код' });

    expect(failed.phase).toBe('code');
    if (failed.phase !== 'code') throw new Error('wrong code must keep the code phase');
    expect(failed.challengeId).toBe('pv_0123456789abcdef01234567');
    expect(failed.error).toBe('Неверный код');
  });

  it('finishes with the verified normalized number', () => {
    const codeState = reducePhoneAuth(phoneAuthInitial(), {
      type: 'code_sent',
      challengeId: 'pv_0123456789abcdef01234567',
      phone: '+972501234567',
      devCode: '481205',
    });

    expect(
      reducePhoneAuth(codeState, {
        type: 'verified',
        registrationToken: 'vr_0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    ).toEqual({
      phase: 'verified',
      phone: '+972501234567',
      registrationToken: 'vr_0123456789abcdef0123456789abcdef0123456789abcdef',
      error: null,
    });
  });
});
