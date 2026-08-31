export type PhoneAuthState =
  | { phase: 'phone'; error: string | null }
  | {
      phase: 'code';
      challengeId: string;
      phone: string;
      /**
       * Код, показанный на экране, — или null, когда сервер его не отдал.
       * Второе теперь и есть значение по умолчанию: код приходит в ответе
       * только на сервере с включённым AUTH_DEV_CODE_IN_RESPONSE, иначе он
       * уходит в лог сервера. Экран должен уметь оба случая, а не считать
       * пустую строку кодом.
       */
      devCode: string | null;
      error: string | null;
    }
  | { phase: 'verified'; phone: string; registrationToken: string; error: string | null };

export type PhoneAuthEvent =
  | { type: 'code_sent'; challengeId: string; phone: string; devCode: string | null }
  | { type: 'failed'; message: string }
  | { type: 'verified'; registrationToken: string }
  | { type: 'restart' };

export function phoneAuthInitial(): PhoneAuthState {
  return { phase: 'phone', error: null };
}

export function reducePhoneAuth(state: PhoneAuthState, event: PhoneAuthEvent): PhoneAuthState {
  switch (event.type) {
    case 'code_sent':
      return {
        phase: 'code',
        challengeId: event.challengeId,
        phone: event.phone,
        devCode: event.devCode,
        error: null,
      };
    case 'failed':
      return { ...state, error: event.message };
    case 'verified':
      return state.phase === 'code'
        ? {
            phase: 'verified',
            phone: state.phone,
            registrationToken: event.registrationToken,
            error: null,
          }
        : state;
    case 'restart':
      return phoneAuthInitial();
  }
}
