/**
 * Researcher accounts, sign-in, project membership and project keys. See docs/researcher-keys.md.
 *
 * The server never holds a key that opens anything. It stores each researcher's personal public
 * key and the SHA-256 of their recovery sign-in secret; per passkey, the researcher's master secret
 * wrapped under the passkey's PRF output; per project, the project public key and the project
 * private key sealed to each member's personal public key.
 *
 * Secrets that grant access (session ids, handoff codes, the browser's pending email sign-in) are
 * random 256-bit values; the database keeps only their SHA-256. Emailed sign-in codes are short, so
 * they only work together with the pending sign-in of the browser and site that asked for them, and
 * only a few times. Nothing here is logged.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, count, eq, gt, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';

import { changes, type Db, type Queries } from './db.ts';
import { handoffs, loginCodes, members, passkeys, projectKeys, researchers, sessions } from './db/schema.ts';
import { b64, fromB64, nowSecs, random, randomToken, sameBytes, sha256 } from './util.ts';

/** How long an emailed sign-in code works. */
export const LOGIN_CODE_TTL_SECS = 10 * 60;
/** Wrong guesses before a sign-in code stops working. */
export const LOGIN_CODE_TRIES = 5;
/** After the email code, the second step (passkey or recovery code) must follow within this time. */
export const EMAIL_SESSION_TTL_SECS = 15 * 60;
/** A signed-in session on the key page. Short, because it can fetch sealed keys. */
export const KEYS_SESSION_TTL_SECS = 2 * 3600;
/** A studio session, which cannot fetch any key material. Long, so researchers rarely need a code. */
export const STUDIO_SESSION_TTL_SECS = 30 * 24 * 3600;
/** A handoff code from the key page to the studio is used within seconds. */
export const HANDOFF_TTL_SECS = 120;
/** Personal and project public keys are X-Wing keys. */
export const PUBLIC_KEY_BYTES = 1216;
const MAX_SEALED_BYTES = 4096;
const MAX_PASSKEYS = 10;

export type AccountError = 'not_found' | 'forbidden' | 'conflict' | 'invalid';

export class AccountFailure extends Error {
  readonly error: AccountError;
  constructor(error: AccountError) {
    super(error);
    this.error = error;
  }
}

const fail = (error: AccountError): never => {
  throw new AccountFailure(error);
};

/** Which site a session belongs to. Sessions never cross between the key page and the main site. */
export type Site = 'keys' | 'main';
/** How far sign-in has got: the email code only, or fully signed in. */
export type Level = 'email' | 'full';

export interface Session {
  researcherId: string;
  site: Site;
  level: Level;
  /** The id of the session record (the SHA-256 of the cookie value). */
  key: Buffer;
}

/** A passkey as `@simplewebauthn/server` verifies it: the credential id and its COSE public key. */
export interface StoredPasskey {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: string[];
}

export interface PasskeyInfo {
  id: string;
  name: string;
  created: number;
  last_used: number | null;
  /** Whether the personal key is stored wrapped under this passkey (it supports PRF). */
  unlocks_key: boolean;
}

export interface Me {
  id: string;
  email: string;
  public_key: string | null;
  passkeys: PasskeyInfo[];
}

export interface MemberInfo {
  researcher_id: string;
  email: string;
  public_key: string | null;
  has_access: boolean;
  added: number;
}

export interface ProjectKeyInfo {
  public_key: string;
  fingerprint: string;
  created: number;
}

/** Emails are compared in lower case, trimmed. A light check only: the email code is the proof. */
export function normalizeEmail(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  const e = email.trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 0) return undefined;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const ok =
    e.length >= 3 &&
    e.length <= 254 &&
    local.length > 0 &&
    domain.includes('.') &&
    !domain.startsWith('.') &&
    !domain.endsWith('.') &&
    /^[!-~]+$/.test(e) &&
    !/[<>"]/.test(e);
  return ok ? e : undefined;
}

/** Sign-in codes have 8 digits: with the tries and rate limits, guessing one is out of reach. */
function newLoginCode(): string {
  // The bias of reducing a 64-bit number modulo 10^8 is below 10^-10.
  return (random(8).readBigUInt64LE() % 100_000_000n).toString().padStart(8, '0');
}

/**
 * A code is stored hashed with its browser's secret, so the database alone does not give it away,
 * and with its site, so a code asked for on the key page cannot sign in to the studio or the other
 * way round.
 */
const codeHash = (site: Site, request: Uint8Array, code: string): Buffer =>
  sha256('combray/login-code/v1/', site, '/', request, code);

