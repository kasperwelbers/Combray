/**
 * The main database (`COMBRAY_DB`): participants' store keys, researcher accounts, sessions,
 * projects and the donation index. Secrets that grant access are stored as SHA-256 hashes only.
 *
 * Change the schema here, then run `pnpm --filter @combray/server db:generate` to write a migration
 * (drizzle/main). The server applies pending migrations when it starts.
 */
import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const bytes = (name: string) => blob(name, { mode: 'buffer' });

// Participants' store keys (docs/security.md#store-keys).

/** One row per participant store: the salts and the password hash, never a key. */
export const stores = sqliteTable('stores', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  participantId: text('participant_id'),
  /** The KEK is HKDF(store master key, this salt, label || store id); deleting the row shreds it. */
  kekSalt: bytes('kek_salt').notNull(),
  pwSalt: bytes('pw_salt').notNull(),
  pwHash: bytes('pw_hash').notNull(),
  deleteHash: bytes('delete_hash').notNull(),
  /** Argon2id cost the hash was made with. */
  mKib: integer('m_kib').notNull(),
  tCost: integer('t_cost').notNull(),
  pCost: integer('p_cost').notNull(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: integer('locked_until').notNull().default(0),
});

/** One-time password reset tokens a researcher made for a participant id in a project. */
export const resetTokens = sqliteTable('reset_tokens', {
  tokenHash: bytes('token_hash').primaryKey(),
  projectId: text('project_id').notNull(),
  participantId: text('participant_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

// Researchers (docs/researcher-keys.md).

export const researchers = sqliteTable('researchers', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  created: integer('created').notNull(),
  /** The personal X-Wing public key, once set up. */
  publicKey: bytes('public_key'),
  /** SHA-256 of the recovery sign-in secret (derived from the recovery code in the browser). */
  recoveryVerifier: bytes('recovery_verifier'),
});

const researcherId = () =>
  text('researcher_id')
    .notNull()
    .references(() => researchers.id, { onDelete: 'cascade' });

export const passkeys = sqliteTable(
  'passkeys',
  {
    /** The credential id (base64url). */
    id: text('id').primaryKey(),
    researcherId: researcherId(),
    /** The COSE public key, as `@simplewebauthn/server` verifies it. */
    publicKey: bytes('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    /** JSON array of transports, as the browser reported them. */
    transports: text('transports'),
    name: text('name').notNull(),
    /** The master secret wrapped under this passkey's PRF output, if it supports PRF. */
    wrappedMaster: bytes('wrapped_master'),
    created: integer('created').notNull(),
    lastUsed: integer('last_used'),
  },
  (t) => [index('passkeys_researcher').on(t.researcherId)],
);

/** Pending email sign-ins, tied to the browser (and site) that asked. */
export const loginCodes = sqliteTable('login_codes', {
  /** SHA-256 of the browser's random secret, which only its cookie holds. */
  requestHash: bytes('request_hash').primaryKey(),
  /** Empty for unknown addresses: those get a pending sign-in too, with a code nobody receives. */
  researcherId: text('researcher_id').references(() => researchers.id, { onDelete: 'cascade' }),
  /** SHA-256 over a label, the site, the browser's secret and the code. */
  codeHash: bytes('code_hash').notNull(),
  tries: integer('tries').notNull().default(0),
  expires: integer('expires').notNull(),
});

export const sessions = sqliteTable('sessions', {
  tokenHash: bytes('token_hash').primaryKey(),
  researcherId: researcherId(),
  site: text('site', { enum: ['keys', 'main'] }).notNull(),
  level: text('level', { enum: ['email', 'full'] }).notNull(),
  expires: integer('expires').notNull(),
});

/** One-time codes from the key page that sign the researcher in to the studio. */
export const handoffs = sqliteTable('handoffs', {
  codeHash: bytes('code_hash').primaryKey(),
  researcherId: researcherId(),
  expires: integer('expires').notNull(),
});

// Projects.

/** The project public key; the private key exists only sealed to members (`members`). */
export const projectKeys = sqliteTable('project_keys', {
  project: text('project').primaryKey(),
  publicKey: bytes('public_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  created: integer('created').notNull(),
});

export const members = sqliteTable(
  'members',
  {
    project: text('project').notNull(),
    researcherId: researcherId(),
    /** The project private key sealed to this member's personal key, once they have access. */
    sealedEnc: bytes('sealed_enc'),
    sealedCt: bytes('sealed_ct'),
    added: integer('added').notNull(),
  },
  (t) => [primaryKey({ columns: [t.project, t.researcherId] }), index('members_researcher').on(t.researcherId)],
);

// Donations: the index and withdrawals. Envelopes are files; sealed keys are in the key database.

export const donations = sqliteTable(
  'donations',
  {
    id: text('id').primaryKey(),
    project: text('project').notNull(),
    /** Dated to the day, never the time. */
    day: text('day').notNull(),
    bytes: integer('bytes').notNull(),
    /** SHA-256 of the participant's withdrawal token. */
    withdrawalHash: bytes('withdrawal_hash').notNull(),
  },
  (t) => [index('donations_project').on(t.project)],
);

/** Withdrawn donations. On start, their sealed keys are deleted again (after a backup restore). */
export const tombstones = sqliteTable('tombstones', {
  id: text('id').primaryKey(),
  project: text('project').notNull(),
  day: text('day').notNull(),
});
