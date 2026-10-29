import type { ValueType } from './tree';

const BOOL = /^(true|false)$/i;
const INT = /^-?\d{1,18}$/;
const FLOAT = /^-?(\d+\.\d*|\.\d+|\d+(\.\d*)?[eE][-+]?\d+)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s?(Z|UTC|[+-]\d{2}:?\d{2})?)?$/;
const DMY_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}( \d{1,2}:\d{2}(:\d{2})?)?$/;
const WRITTEN_DATE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}, \d{4}/i;
const URL_LIKE = /^(https?:\/\/|www\.)\S+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Infer a lightweight type for a raw string value. Cases: test/infer-cases.json. */
export function inferType(raw: string): ValueType {
  const s = raw.trim();
  if (s === '') return 'string';
  if (BOOL.test(s)) return 'bool';
  if (INT.test(s)) return 'int';
  if (FLOAT.test(s)) return 'float';
  if (ISO_DATE.test(s) || DMY_DATE.test(s) || WRITTEN_DATE.test(s)) return 'date-like';
  if (URL_LIKE.test(s)) return 'url-like';
  if (EMAIL.test(s)) return 'email-like';
  return 'string';
}
