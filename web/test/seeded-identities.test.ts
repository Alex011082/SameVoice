import { describe, expect, it } from 'vitest';
import { selectSeededIdentities } from '../src/seeded-identities';
import type { UserProfile } from '../src/types';

describe('seeded test identity selection', () => {
  it('keeps exactly the four permanent test identities and excludes real users', () => {
    const users = [
      { id: 'u_alex' },
      { id: 'u_noa' },
      { id: 'u_omri' },
      { id: 'u_maya' },
      { id: 'u_e463725ae66a061c' },
    ] as UserProfile[];

    expect(selectSeededIdentities(users).map((user) => user.id)).toEqual([
      'u_alex',
      'u_noa',
      'u_omri',
      'u_maya',
    ]);
  });
});
