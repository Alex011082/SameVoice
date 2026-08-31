import type { UserProfile } from './types';

/**
 * The four permanent test identities are the 2x2 grid of translation directions
 * (ru/he x m/f) seeded in backend/src/store.ts. They are listed by id rather
 * than recognised by name, because losing one corner of the grid silently
 * removes a whole direction from what a tester can exercise at all.
 */
const SEEDED_IDS = new Set(['u_alex', 'u_noa', 'u_omri', 'u_maya']);

export function isSeededIdentity(userId: string): boolean {
  return SEEDED_IDS.has(userId);
}

export function selectSeededIdentities(users: UserProfile[]): UserProfile[] {
  return users.filter((user) => SEEDED_IDS.has(user.id));
}
