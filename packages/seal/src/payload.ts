/**
 * What is inside a donation once it is opened: the values the participant chose to share, and
 * their answers (docs/decisions/0015-raw-paths-and-relational-export.md).
 *
 * The values are a long list, made compact with a dictionary of paths. Each entry of the
 * dictionary is one general path (positions written `[*]` and `{*}`) on one platform, with the
 * table and field it was donated as and how its rows are grouped (`Placement`), so a donation
 * can always be read on its own. Each value points at an entry and gives the positions that fill
 * in its path. The participant donation flow fills it (`donationPayload` in `@combray/core`); the
 * key page places the values with the newest name map and gives them as tables.
 *
 * The JSON text is gzipped before it is sealed.
 */
import { fromUtf8, utf8 } from './bytes';
import type { RowGroup } from './names';

export type Cell = string | number | boolean | null;

export const DONATION_FORMAT = 'combray-donation/2';

/** One general path of a donation, with the names it was donated with. */
export interface DonationEntry {
  /** The upload point (platform) the path is in. */
  platform: string;
  /** The keys from the upload's root, `[*]` for list items and `{*}` for keys that are data. */
  path: string[];
  /** The table and field it was donated as (`''` for fields outside any table). */
  table: string;
  field: string;
  /** How its rows were grouped, outermost table first: see `placements`. */
  rows: RowGroup[];
  /** How the value was read, when it was converted (`date`, `number`, ...). */
  as?: string;
}

/**
 * One donated value: its entry, the positions that fill in the entry's `[*]` and `{*}` steps in
 * order, the value as read, and (when it was converted and the researcher asked for both) the
 * value as it was in the file.
 */
export type DonatedValue = [entry: number, positions: number[], value: Cell, raw?: Cell];

export interface DonationPayload {
  format: typeof DONATION_FORMAT;
  /**
   * The published version of the project the donation was made with: which tables and fields,
   * by which names (docs/decisions/0013-names-labels-versions.md#versions). Missing on donations
   * from before versions were kept.
   */
  version?: number;
  entries: DonationEntry[];
  values: DonatedValue[];
  /** Answers to the project's questions, by question id. */
  answers?: Record<string, Cell>;
  /** The questions answered, as the participant read them: so researchers know what was asked. */
  questions?: DonationQuestion[];
  /** What the participant read and agreed to, as they saw it. */
  consent?: DonationConsent;
}

/** A question of the study's story, in the language the participant read it. */
export interface DonationQuestion {
  id: string;
  prompt: string;
  /** For a choice: the options as shown. The answer is the option's text in English (or its first language). */
  options?: string[];
}

/** The study's information and consent statements, in the language the participant read them. */
export interface DonationConsent {
  language: string;
  information?: string;
  /** Every statement the participant ticked: all of the study's, and that they reviewed what is shared. */
  statements: string[];
}

/** The payload as gzipped JSON text, ready to seal. */
export async function encodePayload(payload: DonationPayload): Promise<Uint8Array<ArrayBuffer>> {
  return gzip(utf8(JSON.stringify(payload)));
}

/** The most an opened payload may hold once unzipped: a gzip bomb stops here. */
export const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, max = Infinity): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error('payload too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export const gzip = (bytes: Uint8Array) => pipe(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes: Uint8Array, max = MAX_PAYLOAD_BYTES) => pipe(bytes, new DecompressionStream('gzip'), max);

const isCell = (v: unknown): v is Cell => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isText = (v: unknown): v is string => typeof v === 'string';
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** How many positions a general path needs. */
export const positionsIn = (path: readonly string[]) => path.reduce((n, s) => n + (s === '[*]' || s === '{*}' ? 1 : 0), 0);

function validGroup(g: unknown, length: number): boolean {
  if (typeof g !== 'object' || g === null) return false;
  const r = g as RowGroup;
  return isText(r.table) && isIndex(r.steps) && r.steps <= length && (r.item === undefined || (isIndex(r.item) && r.item < length));
}

function validEntry(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const v = e as DonationEntry;
  return (
    isText(v.platform) &&
    Array.isArray(v.path) &&
    v.path.every(isText) &&
    isText(v.table) &&
    isText(v.field) &&
    Array.isArray(v.rows) &&
    v.rows.every((g) => validGroup(g, v.path.length)) &&
    (v.as === undefined || isText(v.as))
  );
}

/** The path of a value, with its positions filled in (`[3]`, `{0}`). */
export function valuePath(entry: DonationEntry, positions: readonly number[]): string[] {
  let i = 0;
  return entry.path.map((step) => (step === '[*]' ? `[${positions[i++]}]` : step === '{*}' ? `{${positions[i++]}}` : step));
}

/** Parse and check an opened payload (gzipped JSON). Anything unexpected is refused rather than guessed at. */
export async function decodePayload(bytes: Uint8Array): Promise<DonationPayload> {
  let text: string;
  try {
    text = fromUtf8(await gunzip(bytes));
  } catch (e) {
    throw new Error(e instanceof Error && e.message === 'payload too large' ? e.message : 'unknown payload format');
  }
  const value = JSON.parse(text) as Partial<DonationPayload>;
  if (value.format !== DONATION_FORMAT || !Array.isArray(value.entries) || !Array.isArray(value.values)) {
    throw new Error('unknown payload format');
  }
  if (!value.entries.every(validEntry)) throw new Error('invalid entry in payload');
  if (value.version !== undefined && !(Number.isInteger(value.version) && value.version > 0)) throw new Error('invalid version in payload');
  const entries = value.entries;
  const validValue = (v: unknown): boolean => {
    if (!Array.isArray(v) || v.length < 3 || v.length > 4) return false;
    const [entry, positions, cell, raw] = v as unknown[];
    if (!isIndex(entry) || entry >= entries.length || !Array.isArray(positions) || !positions.every(isIndex)) return false;
    return positions.length === positionsIn(entries[entry]!.path) && isCell(cell) && (v.length === 3 || isCell(raw));
  };
  if (!value.values.every(validValue)) throw new Error('invalid value in payload');
  if (value.answers !== undefined && (typeof value.answers !== 'object' || !Object.values(value.answers).every(isCell))) {
    throw new Error('invalid answers in payload');
  }
  const q = value.questions;
  if (
    q !== undefined &&
    (!Array.isArray(q) ||
      !q.every((x) => typeof x === 'object' && x !== null && isText(x.id) && isText(x.prompt) && (x.options === undefined || (Array.isArray(x.options) && x.options.every(isText)))))
  ) {
    throw new Error('invalid questions in payload');
  }
  const c = value.consent;
  if (
    c !== undefined &&
    (typeof c !== 'object' || c === null || !isText(c.language) || (c.information !== undefined && !isText(c.information)) || !Array.isArray(c.statements) || !c.statements.every(isText))
  ) {
    throw new Error('invalid consent in payload');
  }
  return value as DonationPayload;
}
