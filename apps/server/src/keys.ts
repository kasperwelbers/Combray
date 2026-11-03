/**
 * The store key service: holds the key encryption key (KEK) for each participant's local store and
 * releases it only in exchange for the store's password. See docs/security.md#store-keys.
 *
 * - The server never sees the store's data or its data key (DEK). The device keeps the DEK, wrapped
 *   under the KEK, next to the encrypted data. Neither side alone can read the data.
 * - KEK = HKDF-SHA-256(ikm = store master key, salt = per-store random salt, info = label || store id).
 *   The database holds only the salt, so a copy of the database without the store master key yields
 *   no keys, and deleting the row crypto-shreds the store.
 * - Passwords are hashed with Argon2id. Failed attempts are counted per store *before* the hash is
 *   checked, so parallel guesses are counted too, and lead to an increasing lockout.
 * - Per client IP, attempts and new stores are rate limited in memory. IPs are never stored or logged.
 * - Only stores with a participant id can have their password reset, with a one-time token a
 *   researcher creates after verifying who the participant is. A reset keeps the KEK.
 */
import { hkdfSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';

import { hashRaw } from '@node-rs/argon2';

import type { Argon2Cost } from './config.ts';
import { and, eq, gt, lte } from 'drizzle-orm';

import { changes, type Db } from './db.ts';
import { resetTokens, stores } from './db/schema.ts';
import { RateLimit } from './limits.ts';
import { log } from './log.ts';
import { b64, fromB64, nowSecs, random, sameBytes, sha256, validRandomId } from './util.ts';

const KEK_INFO = 'combray/store-kek/v1/';
/** How long a password reset link stays valid. */
export const RESET_TTL_SECS = 72 * 3600;
const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_BYTES = 1024;
/** Failed attempts allowed before the lockout starts. */
const FREE_ATTEMPTS = 5;
const LOCKOUT_BASE_SECS = 30;
const LOCKOUT_MAX_SECS = 3600;

/** Generous, because a whole lab can share one IP; the per-store lockout is the real defence. */
const ATTEMPTS_PER_IP = 120;
const CREATES_PER_IP = 60;
const WINDOW_SECS = 600;

export type KeyError =
  | { kind: 'invalid_password' }
  | { kind: 'not_found' }
  | { kind: 'invalid_reset_token' }
  | { kind: 'wrong_password'; retryAfter?: number }
  | { kind: 'too_many_attempts'; retryAfter: number };

export class KeyFailure extends Error {
  readonly error: KeyError;
  constructor(error: KeyError) {
    super(error.kind);
    this.error = error;
  }
}

const fail = (error: KeyError): never => {
  throw new KeyFailure(error);
};

function checkPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD_CHARS || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
    fail({ kind: 'invalid_password' });
  }
}

/** Read the store master key, or create one if the file does not exist yet. */
export function loadStoreMasterKey(path: string): Buffer {
  try {
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('the store master key file must hold exactly 32 bytes');
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const key = random(32);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, key, { flag: 'wx', mode: 0o600 });
    log.warn({}, 'created a new store master key file; back it up separately from the data');
    return key;
  }
}

/** Seconds to wait after the given number of failed attempts: none at first, then doubling from 30 s to an hour. */
function lockoutSecs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  const doublings = Math.min(failures - FREE_ATTEMPTS, 20);
  return Math.min(LOCKOUT_BASE_SECS * 2 ** doublings, LOCKOUT_MAX_SECS);
}

