/** Researchers write participant-facing text in English and Dutch: helpers for the two fields. */
import type { Localized } from '@combray/core';

/** The text of a localized value in one language (a plain string counts as English). */
export const textIn = (value: Localized | undefined, language: string) =>
  typeof value === 'string' ? (language === 'en' ? value : '') : (value?.[language] ?? '');

/** English and Dutch text as one value, without empty languages; undefined when both are empty. */
export const both = (en: string, nl: string): Localized | undefined => {
  const value: Record<string, string> = {};
  if (en.trim()) value.en = en.trim();
  if (nl.trim()) value.nl = nl.trim();
  return Object.keys(value).length > 0 ? value : undefined;
};