const decode = (token: unknown): Buffer => fromB64(token) ?? fail('invalid');

/** Forget a researcher's personal key, passkeys, sessions and copies of project keys. */
function clearKey(db: Queries, id: string): void {
  db.update(researchers).set({ publicKey: null, recoveryVerifier: null }).where(eq(researchers.id, id)).run();
  db.delete(passkeys).where(eq(passkeys.researcherId, id)).run();
  db.delete(sessions).where(eq(sessions.researcherId, id)).run();
  db.update(members).set({ sealedEnc: null, sealedCt: null }).where(eq(members.researcherId, id)).run();
}

/** The projects where this researcher is the only member with access to the project key. */
function soleAccess(db: Queries, id: string): string[] {
  return db
    .select({ project: members.project })
    .from(members)
    .where(
      and(
        eq(members.researcherId, id),
        isNotNull(members.sealedCt),
        sql`NOT EXISTS (SELECT 1 FROM ${members} o WHERE o.project = ${members.project} AND o.researcher_id != ${id} AND o.sealed_ct IS NOT NULL)`,
      ),
    )
    .orderBy(asc(members.project))
    .all()
    .map((r) => r.project);
}

/** A researcher could not reset their own key: they are the only member with access to these projects. */
export class SoleAccess extends Error {
  readonly projects: string[];
  constructor(projects: string[]) {
    super('sole_access');
    this.projects = projects;
  }
}

const SESSION_TTL: Record<Site, Record<Level, number>> = {
  keys: { email: EMAIL_SESSION_TTL_SECS, full: KEYS_SESSION_TTL_SECS },
  main: { email: EMAIL_SESSION_TTL_SECS, full: STUDIO_SESSION_TTL_SECS },
};

const toStored = (p: typeof passkeys.$inferSelect): StoredPasskey => ({
  id: p.id,
  publicKey: p.publicKey,
  counter: p.counter,
  ...(p.transports ? { transports: JSON.parse(p.transports) as string[] } : {}),
});

const hasAccess = sql<number>`${members.sealedCt} IS NOT NULL`;

export class Accounts {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Researchers.

  /** Create a researcher account, or return the existing one for this email. */
  addResearcher(email: string): string {
    const e = normalizeEmail(email) ?? fail('invalid');
    const existing = this.db.select({ id: researchers.id }).from(researchers).where(eq(researchers.email, e)).get();
    if (existing) return existing.id;
    const id = randomUUID();
    this.db.insert(researchers).values({ id, email: e, created: nowSecs() }).run();
    return id;
  }

  removeResearcher(email: string): void {
    const e = normalizeEmail(email) ?? fail('invalid');
    if (changes(this.db.delete(researchers).where(eq(researchers.email, e)).run()) === 0) fail('not_found');
  }

  listResearchers(): { email: string; hasKey: boolean; passkeys: number }[] {
    return this.db
      .select({
        email: researchers.email,
        hasKey: sql<number>`${researchers.publicKey} IS NOT NULL`,
        passkeys: sql<number>`(SELECT COUNT(*) FROM ${passkeys} WHERE ${passkeys.researcherId} = ${researchers.id})`,
      })
      .from(researchers)
      .orderBy(asc(researchers.email))
      .all()
      .map((r) => ({ email: r.email, hasKey: Boolean(r.hasKey), passkeys: Number(r.passkeys) }));
  }

  /** Forget a researcher's key, passkeys and sealed project keys (the operator's `reset-key`). */
  resetResearcherKey(email: string): void {
    const e = normalizeEmail(email) ?? fail('invalid');
    this.db.transaction((tx) => {
      const row = tx.select({ id: researchers.id }).from(researchers).where(eq(researchers.email, e)).get() ?? fail('not_found');
      clearKey(tx, row.id);
    });
  }

  /**
   * A researcher resets their own key after losing both passkey and recovery code: as the operator's
   * `reset-key`, but refused while they are the only member with access to a project.
   */
  resetOwnKey(researcherId: string): void {
    this.db.transaction((tx) => {
      const sole = soleAccess(tx, researcherId);
      if (sole.length > 0) throw new SoleAccess(sole);
      clearKey(tx, researcherId);
    });
  }

  emailOf(researcherId: string): string {
    return (this.db.select({ email: researchers.email }).from(researchers).where(eq(researchers.id, researcherId)).get() ?? fail('not_found')).email;
  }

