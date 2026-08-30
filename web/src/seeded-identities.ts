import type { UserProfile } from './types';

const SEEDED_IDS = new Set(['u_alex', 'u_noa', 'u_omri', 'u_maya']);

export function selectSeededIdentities(users: UserProfile[]): UserProfile[] {
  return users.filter((user) => SEEDED_IDS.has(user.id));
}
