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

/** One CSV per table id across all donations, with the donation id and day in front. */
export function toCsv(opened: Opened[]): Map<string, { name: string; csv: string }> {
  const tables = new Map<string, { name: string; columns: string[]; rows: Cell[][] }>();
  for (const d of opened) {
    for (const t of d.payload.tables) {
      let table = tables.get(t.id);
      if (!table) {
        table = { name: t.name, columns: [], rows: [] };
        tables.set(t.id, table);
      }
      for (const c of t.columns) if (!table.columns.includes(c)) table.columns.push(c);
      const cols = table.columns;
      for (const row of t.rows) {
        const byName = new Map(t.columns.map((c, i) => [c, row[i] ?? null]));
        table.rows.push([d.id, d.day, ...cols.map((c) => byName.get(c) ?? null)]);
      }
    }
  }
  const out = new Map<string, { name: string; csv: string }>();
  for (const [id, t] of tables) {
    const header = ['donation', 'day', ...t.columns].map(csvCell).join(',');
    // Rows added before a later donation brought new columns are shorter; pad them.
    const width = t.columns.length + 2;
    const lines = t.rows.map((r) => [...r, ...Array<Cell>(Math.max(0, width - r.length)).fill(null)].map(csvCell).join(','));
    out.set(id, { name: t.name, csv: [header, ...lines].join('\r\n') + '\r\n' });
  }
  return out;
}

/** Answers to questions, one row per donation. */
export function answersCsv(opened: Opened[]): string | undefined {
  const questions = [...new Set(opened.flatMap((d) => Object.keys(d.payload.answers ?? {})))];
  if (questions.length === 0) return undefined;
  const lines = opened.map((d) => [d.id, d.day, ...questions.map((q) => d.payload.answers?.[q] ?? null)].map(csvCell).join(','));
  return [['donation', 'day', ...questions].map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'table';
}
