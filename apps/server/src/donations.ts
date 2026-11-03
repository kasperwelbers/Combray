/**
 * Donation storage, kept in two places on purpose (ADR 0006):
 *
 * - **Envelopes** (ciphertext) as files under `donations/{project}/{id}`, with a small index and the
 *   withdrawal tombstones in `donations.sqlite`. These can be backed up for as long as the
 *   institution likes: without the sealed keys they are unreadable.
 * - **Sealed donation keys** in `donation-keys.sqlite`, a separate file with its own, short backup
 *   retention. Withdrawing deletes the sealed key (with `secure_delete`), which makes every copy of
 *   the envelope unreadable, including copies researchers downloaded.
 *
 * On start, every sealed key with a tombstone is deleted again, so restoring an old backup of the
 * key database cannot bring a withdrawn donation back.
 *
 * Envelopes go through `EnvelopeStore`, so object storage can replace the directory later (ADR 0010).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type Db, all, bytes, one, openDb, run, transaction } from './db.ts';
import { log } from './log.ts';
import { b64, randomToken, sameBytes, sha256, today, validRandomId } from './util.ts';

export type DonationError = 'not_found' | 'forbidden' | 'conflict';

export class DonationFailure extends Error {
  readonly error: DonationError;
  constructor(error: DonationError) {
    super(error);
    this.error = error;
  }
}

const fail = (error: DonationError): never => {
  throw new DonationFailure(error);
};

/** Where envelopes live: a directory now, possibly S3-compatible storage later. */
export interface EnvelopeStore {
  save(project: string, id: string, envelope: Uint8Array): void;
  read(project: string, id: string): Buffer;
  delete(project: string, id: string): void;
}

/** Envelopes as files under `{dir}/{project}/{id}`. Project and donation ids are checked by callers. */
export class DirectoryStore implements EnvelopeStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  private path(project: string, id: string): string {
    return join(this.dir, project, id);
  }
  save(project: string, id: string, envelope: Uint8Array): void {
    mkdirSync(dirname(this.path(project, id)), { recursive: true });
    writeFileSync(this.path(project, id), envelope);
  }
  read(project: string, id: string): Buffer {
    return readFileSync(this.path(project, id));
  }
  delete(project: string, id: string): void {
    rmSync(this.path(project, id), { force: true });
  }
}

export interface NewDonation {
  project: string;
  id: string;
  keyFingerprint: string;
  enc: Uint8Array;
  ciphertext: Uint8Array;
  envelope: Uint8Array;
}

export class Donations {
  private readonly index: Db;
  private readonly keys: Db;
  private readonly envelopes: EnvelopeStore;

  /** Open the index and envelope directory under `dataDir`, and the key database at `keysPath`. */
  constructor(dataDir: string, keysPath: string) {
    this.index = openDb(
      join(dataDir, 'donations.sqlite'),
      `PRAGMA journal_mode = WAL;
       CREATE TABLE IF NOT EXISTS donations (
           id              TEXT PRIMARY KEY,
           project         TEXT NOT NULL,
           day             TEXT NOT NULL,
           bytes           INTEGER NOT NULL,
           withdrawal_hash BLOB NOT NULL
       );
       CREATE INDEX IF NOT EXISTS donations_project ON donations (project);
       CREATE TABLE IF NOT EXISTS tombstones (
           id      TEXT PRIMARY KEY,
           project TEXT NOT NULL,
           day     TEXT NOT NULL
       );`,
    );
    this.keys = openDb(
      keysPath,
      `PRAGMA journal_mode = WAL;
       PRAGMA secure_delete = ON;
       CREATE TABLE IF NOT EXISTS sealed_keys (
           donation    TEXT PRIMARY KEY,
           project     TEXT NOT NULL,
           fingerprint TEXT NOT NULL,
           enc         BLOB NOT NULL,
           ciphertext  BLOB NOT NULL
       );`,
    );
    this.envelopes = new DirectoryStore(join(dataDir, 'donations'));
    this.reapplyWithdrawals();
  }

  /** Delete every sealed key that has a tombstone. Runs on start, after a restore. */
  private reapplyWithdrawals(): void {
    let deleted = 0;
    for (const row of all(this.index, 'SELECT id FROM tombstones')) {
      deleted += run(this.keys, 'DELETE FROM sealed_keys WHERE donation = ?', row.id);
    }
    if (deleted > 0) log.warn({ count: deleted }, 'deleted sealed keys of withdrawn donations (a key database backup was restored?)');
  }

