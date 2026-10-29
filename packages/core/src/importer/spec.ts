/**
 * Importer specs: small YAML (or JSON) documents that mark paths in a tree and say how to
 * convert them into a dataset. See docs/universal-importer.md#importers and
 * docs/importer-spec.md for the reference.
 */
import { parse as parseYaml } from 'yaml';

import { parsePath } from '../path';
import { parseWhere } from './where';

export type Localized = string | Record<string, string>;

export type FieldType =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  | 'datetime'
  | 'url'
  | 'domain'
  | 'duration'
  | 'json';

export type Transform =
  | 'lowercase'
  | 'uppercase'
  | 'trim'
  | 'tokenize'
  | 'domain'
  | { replace: { pattern: string; with?: string; ignore_case?: boolean } }
  | { match: { pattern: string; group?: number; ignore_case?: boolean } }
  | { split: { by: string } };

export interface FieldSpec {
  /** Path relative to the row. Mutually exclusive with `from`. */
  path?: string;
  /** Name of an earlier field to start from. */
  from?: string;
  /** Which match to use when the path matches several nodes (0-based). Default 0. */
  nth?: number;
  /** Collect all matches as a list instead of the first one. */
  all?: boolean;
  /** Join all matches into one string with this separator (implies `all`). */
  join?: string;
  /** Built-in transforms, applied in order before `as`. */
  transform?: Transform[];
  /** A pure JavaScript function, run in the QuickJS sandbox: `(value, row) => ...`. */
  script?: string;
  /** Convert to this type. */
  as?: FieldType;
  /** For `datetime`: a format like `YYYY-MM-DD HH:mm:ss`, or `epoch-s`, `epoch-ms`, `epoch-us`. */
  format?: string;
}

export interface DisplayHints {
  /** The field holding the main date, for timelines and memory lane. */
  date?: string;
  /** The field to show as the item's title. */
  title?: string;
  /** The field holding the item's link. */
  url?: string;
  /** Fields that make sense to group and count by, for top items. */
  group_by?: string[];
}

export interface ImporterSpec {
  id: string;
  version: number;
  name: Localized;
  description?: Localized;
  /** Platform pack this importer belongs to, e.g. `google-takeout`. */
  platform?: string;
  match: { file: string };
  select: { rows: string; fields: Record<string, FieldSpec> };
  /** Keep only rows for which this expression is true. */
  where?: string;
  display?: DisplayHints;
}

const FIELD_TYPES = new Set<FieldType>([
  'string',
  'int',
  'float',
  'bool',
  'datetime',
  'url',
  'domain',
  'duration',
  'json',
]);
const SIMPLE_TRANSFORMS = new Set(['lowercase', 'uppercase', 'trim', 'tokenize', 'domain']);

export class SpecError extends Error {
  constructor(
    readonly specId: string,
    message: string,
  ) {
    super(`importer ${specId}: ${message}`);
    this.name = 'SpecError';
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function checkTransform(id: string, field: string, t: unknown): void {
  if (typeof t === 'string') {
    if (!SIMPLE_TRANSFORMS.has(t)) throw new SpecError(id, `field ${field}: unknown transform '${t}'`);
    return;
  }
  if (!isRecord(t) || Object.keys(t).length !== 1) {
    throw new SpecError(id, `field ${field}: a transform is a name or a single-key object`);
  }
  const [name, args] = Object.entries(t)[0]!;
  if (!isRecord(args)) throw new SpecError(id, `field ${field}: ${name} needs arguments`);
  const pattern = (p: unknown) => {
    if (typeof p !== 'string') throw new SpecError(id, `field ${field}: ${name} needs a pattern`);
    try {
      new RegExp(p);
    } catch {
      throw new SpecError(id, `field ${field}: invalid regular expression ${p}`);
    }
  };
  switch (name) {
    case 'replace':
    case 'match':
      pattern(args.pattern);
      return;
    case 'split':
      if (typeof args.by !== 'string') throw new SpecError(id, `field ${field}: split needs 'by'`);
      return;
    default:
      throw new SpecError(id, `field ${field}: unknown transform '${name}'`);
  }
}

/** Check a parsed spec and return it typed. Throws `SpecError` with a readable message. */
export function validateSpec(raw: unknown): ImporterSpec {
  if (!isRecord(raw)) throw new SpecError('?', 'a spec must be an object');
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined;
  if (!id) throw new SpecError('?', "missing 'id'");
  if (!Number.isInteger(raw.version)) throw new SpecError(id, "'version' must be an integer");
  if (typeof raw.name !== 'string' && !isRecord(raw.name)) throw new SpecError(id, "missing 'name'");
  if (!isRecord(raw.match) || typeof raw.match.file !== 'string') {
    throw new SpecError(id, "missing 'match.file'");
  }
  if (!isRecord(raw.select) || typeof raw.select.rows !== 'string' || !isRecord(raw.select.fields)) {
    throw new SpecError(id, "missing 'select.rows' or 'select.fields'");
  }
  const tryPath = (p: string, where: string) => {
    try {
      parsePath(p);
    } catch (e) {
      throw new SpecError(id, `${where}: ${(e as Error).message}`);
    }
  };
  tryPath(raw.match.file, 'match.file');
  tryPath(raw.select.rows, 'select.rows');
  const seen = new Set<string>();
  for (const [name, field] of Object.entries(raw.select.fields)) {
    if (!isRecord(field)) throw new SpecError(id, `field ${name} must be an object`);
    const hasPath = typeof field.path === 'string';
    const hasFrom = typeof field.from === 'string';
    if (hasPath === hasFrom) throw new SpecError(id, `field ${name} needs exactly one of 'path' or 'from'`);
    if (hasPath) tryPath(field.path as string, `field ${name}`);
    if (hasFrom && !seen.has(field.from as string)) {
      throw new SpecError(id, `field ${name}: 'from' must name an earlier field`);
    }
    if (field.as !== undefined && !FIELD_TYPES.has(field.as as FieldType)) {
      throw new SpecError(id, `field ${name}: unknown type '${String(field.as)}'`);
    }
    if (field.transform !== undefined) {
      if (!Array.isArray(field.transform)) throw new SpecError(id, `field ${name}: 'transform' must be a list`);
      for (const t of field.transform) checkTransform(id, name, t);
    }
    if (field.script !== undefined && typeof field.script !== 'string') {
      throw new SpecError(id, `field ${name}: 'script' must be a string`);
    }
    seen.add(name);
  }
  if (raw.where !== undefined) {
    if (typeof raw.where !== 'string') throw new SpecError(id, "'where' must be a string");
    try {
      parseWhere(raw.where);
    } catch (e) {
      throw new SpecError(id, `where: ${(e as Error).message}`);
    }
  }
  if (raw.display !== undefined) {
    if (!isRecord(raw.display)) throw new SpecError(id, "'display' must be an object");
    for (const [key, value] of Object.entries(raw.display)) {
      const names = Array.isArray(value) ? value : [value];
      for (const n of names) {
        if (typeof n !== 'string' || !seen.has(n)) {
          throw new SpecError(id, `display.${key}: '${String(n)}' is not a field`);
        }
      }
    }
  }
  return raw as unknown as ImporterSpec;
}

/** Parse a YAML or JSON importer spec. */
export function parseSpec(source: string): ImporterSpec {
  return validateSpec(parseYaml(source));
}

/** Pick the text for a language from a localized string. */
export function localize(text: Localized | undefined, language: string): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  return text[language] ?? text.en ?? Object.values(text)[0] ?? '';
}
