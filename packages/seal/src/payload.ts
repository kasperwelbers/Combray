/**
 * What is inside a donation once it is opened: the values the participant chose to share, in
 * long format, and their answers. The participant donation flow fills it (`donationValues` in
 * `@combray/core`); the key page pivots the values into tables and gives them as CSV and JSON.
 *
 * Values are the data as matched by the project's configuration, not as tables: the
 * configuration can still change after people donate (docs/decisions/0012-names-and-matches.md).
 */
import { fromUtf8, utf8 } from './bytes';

export type Cell = string | number | boolean | null;

/** A table, for people: its name and its fields' names. */
export interface DonatedTable {
  /** Stable id of the table in the configuration (a name's id, or the path of its rows). */
  id: string;
  /** Name shown to researchers. */
  name: string;
  fields: { id: string; name: string }[];
}

/** One donated value. */
export interface DonatedValue {
  /** The table it belongs to (`DonatedTable.id`). */
  table: string;
  /** The row in this donation; values of one row share it. */
  row: number;
  /** For a row of a nested table: the row it is in. */
  parent?: { table: string; row: number };
  /** The field (`DonatedTable.fields[].id`). */
  field: string;
  /** Where the value was in the participant's files: keys, `[i]` for list items, `{i}` for keys that are data. */
  path: string[];
  /** The value as read. */
  value: Cell;
  /** The value as it was in the file, when it was converted and the researcher asked for both. */
  raw?: Cell;
}

export interface DonationPayload {
  format: 'combray-donation/1';
  tables: DonatedTable[];
  values: DonatedValue[];
  /** Answers to the project's questions, by question id. */
  answers?: Record<string, Cell>;
}

export function encodePayload(payload: DonationPayload): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(payload));
}

const isCell = (v: unknown): v is Cell => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isText = (v: unknown): v is string => typeof v === 'string';
const isRow = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function validValue(v: DonatedValue): boolean {
  return (
    isText(v.table) &&
    isRow(v.row) &&
    (v.parent === undefined || (typeof v.parent === 'object' && v.parent !== null && isText(v.parent.table) && isRow(v.parent.row))) &&
    isText(v.field) &&
    Array.isArray(v.path) &&
    v.path.every(isText) &&
    isCell(v.value) &&
    (v.raw === undefined || isCell(v.raw))
  );
}

/** Parse and check an opened payload. Anything unexpected is refused rather than guessed at. */
export function decodePayload(bytes: Uint8Array): DonationPayload {
  const value = JSON.parse(fromUtf8(bytes)) as Partial<DonationPayload>;
  if (value.format !== 'combray-donation/1' || !Array.isArray(value.tables) || !Array.isArray(value.values)) {
    throw new Error('unknown payload format');
  }
  for (const t of value.tables) {
    const ok =
      isText(t.id) &&
      isText(t.name) &&
      Array.isArray(t.fields) &&
      t.fields.every((f) => typeof f === 'object' && f !== null && isText(f.id) && isText(f.name));
    if (!ok) throw new Error('invalid table in payload');
  }
  if (!value.values.every(validValue)) throw new Error('invalid value in payload');
  if (value.answers !== undefined && (typeof value.answers !== 'object' || !Object.values(value.answers).every(isCell))) {
    throw new Error('invalid answers in payload');
  }
  return value as DonationPayload;
}
