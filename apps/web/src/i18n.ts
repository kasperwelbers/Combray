import i18n, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { pickLanguage, savedLanguage } from './language';

export { LANGUAGES } from './language';

/**
 * Translations live in `locales/{language}/{group}.json`, one file per feature, and each file is
 * the `{group}` part of the keys (`lock.json` holds `lock.*`). Everything participants see exists
 * in every language; a test checks that. The researcher workspace (`studio.json`) is English
 * only. See docs/translation.md.
 */
const files = import.meta.glob<Record<string, unknown>>('./locales/*/*.json', { eager: true, import: 'default' });

function buildResources(found: Record<string, Record<string, unknown>>): Resource {
  const resources: Resource = {};
  for (const [path, content] of Object.entries(found)) {
    const match = /\/locales\/([a-z]+)\/([a-zA-Z0-9-]+)\.json$/.exec(path);
    if (!match) continue;
    const [, language, group] = match as unknown as [string, string, string];
    const translation = ((resources[language] ??= { translation: {} }).translation ?? {}) as Record<string, unknown>;
    translation[group] = content;
  }
  return resources;
}

const preferred = pickLanguage(savedLanguage(), navigator.languages);

void i18n.use(initReactI18next).init({
  resources: buildResources(files),
  lng: preferred,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});
document.documentElement.lang = preferred;

export default i18n;
