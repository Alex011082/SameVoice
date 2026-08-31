import { describe, expect, it } from 'vitest';
import { resolveIdentity } from '../src/identity';

/**
 * Дыра, которую это закрывает: личность была параметром `?me=<userId>`, и кто
 * держал ссылку, тот и был этим человеком. Параметр остался — он удобен, — но
 * тесты ниже держат его в роли подсказки: подсказка не входит, не выбирает и
 * не подменяет, она может только не совпасть.
 */
describe('?me= — подсказка, а не вход', () => {
  it('без сессии не пускает никуда, как бы уверенно ссылка ни называла профиль', () => {
    const resolved = resolveIdentity('u_alex', null);

    expect(resolved.userId).toBeNull();
    expect(resolved.ignoredHint).toBe('u_alex');
  });

  it('при расхождении побеждает сессия, а не адресная строка', () => {
    const resolved = resolveIdentity('u_alex', 'u_maya');

    expect(resolved.userId).toBe('u_maya');
    // Именно это раньше и было дырой: чужой id в ссылке открывал чужой профиль.
    expect(resolved.userId).not.toBe('u_alex');
    expect(resolved.ignoredHint).toBe('u_alex');
  });

  it('совпадающая подсказка — обычный случай и не повод ничего сообщать', () => {
    const resolved = resolveIdentity('u_maya', 'u_maya');

    expect(resolved.userId).toBe('u_maya');
    expect(resolved.ignoredHint).toBeNull();
  });

  it('ссылки может не быть вовсе: вход помнит сам себя', () => {
    const resolved = resolveIdentity(null, 'u_maya');

    expect(resolved.userId).toBe('u_maya');
    expect(resolved.ignoredHint).toBeNull();
  });

  it('ни сессии, ни ссылки — просто экран входа, без жалоб', () => {
    expect(resolveIdentity(null, null)).toEqual({ userId: null, ignoredHint: null });
  });
});
