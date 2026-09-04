import { describe, expect, it } from 'vitest';
import { describeDirection, genderLabel } from '../src/direction';

describe('translation direction on a contact card', () => {
  it('names the direction and the Hebrew gender for a russian man calling a hebrew woman', () => {
    expect(describeDirection({ lang: 'ru', gender: 'm' }, { lang: 'he', gender: 'f' })).toEqual({
      translated: true,
      badge: 'с переводом',
      from: 'ru',
      to: 'he',
      note: 'иврит, женский род',
    });
  });

  it('separates the two hebrew corners of the grid by gender, not by name', () => {
    const toOmri = describeDirection({ lang: 'ru', gender: 'm' }, { lang: 'he', gender: 'm' });
    const toNoa = describeDirection({ lang: 'ru', gender: 'm' }, { lang: 'he', gender: 'f' });

    expect(toOmri.note).toBe('иврит, мужской род');
    expect(toNoa.note).toBe('иврит, женский род');
  });

  it('says whose hebrew it is when the hebrew side is me', () => {
    expect(describeDirection({ lang: 'he', gender: 'f' }, { lang: 'ru', gender: 'm' })).toMatchObject(
      { from: 'he', to: 'ru', note: 'ваш иврит, женский род' },
    );
  });

  it('calls the same-language pair what it is: no translation', () => {
    expect(describeDirection({ lang: 'ru', gender: 'm' }, { lang: 'ru', gender: 'f' })).toEqual({
      translated: false,
      badge: 'без перевода',
      from: 'ru',
      to: 'ru',
      note: 'один язык — перевод не нужен',
    });
  });

  it('reports a forced translation between two russian speakers as manual', () => {
    expect(
      describeDirection({ lang: 'ru', gender: 'm' }, { lang: 'ru', gender: 'f' }, true),
    ).toMatchObject({ translated: true, note: 'перевод включён вручную' });
  });

  it('never claims a gender it was not told', () => {
    expect(describeDirection({ lang: 'ru', gender: 'm' }, { lang: 'he', gender: 'u' }).note).toBe(
      'иврит, род не указан',
    );
    expect(genderLabel('u')).toBe('род не указан');
  });
});
