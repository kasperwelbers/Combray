/**
 * Database migrations (drizzle/main, drizzle/keys): the server applies every pending migration when
 * it starts, once. Reads the database files directly, like the test that checks they hold no keys.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { repo, startServer } from './harness';

const migrationsIn = (database: 'main' | 'keys') =>
  readdirSync(join(repo, 'apps/server/drizzle', database), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

const applied = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('SELECT name FROM __drizzle_migrations ORDER BY id').all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
};

describe('database migrations', () => {
  it('are applied to both databases when the server starts, and only once', async () => {
    const s = await startServer({ research: true });
    expect(migrationsIn('main').length).toBeGreaterThan(0);
    expect(applied(s.paths.db)).toEqual(migrationsIn('main'));
    expect(applied(s.paths.donationKeysDb)).toEqual(migrationsIn('keys'));

    await s.restart();
    expect(applied(s.paths.db)).toEqual(migrationsIn('main'));
    expect(applied(s.paths.donationKeysDb)).toEqual(migrationsIn('keys'));
  });

  it('create the main database for the store service alone, without researcher settings', async () => {
    const s = await startServer({ research: false });
    expect(applied(s.paths.db)).toEqual(migrationsIn('main'));
  });
});
