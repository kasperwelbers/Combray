/**
 * Fetch, open and export a project's donations. Keys are fetched from the server on every use
 * and dropped right after; plaintext exists only in this page's memory until the researcher
 * saves the export (docs/key-design.md#5-analysing-fetch-on-use).
 */
import { type Cell, type DonationPayload, type NameMap, decodePayload, openDonation, parseNameMap, sealedFromJson } from '@combray/seal';

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
      opened.push({ id: d.id, day: d.day, payload: await decodePayload(payload) });
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

/**
 * The name maps of the project's newest published version, by platform (upload point): what the
 * export places donated values with (`export.ts`). Platforms without one (or a map that does not
 * check out) are left out: their values keep the names they were donated with.
 */
export async function newestNameMaps(projectId: string): Promise<{ version?: number; maps: Map<string, NameMap> }> {
  const maps = new Map<string, NameMap>();
  const { versions } = await api.get<{ versions: { version: number }[] }>(`/projects/${projectId}/versions`);
  const newest = versions.reduce<number | undefined>((n, v) => (n === undefined || v.version > n ? v.version : n), undefined);
  if (newest === undefined) return { maps };
  const { config } = await api.get<{ config: { uploads?: { id: string; importer?: { names?: unknown } }[] } }>(`/projects/${projectId}/versions/${newest}`);
  for (const upload of config.uploads ?? []) {
    if (upload.importer?.names === undefined) continue;
    try {
      maps.set(upload.id, parseNameMap(upload.importer.names));
    } catch {
      // A map that does not check out places nothing: names stay as donated.
    }
  }
  return { version: newest, maps };
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
