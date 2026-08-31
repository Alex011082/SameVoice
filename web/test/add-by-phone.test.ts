import { describe, expect, it } from 'vitest';
import { ADD_BY_PHONE_DONE, addByPhoneDone, addByPhoneFailed } from '../src/add-by-phone';

/** Ошибка в форме конверта backend'а, как её видит клиент. */
function apiError(code: string, status: number, message = 'boom'): unknown {
  return { code, status, message };
}

describe('«добавить по номеру»: что видит человек', () => {
  it('подтверждает условно и не говорит, есть ли у номера профиль', () => {
    const status = addByPhoneDone();

    expect(status.tone).toBe('ok');
    // Утечка вернулась бы именно так: сервер отвечает одинаково на знакомый и
    // на незнакомый номер, а экран дорисовывает разницу словами.
    expect(status.text).not.toMatch(/добавлен[аоы]?\b/i);
    expect(status.text).not.toMatch(/зарегистрирован/i);
    expect(status.text).not.toMatch(/не найден|нет такого|не существует/i);
    expect(status.text).toContain('Если у этого номера есть профиль');
    expect(ADD_BY_PHONE_DONE).toBe(status.text);
  });

  it('объясняет лимит через чужие номера, а не через нагрузку на сервер', () => {
    const status = addByPhoneFailed(apiError('rate_limited', 429));

    expect(status.tone).toBe('error');
    expect(status.text).toContain('перебора');
    expect(status.text).not.toMatch(/ошибка|сломал/i);
  });

  it('на 401 отправляет входить заново, а не пробовать ещё раз', () => {
    expect(addByPhoneFailed(apiError('unauthorized', 401)).text).toContain('войдите по номеру');
  });

  it('на нечитаемый номер повторяет формат, который принимает сервер', () => {
    const text = addByPhoneFailed(apiError('bad_request', 400)).text;

    expect(text).toContain('05X XXX XXXX');
    expect(text).toContain('«+»');
  });

  it('оборванная сеть — это не «номера нет»', () => {
    const text = addByPhoneFailed(apiError('network', 0, 'fetch failed')).text;

    expect(text).toContain('Сервер не отвечает');
    expect(text).not.toMatch(/профил|номер[ае]/i);
  });

  it('старая сборка backend’а названа своим именем', () => {
    expect(addByPhoneFailed(apiError('route_missing', 404)).text).toContain('Обновите backend');
  });

  it('незнакомый код ошибки не молчит: показывает, что ответил сервер', () => {
    expect(addByPhoneFailed(apiError('internal', 500, 'boom')).text).toContain('boom');
  });
});
