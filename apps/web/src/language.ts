/** Which interface language to start in. Pure, for tests; see i18n.ts. */

export const LANGUAGES = ['en', 'nl'] as const;
export type Language = (typeof LANGUAGES)[number];

const STORAGE_KEY = 'combray:language';

function supported(tag: string | null | undefined): Language | undefined {
  const base = tag?.toLowerCase().split('-')[0];
  return LANGUAGES.find((l) => l === base);
}

/**
 * The language the person chose in the app, if any; otherwise the first supported language in
 * the browser's preference order; otherwise English.
 */
export function pickLanguage(saved: string | null | undefined, browser: readonly string[]): Language {
  return supported(saved) ?? browser.map(supported).find((l) => l !== undefined) ?? 'en';
}

/** The language chosen in the app's language menu, kept on this computer. */
export function savedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveLanguage(language: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Without local storage, the browser's preference applies on the next visit.
  }
}
