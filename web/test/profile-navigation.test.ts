import { describe, expect, it } from 'vitest';

import { profileUrl } from '../src/profile-navigation';

describe('profile navigation', () => {
  it('builds an explicit profile URL without losing unrelated diagnostics parameters', () => {
    expect(profileUrl('https://samevoice.0110.digital/?check=profile', 'u_1234abcd')).toBe(
      'https://samevoice.0110.digital/?check=profile&me=u_1234abcd',
    );
  });
});
