import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import nl from './locales/nl.json';

export const LANGUAGES = ['en', 'nl'] as const;

const preferred = navigator.languages.find((l) => l.toLowerCase().startsWith('nl')) ? 'nl' : 'en';

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, nl: { translation: nl } },
  lng: preferred,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});
document.documentElement.lang = preferred;

export default i18n;
