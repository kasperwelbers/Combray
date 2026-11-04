import { describe, expect, it } from 'vitest';

import { pickLanguage } from '../src/language';

describe('pickLanguage', () => {
  it('follows the order of the browser languages', () => {
    expect(pickLanguage(null, ['en-US', 'en', 'nl'])).toBe('en');
    expect(pickLanguage(null, ['nl-NL', 'en'])).toBe('nl');
    expect(pickLanguage(null, ['de-DE', 'nl', 'en'])).toBe('nl');
  });

  it('prefers the language chosen in the app', () => {
    expect(pickLanguage('nl', ['en-US'])).toBe('nl');
    expect(pickLanguage('en', ['nl-NL'])).toBe('en');
  });

  it('ignores unsupported saved values and falls back to English', () => {
    expect(pickLanguage('fr', ['nl'])).toBe('nl');
    expect(pickLanguage(null, ['de', 'fr'])).toBe('en');
    expect(pickLanguage(null, [])).toBe('en');
  });
});
