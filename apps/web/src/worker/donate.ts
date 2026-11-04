/**
 * The donation, in the data worker: what the study asks for, from every upload, for the
 * participant to review, leave rows out of, and send encrypted (docs/privacy-and-encryption.md).
 *
 * The values are matched afresh from the stored uploads with the study's current settings, in
 * long format (`donationValues` in `@combray/core`). They are sealed here, to the study's key,
 * and only the sealed envelope leaves the device.
 */
import {
  buildTree,
  combineDonations,
  deriveTables,
  donationValues,
  extractShape,
  knownKeys,
  localize,
  normalizeTree,
  parseStory,
  storyQuestions,
  validAnswer,
  withoutRows,
  type Answer,
  type DonatedRow,
  type DonationContent,
  type Localized,
  type Story,
  type TreeNode,
} from '@combray/core';
import { donationRequest, encodePayload, fingerprint, fromBase64Url, sealDonation, type DonationConsent, type DonationQuestion } from '@combray/seal';

import { uploadPoints } from '../projectConfig';
import type { DonateResult, DonationOverview, DonationRow, DonationTable, Page, StudyConsent, UploadPoint } from './api';
import type { PointProject } from './derived';

/** The donation from one upload, with a stable key per row and names for people. */
export interface UploadDonation {
  content: DonationContent;
  keys: string[];
  names: Map<string, { name: Localized; fields: Map<string, Localized> }>;
}

/**
 * What one upload gives: its tree (as stored) read the way the import read it, matched with the
 * study's settings. Rows are keyed by upload, table and the path of the row in the files.
 */
export function uploadDonation(sourceId: string, raw: TreeNode, project: PointProject): UploadDonation {
  const prepared = normalizeTree(raw, { keys: knownKeys(project.tree) });
  const tree = buildTree(project.config, extractShape(prepared), {
    seen: project.seen,
  }).tree;
  const tables = deriveTables(tree);
  const content = donationValues(prepared, tree, tables);
  const names = new Map<string, { name: Localized; fields: Map<string, Localized> }>();
  for (const t of tables) {
    const entry = names.get(t.id) ?? {
      name: t.name,
      fields: new Map<string, Localized>(),
    };
    for (const c of t.columns) if (!entry.fields.has(c.id)) entry.fields.set(c.id, c.name);
    names.set(t.id, entry);
  }
  return {
    content,
    keys: content.rows.map((r) => JSON.stringify([sourceId, r.table, r.path])),
    names,
  };
}

const rowId = (table: string, row: number) => `${table}\u0000${row}`;

const cellText = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/**
 * The donation of all uploads, for review. Left-out rows are kept by key, so they stay out as
 * long as the uploads and the study's settings do not change.
 */
export class Review {
  readonly content: DonationContent;
  /** The study's settings it was made with: a donation is only sent with the same. */
  readonly settings: string;
  private readonly keyOf = new Map<DonatedRow, string>();
  private readonly cells = new Map<string, Record<string, string[]>>();
  private readonly names = new Map<string, { name: Localized; fields: Map<string, Localized> }>();

  /** What the study tells participants and asks them to agree to. */
  readonly consent: StudyConsent | undefined;

  constructor(parts: UploadDonation[], settings: string, consent?: StudyConsent) {
    this.settings = settings;
    this.consent = consent;
    this.content = combineDonations(parts.map((p) => p.content));
    // `combineDonations` keeps the rows in order, upload after upload.
    const keys = parts.flatMap((p) => p.keys);
    this.content.rows.forEach((row, i) => this.keyOf.set(row, keys[i]!));
    for (const part of parts) for (const [id, n] of part.names) if (!this.names.has(id)) this.names.set(id, n);
    for (const v of this.content.values) {
      const id = rowId(v.table, v.row);
      const cells = this.cells.get(id) ?? {};
      (cells[v.field] ??= []).push(cellText(v.value));
      this.cells.set(id, cells);
    }
  }

  get empty(): boolean {
    return this.content.values.length === 0;
  }

  /** Rows that are out: left out themselves, or in a row that is. */
  private dropped(leftOut: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    for (const row of this.content.rows) {
      if (leftOut.has(this.keyOf.get(row)!) || (row.parent && out.has(rowId(row.parent.table, row.parent.row)))) {
        out.add(rowId(row.table, row.row));
      }
    }
    return out;
  }

  overview(leftOut: ReadonlySet<string>): DonationOverview {
    const dropped = this.dropped(leftOut);
    const tables: DonationTable[] = this.content.tables.map((t) => {
      const rows = this.content.rows.filter((r) => r.table === t.id);
      const names = this.names.get(t.id);
      const parent = rows.find((r) => r.parent)?.parent?.table;
      return {
        id: t.id,
        name: names?.name ?? t.name,
        fields: t.fields.map((f) => ({
          id: f.id,
          name: names?.fields.get(f.id) ?? f.name,
        })),
        ...(parent !== undefined ? { parent } : {}),
        rowCount: rows.length,
        leftOut: rows.filter((r) => dropped.has(rowId(r.table, r.row))).length,
      };
    });
    return {
      tables,
      rows: this.content.rows.length,
      leftOut: dropped.size,
      ...(this.consent ? { consent: this.consent } : {}),
    };
  }

  private matches(row: DonatedRow, query: string): boolean {
    if (!query) return true;
    const cells = this.cells.get(rowId(row.table, row.row)) ?? {};
    return Object.values(cells).some((values) => values.some((v) => v.toLocaleLowerCase().includes(query)));
  }

  /** The keys of the rows of a table (or all tables) that contain the text. */
  matching(tableId: string | undefined, query: string): string[] {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return [];
    return this.content.rows.filter((r) => (tableId === undefined || r.table === tableId) && this.matches(r, q)).map((r) => this.keyOf.get(r)!);
  }

