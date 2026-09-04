export type PhoneAuthState =
  | { phase: 'phone'; error: string | null }
  | {
      phase: 'code';
      challengeId: string;
      phone: string;
      devCode: string;
      error: string | null;
    }
  | { phase: 'verified'; phone: string; registrationToken: string; error: string | null };

export type PhoneAuthEvent =
  | { type: 'code_sent'; challengeId: string; phone: string; devCode: string }
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
