/** Built-in transforms and type conversions for importer fields. */
import type { FieldType, Transform } from './spec';

export type FieldValue = string | number | boolean | null | FieldValue[] | { [key: string]: FieldValue };

function mapValue(value: FieldValue, f: (s: string) => FieldValue): FieldValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => mapValue(v, f));
  if (typeof value === 'object') return value;
  return f(String(value));
}

/** The host name of a URL without `www.`, or null. */
export function toDomain(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return url.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Words in a string: lowercased runs of letters and digits, at least 2 characters long. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? []).filter((w) => w.length > 1);
}

export function applyTransform(value: FieldValue, transform: Transform): FieldValue {
  if (typeof transform === 'string') {
    switch (transform) {
      case 'lowercase':
        return mapValue(value, (s) => s.toLowerCase());
      case 'uppercase':
        return mapValue(value, (s) => s.toUpperCase());
      case 'trim':
        return mapValue(value, (s) => s.trim());
      case 'domain':
        return mapValue(value, toDomain);
      case 'tokenize':
        return value === null ? null : tokenize(Array.isArray(value) ? value.join(' ') : String(value));
    }
  }
  if ('replace' in transform) {
    const { pattern, with: replacement = '', ignore_case } = transform.replace;
    const re = new RegExp(pattern, ignore_case ? 'gi' : 'g');
    return mapValue(value, (s) => s.replace(re, replacement));
  }
  if ('match' in transform) {
    const { pattern, group = 0, ignore_case } = transform.match;
    const re = new RegExp(pattern, ignore_case ? 'i' : '');
    return mapValue(value, (s) => re.exec(s)?.[group] ?? null);
  }
  return mapValue(value, (s) => s.split(transform.split.by));
}

// Month names in the languages exports come in, mapped to English for Date.parse.
const MONTHS: Record<string, string> = {
  januari: 'Jan', februari: 'Feb', maart: 'Mar', mrt: 'Mar', april: 'Apr', mei: 'May', juni: 'Jun',
  juli: 'Jul', augustus: 'Aug', okt: 'Oct', oktober: 'Oct',
  januar: 'Jan', februar: 'Feb', 'märz': 'Mar', mai: 'May', dezember: 'Dec', dez: 'Dec',
  janvier: 'Jan', 'février': 'Feb', mars: 'Mar', avril: 'Apr', juin: 'Jun', juillet: 'Jul',
  'août': 'Aug', septembre: 'Sep', octobre: 'Oct', novembre: 'Nov', 'décembre': 'Dec',
  'mär': 'Mar', janv: 'Jan', 'févr': 'Feb', avr: 'Apr', juil: 'Jul', 'déc': 'Dec',
};

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** A local ("floating") ISO timestamp without a zone: the time as the export wrote it. */
function floating(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
}

const ENGLISH_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The month (1 to 12) of a month name or abbreviation, in English, Dutch, German or French. */
function monthNumber(word: string): number | undefined {
  const w = word.replace('.', '').toLowerCase();
  const english = (MONTHS[w] ?? w).toLowerCase();
  const n = ENGLISH_MONTHS.findIndex((m) => english.startsWith(m));
  return n >= 0 ? n + 1 : undefined;
}

const TOKENS: Record<string, string> = {
  YYYY: '(?<Y>\\d{4})',
  MMM: '(?<N>\\p{L}+)',
  MM: '(?<M>\\d{2})',
  M: '(?<M>\\d{1,2})',
  DD: '(?<D>\\d{2})',
  D: '(?<D>\\d{1,2})',
  HH: '(?<h>\\d{2})',
  H: '(?<h>\\d{1,2})',
  mm: '(?<m>\\d{2})',
  ss: '(?<s>\\d{2})',
  SSS: '\\d{1,6}',
  A: '(?<A>[AaPp][Mm])',
  Z: '(?<Z>Z|UTC|GMT|[A-Z]{2,5}|[+-]\\d{2}(?::?\\d{2})?)',
};

const formatCache = new Map<string, RegExp>();
function formatRegex(format: string): RegExp {
  let re = formatCache.get(format);
  if (!re) {
    const source = format.replace(/YYYY|MMM|SSS|MM|DD|HH|mm|ss|M|D|H|A|Z|[.*+?^${}()|[\]\\]/g, (t) =>
      TOKENS[t] ?? `\\${t}`,
    );
    re = new RegExp(`^${source}$`, 'u');
    formatCache.set(format, re);
  }
  return re;
}

