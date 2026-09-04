import { isSeededIdentity, selectSeededIdentities } from './seeded-identities';
import type { ContactCard, UserProfile } from './types';

export interface DirectoryEntry {
  contact: ContactCard;
  /**
   * У сервера есть строка контакта для этой пары. Без неё PATCH
   * /api/users/:id/contacts/:peer отвечает 404, поэтому per-contact настройки
   * для такой карточки не показываются. На сам звонок это не влияет:
   * POST /api/calls требует только чтобы оба пользователя существовали.
   */
  saved: boolean;
  /** Одна из четырёх постоянных тестовых личностей. */
  test: boolean;
}

export type ContactsModel =
  | { kind: 'list'; entries: DirectoryEntry[] }
  | { kind: 'empty'; title: string; detail: string };

function cardFor(user: UserProfile): ContactCard {
  return {
    userId: user.id,
    displayName: user.displayName,
    lang: user.lang,
    gender: user.gender,
    tone: user.tone,
    forceTranslate: false,
    overrides: {},
  };
}

/**
 * Список контактов плюс четыре тестовых аккаунта, даже если сервер не завёл на
 * них строк контактов.
 *
 * Инцидент, ради которого это написано: после подтверждения номера человек
 * попадал в приложение, где `GET /api/users/:id/contacts` возвращал `[]` —
 * позвонить было некуда, и протестировать нельзя было ни одно направление. Строки
 * контактов чинятся на сервере, но клиент не должен зависеть от того, какая
 * сборка backend'а сейчас развёрнута: тестовые личности постоянны, они видны
 * в `GET /api/users`, и звонок им работает и без строки контакта.
 */
export function buildDirectory(
  me: UserProfile,
  contacts: ContactCard[],
  users: UserProfile[],
): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  // Свой же профиль в списке означал бы кнопку «позвонить самому себе».
  const seen = new Set<string>([me.id]);

  for (const contact of contacts) {
    if (seen.has(contact.userId)) continue;
    seen.add(contact.userId);
    entries.push({ contact, saved: true, test: isSeededIdentity(contact.userId) });
  }

  // Тестовые обитатели существуют, чтобы новичку было куда позвонить, и
  // мешают всем остальным: у основателя один живой Igor тонул среди семи
  // тестовых (его скрин 02.09.2026). Поэтому решение принимается здесь, на
  // экране, а не в хранилище: есть хоть один живой собеседник — тестовых
  // прячем; нет ни одного — показываем всю посеянную сетку.
  const alive = entries.filter((entry) => !entry.test);
  if (alive.length > 0) return alive;

  for (const user of selectSeededIdentities(users)) {
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    entries.push({ contact: cardFor(user), saved: false, test: true });
  }

  return entries;
}

/**
 * Что показывает экран контактов. Пустой список — всегда объяснённый: молчащий
 * пустой экран и есть причина, по которой поломка контактов жила незамеченной
 * несколько дней.
 *
 * @param contacts `null` — запрос контактов не удался.
 * @param users `null` — запрос списка пользователей не удался.
 * @param failure русский текст первой отказавшей ручки, иначе `null`.
 */
export function contactsModel(input: {
  me: UserProfile;
  contacts: ContactCard[] | null;
  users: UserProfile[] | null;
  failure: string | null;
}): ContactsModel {
  const entries = buildDirectory(input.me, input.contacts ?? [], input.users ?? []);
  if (entries.length > 0) return { kind: 'list', entries };

  if (input.failure !== null) {
    return {
      kind: 'empty',
      title: 'Контакты не загрузились',
      detail: `${input.failure} Список приходит с сервера — обновите страницу, когда связь вернётся.`,
    };
  }

  return {
    kind: 'empty',
    title: 'Звонить пока некому',
    detail:
      'Сервер не вернул ни одного профиля — даже четырёх тестовых (Alex, Noa, Omri, Maya). ' +
      'Обновите страницу; если снова пусто, backend поднят без начальных данных.',
  };
}
