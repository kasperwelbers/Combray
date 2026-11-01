/**
 * Value formats: how a value is written, without the value. `2010-12-05` becomes
 * `YYYY-MM-DD` and `Mar 4, 2021, 10:20:30 AM CET` becomes `MMM D, YYYY, H:mm:ss A Z`.
 *
 * Formats are structure metadata (docs/exploration.md#value-formats): researchers who only
 * see the structure can still set up a date parser and a timeline. A format is made of tokens
 * and separators only; any part of a value that is not a known token gives no format, so no
 * text from a value can end up in one. The tokens are those of `parseDate`, plus `X` for a day
 * or month whose order cannot be told from this value (`4/3/2021`).
 */
import type { ValueType } from './tree';

/** At most this many formats are kept per position; more is unusual and not useful. */
export const MAX_FORMATS = 8;

// Month names and abbreviations in the languages exports come in (en, nl, de, fr).
const MONTH_WORDS = new Set(
  (
    'jan january feb february mar march apr april may jun june jul july aug august sep sept september ' +
    'oct october nov november dec december januari februari maart mrt mei juni juli augustus okt oktober ' +
    'januar februar märz mär mai dezember dez janvier janv février févr mars avril avr juin juillet ' +
    'juil août septembre octobre novembre décembre déc'
  ).split(' '),
);

const ZONE = /^(Z|UTC|GMT|[A-Z]{2,5})$/;

type Token = { t: 'num'; s: string } | { t: 'word'; s: string } | { t: 'sep'; s: string };

function tokens(s: string): Token[] | undefined {
  const out: Token[] = [];
  const re = /(\d+)|(\p{L}+)|([\s,./:+-])/uy;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return undefined;
    if (m[1]) out.push({ t: 'num', s: m[1] });
    else if (m[2]) out.push({ t: 'word', s: m[2] });
    else out.push({ t: 'sep', s: m[3] === ' ' ? ' ' : m[3]! });
    i = re.lastIndex;
  }
  return out;
}

/** The format of a written date, or undefined if any part of it is not a known token. */
function dateFormat(raw: string): string | undefined {
  const s = raw.trim().replace(/[  ]/g, ' ').replace(/\s+/g, ' ');
  // ISO 8601 has a T between date and time; split it off so the tokenizer sees a separator.
  const iso = /^(\d{4}-\d{2}-\d{2})T(.*)$/.exec(s);
  const parts = tokens(iso ? `${iso[1]} ${iso[2]}` : s);
  if (!parts) return undefined;
  const out: string[] = parts.map((p) => p.s);
  const date: number[] = [];
  let hasMonthName = false;
  let afterTime = false;
  const isoLike = /^\d{4}-\d{2}-\d{2}/.test(s);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.t === 'num') {
      // A time: H:mm, H:mm:ss, H:mm:ss.SSS.
      if (parts[i + 1]?.s === ':' && parts[i + 2]?.t === 'num' && p.s.length <= 2) {
        // `H` reads one or two digits; written dates vary (`9:05 AM`, `10:05 AM`), ISO does not.
        out[i] = isoLike && p.s.length === 2 ? 'HH' : 'H';
        out[i + 2] = 'mm';
        let j = i + 2;
        if (parts[j + 1]?.s === ':' && parts[j + 2]?.t === 'num') {
          out[j + 2] = 'ss';
          j += 2;
          if (parts[j + 1]?.s === '.' && parts[j + 2]?.t === 'num') {
            out[j + 2] = 'SSS';
            j += 2;
          }
        }
        i = j;
        afterTime = true;
        continue;
      }
      if (p.s.length === 4) {
        out[i] = 'YYYY';
        continue;
      }
      if (p.s.length > 2 || afterTime) return undefined;
      date.push(i);
      continue;
    }
    if (p.t === 'word') {
      const w = p.s.toLowerCase();
      if (MONTH_WORDS.has(w)) {
        out[i] = 'MMM';
        hasMonthName = true;
      } else if (/^[ap]m$/.test(w)) out[i] = 'A';
      else if (ZONE.test(p.s) && (afterTime || p.s === 'Z')) out[i] = 'Z';
      else return undefined;
      continue;
    }
    // A zone offset after the time: +01:00, +0100, -05. Date parts are separated by `-` too.
    if ((p.s === '+' || p.s === '-') && afterTime) {
      if (parts[i + 1]?.t !== 'num' || ![2, 4].includes(parts[i + 1]!.s.length)) return undefined;
      out[i] = 'Z';
      out[i + 1] = '';
      i++;
      if (parts[i + 1]?.s === ':' && parts[i + 2]?.t === 'num') {
        out[i + 1] = '';
        out[i + 2] = '';
        i += 2;
      }
    }
  }
  if (!out.includes('YYYY')) return undefined;
  const yearFirst = out.indexOf('YYYY') < (date[0] ?? Infinity);
  if (hasMonthName) {
    if (date.length !== 1) return undefined;
    out[date[0]!] = 'D';
  } else if (date.length === 2) {
    const [a, b] = date.map((i) => Number(parts[i]!.s)) as [number, number];
    if (yearFirst) {
      out[date[0]!] = parts[date[0]!]!.s.length === 2 ? 'MM' : 'M';
      out[date[1]!] = parts[date[1]!]!.s.length === 2 ? 'DD' : 'D';
    } else if (a > 12 && b <= 12) {
      out[date[0]!] = 'D';
      out[date[1]!] = 'M';
    } else if (b > 12 && a <= 12) {
      out[date[0]!] = 'M';
      out[date[1]!] = 'D';
    } else {
      out[date[0]!] = 'X';
      out[date[1]!] = 'X';
    }
  } else {
    return undefined;
  }
  let format = out.join('');
  if (iso) format = format.replace(/^YYYY-MM-DD /, 'YYYY-MM-DDT');
  return format;
}

