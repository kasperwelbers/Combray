/**
 * App texts a project words its own way (docs/translation.md#project-texts): participant-facing
 * texts of the screens inside a study, by `group:key` (`donate:review.title`, the key
 * `donate.review.title` of `locales/{language}/donate.json`). Screens outside a study (the
 * landing page, the list of studies) and the researcher workspace keep the app's texts.
 */
import type { ProjectTexts, Translations } from '@combray/core';

import i18n, { LANGUAGES } from './i18n';

/** Groups of texts a project can word its own way: what participants see inside a study. */
export const PROJECT_GROUPS = ['app', 'backup', 'chart', 'datasets', 'donate', 'explore', 'faq', 'fields', 'import', 'kind', 'lock', 'notice', 'story', 'table', 'type', 'views'] as const;

/**
 * Groups about privacy, keys and donating: a project may word them its own way, but what they
 * say must stay true, so the Texts page warns before they are changed.
 */
export const CAREFUL_GROUPS = new Set<string>(['lock', 'backup', 'donate', 'notice', 'faq']);

export const appTextKey = (key: string) => key.replace(':', '.');

/** The app's own texts that a study's texts replaced, to put back when another study opens. */
let replaced: { language: string; key: string; text: string }[] = [];

/**
 * Lay a study's app texts over the app's own, for the languages the app has; the texts of the
 * study opened before are taken off first.
 */
export function applyAppTexts(app: Record<string, Translations> | undefined): void {
  for (const { language, key, text } of replaced) i18n.addResource(language, 'translation', key, text);
  replaced = [];
  for (const [key, texts] of Object.entries(app ?? {})) {
    const group = key.slice(0, key.indexOf(':'));
    if (!(PROJECT_GROUPS as readonly string[]).includes(group)) continue;
    for (const [language, text] of Object.entries(texts)) {
      if (!(LANGUAGES as readonly string[]).includes(language)) continue;
      const at = appTextKey(key);
      const before = i18n.getResource(language, 'translation', at) as unknown;
      // Only texts the app has: a study cannot add keys of its own.
      if (typeof before !== 'string') continue;
      replaced.push({ language, key: at, text: before });
      i18n.addResource(language, 'translation', at, text);
    }
  }
}

/** The app's languages a study is in, in the study's order; all of them if it says none the app has. */
export function studyLanguages(texts: ProjectTexts): string[] {
  const own = (texts.languages ?? []).filter((l) => (LANGUAGES as readonly string[]).includes(l));
  return own.length > 0 ? own : [...LANGUAGES];
}
