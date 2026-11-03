/**
 * What is inside a donation once it is opened. A first, deliberately plain format for the pilot:
 * the tables the participant chose to share, and their answers. The participant donation flow
 * fills it; the key page turns it into CSV and JSON files.
 */
import { fromUtf8, utf8 } from './bytes';

export type Cell = string | number | boolean | null;

export interface DonatedTable {
  /** Stable id of the table in the project tree. */
  id: string;
  /** Name shown to researchers. */
  name: string;
  columns: string[];
  rows: Cell[][];
}

export interface DonationPayload {
  format: 'combray-donation/1';
  tables: DonatedTable[];
  /** Answers to the project's questions, by question id. */
  answers?: Record<string, Cell>;
}

export function encodePayload(payload: DonationPayload): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(payload));
}

const isCell = (v: unknown): v is Cell => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Parse and check an opened payload. Anything unexpected is refused rather than guessed at. */
export function decodePayload(bytes: Uint8Array): DonationPayload {
  const value = JSON.parse(fromUtf8(bytes)) as Partial<DonationPayload>;
  if (value.format !== 'combray-donation/1' || !Array.isArray(value.tables)) throw new Error('unknown payload format');
  for (const t of value.tables) {
    const ok =
      typeof t.id === 'string' &&
      typeof t.name === 'string' &&
      Array.isArray(t.columns) &&
      t.columns.every((c) => typeof c === 'string') &&
      Array.isArray(t.rows) &&
      t.rows.every((r) => Array.isArray(r) && r.every(isCell));
    if (!ok) throw new Error('invalid table in payload');
  }
  if (value.answers !== undefined && (typeof value.answers !== 'object' || !Object.values(value.answers).every(isCell))) {
    throw new Error('invalid answers in payload');
  }
  return value as DonationPayload;
}