/**
 * Parse a date. With a `format` (tokens YYYY MMM MM M DD D HH H mm ss SSS A Z, or epoch-s,
 * epoch-ms, epoch-us) the value must match it. Without one, ISO 8601 and common written forms
 * are tried. Values with a zone become UTC ISO strings (`...Z`); values without one stay
 * floating (`YYYY-MM-DDTHH:mm:ss`), as the participant's local time.
 */
export function parseDate(raw: string, format?: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  if (format?.startsWith('epoch-')) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const ms = format === 'epoch-s' ? n * 1000 : format === 'epoch-us' ? n / 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (format) {
    const g = formatRegex(format).exec(s)?.groups;
    if (!g) return null;
    let hour = Number(g.h ?? 0);
    if (g.A) hour = (hour % 12) + (g.A.toLowerCase() === 'pm' ? 12 : 0);
    const month = g.N !== undefined ? monthNumber(g.N) : Number(g.M ?? 1);
    if (month === undefined) return null;
    const local = floating(Number(g.Y), month, Number(g.D ?? 1), hour, Number(g.m ?? 0), Number(g.s ?? 0));
    // An offset or UTC makes the time absolute; a zone abbreviation is dropped, as below.
    const zone = g.Z && /^(Z|UTC|GMT)$/.test(g.Z) ? 'Z' : g.Z?.match(/^[+-]/) ? g.Z : undefined;
    if (!local || zone === undefined) return local;
    const offset = zone === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})$/, '$1:00').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const date = new Date(`${local}${offset}`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s?(Z|UTC|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (iso) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', zone] = iso;
    if (!zone) return floating(+y!, +mo!, +d!, +h, +mi, +sec);
    const offset = zone === 'Z' || zone === 'UTC' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const date = new Date(`${y}-${mo}-${d}T${pad(+h)}:${pad(+mi)}:${pad(+sec)}${offset}`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dmy) {
    const [, d, mo, y, h = '0', mi = '0', sec = '0'] = dmy;
    return floating(+y!, +mo!, +d!, +h, +mi, +sec);
  }
  // Written dates, e.g. Google's "Mar 4, 2024, 10:20:30 AM CET" or "4 mrt 2024, 10:20:30 CET".
  // The zone abbreviation is dropped: the time stays as the export wrote it.
  const written = s
    .replace(/ | /g, ' ')
    .replace(/\s+[A-Z]{2,5}([+-]\d{1,2}(:\d{2})?)?$/, '')
    .replace(/\p{L}+\.?/gu, (w) => MONTHS[w.replace('.', '').toLowerCase()] ?? w);
  const parsed = new Date(written.replace(/(\d{4}),/, '$1'));
  if (Number.isNaN(parsed.getTime())) return null;
  return floating(
    parsed.getFullYear(),
    parsed.getMonth() + 1,
    parsed.getDate(),
    parsed.getHours(),
    parsed.getMinutes(),
    parsed.getSeconds(),
  );
}

/** Seconds from `PT1H2M3S`, `1:02:03`, `2:03` or a plain number. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (iso && s !== 'P' && s !== 'PT') {
    const [, d = '0', h = '0', m = '0', sec = '0'] = iso;
    return +d * 86400 + +h * 3600 + +m * 60 + +sec;
  }
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) return +(clock[1] ?? 0) * 3600 + +clock[2]! * 60 + +clock[3]!;
  return null;
}

export function convert(value: FieldValue, type: FieldType, format?: string): FieldValue {
  if (type === 'json') return value;
  return mapValue(value, (s) => {
    switch (type) {
      case 'string':
        return s;
      case 'int': {
        const n = Number(s.trim());
        return s.trim() !== '' && Number.isFinite(n) ? Math.trunc(n) : null;
      }
      case 'float': {
        const n = Number(s.trim());
        return s.trim() !== '' && Number.isFinite(n) ? n : null;
      }
      case 'bool':
        return /^(true|yes|1)$/i.test(s.trim()) ? true : /^(false|no|0)$/i.test(s.trim()) ? false : null;
      case 'datetime':
        return parseDate(s, format);
      case 'url':
        return /^(https?:\/\/|www\.)\S+$/i.test(s.trim()) ? s.trim() : null;
      case 'domain':
        return toDomain(s);
      case 'duration':
        return parseDuration(s);
    }
  });
}