  me(researcherId: string): Me {
    const row = this.db.select().from(researchers).where(eq(researchers.id, researcherId)).get() ?? fail('not_found');
    const keys = this.db.select().from(passkeys).where(eq(passkeys.researcherId, researcherId)).orderBy(asc(passkeys.created)).all();
    return {
      id: researcherId,
      email: row.email,
      public_key: row.publicKey ? b64(row.publicKey) : null,
      passkeys: keys.map((p) => ({ id: p.id, name: p.name, created: p.created, last_used: p.lastUsed, unlocks_key: p.wrappedMaster !== null })),
    };
  }

  /** Set the personal public key, once. Only the operator or a reset can clear it. */
  setPersonalKey(researcherId: string, publicKey: Uint8Array, recoveryVerifier: Uint8Array): void {
    if (publicKey.length !== PUBLIC_KEY_BYTES || recoveryVerifier.length !== 32) fail('invalid');
    const result = this.db
      .update(researchers)
      .set({ publicKey: Buffer.from(publicKey), recoveryVerifier: Buffer.from(recoveryVerifier) })
      .where(and(eq(researchers.id, researcherId), isNull(researchers.publicKey)))
      .run();
    if (changes(result) === 0) fail('conflict');
  }

  /** Check a recovery sign-in secret against the stored verifier. */
  checkRecovery(researcherId: string, secret: Uint8Array): boolean {
    const row = this.db.select({ verifier: researchers.recoveryVerifier }).from(researchers).where(eq(researchers.id, researcherId)).get();
    return !!row?.verifier && sameBytes(sha256(secret), row.verifier);
  }

  // Email sign-in.

  /**
   * Start an email sign-in for the browser holding `request` (a random secret in its cookie). Returns
   * the code to mail, if there is a researcher with this email. For an unknown email a pending
   * sign-in is stored all the same, with a code nobody receives, so both cases behave alike.
   */
  createLoginCode(site: Site, request: Uint8Array, email: string): string | undefined {
    this.db.delete(loginCodes).where(lte(loginCodes.expires, nowSecs())).run();
    const e = normalizeEmail(email);
    const researcher = e ? this.db.select({ id: researchers.id }).from(researchers).where(eq(researchers.email, e)).get() : undefined;
    const code = newLoginCode();
    const row = { researcherId: researcher?.id ?? null, codeHash: codeHash(site, request, code), tries: 0, expires: nowSecs() + LOGIN_CODE_TTL_SECS };
    this.db
      .insert(loginCodes)
      .values({ requestHash: sha256(request), ...row })
      .onConflictDoUpdate({ target: loginCodes.requestHash, set: row })
      .run();
    return researcher ? code : undefined;
  }

  /** Check a sign-in code against the browser's pending sign-in. Works once, with a few wrong tries. */
  useLoginCode(site: Site, request: Uint8Array, code: string): string {
    const typed = code.replace(/[\s-]/g, '');
    const key = sha256(request);
    const researcher = this.db.transaction(
      (tx) => {
        const row = tx.select().from(loginCodes).where(and(eq(loginCodes.requestHash, key), gt(loginCodes.expires, nowSecs()))).get();
        if (!row) return null;
        if (sameBytes(codeHash(site, request, typed), row.codeHash) && row.researcherId !== null) {
          tx.delete(loginCodes).where(eq(loginCodes.requestHash, key)).run();
          return row.researcherId;
        }
        // Count the wrong try (and commit it), then refuse.
        if (row.tries + 1 >= LOGIN_CODE_TRIES) tx.delete(loginCodes).where(eq(loginCodes.requestHash, key)).run();
        else tx.update(loginCodes).set({ tries: row.tries + 1 }).where(eq(loginCodes.requestHash, key)).run();
        return null;
      },
      { behavior: 'immediate' },
    );
    return researcher ?? fail('forbidden');
  }

  // Sessions.

  /** Start a session; returns the cookie value. */
  createSession(researcherId: string, site: Site, level: Level): string {
    const token = randomToken();
    this.db.delete(sessions).where(lte(sessions.expires, nowSecs())).run();
    this.db.insert(sessions).values({ tokenHash: sha256(token), researcherId, site, level, expires: nowSecs() + SESSION_TTL[site][level] }).run();
    return b64(token);
  }

