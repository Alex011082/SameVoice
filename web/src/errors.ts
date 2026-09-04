/**
 * Ошибки по-русски, на экране.
 *
 * Backend отвечает конвертом `{ error: { code, message } }`, и message в нём
 * английский — он писался для лога, а не для человека с телефоном в руке.
 * Тестировщик, увидевший «the confirmation code is incorrect», не знает,
 * ошибся ли он цифрой, просрочил ли код или упала сеть; отличать эти три
 * случая и есть работа этого модуля. Код ошибки — то, что решает; message
 * остаётся хвостом только там, где кода не хватило.
 */

export type AuthStep = 'phone' | 'code' | 'profile';

export interface Failure {
  /** Код из конверта backend'а; `network`, когда запрос вообще не ушёл. */
  code: string;
  status: number;
  message: string;
}

/**
 * Утиная типизация вместо `instanceof ApiRequestError`: этот модуль обязан
 * оставаться пригодным для теста без DOM и без загрузки api.ts.
 */
export function toFailure(err: unknown): Failure {
  if (typeof err === 'object' && err !== null) {
    const shaped = err as { code?: unknown; status?: unknown; message?: unknown };
    const message = typeof shaped.message === 'string' ? shaped.message : String(err);
    if (typeof shaped.code === 'string') {
      return {
        code: shaped.code,
        status: typeof shaped.status === 'number' ? shaped.status : 0,
        message,
      };
    }
    return { code: 'unknown', status: 0, message };
  }
  return { code: 'unknown', status: 0, message: String(err) };
}

/**
 * «Сервер не отвечает» — это и оборванный fetch, и ответ шлюза. Прокси перед
 * backend'ом отдаёт 502/503/504 без нашего конверта, и без этой ветки человек
 * читал «Сервер ответил: 502 Bad Gateway» — то есть ничего.
 */
function isNetwork(failure: Failure): boolean {
  if (failure.code === 'network' || failure.status === 0) return true;
  return failure.status === 502 || failure.status === 503 || failure.status === 504;
}

const BAD_REQUEST: Record<AuthStep, string> = {
  phone: 'Не похоже на номер. Израильский мобильный — 05X XXX XXXX, иначе международный с «+».',
  code: 'Код — это шесть цифр. Введите их полностью.',
  profile: 'Заполните имя, язык и голос.',
};

export function authErrorText(step: AuthStep, err: unknown): string {
  const failure = toFailure(err);
  if (isNetwork(failure)) {
    return 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.';
  }
  switch (failure.code) {
    case 'invalid_code':
      return 'Неверный код. Проверьте шесть цифр из сообщения и введите ещё раз.';
    case 'invalid_challenge':
      // Один код живёт пять минут и выдерживает пять попыток; после этого
      // сервер забывает и сам запрос, поэтому «введите правильнее» — вранье.
      return 'Код больше не действует: прошло больше пяти минут или было слишком много попыток. Запросите новый.';
    case 'invalid_verification':
      return 'Подтверждение номера истекло. Начните заново — понадобится новый код.';
    case 'bad_request':
      return BAD_REQUEST[step];
    default:
      return `Не получилось. Сервер ответил: ${failure.message}`;
  }
}

export function callErrorText(err: unknown): string {
  const failure = toFailure(err);
  if (isNetwork(failure)) return 'Сервер не отвечает — звонок не начался.';
  switch (failure.code) {
    case 'busy':
      return 'Линия занята: у одного из вас уже идёт звонок. Завершите его и попробуйте снова.';
    case 'self_call':
      return 'Это вы сами — позвонить себе нельзя.';
    case 'not_found':
      return 'Этого собеседника больше нет на сервере. Обновите страницу.';
    default:
      return `Звонок не начался. Сервер ответил: ${failure.message}`;
  }
}

export function contactsErrorText(err: unknown): string {
  const failure = toFailure(err);
  if (isNetwork(failure)) {
    return 'Сервер не отвечает — список контактов не загрузился.';
  }
  if (failure.code === 'not_found') {
    return 'Этого профиля больше нет на сервере. Нажмите «сменить» вверху и войдите заново.';
  }
  return `Контакты не загрузились. Сервер ответил: ${failure.message}`;
}
