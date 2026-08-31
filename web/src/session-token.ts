/**
 * Хранение bearer-копии сессионного токена.
 *
 * Основной носитель сессии — httpOnly-cookie `sv_session`, которую ставит
 * backend (backend/src/session.ts). Её JavaScript не видит и видеть не должен:
 * страница, которая может прочитать свой токен, может его и утечь. Но cookie
 * с `SameSite=Lax` НЕ уходит в кросс-origin fetch, а именно так устроена
 * разработка — страница на :5173, API на :8787. Поэтому backend отдаёт тот же
 * токен ещё и в теле ответа на вход, и вот эта копия лежит здесь.
 *
 * Цена копии названа прямо: она в localStorage, то есть доступна скриптам на
 * странице. Это осознанный размен ради работающей локальной разработки, а не
 * недосмотр. На боевом домене (страница и API за одним Caddy) хватает cookie,
 * и заголовок просто дублирует её.
 *
 * Хранится ТОЛЬКО токен. Ни номера телефона, ни имени: номер — это учётные
 * данные, вокруг которых построен вход, и в браузерном хранилище ему нечего
 * делать. Кто владелец токена, говорит сервер (`GET /api/auth/session`), а не
 * запись рядом с ним.
 */

const KEY = 'speakeasy.session.token';

/** Ровно та часть Storage, которая здесь нужна — чтобы тест обошёлся без DOM. */
export interface TokenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Любое обращение к хранилищу обёрнуто в try/catch: Safari в приватном режиме
 * и браузер с запретом на данные сайта бросают исключение прямо из getItem, и
 * упавший при старте клиент — это «приложение не открывается», а не «вход не
 * запомнился».
 */
export function readSessionToken(store: TokenStore): string | null {
  try {
    const token = store.getItem(KEY);
    return token !== null && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function rememberSessionToken(store: TokenStore, token: string): void {
  try {
    store.setItem(KEY, token);
  } catch {
    // Вход всё равно состоялся: cookie уже стоит, и на одном домене этого
    // достаточно. Молча теряется только кросс-origin запас.
  }
}

export function forgetSessionToken(store: TokenStore): void {
  try {
    store.removeItem(KEY);
  } catch {
    // Нечего делать: сессию всё равно закрывает сервер.
  }
}

/**
 * Заголовок для запроса, требующего сессию. Пустой объект, когда токена нет:
 * запрос уходит с одной cookie, и решает сервер, а не клиент.
 */
export function sessionAuthHeaders(store: TokenStore): Record<string, string> {
  const token = readSessionToken(store);
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}