/** Argon2 is memory hard: bound how many hashes run at once. */
class Semaphore {
  private waiting: (() => void)[] = [];
  private free: number;
  constructor(n: number) {
    this.free = n;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

export interface NewStore {
  storeId: string;
  kek: string;
  /** Lets the device delete the store's key without the password. The server keeps only its SHA-256. */
  deleteToken: string;
}

export class KeyService {
  private readonly db: Db;
  private readonly master: Buffer;
  private readonly cost: Argon2Cost;
  private readonly hashing = new Semaphore(availableParallelism());
  private readonly attemptsPerIp = new RateLimit(ATTEMPTS_PER_IP, WINDOW_SECS);
  private readonly createsPerIp = new RateLimit(CREATES_PER_IP, WINDOW_SECS);

  constructor(db: Db, master: Buffer, cost: Argon2Cost) {
    this.db = db;
    this.master = master;
    this.cost = cost;
  }

  private kek(storeId: string, salt: Uint8Array): string {
    return b64(Buffer.from(hkdfSync('sha256', this.master, salt, Buffer.concat([Buffer.from(KEK_INFO), Buffer.from(storeId)]), 32)));
  }

  private hash(password: string, salt: Uint8Array, cost: Argon2Cost): Promise<Buffer> {
    return this.hashing.run(() =>
      hashRaw(password, {
        // The library's const enums: Algorithm.Argon2id = 2, Version.V0x13 = 1 (version 0x13).
        algorithm: 2,
        version: 1,
        memoryCost: cost.mKib,
        timeCost: cost.t,
        parallelism: cost.p,
        outputLen: 32,
        salt,
      }),
    );
  }

  private limited(limit: RateLimit, ip: string): void {
    const retryAfter = limit.hit(ip);
    if (retryAfter !== undefined) fail({ kind: 'too_many_attempts', retryAfter });
  }

  /** Create a store for a project (and participant, if any). The caller checked the project's policy. */
  async create(ip: string, projectId: string, participantId: string | null, password: unknown): Promise<NewStore> {
    checkPassword(password);
    this.limited(this.createsPerIp, ip);
    const storeId = b64(random(16));
    const kekSalt = random(32);
    const pwSalt = random(16);
    const cost = this.cost;
    const pwHash = await this.hash(password, pwSalt, cost);
    const deleteToken = random(32);
    this.db
      .insert(stores)
      .values({ id: storeId, projectId, participantId, kekSalt, pwSalt, pwHash, deleteHash: sha256(deleteToken), mKib: cost.mKib, tCost: cost.t, pCost: cost.p })
      .run();
    return { storeId, kek: this.kek(storeId, kekSalt), deleteToken: b64(deleteToken) };
  }

  /** Check the password; on success, reset the failure count and return the store's KEK salt. */
  private async verify(ip: string, storeId: unknown, password: unknown): Promise<Buffer> {
    if (!validRandomId(storeId)) return fail({ kind: 'not_found' });
    if (typeof password !== 'string' || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return fail({ kind: 'invalid_password' });
    this.limited(this.attemptsPerIp, ip);
    const now = nowSecs();
    // Count this attempt as failed up front, in one transaction with the lockout check.
    const { store, failures } = this.db.transaction(
      (tx) => {
        const store = tx.select().from(stores).where(eq(stores.id, storeId)).get();
        if (!store) return fail({ kind: 'not_found' });
        if (store.lockedUntil > now) return fail({ kind: 'too_many_attempts', retryAfter: store.lockedUntil - now });
        const failures = store.failures + 1;
        tx.update(stores).set({ failures, lockedUntil: now + lockoutSecs(failures) }).where(eq(stores.id, storeId)).run();
        return { store, failures };
      },
      { behavior: 'immediate' },
    );
    const hash = await this.hash(password, store.pwSalt, { mKib: store.mKib, t: store.tCost, p: store.pCost });
    if (!sameBytes(hash, store.pwHash)) {
      const lockout = lockoutSecs(failures);
      return fail({ kind: 'wrong_password', ...(lockout > 0 ? { retryAfter: lockout } : {}) });
    }
    this.db.update(stores).set({ failures: 0, lockedUntil: 0 }).where(eq(stores.id, storeId)).run();
    return store.kekSalt;
  }

  /** Return the store's KEK, if the password is right. */
  async unlock(ip: string, storeId: unknown, password: unknown): Promise<string> {
    const salt = await this.verify(ip, storeId, password);
    return this.kek(storeId as string, salt);
  }

  /** Forget the store's KEK salt, which makes the data on the device unreadable for good. */
  delete(ip: string, storeId: unknown, deleteToken: unknown): void {
    if (!validRandomId(storeId)) return fail({ kind: 'not_found' });
    this.limited(this.attemptsPerIp, ip);
    const token = fromB64(deleteToken);
    if (!token) return fail({ kind: 'wrong_password' });
    const store = this.db.select({ deleteHash: stores.deleteHash }).from(stores).where(eq(stores.id, storeId)).get();
    if (!store) return fail({ kind: 'not_found' });
    if (!sameBytes(sha256(token), store.deleteHash)) return fail({ kind: 'wrong_password' });
    this.db.delete(stores).where(eq(stores.id, storeId)).run();
  }

  /** A one-time password reset token for a participant's stores in a project. */
  createResetToken(projectId: string, participantId: string): string {
    const token = random(32);
    this.db.delete(resetTokens).where(lte(resetTokens.expiresAt, nowSecs())).run();
    this.db.insert(resetTokens).values({ tokenHash: sha256(token), projectId, participantId, expiresAt: nowSecs() + RESET_TTL_SECS }).run();
    return b64(token);
  }

  /** Set a new password with a reset token, and return the (unchanged) KEK. The token is used up. */
  async reset(ip: string, storeId: unknown, token: unknown, password: unknown): Promise<string> {
    if (!validRandomId(storeId)) return fail({ kind: 'not_found' });
    checkPassword(password);
    this.limited(this.attemptsPerIp, ip);
    const raw = fromB64(token);
    if (!raw) return fail({ kind: 'invalid_reset_token' });
    // Use the token up first, so it cannot be raced; it only counts if it matches the store.
    const kekSalt = this.db.transaction(
      (tx) => {
        const store = tx.select().from(stores).where(eq(stores.id, storeId)).get();
        if (!store) return fail({ kind: 'not_found' });
        if (store.participantId === null) return fail({ kind: 'invalid_reset_token' });
        const used = tx
          .delete(resetTokens)
          .where(
            and(
              eq(resetTokens.tokenHash, sha256(raw)),
              eq(resetTokens.projectId, store.projectId),
              eq(resetTokens.participantId, store.participantId),
              gt(resetTokens.expiresAt, nowSecs()),
            ),
          )
          .run();
        if (changes(used) !== 1) return fail({ kind: 'invalid_reset_token' });
        return store.kekSalt;
      },
      { behavior: 'immediate' },
    );
    const pwSalt = random(16);
    const cost = this.cost;
    const pwHash = await this.hash(password, pwSalt, cost);
    this.db
      .update(stores)
      .set({ pwSalt, pwHash, mKib: cost.mKib, tCost: cost.t, pCost: cost.p, failures: 0, lockedUntil: 0 })
      .where(eq(stores.id, storeId))
      .run();
    return this.kek(storeId, kekSalt);
  }
}
