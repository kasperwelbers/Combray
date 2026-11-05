/**
 * Fetch, open and export a project's donations. Keys are fetched from the server on every use
 * and dropped right after; plaintext exists only in this page's memory until the researcher
 * saves the export (docs/key-design.md#5-analysing-fetch-on-use).
 */
import { type Cell, type DonationPayload, decodePayload, openDonation, sealedFromJson } from '@combray/seal';

import { type DonationList, type SealedDonationKey, api } from './api';

export interface Opened {
  id: string;
  day: string;
  payload: DonationPayload;
}

export interface Failed {
  id: string;
  reason: string;
}

export async function openAll(
  projectId: string,
  projectSeed: Uint8Array,
  onProgress: (done: number, total: number) => void,
): Promise<{ opened: Opened[]; failed: Failed[]; withdrawn: number }> {
  const list = await api.get<DonationList>(`/projects/${projectId}/donations`);
  const ids = list.donations.map((d) => d.id);
  const keys = new Map<string, SealedDonationKey>();
  for (let i = 0; i < ids.length; i += 500) {
    const batch = await api.post<{ keys: SealedDonationKey[] }>(`/projects/${projectId}/donation-keys`, { ids: ids.slice(i, i + 500) });
    for (const k of batch.keys) keys.set(k.id, k);
  }
  const opened: Opened[] = [];
  const failed: Failed[] = [];
  for (const [i, d] of list.donations.entries()) {
    onProgress(i, list.donations.length);
    const key = keys.get(d.id);
    if (!key) {
      failed.push({ id: d.id, reason: 'withdrawn or no key' });
      continue;
    }
    try {
      const envelope = await api.bytes(`/projects/${projectId}/donations/${d.id}`);
      const { payload } = await openDonation(envelope, sealedFromJson(key), projectSeed, { projectId, donationId: d.id });
      opened.push({ id: d.id, day: d.day, payload: decodePayload(payload) });
    } catch (e) {
      failed.push({ id: d.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  keys.clear();
  onProgress(list.donations.length, list.donations.length);
  return { opened, failed, withdrawn: list.withdrawn.length };
}

/**
 * One CSV cell. Values that a spreadsheet would read as a formula (`=`, `+`, `-`, `@`, tab,
 * carriage return) get a leading apostrophe: participant data must never run as a formula.
 */
export function csvCell(value: Cell): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const toLine = (cells: Cell[]) => cells.map(csvCell).join(',');
const toFile = (lines: Cell[][]) => lines.map(toLine).join('\r\n') + '\r\n';

/** The cell for a field of a row: its value, or all of them as JSON when the field is a list. */
const joined = (values: Cell[] | undefined): Cell =>
  values === undefined || values.length === 0 ? null : values.length === 1 ? values[0]! : JSON.stringify(values);

/**
 * One CSV per table across all donations: the donated values pivoted into rows, with the
 * donation id, its day and the row number in front (and, for nested tables, the row they are in).
 * A field read in a converted way that was donated as in the file too gets a second column.
 */
export function toCsv(opened: Opened[]): Map<string, { name: string; csv: string }> {
  interface Table {
    name: string;
    fields: Map<string, string>;
    withRaw: Set<string>;
    nested: boolean;
    rows: Map<string, { donation: string; day: string; row: number; parent?: number; values: Map<string, Cell[]>; raw: Map<string, Cell[]> }>;
  }
  const tables = new Map<string, Table>();
  for (const d of opened) {
    for (const t of d.payload.tables) {
      const table = tables.get(t.id) ?? { name: t.name, fields: new Map(), withRaw: new Set(), nested: false, rows: new Map() };
      for (const f of t.fields) if (!table.fields.has(f.id)) table.fields.set(f.id, f.name);
      tables.set(t.id, table);
    }
    for (const v of d.payload.values) {
      const table = tables.get(v.table);
      if (!table) continue;
      if (!table.fields.has(v.field)) table.fields.set(v.field, v.field);
      if (v.parent) table.nested = true;
      if (v.raw !== undefined) table.withRaw.add(v.field);
      const key = `${d.id}\u0000${v.row}`;
      const row = table.rows.get(key) ?? { donation: d.id, day: d.day, row: v.row, ...(v.parent ? { parent: v.parent.row } : {}), values: new Map(), raw: new Map() };
      row.values.set(v.field, [...(row.values.get(v.field) ?? []), v.value]);
      if (v.raw !== undefined) row.raw.set(v.field, [...(row.raw.get(v.field) ?? []), v.raw]);
      table.rows.set(key, row);
    }
  }
  const out = new Map<string, { name: string; csv: string }>();
  for (const [id, t] of tables) {
    const fields = [...t.fields.keys()];
    const header: Cell[] = ['donation', 'day', 'row', ...(t.nested ? ['in row'] : [])];
    for (const f of fields) {
      header.push(t.fields.get(f)!);
      if (t.withRaw.has(f)) header.push(`${t.fields.get(f)!} (as in the file)`);
    }
    const lines = [...t.rows.values()].map((r) => {
      const cells: Cell[] = [r.donation, r.day, r.row, ...(t.nested ? [r.parent ?? null] : [])];
      for (const f of fields) {
        cells.push(joined(r.values.get(f)));
        if (t.withRaw.has(f)) cells.push(joined(r.raw.get(f)));
      }
      return cells;
    });
    out.set(id, { name: t.name, csv: toFile([header, ...lines]) });
  }
  return out;
}

/** Every donated value, one per line, with where it was in the participant's files. */
export function valuesCsv(opened: Opened[]): string {
  const header: Cell[] = ['donation', 'day', 'table', 'row', 'parent table', 'parent row', 'field', 'path', 'value', 'as in the file'];
  const lines = opened.flatMap((d) =>
    d.payload.values.map((v): Cell[] => [
      d.id,
      d.day,
      v.table,
      v.row,
      v.parent?.table ?? null,
      v.parent?.row ?? null,
      v.field,
      v.path.join('/'),
      v.value,
      v.raw ?? null,
    ]),
  );
  return toFile([header, ...lines]);
}

/** One row per donation: its day, the project version it was made with, and the participant's language. */
export function donationsCsv(opened: Opened[]): string {
  const rows = opened.map((d): Cell[] => [d.id, d.day, d.payload.version ?? null, d.payload.consent?.language ?? null]);
  return toFile([['donation', 'day', 'version', 'language'], ...rows]);
}

/** Answers to questions, one row per donation. */
export function answersCsv(opened: Opened[]): string | undefined {
  const questions = [...new Set(opened.flatMap((d) => Object.keys(d.payload.answers ?? {})))];
  if (questions.length === 0) return undefined;
  const lines = opened.map((d) => [d.id, d.day, ...questions.map((q) => d.payload.answers?.[q] ?? null)].map(csvCell).join(','));
  return [['donation', 'day', ...questions].map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}

/** The questions as each participant read them: one row per question, in their language. */
export function questionsCsv(opened: Opened[]): string | undefined {
  const rows = opened.flatMap((d) =>
    (d.payload.questions ?? []).map((q) => [d.id, d.day, d.payload.consent?.language ?? null, q.id, q.prompt, q.options ? q.options.join(' | ') : null]),
  );
  if (rows.length === 0) return undefined;
  return [['donation', 'day', 'language', 'question', 'prompt', 'options'], ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** What each participant agreed to: one row per statement, in the language they read it in. */
export function consentCsv(opened: Opened[]): string | undefined {
  const rows = opened.flatMap((d) => (d.payload.consent?.statements ?? []).map((s) => [d.id, d.day, d.payload.consent!.language, s]));
  if (rows.length === 0) return undefined;
  return [['donation', 'day', 'language', 'statement'], ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'table';
}