const EPOCH_S = [978307200, 4102444800] as const; // 2001 to 2100

/** Numbers that could be timestamps: seconds, milliseconds or microseconds since 1970. */
function epochFormat(raw: string): string | undefined {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n >= EPOCH_S[0] && n < EPOCH_S[1]) return 'epoch-s';
  if (n >= EPOCH_S[0] * 1e3 && n < EPOCH_S[1] * 1e3) return 'epoch-ms';
  if (n >= EPOCH_S[0] * 1e6 && n < EPOCH_S[1] * 1e6) return 'epoch-us';
  return undefined;
}

/** The format of a value, for types that have one. Never contains any part of the value. */
export function valueFormat(raw: string, type: ValueType): string | undefined {
  switch (type) {
    case 'date-like':
      return dateFormat(raw);
    case 'int':
    case 'float':
      return epochFormat(raw);
    default:
      return undefined;
  }
}

const FORMAT_SYNTAX = /^(epoch-(s|ms|us)|[YMDHmsSAZXT ,./:-]{1,60})$/;

/** True if a string could be a format: tokens and separators only, for validating files. */
export function isFormat(s: string): boolean {
  return FORMAT_SYNTAX.test(s) && (s.startsWith('epoch-') || /YYYY/.test(s));
}

/**
 * The formats to parse with, from those seen: an `X` day-or-month order is resolved by an
 * order seen elsewhere at the same position, or else offered both ways, day first.
 */
export function dateFormats(seen: string[]): string[] {
  const out: string[] = [];
  const add = (f: string) => {
    if (!out.includes(f)) out.push(f);
  };
  const definite = seen.filter((f) => !f.includes('X'));
  for (const f of definite) add(f);
  for (const f of seen.filter((f) => f.includes('X'))) {
    const dayFirst = f.replace('X', 'D').replace('X', 'M');
    const monthFirst = f.replace('X', 'M').replace('X', 'D');
    if (definite.includes(dayFirst)) continue;
    if (definite.includes(monthFirst)) continue;
    add(dayFirst);
    add(monthFirst);
  }
  return out;
}
