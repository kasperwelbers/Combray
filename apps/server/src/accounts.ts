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

import { isoCBOR } from '@simplewebauthn/server/helpers';

import { type Db, all, bytes, one, openDb, run, transaction } from './db.ts';
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

/**
 * Read a stored passkey. Records written by the earlier server (in webauthn-rs's format) hold the public
 * key as coordinates; they are turned into the COSE key that `@simplewebauthn/server` checks.
 */
export function parsePasskey(json: string): StoredPasskey | undefined {
  const value = JSON.parse(json) as Record<string, unknown>;
  if (value.v === 2) {
    return {
      id: String(value.id),
      publicKey: Buffer.from(String(value.publicKey), 'base64url'),
      counter: Number(value.counter ?? 0),
      ...(Array.isArray(value.transports) ? { transports: value.transports.map(String) } : {}),
    };
  }
  const cred = (value.cred ?? {}) as Record<string, unknown>;
  const inner = (cred.cred ?? {}) as { type_?: string; key?: Record<string, Record<string, string>> };
  const bin = (s: string | undefined) => Buffer.from(s ?? '', 'base64url');
  const key = inner.key ?? {};
  let cose: Map<number, number | Uint8Array> | undefined;
  const ec2 = key.EC_EC2;
  const okp = key.EC_OKP;
  const rsa = key.RSA;
  if (ec2) {
    const curves: Record<string, [number, number]> = { SECP256R1: [1, -7], SECP384R1: [2, -35], SECP521R1: [3, -36] };
    const curve = curves[ec2.curve ?? ''];
    if (curve) cose = new Map<number, number | Uint8Array>([[1, 2], [3, curve[1]], [-1, curve[0]], [-2, bin(ec2.x)], [-3, bin(ec2.y)]]);
  } else if (okp && okp.curve === 'ED25519') {
    cose = new Map<number, number | Uint8Array>([[1, 1], [3, -8], [-1, 6], [-2, bin(okp.x)]]);
  } else if (rsa) {
    cose = new Map<number, number | Uint8Array>([[1, 3], [3, -257], [-1, bin(rsa.n)], [-2, bin(rsa.e)]]);
  }
  if (!cose || typeof cred.cred_id !== 'string') return undefined;
  return {
    id: b64(bin(cred.cred_id)),
    publicKey: isoCBOR.encode(cose as never),
    counter: Number(cred.counter ?? 0),
    ...(Array.isArray(cred.transports) ? { transports: (cred.transports as unknown[]).map((t) => String(t).toLowerCase()) } : {}),
  };
}

const passkeyJson = (p: StoredPasskey): string =>
  JSON.stringify({ v: 2, id: p.id, publicKey: b64(p.publicKey), counter: p.counter, ...(p.transports ? { transports: p.transports } : {}) });

/** Forget a researcher's personal key, passkeys, sessions and copies of project keys. */
function clearKey(db: Db, id: string): void {
  run(db, 'UPDATE researchers SET public_key = NULL, recovery_verifier = NULL WHERE id = ?', id);
  run(db, 'DELETE FROM passkeys WHERE researcher_id = ?', id);
  run(db, 'DELETE FROM sessions WHERE researcher_id = ?', id);
  run(db, 'UPDATE members SET sealed_enc = NULL, sealed_ct = NULL WHERE researcher_id = ?', id);
}

