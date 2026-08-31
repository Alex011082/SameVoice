import type { Gender, Lang } from './types';

/**
 * Какое направление перевода проверит звонок этому контакту.
 *
 * Раньше пол и язык собеседника считались диагностикой и жили только под
 * `?debug=1`. Ровно из-за этого четыре тестовых аккаунта стали бесполезны:
 * на экране четыре имени, и по ним невозможно понять, какое направление и
 * какой род иврита проверяет каждое. Направление — это и есть весь смысл
 * существования этих четырёх профилей, поэтому оно продуктовое и видно всегда.
 */
export interface Speaker {
  lang: Lang;
  gender: Gender;
}

export interface CallDirection {
  /** Пойдёт ли звонок через переводящего агента. */
  translated: boolean;
  /** Метка режима на карточке. */
  badge: string;
  /** Мой язык — левый конец стрелки. */
  from: Lang;
  /** Язык собеседника — правый конец стрелки. */
  to: Lang;
  /**
   * Чей род задаёт грамматику иврита. В иврите род — это грамматика, а не
   * стиль: одна и та же фраза звучит по-разному мужчине и женщине, поэтому
   * пара (направление, род) и есть то, что проверяется звонком.
   */
  note: string;
}

/** Короткая метка рядом с языком в карточке контакта. */
export function genderLabel(gender: Gender): string {
  if (gender === 'm') return 'муж.';
  if (gender === 'f') return 'жен.';
  return 'род не указан';
}

function genderCase(gender: Gender): string {
  if (gender === 'm') return 'мужской род';
  if (gender === 'f') return 'женский род';
  return 'род не указан';
}

export function describeDirection(
  me: Speaker,
  contact: Speaker,
  forceTranslate = false,
): CallDirection {
  const translated = forceTranslate || me.lang !== contact.lang;
  const hebrewIsMine = contact.lang !== 'he' && me.lang === 'he';
  const hebrewSpeaker = contact.lang === 'he' ? contact : hebrewIsMine ? me : null;

  let note: string;
  if (!translated) {
    note = 'один язык — перевод не нужен';
  } else if (hebrewSpeaker === null) {
    // Один язык с обеих сторон, но перевод включён вручную для этого контакта.
    note = 'перевод включён вручную';
  } else {
    note = `${hebrewIsMine ? 'ваш иврит' : 'иврит'}, ${genderCase(hebrewSpeaker.gender)}`;
  }

  return {
    translated,
    badge: translated ? 'с переводом' : 'без перевода',
    from: me.lang,
    to: contact.lang,
    note,
  };
}
