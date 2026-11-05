/**
 * Texts: what participants read, kept apart from the extractor (docs/decisions/0013-names-labels-versions.md).
 *
 * Tables and fields are called by their names; labels say how participants see them, per
 * language, and change nothing else: not what is extracted, not what stories refer to. A platform
 * pack brings labels of its own (`texts.json`); a project's texts go over them. Without a label,
 * participants see the name with spaces (`defaultLabel`).
 */
import type { Labels } from './derive';
import type { Localized } from './importer/spec';
import { defaultLabel, isName } from './names';

/** Per language: `{ en: 'Watch history', nl: 'Kijkgeschiedenis' }`. */
export type Translations = Record<string, string>;

export interface FieldTexts {
  label?: Translations;
  /** One sentence for participants about what it is. */
  description?: Translations;
}

export interface TableTexts extends FieldTexts {
  /** By the field's name. */
  fields?: Record<string, FieldTexts>;
}

/** The texts of one platform's tables and fields, by the table's name. */
export interface PlatformTexts {
  tables?: Record<string, TableTexts>;
}

export const TEXTS_FORMAT = 'combray-texts@1';

/** A platform pack's texts, as a file. */
export interface TextsFile extends PlatformTexts {
  format: typeof TEXTS_FORMAT;
}

/** Languages as codes: `en`, `nl`, `pt-BR`. */
export const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const MAX_TEXT = 2000;

export class TextsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextsError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new TextsError(message);
}

/** Check translations; empty ones are left out. */
export function checkTranslations(v: unknown, what: string): Translations | undefined {
  if (v === undefined) return undefined;
  check(isObject(v), `${what} must be a map of languages to text`);
  const out: Translations = {};
  for (const [language, text] of Object.entries(v)) {
    check(LANGUAGE.test(language), `${what}: ${language} is not a language code`);
    check(typeof text === 'string' && text.length <= MAX_TEXT, `${what}: ${language} must be text of at most ${MAX_TEXT} characters`);
    if (text.trim() !== '') out[language] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function checkField(v: unknown, what: string): FieldTexts | undefined {
  check(isObject(v), `${what} must be an object`);
  const label = checkTranslations(v.label, `${what}: label`);
  const description = checkTranslations(v.description, `${what}: description`);
  const out: FieldTexts = { ...(label ? { label } : {}), ...(description ? { description } : {}) };
  return label || description ? out : undefined;
}

/** Check a platform's texts: names as keys, translations as values. Empty entries are left out. */
export function checkPlatformTexts(v: unknown, what = 'texts'): PlatformTexts {
  if (v === undefined || v === null) return {};
  check(isObject(v), `${what} must be an object`);
  if (v.tables === undefined) return {};
  check(isObject(v.tables), `${what}: tables must be an object`);
  const tables: Record<string, TableTexts> = {};
  for (const [table, raw] of Object.entries(v.tables)) {
    const at = `${what}: ${table}`;
    check(isName(table), `${at} is not a name`);
    check(isObject(raw), `${at} must be an object`);
    const own = checkField({ label: raw.label, description: raw.description }, at);
    const fields: Record<string, FieldTexts> = {};
    if (raw.fields !== undefined) {
      check(isObject(raw.fields), `${at}: fields must be an object`);
      for (const [field, texts] of Object.entries(raw.fields)) {
        check(isName(field), `${at}.${field} is not a name`);
        const checked = checkField(texts, `${at}.${field}`);
        if (checked) fields[field] = checked;
      }
    }
    const entry: TableTexts = { ...own, ...(Object.keys(fields).length > 0 ? { fields } : {}) };
    if (Object.keys(entry).length > 0) tables[table] = entry;
  }
  return Object.keys(tables).length > 0 ? { tables } : {};
}

export function parseTextsFile(json: unknown): TextsFile {
  check(isObject(json) && json.format === TEXTS_FORMAT, `not a ${TEXTS_FORMAT} file`);
  return { format: TEXTS_FORMAT, ...checkPlatformTexts(json, 'texts') };
}

/** The texts of a table or field, from the last layer that has them, language by language. */
function merged(layers: readonly PlatformTexts[], key: 'label' | 'description', table: string, field?: string): Translations | undefined {
  let out: Translations | undefined;
  for (const layer of layers) {
    const t = layer.tables?.[table];
    const texts = field === undefined ? t?.[key] : t?.fields?.[field]?.[key];
    if (texts) out = { ...(out ?? {}), ...texts };
  }
  return out;
}

/**
 * Labels from layers of texts, the last one winning (a pack's, then the project's). A label
 * without English gets the name with spaces in English, so a language without a label never
 * shows another language's.
 */
export function labelsOf(...layers: readonly (PlatformTexts | undefined)[]): Labels & { description(table: string, field?: string): Localized | undefined } {
  const present = layers.filter((l): l is PlatformTexts => l !== undefined);
  return {
    label(table, field) {
      const texts = merged(present, 'label', table, field);
      if (!texts) return undefined;
      return texts.en !== undefined ? texts : { en: defaultLabel(field ?? table), ...texts };
    },
    description(table, field) {
      return merged(present, 'description', table, field);
    },
  };
}
