import { describe, expect, it } from 'vitest';
import { buildDirectory, contactsModel } from '../src/contact-directory';
import type { ContactCard, UserProfile } from '../src/types';

const me: UserProfile = {
  id: 'u_4e224d03a7370d19',
  handle: 'user_4e224d03',
  displayName: 'Саша',
  lang: 'ru',
  gender: 'm',
  tone: 'friendly',
};

const seeded: UserProfile[] = [
  { id: 'u_alex', handle: 'alex', displayName: 'Alex', lang: 'ru', gender: 'm', tone: 'neutral' },
  { id: 'u_noa', handle: 'noa', displayName: 'Noa', lang: 'he', gender: 'f', tone: 'friendly' },
  { id: 'u_omri', handle: 'omri', displayName: 'Omri', lang: 'he', gender: 'm', tone: 'friendly' },
  { id: 'u_maya', handle: 'maya', displayName: 'Maya', lang: 'ru', gender: 'f', tone: 'friendly' },
];

function card(user: UserProfile): ContactCard {
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

describe('contacts screen model', () => {
  it('shows the four test identities to a user the server kept no contact rows for', () => {
    // Ровно то, что увидел основатель: контакты пустые, звонить некуда.
    const model = contactsModel({ me, contacts: [], users: seeded, failure: null });

    expect(model.kind).toBe('list');
    if (model.kind !== 'list') throw new Error('the four test identities must be callable');
    expect(model.entries.map((entry) => entry.contact.userId)).toEqual([
      'u_alex',
      'u_noa',
      'u_omri',
      'u_maya',
    ]);
    expect(model.entries.every((entry) => entry.test)).toBe(true);
    expect(model.entries.every((entry) => entry.saved)).toBe(false);
  });

  it('keeps a server contact row once, and marks it as saved', () => {
    const entries = buildDirectory(me, [card(seeded[1]!)], seeded);

    expect(entries.map((entry) => entry.contact.userId)).toEqual([
      'u_noa',
      'u_alex',
      'u_omri',
      'u_maya',
    ]);
    expect(entries[0]).toMatchObject({ saved: true, test: true });
    expect(entries[1]).toMatchObject({ saved: false, test: true });
  });

  it('never lists the signed-in user as someone to call', () => {
    const alex = seeded[0]!;
    const entries = buildDirectory(alex, [card(seeded[1]!)], seeded);

    expect(entries.map((entry) => entry.contact.userId)).toEqual(['u_noa', 'u_omri', 'u_maya']);
  });

  it('marks a real contact as neither test nor unsaved', () => {
    const friend: UserProfile = {
      id: 'u_9f1c2b3a4d5e6f70',
      handle: 'user_9f1c2b3a',
      displayName: 'Дана',
      lang: 'he',
      gender: 'f',
      tone: 'friendly',
    };
    const entries = buildDirectory(me, [card(friend)], []);

    expect(entries).toEqual([{ contact: card(friend), saved: true, test: false }]);
  });

  it('explains an empty list instead of leaving a silent blank screen', () => {
    const model = contactsModel({ me, contacts: [], users: [], failure: null });

    expect(model.kind).toBe('empty');
    if (model.kind !== 'empty') throw new Error('an empty list must explain itself');
    expect(model.title).toBe('Звонить пока некому');
    expect(model.detail).toContain('Alex, Noa, Omri, Maya');
  });

  it('turns a failed request into the reason the screen is empty', () => {
    const model = contactsModel({
      me,
      contacts: null,
      users: null,
      failure: 'Сервер не отвечает — список контактов не загрузился.',
    });

    expect(model).toEqual({
      kind: 'empty',
      title: 'Контакты не загрузились',
      detail:
        'Сервер не отвечает — список контактов не загрузился. ' +
        'Список приходит с сервера — обновите страницу, когда связь вернётся.',
    });
  });

  it('still lists the test identities when only the contacts request failed', () => {
    // Одна отказавшая ручка не должна оставлять телефон без единой кнопки.
    const model = contactsModel({
      me,
      contacts: null,
      users: seeded,
      failure: 'Сервер не отвечает — список контактов не загрузился.',
    });

    expect(model.kind).toBe('list');
    if (model.kind !== 'list') throw new Error('users answered, so calling must stay possible');
    expect(model.entries).toHaveLength(4);
  });
});