  rows(tableId: string, query: string, offset: number, limit: number, leftOut: ReadonlySet<string>): Page<DonationRow> {
    const q = query.trim().toLocaleLowerCase();
    const dropped = this.dropped(leftOut);
    const rows = this.content.rows.filter((r) => r.table === tableId && this.matches(r, q));
    return {
      total: rows.length,
      offset,
      items: rows.slice(offset, offset + limit).map((r) => {
        const key = this.keyOf.get(r)!;
        const out = dropped.has(rowId(r.table, r.row));
        return {
          key,
          cells: this.cells.get(rowId(r.table, r.row)) ?? {},
          leftOut: out && leftOut.has(key),
          withParent: out && !leftOut.has(key),
        };
      }),
    };
  }

  /** What is sent: everything but the rows that are out. */
  donated(leftOut: ReadonlySet<string>): DonationContent {
    return withoutRows(this.content, (r) => leftOut.has(this.keyOf.get(r)!));
  }
}

/** The parts of a study's public config a donation needs. */
export interface StudySettings {
  points: UploadPoint[];
  /** The upload points, consent and story as sent, to tell when they change. */
  settings: string;
  consent?: StudyConsent;
  /** The story participants are walked through, checked block by block. */
  story?: Story;
  key?: { public_key: string; fingerprint: string };
}

/** The study's config, fetched fresh: settings the researcher changed today apply. */
export async function fetchSettings(projectId: string): Promise<StudySettings | undefined> {
  try {
    const response = await fetch(`/api/v1/p/${projectId}/config`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return undefined;
    const config = (await response.json()) as {
      uploads?: unknown;
      consent?: unknown;
      story?: unknown;
      donation_key?: { public_key?: unknown; fingerprint?: unknown };
    };
    const key = config.donation_key;
    const consent = studyConsent(config.consent);
    const story = parseStory(config.story);
    return {
      points: uploadPoints(config.uploads),
      settings: JSON.stringify([config.uploads ?? null, config.consent ?? null, config.story ?? null]),
      ...(consent ? { consent } : {}),
      ...(story ? { story } : {}),
      ...(key && typeof key.public_key === 'string' && typeof key.fingerprint === 'string'
        ? { key: { public_key: key.public_key, fingerprint: key.fingerprint } }
        : {}),
    };
  } catch {
    return undefined;
  }
}

const isLocalized = (v: unknown): v is Localized =>
  typeof v === 'string' || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((s) => typeof s === 'string'));

/** The study's information and consent statements from its config, without trusting its shape. */
export function studyConsent(raw: unknown): StudyConsent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const information = isLocalized(c.information) ? c.information : undefined;
  const statements = Array.isArray(c.statements) ? c.statements.filter(isLocalized) : [];
  if (!information && statements.length === 0) return undefined;
  return {
    ...(information ? { information } : {}),
    ...(statements.length > 0 ? { statements } : {}),
  };
}

/**
 * The answers that go with a donation: to the story's questions as it is now, and only answers
 * that fit them. The questions go along as the participant read them, in their language.
 */
export function donatedAnswers(
  story: Story | undefined,
  answers: Record<string, Answer>,
  language: string,
): { answers: Record<string, Answer>; questions: DonationQuestion[] } {
  const out: Record<string, Answer> = {};
  const questions: DonationQuestion[] = [];
  for (const q of storyQuestions(story)) {
    const answer = answers[q.id];
    if (answer === undefined || !validAnswer(q, answer)) continue;
    out[q.id] = answer;
    questions.push({
      id: q.id,
      prompt: localize(q.prompt, language),
      ...(q.options ? { options: q.options.map((o) => localize(o, language)) } : {}),
    });
  }
  return { answers: out, questions };
}

/**
 * Seal a donation to the study's key and send it. The key must match the fingerprint the server
 * gives for it and, when the participant came in through a study link with one, that link's.
 */
export async function sendDonation(
  projectId: string,
  study: StudySettings,
  content: DonationContent,
  pin: string | undefined,
  consent: DonationConsent,
  asked: { answers: Record<string, Answer>; questions: DonationQuestion[] },
): Promise<DonateResult | { status: 'sent'; donation: string; token: string }> {
  if (!study.key) return { status: 'no-key' };
  const publicKey = fromBase64Url(study.key.public_key);
  const actual = await fingerprint(publicKey);
  if (actual !== study.key.fingerprint || (pin !== undefined && pin !== actual)) return { status: 'wrong-key' };
  const payload = encodePayload({
    format: 'combray-donation/1',
    tables: content.tables,
    values: content.values,
    ...(asked.questions.length > 0 ? asked : {}),
    consent,
  });
  const sealed = await sealDonation(payload, {
    projectId,
    projectPublicKey: publicKey,
  });
  let response: Response;
  try {
    response = await fetch(`/api/v1/p/${projectId}/donations`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: donationRequest(sealed),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return { status: 'unreachable' };
  }
  if (response.status === 413) return { status: 'too-big' };
  if (response.status === 409) return { status: 'no-key' };
  if (response.status !== 201) return { status: 'failed' };
  const body = (await response.json()) as {
    donation: string;
    withdrawal_token: string;
  };
  return {
    status: 'sent',
    donation: body.donation,
    token: body.withdrawal_token,
  };
}

/** Ask the server to forget a donation's key. */
export async function withdrawDonation(donation: string, token: string): Promise<'done' | 'unreachable' | 'failed'> {
  try {
    const response = await fetch(`/api/v1/donations/${encodeURIComponent(donation)}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    // Not found: it was withdrawn already (by the researchers, on request), so it is gone too.
    return response.status === 204 || response.status === 404 ? 'done' : 'failed';
  } catch {
    return 'unreachable';
  }
}
