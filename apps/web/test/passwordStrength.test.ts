import { describe, expect, it } from 'vitest';

import { isWeakPassword, passwordBits } from '../src/passwordStrength';

describe('isWeakPassword', () => {
  it('flags short, repeated and sequential passwords', () => {
    for (const p of ['123456', '000000', 'aaaaaaaa', 'abcdef', '654321', '1234567', 'abcabc']) {
      expect(isWeakPassword(p), p).toBe(true);
    }
  });

  it('does not flag longer or mixed passwords', () => {
    for (const p of ['madeleine', 'Thee2024!', 'tea and cake', 'gR7qp2', 'k3Vx9!']) {
      expect(isWeakPassword(p), p).toBe(false);
    }
  });

  it('counts a run or sequence as one character', () => {
    expect(passwordBits('aaaa')).toBe(passwordBits('a'));
    expect(passwordBits('1234')).toBe(passwordBits('9'));
    expect(passwordBits('')).toBe(0);
  });
});