function soleAccess(db: Db, id: string): string[] {
  return all(
    db,
    `SELECT m.project FROM members m
     WHERE m.researcher_id = ? AND m.sealed_ct IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM members o WHERE o.project = m.project
                       AND o.researcher_id != ? AND o.sealed_ct IS NOT NULL)
     ORDER BY m.project`,
    id, id,
  ).map((r) => String(r.project));
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

export class Accounts {
  private readonly db: Db;

  constructor(path: string) {
    this.db = openDb(
      path,
      `PRAGMA journal_mode = WAL;
       PRAGMA secure_delete = ON;
       PRAGMA foreign_keys = ON;
       CREATE TABLE IF NOT EXISTS researchers (
           id                TEXT PRIMARY KEY,
           email             TEXT NOT NULL UNIQUE,
           created           INTEGER NOT NULL,
           public_key        BLOB,
           recovery_verifier BLOB
       );
       CREATE TABLE IF NOT EXISTS passkeys (
           id             TEXT PRIMARY KEY,
           researcher_id  TEXT NOT NULL REFERENCES researchers(id) ON DELETE CASCADE,
           passkey        TEXT NOT NULL,
           name           TEXT NOT NULL,
           wrapped_master BLOB,
           created        INTEGER NOT NULL,
           last_used      INTEGER
       );
       DROP TABLE IF EXISTS login_tokens;
       CREATE TABLE IF NOT EXISTS login_codes (
           request_hash  BLOB PRIMARY KEY,
           researcher_id TEXT REFERENCES researchers(id) ON DELETE CASCADE,
           code_hash     BLOB NOT NULL,
           tries         INTEGER NOT NULL DEFAULT 0,
           expires       INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS sessions (
           token_hash    BLOB PRIMARY KEY,
           researcher_id TEXT NOT NULL REFERENCES researchers(id) ON DELETE CASCADE,
           site          TEXT NOT NULL,
           level         TEXT NOT NULL,
           expires       INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS handoffs (
           code_hash     BLOB PRIMARY KEY,
           researcher_id TEXT NOT NULL REFERENCES researchers(id) ON DELETE CASCADE,
           expires       INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS project_keys (
           project     TEXT PRIMARY KEY,
           public_key  BLOB NOT NULL,
           fingerprint TEXT NOT NULL,
           created     INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS members (
           project       TEXT NOT NULL,
           researcher_id TEXT NOT NULL REFERENCES researchers(id) ON DELETE CASCADE,
           sealed_enc    BLOB,
           sealed_ct     BLOB,
           added         INTEGER NOT NULL,
           PRIMARY KEY (project, researcher_id)
       );`,
    );
  }

  // Researchers.

  /** Create a researcher account, or return the existing one for this email. */
  addResearcher(email: string): string {
    const e = normalizeEmail(email) ?? fail('invalid');
    const existing = one(this.db, 'SELECT id FROM researchers WHERE email = ?', e);
    if (existing) return String(existing.id);
    const id = randomUUID();
    run(this.db, 'INSERT INTO researchers (id, email, created) VALUES (?, ?, ?)', id, e, nowSecs());
    return id;
  }

  removeResearcher(email: string): void {
    const e = normalizeEmail(email) ?? fail('invalid');
    if (run(this.db, 'DELETE FROM researchers WHERE email = ?', e) === 0) fail('not_found');
  }

  listResearchers(): { email: string; hasKey: boolean; passkeys: number }[] {
    return all(
      this.db,
      `SELECT r.email, r.public_key IS NOT NULL AS has_key,
              (SELECT COUNT(*) FROM passkeys p WHERE p.researcher_id = r.id) AS passkeys
       FROM researchers r ORDER BY r.email`,
    ).map((r) => ({ email: String(r.email), hasKey: Boolean(r.has_key), passkeys: Number(r.passkeys) }));
  }

  /** Forget a researcher's key, passkeys and sealed project keys (the operator's `reset-key`). */
  resetResearcherKey(email: string): void {
    const e = normalizeEmail(email) ?? fail('invalid');
    transaction(this.db, () => {
      const row = one(this.db, 'SELECT id FROM researchers WHERE email = ?', e) ?? fail('not_found');
      clearKey(this.db, String(row.id));
    });
  }

  /**
   * A researcher resets their own key after losing both passkey and recovery code: as the operator's
   * `reset-key`, but refused while they are the only member with access to a project.
   */
  resetOwnKey(researcherId: string): void {
    transaction(this.db, () => {
      const sole = soleAccess(this.db, researcherId);
      if (sole.length > 0) throw new SoleAccess(sole);
      clearKey(this.db, researcherId);
    });
  }

  emailOf(researcherId: string): string {
    const row = one(this.db, 'SELECT email FROM researchers WHERE id = ?', researcherId) ?? fail('not_found');
    return String(row.email);
  }

  me(researcherId: string): Me {
    const row = one(this.db, 'SELECT email, public_key FROM researchers WHERE id = ?', researcherId) ?? fail('not_found');
    const passkeys = all(
      this.db,
      `SELECT id, name, created, last_used, wrapped_master IS NOT NULL AS unlocks_key
       FROM passkeys WHERE researcher_id = ? ORDER BY created`,
      researcherId,
    ).map((p) => ({
      id: String(p.id),
      name: String(p.name),
      created: Number(p.created),
      last_used: p.last_used === null ? null : Number(p.last_used),
      unlocks_key: Boolean(p.unlocks_key),
    }));
    const key = bytes(row.public_key);
    return { id: researcherId, email: String(row.email), public_key: key ? b64(key) : null, passkeys };
  }

  /** Set the personal public key, once. Only the operator or a reset can clear it. */
  setPersonalKey(researcherId: string, publicKey: Uint8Array, recoveryVerifier: Uint8Array): void {
    if (publicKey.length !== PUBLIC_KEY_BYTES || recoveryVerifier.length !== 32) fail('invalid');
    const n = run(
      this.db,
      'UPDATE researchers SET public_key = ?, recovery_verifier = ? WHERE id = ? AND public_key IS NULL',
      publicKey, recoveryVerifier, researcherId,
    );
    if (n === 0) fail('conflict');
  }

  /** Check a recovery sign-in secret against the stored verifier. */
  checkRecovery(researcherId: string, secret: Uint8Array): boolean {
    const verifier = bytes(one(this.db, 'SELECT recovery_verifier FROM researchers WHERE id = ?', researcherId)?.recovery_verifier);
    return verifier !== undefined && sameBytes(sha256(secret), verifier);
  }

  // Email sign-in.

  /**
   * Start an email sign-in for the browser holding `request` (a random secret in its cookie). Returns
   * the code to mail, if there is a researcher with this email. For an unknown email a pending
   * sign-in is stored all the same, with a code nobody receives, so both cases behave alike.
   */
  createLoginCode(site: Site, request: Uint8Array, email: string): string | undefined {
    run(this.db, 'DELETE FROM login_codes WHERE expires <= ?', nowSecs());
    const e = normalizeEmail(email);
    const researcher = e ? one(this.db, 'SELECT id FROM researchers WHERE email = ?', e) : undefined;
    const code = newLoginCode();
    run(
      this.db,
      'INSERT OR REPLACE INTO login_codes (request_hash, researcher_id, code_hash, expires) VALUES (?, ?, ?, ?)',
      sha256(request), researcher ? String(researcher.id) : null, codeHash(site, request, code), nowSecs() + LOGIN_CODE_TTL_SECS,
    );
    return researcher ? code : undefined;
  }

  /** Check a sign-in code against the browser's pending sign-in. Works once, with a few wrong tries. */
  useLoginCode(site: Site, request: Uint8Array, code: string): string {
    const typed = code.replace(/[\s-]/g, '');
    return transaction(this.db, () => {
      const key = sha256(request);
      const row = one(this.db, 'SELECT researcher_id, code_hash, tries FROM login_codes WHERE request_hash = ? AND expires > ?', key, nowSecs());
      if (!row) return fail('forbidden');
      const right = sameBytes(codeHash(site, request, typed), bytes(row.code_hash)!);
      if (right && row.researcher_id !== null) {
        run(this.db, 'DELETE FROM login_codes WHERE request_hash = ?', key);
        return String(row.researcher_id);
      }
      if (Number(row.tries) + 1 >= LOGIN_CODE_TRIES) run(this.db, 'DELETE FROM login_codes WHERE request_hash = ?', key);
      else run(this.db, 'UPDATE login_codes SET tries = tries + 1 WHERE request_hash = ?', key);
      // Commit the counted try, then refuse.
      return null;
    }) ?? fail('forbidden');
  }

  // Sessions.

  /** Start a session; returns the cookie value. */
  createSession(researcherId: string, site: Site, level: Level): string {
    const token = randomToken();
    run(this.db, 'DELETE FROM sessions WHERE expires <= ?', nowSecs());
    run(
      this.db,
      'INSERT INTO sessions (token_hash, researcher_id, site, level, expires) VALUES (?, ?, ?, ?, ?)',
      sha256(token), researcherId, site, level, nowSecs() + SESSION_TTL[site][level],
    );
    return b64(token);
  }

  session(token: string, site: Site): Session | undefined {
    const raw = fromB64(token);
    if (!raw) return undefined;
    const key = sha256(raw);
    const row = one(this.db, 'SELECT researcher_id, level FROM sessions WHERE token_hash = ? AND site = ? AND expires > ?', key, site, nowSecs());
    if (!row) return undefined;
    return { researcherId: String(row.researcher_id), site, level: row.level === 'full' ? 'full' : 'email', key };
  }

  /** Replace a session with a fully signed-in one (a new id, so a token seen before is worthless). */
  upgradeSession(session: Session): string {
    this.endSession(session);
    return this.createSession(session.researcherId, session.site, 'full');
  }

  endSession(session: Session): void {
    run(this.db, 'DELETE FROM sessions WHERE token_hash = ?', session.key);
  }

  /** A one-time code that lets the studio start its own session for this researcher. */
  createHandoff(researcherId: string): string {
    const code = randomToken();
    run(this.db, 'DELETE FROM handoffs WHERE expires <= ?', nowSecs());
    run(this.db, 'INSERT INTO handoffs (code_hash, researcher_id, expires) VALUES (?, ?, ?)', sha256(code), researcherId, nowSecs() + HANDOFF_TTL_SECS);
    return b64(code);
  }

  useHandoff(code: string): string {
    const raw = decode(code);
    const id = transaction(this.db, () => {
      const row = one(this.db, 'SELECT researcher_id FROM handoffs WHERE code_hash = ? AND expires > ?', sha256(raw), nowSecs());
      run(this.db, 'DELETE FROM handoffs WHERE code_hash = ?', sha256(raw));
      return row ? String(row.researcher_id) : undefined;
    });
    return id ?? fail('forbidden');
  }

  // Passkeys.

  passkeys(researcherId: string): StoredPasskey[] {
    return all(this.db, 'SELECT passkey FROM passkeys WHERE researcher_id = ?', researcherId)
      .map((r) => parsePasskey(String(r.passkey)))
      .filter((p): p is StoredPasskey => p !== undefined);
  }

  addPasskey(researcherId: string, passkey: StoredPasskey, name: string): string {
    const trimmed = [...name.trim()].slice(0, 60).join('');
    const count = Number(one(this.db, 'SELECT COUNT(*) AS n FROM passkeys WHERE researcher_id = ?', researcherId)?.n ?? 0);
    if (count >= MAX_PASSKEYS) fail('conflict');
    // The same credential cannot belong to two accounts.
    const n = run(
      this.db,
      'INSERT OR IGNORE INTO passkeys (id, researcher_id, passkey, name, created) VALUES (?, ?, ?, ?, ?)',
      passkey.id, researcherId, passkeyJson(passkey), trimmed || 'Passkey', nowSecs(),
    );
    if (n === 0) fail('conflict');
    return passkey.id;
  }

  /** Record a successful use: the updated counter and the time. */
  passkeyUsed(researcherId: string, passkey: StoredPasskey): void {
    run(this.db, 'UPDATE passkeys SET passkey = ?, last_used = ? WHERE id = ? AND researcher_id = ?', passkeyJson(passkey), nowSecs(), passkey.id, researcherId);
  }

  wrappedMaster(researcherId: string, credentialId: string): string | null {
    const row = one(this.db, 'SELECT wrapped_master FROM passkeys WHERE id = ? AND researcher_id = ?', credentialId, researcherId) ?? fail('not_found');
    const wrapped = bytes(row.wrapped_master);
    return wrapped ? b64(wrapped) : null;
  }

  setWrappedMaster(researcherId: string, credentialId: string, wrapped: Uint8Array): void {
    // 12-byte nonce, 32-byte secret, 16-byte tag.
    if (wrapped.length !== 60) fail('invalid');
    if (run(this.db, 'UPDATE passkeys SET wrapped_master = ? WHERE id = ? AND researcher_id = ?', wrapped, credentialId, researcherId) === 0) fail('not_found');
  }

  /** Remove a passkey. The last one cannot be removed: the account would be locked. */
  removePasskey(researcherId: string, credentialId: string): void {
    transaction(this.db, () => {
      const count = Number(one(this.db, 'SELECT COUNT(*) AS n FROM passkeys WHERE researcher_id = ?', researcherId)?.n ?? 0);
      if (count <= 1) fail('conflict');
      if (run(this.db, 'DELETE FROM passkeys WHERE id = ? AND researcher_id = ?', credentialId, researcherId) === 0) fail('not_found');
    });
  }

  // Projects.

  /** Make a researcher a member of a project; a conflict if they already are. */
  addMember(project: string, researcherId: string): void {
    const n = run(this.db, 'INSERT OR IGNORE INTO members (project, researcher_id, added) VALUES (?, ?, ?)', project, researcherId, nowSecs());
    if (n === 0) fail('conflict');
  }

  /** Remove a member and their sealed copy. The last member with access cannot be removed. */
  removeMember(project: string, researcherId: string): void {
    transaction(this.db, () => {
      const row =
        one(
          this.db,
          `SELECT sealed_ct IS NOT NULL AS has_access,
                  (SELECT COUNT(*) FROM members m2 WHERE m2.project = ? AND m2.researcher_id != ? AND m2.sealed_ct IS NOT NULL) AS others
           FROM members WHERE project = ? AND researcher_id = ?`,
          project, researcherId, project, researcherId,
        ) ?? fail('not_found');
      if (row.has_access && Number(row.others) === 0) fail('conflict');
      run(this.db, 'DELETE FROM members WHERE project = ? AND researcher_id = ?', project, researcherId);
    });
  }

  /** The projects a researcher belongs to, with whether they have access to the key. */
  projectsOf(researcherId: string): { project: string; hasAccess: boolean }[] {
    return all(this.db, 'SELECT project, sealed_ct IS NOT NULL AS has_access FROM members WHERE researcher_id = ? ORDER BY project', researcherId).map(
      (r) => ({ project: String(r.project), hasAccess: Boolean(r.has_access) }),
    );
  }

  /** Whether the researcher is a member (undefined if not), and whether they have key access. */
  membership(project: string, researcherId: string): boolean | undefined {
    const row = one(this.db, 'SELECT sealed_ct IS NOT NULL AS has_access FROM members WHERE project = ? AND researcher_id = ?', project, researcherId);
    return row ? Boolean(row.has_access) : undefined;
  }

  members(project: string): MemberInfo[] {
    return all(
      this.db,
      `SELECT m.researcher_id, r.email, r.public_key, m.sealed_ct IS NOT NULL AS has_access, m.added
       FROM members m JOIN researchers r ON r.id = m.researcher_id
       WHERE m.project = ? ORDER BY m.added`,
      project,
    ).map((r) => {
      const key = bytes(r.public_key);
      return {
        researcher_id: String(r.researcher_id),
        email: String(r.email),
        public_key: key ? b64(key) : null,
        has_access: Boolean(r.has_access),
        added: Number(r.added),
      };
    });
  }

  projectKey(project: string): ProjectKeyInfo | null {
    const row = one(this.db, 'SELECT public_key, fingerprint, created FROM project_keys WHERE project = ?', project);
    return row ? { public_key: b64(bytes(row.public_key)!), fingerprint: String(row.fingerprint), created: Number(row.created) } : null;
  }

  /** Set the project key, once, together with the creating member's sealed copy. */
  createProjectKey(project: string, researcherId: string, publicKey: Uint8Array, fingerprint: string, enc: Uint8Array, ct: Uint8Array): void {
    if (publicKey.length !== PUBLIC_KEY_BYTES || fingerprint.length > 64 || enc.length > MAX_SEALED_BYTES || ct.length > MAX_SEALED_BYTES) fail('invalid');
    transaction(this.db, () => {
      if (!one(this.db, 'SELECT 1 FROM members WHERE project = ? AND researcher_id = ?', project, researcherId)) fail('forbidden');
      const n = run(this.db, 'INSERT OR IGNORE INTO project_keys (project, public_key, fingerprint, created) VALUES (?, ?, ?, ?)', project, publicKey, fingerprint, nowSecs());
      if (n === 0) fail('conflict');
      run(this.db, 'UPDATE members SET sealed_enc = ?, sealed_ct = ? WHERE project = ? AND researcher_id = ?', enc, ct, project, researcherId);
    });
  }

  sealedProjectKey(project: string, researcherId: string): { enc: string; ciphertext: string } | null {
    const row = one(this.db, 'SELECT sealed_enc, sealed_ct FROM members WHERE project = ? AND researcher_id = ?', project, researcherId);
    const enc = bytes(row?.sealed_enc);
    const ct = bytes(row?.sealed_ct);
    return enc && ct ? { enc: b64(enc), ciphertext: b64(ct) } : null;
  }

  /** Give a member access: the project key sealed (in the granter's browser) to their personal key. */
  grant(project: string, granter: string, member: string, enc: Uint8Array, ct: Uint8Array): void {
    if (enc.length > MAX_SEALED_BYTES || ct.length > MAX_SEALED_BYTES) fail('invalid');
    if (this.membership(project, granter) !== true) fail('forbidden');
    const n = run(
      this.db,
      `UPDATE members SET sealed_enc = ?, sealed_ct = ?
       WHERE project = ? AND researcher_id = ? AND sealed_ct IS NULL
         AND (SELECT public_key FROM researchers WHERE id = ?) IS NOT NULL`,
      enc, ct, project, member, member,
    );
    if (n === 0) fail('conflict');
  }
}
