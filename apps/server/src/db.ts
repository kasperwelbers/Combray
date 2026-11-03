/** SQLite through Node's built-in driver: no native modules to build or download. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;
export type Row = Record<string, unknown>;

export function openDb(path: string, schema: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(schema);
  return db;
}

/** Run `work` in a transaction (statements run synchronously, so nothing interleaves). */
export function transaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const one = (db: Db, sql: string, ...params: unknown[]): Row | undefined =>
  db.prepare(sql).get(...(params as never[])) as Row | undefined;

export const all = (db: Db, sql: string, ...params: unknown[]): Row[] =>
  db.prepare(sql).all(...(params as never[])) as Row[];

/** Run a statement; returns the number of changed rows. */
export const run = (db: Db, sql: string, ...params: unknown[]): number =>
  Number(db.prepare(sql).run(...(params as never[])).changes);

export const bytes = (value: unknown): Buffer | undefined =>
  value instanceof Uint8Array ? Buffer.from(value) : undefined;
