import { describe, expect, it } from 'vitest';

import { compileWhere, parseWhere } from '../src';

const row = { url: 'https://www.google.com/search?q=tea', details: null, n: '12', title: "Aunt's tea", ok: true };

describe('where expressions', () => {
  it.each([
    ["url ~ 'google\\.com/search'", true],
    ["url ~ 'GOOGLE'", false],
    ["url ~* 'GOOGLE'", true],
    ["url !~ 'youtube'", true],
    ['details == null', true],
    ['details != null', false],
    ['n > 5', true],
    ['n >= 12 and n <= 12', true],
    ["n == '12'", true],
    ['missing == null', true],
    ['missing > 3', false],
    ["not (url ~ 'google') or ok", true],
    ["not url ~ 'google'", false],
    ['ok', true],
    ['details', false],
    ["title == 'Aunt\\'s tea'", true],
  ])('%s → %s', (expression, expected) => {
    expect(compileWhere(expression)(row)).toBe(expected);
  });

  it.each(['url ~', "url ~ field", '(a == 1', 'a == 1 b', "'open", 'and a', "x ~ '['"])('rejects %s', (bad) => {
    expect(() => parseWhere(bad)).toThrow();
  });
});