  session(token: string, site: Site): Session | undefined {
    const raw = fromB64(token);
    if (!raw) return undefined;
    const key = sha256(raw);
    const row = this.db
      .select({ researcherId: sessions.researcherId, level: sessions.level })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, key), eq(sessions.site, site), gt(sessions.expires, nowSecs())))
      .get();
    return row ? { researcherId: row.researcherId, site, level: row.level, key } : undefined;
  }

  /** Replace a session with a fully signed-in one (a new id, so a token seen before is worthless). */
  upgradeSession(session: Session): string {
    this.endSession(session);
    return this.createSession(session.researcherId, session.site, 'full');
  }

  endSession(session: Session): void {
    this.db.delete(sessions).where(eq(sessions.tokenHash, session.key)).run();
  }

  /** A one-time code that lets the studio start its own session for this researcher. */
  createHandoff(researcherId: string): string {
    const code = randomToken();
    this.db.delete(handoffs).where(lte(handoffs.expires, nowSecs())).run();
    this.db.insert(handoffs).values({ codeHash: sha256(code), researcherId, expires: nowSecs() + HANDOFF_TTL_SECS }).run();
    return b64(code);
  }

  useHandoff(code: string): string {
    const hash = sha256(decode(code));
    const id = this.db.transaction((tx) => {
      const row = tx.select({ researcherId: handoffs.researcherId }).from(handoffs).where(and(eq(handoffs.codeHash, hash), gt(handoffs.expires, nowSecs()))).get();
      tx.delete(handoffs).where(eq(handoffs.codeHash, hash)).run();
      return row?.researcherId;
    });
    return id ?? fail('forbidden');
  }

  // Passkeys.

  passkeys(researcherId: string): StoredPasskey[] {
    return this.db.select().from(passkeys).where(eq(passkeys.researcherId, researcherId)).all().map(toStored);
  }

  addPasskey(researcherId: string, passkey: StoredPasskey, name: string): string {
    const trimmed = [...name.trim()].slice(0, 60).join('');
    const n = this.db.select({ n: count() }).from(passkeys).where(eq(passkeys.researcherId, researcherId)).get()?.n ?? 0;
    if (n >= MAX_PASSKEYS) fail('conflict');
    // The same credential cannot belong to two accounts.
    const result = this.db
      .insert(passkeys)
      .values({
        id: passkey.id,
        researcherId,
        publicKey: Buffer.from(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.stringify(passkey.transports) : null,
        name: trimmed || 'Passkey',
        created: nowSecs(),
      })
      .onConflictDoNothing()
      .run();
    if (changes(result) === 0) fail('conflict');
    return passkey.id;
  }

  /** Record a successful use: the updated counter and the time. */
  passkeyUsed(researcherId: string, passkey: StoredPasskey): void {
    this.db
      .update(passkeys)
      .set({ counter: passkey.counter, lastUsed: nowSecs() })
      .where(and(eq(passkeys.id, passkey.id), eq(passkeys.researcherId, researcherId)))
      .run();
  }

  wrappedMaster(researcherId: string, credentialId: string): string | null {
    const row =
      this.db
        .select({ wrapped: passkeys.wrappedMaster })
        .from(passkeys)
        .where(and(eq(passkeys.id, credentialId), eq(passkeys.researcherId, researcherId)))
        .get() ?? fail('not_found');
    return row.wrapped ? b64(row.wrapped) : null;
  }

  setWrappedMaster(researcherId: string, credentialId: string, wrapped: Uint8Array): void {
    // 12-byte nonce, 32-byte secret, 16-byte tag.
    if (wrapped.length !== 60) fail('invalid');
    const result = this.db
      .update(passkeys)
      .set({ wrappedMaster: Buffer.from(wrapped) })
      .where(and(eq(passkeys.id, credentialId), eq(passkeys.researcherId, researcherId)))
      .run();
    if (changes(result) === 0) fail('not_found');
  }

  /** Remove a passkey. The last one cannot be removed: the account would be locked. */
  removePasskey(researcherId: string, credentialId: string): void {
    this.db.transaction((tx) => {
      const n = tx.select({ n: count() }).from(passkeys).where(eq(passkeys.researcherId, researcherId)).get()?.n ?? 0;
      if (n <= 1) fail('conflict');
      if (changes(tx.delete(passkeys).where(and(eq(passkeys.id, credentialId), eq(passkeys.researcherId, researcherId))).run()) === 0) fail('not_found');
    });
  }

  // Projects.

  /** Make a researcher a member of a project; a conflict if they already are. */
  addMember(project: string, researcherId: string): void {
    const result = this.db.insert(members).values({ project, researcherId, added: nowSecs() }).onConflictDoNothing().run();
    if (changes(result) === 0) fail('conflict');
  }

  /** Remove a member and their sealed copy. The last member with access cannot be removed. */
  removeMember(project: string, researcherId: string): void {
    this.db.transaction((tx) => {
      const member = tx.select().from(members).where(and(eq(members.project, project), eq(members.researcherId, researcherId))).get() ?? fail('not_found');
      const others =
        tx
          .select({ n: count() })
          .from(members)
          .where(and(eq(members.project, project), ne(members.researcherId, researcherId), isNotNull(members.sealedCt)))
          .get()?.n ?? 0;
      if (member.sealedCt !== null && others === 0) fail('conflict');
      tx.delete(members).where(and(eq(members.project, project), eq(members.researcherId, researcherId))).run();
    });
  }

  /** The projects a researcher belongs to, with whether they have access to the key. */
  projectsOf(researcherId: string): { project: string; hasAccess: boolean }[] {
    return this.db
      .select({ project: members.project, hasAccess })
      .from(members)
      .where(eq(members.researcherId, researcherId))
      .orderBy(asc(members.project))
      .all()
      .map((r) => ({ project: r.project, hasAccess: Boolean(r.hasAccess) }));
  }

  /** Whether the researcher is a member (undefined if not), and whether they have key access. */
  membership(project: string, researcherId: string): boolean | undefined {
    const row = this.db.select({ hasAccess }).from(members).where(and(eq(members.project, project), eq(members.researcherId, researcherId))).get();
    return row ? Boolean(row.hasAccess) : undefined;
  }

  members(project: string): MemberInfo[] {
    return this.db
      .select({ researcherId: members.researcherId, email: researchers.email, publicKey: researchers.publicKey, hasAccess, added: members.added })
      .from(members)
      .innerJoin(researchers, eq(researchers.id, members.researcherId))
      .where(eq(members.project, project))
      .orderBy(asc(members.added))
      .all()
      .map((r) => ({
        researcher_id: r.researcherId,
        email: r.email,
        public_key: r.publicKey ? b64(r.publicKey) : null,
        has_access: Boolean(r.hasAccess),
        added: r.added,
      }));
  }

  projectKey(project: string): ProjectKeyInfo | null {
    const row = this.db.select().from(projectKeys).where(eq(projectKeys.project, project)).get();
    return row ? { public_key: b64(row.publicKey), fingerprint: row.fingerprint, created: row.created } : null;
  }

  /** Set the project key, once, together with the creating member's sealed copy. */
  createProjectKey(project: string, researcherId: string, publicKey: Uint8Array, fingerprint: string, enc: Uint8Array, ct: Uint8Array): void {
    if (publicKey.length !== PUBLIC_KEY_BYTES || fingerprint.length > 64 || enc.length > MAX_SEALED_BYTES || ct.length > MAX_SEALED_BYTES) fail('invalid');
    this.db.transaction((tx) => {
      const member = tx.select({ project: members.project }).from(members).where(and(eq(members.project, project), eq(members.researcherId, researcherId))).get();
      if (!member) fail('forbidden');
      const created = tx.insert(projectKeys).values({ project, publicKey: Buffer.from(publicKey), fingerprint, created: nowSecs() }).onConflictDoNothing().run();
      if (changes(created) === 0) fail('conflict');
      tx.update(members)
        .set({ sealedEnc: Buffer.from(enc), sealedCt: Buffer.from(ct) })
        .where(and(eq(members.project, project), eq(members.researcherId, researcherId)))
        .run();
    });
  }

  sealedProjectKey(project: string, researcherId: string): { enc: string; ciphertext: string } | null {
    const row = this.db
      .select({ enc: members.sealedEnc, ct: members.sealedCt })
      .from(members)
      .where(and(eq(members.project, project), eq(members.researcherId, researcherId)))
      .get();
    return row?.enc && row.ct ? { enc: b64(row.enc), ciphertext: b64(row.ct) } : null;
  }

  /** Give a member access: the project key sealed (in the granter's browser) to their personal key. */
  grant(project: string, granter: string, member: string, enc: Uint8Array, ct: Uint8Array): void {
    if (enc.length > MAX_SEALED_BYTES || ct.length > MAX_SEALED_BYTES) fail('invalid');
    if (this.membership(project, granter) !== true) fail('forbidden');
    const result = this.db
      .update(members)
      .set({ sealedEnc: Buffer.from(enc), sealedCt: Buffer.from(ct) })
      .where(
        and(
          eq(members.project, project),
          eq(members.researcherId, member),
          isNull(members.sealedCt),
          sql`(SELECT ${researchers.publicKey} FROM ${researchers} WHERE ${researchers.id} = ${member}) IS NOT NULL`,
        ),
      )
      .run();
    if (changes(result) === 0) fail('conflict');
  }
}