  /** Store a donation; returns the withdrawal token for the participant's receipt. */
  store(d: NewDonation): string {
    if (!validRandomId(d.id)) throw new Error('donation id');
    const token = randomToken();
    if (one(this.index, 'SELECT 1 FROM donations WHERE id = ? UNION SELECT 1 FROM tombstones WHERE id = ?', d.id, d.id)) fail('conflict');
    // The envelope first, then the key, then the index entry that makes it visible.
    this.envelopes.save(d.project, d.id, d.envelope);
    run(this.keys, 'INSERT INTO sealed_keys (donation, project, fingerprint, enc, ciphertext) VALUES (?, ?, ?, ?, ?)', d.id, d.project, d.keyFingerprint, d.enc, d.ciphertext);
    run(
      this.index,
      'INSERT INTO donations (id, project, day, bytes, withdrawal_hash) VALUES (?, ?, ?, ?, ?)',
      d.id, d.project, today(), d.envelope.length, sha256(token),
    );
    return b64(token);
  }

  /** Withdraw a donation: delete its sealed key and envelope, keep a tombstone. */
  private withdraw(project: string, id: string): void {
    run(this.keys, 'DELETE FROM sealed_keys WHERE donation = ?', id);
    transaction(this.index, () => {
      run(this.index, 'DELETE FROM donations WHERE id = ?', id);
      run(this.index, 'INSERT OR IGNORE INTO tombstones (id, project, day) VALUES (?, ?, ?)', id, project, today());
    });
    this.envelopes.delete(project, id);
  }

  /** Withdraw with the participant's withdrawal token. */
  withdrawWithToken(id: string, token: Uint8Array): void {
    if (!validRandomId(id)) fail('not_found');
    const row = one(this.index, 'SELECT project, withdrawal_hash FROM donations WHERE id = ?', id) ?? fail('not_found');
    if (!sameBytes(sha256(token), bytes(row.withdrawal_hash)!)) fail('forbidden');
    this.withdraw(String(row.project), id);
  }

  /** Withdraw on a participant's behalf, by a researcher of the project. */
  withdrawForProject(project: string, id: string): void {
    if (!one(this.index, 'SELECT 1 FROM donations WHERE id = ? AND project = ?', id, project)) fail('not_found');
    this.withdraw(project, id);
  }

  list(project: string): { donations: { id: string; day: string; bytes: number }[]; withdrawn: { id: string; day: string }[] } {
    return {
      donations: all(this.index, 'SELECT id, day, bytes FROM donations WHERE project = ? ORDER BY day, id', project).map((r) => ({
        id: String(r.id),
        day: String(r.day),
        bytes: Number(r.bytes),
      })),
      withdrawn: all(this.index, 'SELECT id, day FROM tombstones WHERE project = ? ORDER BY day, id', project).map((r) => ({
        id: String(r.id),
        day: String(r.day),
      })),
    };
  }

  envelope(project: string, id: string): Buffer {
    if (!validRandomId(id)) fail('not_found');
    if (!one(this.index, 'SELECT 1 FROM donations WHERE id = ? AND project = ?', id, project)) fail('not_found');
    return this.envelopes.read(project, id);
  }

  /** The sealed keys of the given donations of a project. Unknown or withdrawn ids are left out. */
  sealedKeys(project: string, ids: unknown[]): { id: string; key: string; enc: string; ciphertext: string }[] {
    const out = [];
    for (const id of ids) {
      if (!validRandomId(id)) continue;
      const row = one(this.keys, 'SELECT fingerprint, enc, ciphertext FROM sealed_keys WHERE donation = ? AND project = ?', id, project);
      if (row) out.push({ id, key: String(row.fingerprint), enc: b64(bytes(row.enc)!), ciphertext: b64(bytes(row.ciphertext)!) });
    }
    return out;
  }
}

/** The envelope header fields the server checks (see packages/seal/src/envelope.ts). */
export interface EnvelopeHeader {
  v: number;
  project: string;
  donation: string;
  key: string;
}

const MAGIC = Buffer.from('CMBRDON1');

/** Read the header of an envelope; undefined if it is not a valid one. */
export function readHeader(envelope: Buffer): EnvelopeHeader | undefined {
  if (envelope.length < 12 || !envelope.subarray(0, 8).equals(MAGIC)) return undefined;
  const length = envelope.readUInt32BE(8);
  if (length > 16 * 1024 || 12 + length > envelope.length) return undefined;
  try {
    const h = JSON.parse(envelope.subarray(12, 12 + length).toString('utf8')) as Record<string, unknown>;
    if (typeof h.v !== 'number' || typeof h.project !== 'string' || typeof h.donation !== 'string' || typeof h.key !== 'string') return undefined;
    return { v: h.v, project: h.project, donation: h.donation, key: h.key };
  } catch {
    return undefined;
  }
}
