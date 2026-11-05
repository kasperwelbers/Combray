import { describe, expect, it, vi } from 'vitest';

// The app's i18n set-up looks at the browser's languages and the page; these tests run without.
vi.stubGlobal('navigator', { languages: ['en'] });
vi.stubGlobal('document', { documentElement: {} });
const { applyAppTexts, studyLanguages } = await import('../src/appTexts');
const { default: i18n } = await import('../src/i18n');

describe('a study wording the app its own way', () => {
  it('replaces texts inside a study, and puts them back for the next study', async () => {
    await i18n.changeLanguage('en');
    const before = i18n.t('donate.title');
    applyAppTexts({ 'donate:title': { en: 'Give us your data', nl: 'Geef ons je gegevens' }, 'admin:title': { en: 'no' }, 'donate:nope': { en: 'new' } });
    expect(i18n.t('donate.title')).toBe('Give us your data');
    expect(i18n.t('donate.title', { lng: 'nl' })).toBe('Geef ons je gegevens');
    expect(i18n.exists('donate.nope')).toBe(false);
    applyAppTexts(undefined);
    expect(i18n.t('donate.title')).toBe(before);
  });

  it('keeps the languages the app has, in the study order', () => {
    expect(studyLanguages({ languages: ['nl', 'fr', 'en'] })).toEqual(['nl', 'en']);
    expect(studyLanguages({ languages: ['fr'] })).toEqual(['en', 'nl']);
    expect(studyLanguages({})).toEqual(['en', 'nl']);
  });
});
