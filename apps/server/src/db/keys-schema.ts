/**
 * The donation key database (`COMBRAY_DONATION_KEYS_DB`), separate from the main database on
 * purpose (ADR 0006): it holds the sealed donation keys, and is backed up for a short time only,
 * so that a withdrawal, which deletes the key, becomes final once the last backup with it is gone.
 *
 * Change the schema here, then run `pnpm --filter @combray/server db:generate` (drizzle/keys).
 */
import { blob, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sealedKeys = sqliteTable('sealed_keys', {
  donation: text('donation').primaryKey(),
  project: text('project').notNull(),
  /** Fingerprint of the project key the donation key is sealed to. */
  fingerprint: text('fingerprint').notNull(),
  enc: blob('enc', { mode: 'buffer' }).notNull(),
  ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
});
