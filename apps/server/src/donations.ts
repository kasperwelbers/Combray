/**
 * Donation storage, kept in two places on purpose (ADR 0006):
 *
 * - **Envelopes** (ciphertext) as files under `donations/{project}/{id}`, with a small index and the
 *   withdrawal tombstones in the main database. These can be backed up for as long as the
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

import { and, asc, eq } from 'drizzle-orm';

import type { Db } from './db.ts';
import { donations, tombstones } from './db/schema.ts';
import { sealedKeys } from './db/keys-schema.ts';
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

  /** The donation index in the main database, sealed keys in the key database, envelopes in `dataDir/donations`. */
  constructor(index: Db, keys: Db, dataDir: string) {
    this.index = index;
    this.keys = keys;
    this.envelopes = new DirectoryStore(join(dataDir, 'donations'));
    this.reapplyWithdrawals();
  }

  /** Delete every sealed key that has a tombstone. Runs on start, after a restore. */
  private reapplyWithdrawals(): void {
    let deleted = 0;
    for (const { id } of this.index.select({ id: tombstones.id }).from(tombstones).all()) {
      deleted += Number(this.keys.delete(sealedKeys).where(eq(sealedKeys.donation, id)).run().changes);
    }
    if (deleted > 0) log.warn({ count: deleted }, 'deleted sealed keys of withdrawn donations (a key database backup was restored?)');
  }

  private taken(id: string): boolean {
    return (
      this.index.select({ id: donations.id }).from(donations).where(eq(donations.id, id)).get() !== undefined ||
      this.index.select({ id: tombstones.id }).from(tombstones).where(eq(tombstones.id, id)).get() !== undefined
    );
  }

  private exists(project: string, id: string): boolean {
    return this.index.select({ id: donations.id }).from(donations).where(and(eq(donations.id, id), eq(donations.project, project))).get() !== undefined;
  }

  /** Store a donation; returns the withdrawal token for the participant's receipt. */
  store(d: NewDonation): string {
    if (!validRandomId(d.id)) throw new Error('donation id');
    const token = randomToken();
    if (this.taken(d.id)) fail('conflict');
    // The envelope first, then the key, then the index entry that makes it visible.
    this.envelopes.save(d.project, d.id, d.envelope);
    this.keys
      .insert(sealedKeys)
      .values({ donation: d.id, project: d.project, fingerprint: d.keyFingerprint, enc: Buffer.from(d.enc), ciphertext: Buffer.from(d.ciphertext) })
      .run();
    this.index.insert(donations).values({ id: d.id, project: d.project, day: today(), bytes: d.envelope.length, withdrawalHash: sha256(token) }).run();
    return b64(token);
  }

  /** Withdraw a donation: delete its sealed key and envelope, keep a tombstone. */
  private withdraw(project: string, id: string): void {
    this.keys.delete(sealedKeys).where(eq(sealedKeys.donation, id)).run();
    this.index.transaction((tx) => {
      tx.delete(donations).where(eq(donations.id, id)).run();
      tx.insert(tombstones).values({ id, project, day: today() }).onConflictDoNothing().run();
    });
    this.envelopes.delete(project, id);
  }

  /** Withdraw with the participant's withdrawal token. */
  withdrawWithToken(id: string, token: Uint8Array): void {
    if (!validRandomId(id)) fail('not_found');
    const row = this.index.select().from(donations).where(eq(donations.id, id)).get() ?? fail('not_found');
    if (!sameBytes(sha256(token), row.withdrawalHash)) fail('forbidden');
    this.withdraw(row.project, id);
  }

  /** Withdraw on a participant's behalf, by a researcher of the project. */
  withdrawForProject(project: string, id: string): void {
    if (!this.exists(project, id)) fail('not_found');
    this.withdraw(project, id);
  }

  list(project: string): { donations: { id: string; day: string; bytes: number }[]; withdrawn: { id: string; day: string }[] } {
    return {
      donations: this.index
        .select({ id: donations.id, day: donations.day, bytes: donations.bytes })
        .from(donations)
        .where(eq(donations.project, project))
        .orderBy(asc(donations.day), asc(donations.id))
        .all(),
      withdrawn: this.index
        .select({ id: tombstones.id, day: tombstones.day })
        .from(tombstones)
        .where(eq(tombstones.project, project))
        .orderBy(asc(tombstones.day), asc(tombstones.id))
        .all(),
    };
  }

  envelope(project: string, id: string): Buffer {
    if (!validRandomId(id) || !this.exists(project, id)) fail('not_found');
    return this.envelopes.read(project, id);
  }

  /** The sealed keys of the given donations of a project. Unknown or withdrawn ids are left out. */
  sealedKeys(project: string, ids: unknown[]): { id: string; key: string; enc: string; ciphertext: string }[] {
    const out = [];
    for (const id of ids) {
      if (!validRandomId(id)) continue;
      const row = this.keys.select().from(sealedKeys).where(and(eq(sealedKeys.donation, id), eq(sealedKeys.project, project))).get();
      if (row) out.push({ id, key: row.fingerprint, enc: b64(row.enc), ciphertext: b64(row.ciphertext) });
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
