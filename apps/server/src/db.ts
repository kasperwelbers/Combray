/**
 * The two SQLite databases, through Node's built-in driver (no native modules) and Drizzle. Pending
 * migrations (drizzle/main, drizzle/keys) are applied when a database is opened.
 *
 * Queries and transactions run synchronously on one connection, so a transaction is never
 * interleaved with another request's statements.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

export type Db = NodeSQLiteDatabase;
/** A transaction, for helpers that run inside one. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Somewhere to run queries: the database itself or a transaction. */
export type Queries = Db | Tx;

function open(path: string, migrations: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path);
  // WAL lets the operator's commands run next to the server; secure_delete overwrites deleted
  // rows (withdrawn keys, ended sessions); the busy timeout waits for the other writer.
  client.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const db = drizzle({ client });
  migrate(db, { migrationsFolder: fileURLToPath(new URL(migrations, import.meta.url)) });
  return db;
}

/** The main database: store keys, researchers, sessions, projects, the donation index. */
export const openMainDb = (path: string): Db => open(path, '../drizzle/main');

/** The donation key database, kept apart on purpose (ADR 0006). */
export const openKeysDb = (path: string): Db => open(path, '../drizzle/keys');

/** The number of rows a write changed. */
export const changes = (result: { changes: number | bigint }): number => Number(result.changes);
