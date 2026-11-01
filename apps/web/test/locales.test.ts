import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Everything participants see exists in every language, with the same placeholders and markup.
 * The researcher workspace is English only. See docs/translation.md.
 */
const LOCALES = join(import.meta.dirname, '../src/locales');
const LANGUAGES = ['en', 'nl'];
const ENGLISH_ONLY = new Set(['studio.json']);

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const read = (language: string, file: string) =>
  flatten(JSON.parse(readFileSync(join(LOCALES, language, file), 'utf8')) as Tree);

/** `{{name}}` placeholders and `<b>`, `<1>` and similar tags, sorted. */
const tokens = (text: string) =>
  [...text.matchAll(/\{\{\s*[\w.]+\s*\}\}|<\/?[\w]+\s*\/?>/g)].map((m) => m[0].replace(/\s/g, '')).sort();

describe('translations', () => {
  const files = readdirSync(join(LOCALES, 'en')).filter((f) => f.endsWith('.json'));

  it('has the same files in every language, except English-only ones', () => {
    for (const language of LANGUAGES) {
      const expected = language === 'en' ? files : files.filter((f) => !ENGLISH_ONLY.has(f));
      expect(readdirSync(join(LOCALES, language)).sort(), language).toEqual([...expected].sort());
    }
  });

  for (const file of files.filter((f) => !ENGLISH_ONLY.has(f))) {
    it(`${file}: same keys, placeholders and tags in every language`, () => {
      const english = read('en', file);
      for (const language of LANGUAGES.filter((l) => l !== 'en')) {
        const other = read(language, file);
        expect([...other.keys()].sort(), `${language}/${file} keys`).toEqual([...english.keys()].sort());
        for (const [key, text] of english) {
          expect(tokens(other.get(key) ?? ''), `${language}/${file} ${key}`).toEqual(tokens(text));
        }
      }
    });
  }
});
