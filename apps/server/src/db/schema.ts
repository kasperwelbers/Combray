/**
 * The main database (`COMBRAY_DB`): participants' store keys, researcher accounts, sessions,
 * projects and the donation index. Secrets that grant access are stored as SHA-256 hashes only.
 *
 * Change the schema here, then run `pnpm --filter @combray/server db:generate` to write a migration
 * (drizzle/main). The server applies pending migrations when it starts.
 */
import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  /** The hard limit: the session ends then, however active. */
  expires: integer('expires').notNull(),
  /** When it was last used, for the studio's idle limit. */
  lastSeen: integer('last_seen').notNull().default(0),
});

/** One-time codes from the key page that sign the researcher in to the studio. */
export const handoffs = sqliteTable('handoffs', {
  codeHash: bytes('code_hash').primaryKey(),
  researcherId: researcherId(),
  expires: integer('expires').notNull(),
});

// Projects. A project has a draft, edited in the studio in parts (details, platforms), and a live
// version: one JSON document, copied from the draft when it is published on the key page, which
// is what participants get.

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  created: integer('created').notNull(),
  /** When any part of the draft last changed. */
  draftUpdated: integer('draft_updated').notNull(),
  /** Counts changes to the draft; `publishedRevision` is the one that went live. */
  draftRevision: integer('draft_revision').notNull().default(1),
  publishedRevision: integer('published_revision').notNull().default(0),
  /** The published config (JSON), or empty while the project was never published. */
  live: text('live'),
  liveVersion: integer('live_version').notNull().default(0),
  publishedAt: integer('published_at'),
});

const projectId = () =>
  text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' });

/** The draft's details. Localised texts are JSON (`{"en": "…", "nl": "…"}` or a plain string). */
export const projectDetails = sqliteTable('project_details', {
  projectId: projectId().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  participantsMode: text('participants_mode', { enum: ['anonymous', 'optional', 'required'] }).notNull().default('optional'),
  /** A regular expression participant ids must match (never sent to participants). */
  participantsPattern: text('participants_pattern'),
  /** Information for participants and the statements they agree to before donating (JSON). */
  consent: text('consent'),
  /** The story participants are walked through: slides with text, their data and questions (JSON). */
  story: text('story'),
});

/** The draft's platforms (upload points): each with the project tree participants' data is read with. */
export const projectPlatforms = sqliteTable(
  'project_platforms',
  {
    projectId: projectId(),
    /** The upload point id, e.g. `tiktok`; also stored with each donation. */
    id: text('id').notNull(),
    name: text('name').notNull(),
    /** The bundled platform pack it started from, if any. */
    pack: text('pack'),
    position: integer('position').notNull().default(0),
    /** The project tree as the studio saves it: structure and settings (JSON, opaque to the server). */
    structure: text('structure'),
    importer: text('importer'),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.id] })],
);

/**
 * Test packages of a draft's platform, added in the studio: the structure (shape) of a researcher's
 * own export, and, only when the researcher declares it synthetic or not sensitive, its parsed
 * content (gzip of the JSON), so colleagues can see values without uploading it again. Members
 * only; deleted with the platform and the project (docs/security.md#test-packages).
 */
export const testPackages = sqliteTable(
  'test_packages',
  {
    projectId: projectId(),
    platformId: text('platform_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    /** SHA-256 (hex) of the shape's JSON text: one structure, however often it is added. */
    structureHash: text('structure_hash').notNull(),
    shape: text('shape').notNull(),
    data: bytes('data'),
    /** Size of the content's JSON text, before compression; 0 without content. */
    dataBytes: integer('data_bytes').notNull().default(0),
    /** The researcher who added it; empty once their account is gone. */
    addedBy: text('added_by').references(() => researchers.id, { onDelete: 'set null' }),
    added: integer('added').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.platformId, t.id] }),
    uniqueIndex('test_packages_structure_name').on(t.projectId, t.platformId, t.structureHash, t.name),
  ],
);

/** The project public key; the private key exists only sealed to members (`members`). */
export const projectKeys = sqliteTable('project_keys', {
  project: text('project')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  publicKey: bytes('public_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  created: integer('created').notNull(),
});

export const members = sqliteTable(
  'members',
  {
    project: text('project')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
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
