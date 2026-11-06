import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';

import { BackupError, LocalStore, newPasswordSalt, passwordForServer, StoreLockedError, WrongKeyError, type ServerStore } from '../src';

let n = 0;
const about = { project: { id: 'willow', name: { en: 'Willow study' } }, participantId: 'P1234' };

/** What the key service would return: a fresh store id, KEK and delete token. */
function serverStore(): ServerStore & { copy: () => Uint8Array<ArrayBuffer> } {
  const kek = crypto.getRandomValues(new Uint8Array(32));
  const saved = kek.slice();
  return { storeId: `store-${n}`, kek, deleteToken: 'token', copy: () => saved.slice() };
}
const stores: LocalStore[] = [];

async function newStore(): Promise<LocalStore<{ name: string }>> {
  const store = await LocalStore.open<{ name: string }>(`test-${n++}`);
  stores.push(store);
  return store;
}

afterEach(async () => {
  const all = stores.splice(0);
  for (const s of all) s.close();
  for (const name of new Set(all.map((s) => s.dbName))) await deleteDB(name);
});

const items = Array.from({ length: 12 }, (_, i) => ({ name: `memory ${i}`, value: i }));

describe('LocalStore', () => {
  it('creates, stores and reads back datasets in chunks', async () => {
    const store = await newStore();
    expect(store.exists).toBe(false);
    await store.create(serverStore(), about);
    const id = await store.putDataset({ name: 'Synthetic history' }, items, 5);
    expect(await store.getItems(id)).toEqual(items);
    expect(await store.listDatasets()).toEqual([{ id, manifest: { name: 'Synthetic history' } }]);
  });

  it('stores empty datasets', async () => {
    const store = await newStore();
    await store.create(serverStore(), about);
    const id = await store.putDataset({ name: 'empty' }, []);
    expect(await store.getItems(id)).toEqual([]);
  });

  it('locks, and unlocks only with the right KEK', async () => {
    const store = await newStore();
    const server = serverStore();
    await store.create(server, about);
    expect(store.storeId).toBe(server.storeId);
    expect(store.deleteToken).toBe('token');
    expect(store.project).toEqual(about.project);
    expect(store.participantId).toBe('P1234');
    const id = await store.putDataset({ name: 'x' }, items);
    store.lock();
    await expect(store.getItems(id)).rejects.toBeInstanceOf(StoreLockedError);
    await expect(store.unlock(serverStore().kek)).rejects.toBeInstanceOf(WrongKeyError);
    await expect(store.unlock(new Uint8Array(16))).rejects.toBeInstanceOf(WrongKeyError);
    await store.unlock(server.copy());
    expect(await store.getItems(id)).toEqual(items);
  });

  it('wipes the KEK bytes it was given', async () => {
    const store = await newStore();
    const server = serverStore();
    await store.create(server, about);
    expect(server.kek.every((b) => b === 0)).toBe(true);
    store.lock();
    const kek = server.copy();
    await store.unlock(kek);
    expect(kek.every((b) => b === 0)).toBe(true);
  });

  it('stores files as encrypted slices and reads them back whole', async () => {
    const store = await newStore();
    await store.create(serverStore(), about);
    const bytes = crypto.getRandomValues(new Uint8Array(10_000));
    const id = await store.putFile({ name: 'watch-history.json' }, new Blob([bytes]), 4096);
    const blob = await store.getFile(id, 'application/json');
    expect(blob.type).toBe('application/json');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(await store.listDatasets()).toEqual([{ id, manifest: { name: 'watch-history.json' } }]);
    await expect(store.getItems(id)).rejects.toThrow();
    const empty = await store.putFile({ name: 'empty' }, new Blob([]));
    expect((await store.getFile(empty)).size).toBe(0);
  });

  it('rejects file slices that were reordered', async () => {
    const store = await newStore();
    const server = serverStore();
    await store.create(server, about);
    const id = await store.putFile({ name: 'f' }, new Blob([new Uint8Array(100).fill(1)]), 50);
    store.close();
    const db = await openDB(store.dbName);
    const [first, second] = [await db.get('chunks', [id, 0]), await db.get('chunks', [id, 1])];
    await db.put('chunks', second, [id, 0]);
    await db.put('chunks', first, [id, 1]);
    db.close();
    const reopened = await LocalStore.open(store.dbName);
    stores.push(reopened);
    await reopened.unlock(server.copy());
    await expect(reopened.getFile(id)).rejects.toThrow();
  });

  it('drops stores in the old passphrase format', async () => {
    const name = `test-${n++}`;
    const old = await openDB(name, 1, {
      upgrade(db) {
        for (const s of ['meta', 'index', 'manifests', 'chunks']) db.createObjectStore(s);
      },
    });
    await old.put('meta', { storeId: 'old', unlock: { mode: 'passphrase' } }, 'store');
    old.close();
    const store = await LocalStore.open(name);
    stores.push(store);
    expect(store.exists).toBe(false);
  });

  it('survives reopening the database', async () => {
    const first = await newStore();
    const server = serverStore();
    await first.create(server, about);
    const id = await first.putDataset({ name: 'kept' }, items);
    first.close();
    const second = await LocalStore.open(first.dbName);
    stores.push(second);
    expect(second.exists).toBe(true);
    expect(second.unlocked).toBe(false);
    await second.unlock(server.copy());
    expect(await second.getItems(id)).toEqual(items);
  });

  it('keeps no plaintext in IndexedDB', async () => {
    const store = await newStore();
    await store.create(serverStore(), about);
    await store.putDataset({ name: 'Secret dataset name' }, [{ title: 'very private search' }]);
    await store.putFile({ name: 'Secret file name' }, new Blob(['very private file']));
    store.close();
    const db = await openDB(store.dbName);
    const dump: string[] = [];
    for (const name of db.objectStoreNames) {
      for (const value of await db.getAll(name)) {
        const record = value as Record<string, unknown>;
        dump.push(JSON.stringify(record));
        for (const v of Object.values(record)) {
          if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
            dump.push(new TextDecoder().decode(v as ArrayBuffer));
          }
        }
      }
    }
    db.close();
    const all = dump.join('\n');
    expect(all).not.toContain('Secret dataset name');
    expect(all).not.toContain('very private search');
    expect(all).not.toContain('Secret file name');
    expect(all).not.toContain('very private file');
    const reopened = await LocalStore.open(store.dbName);
    stores.push(reopened);
  });

  it('rejects chunks moved between datasets', async () => {
    const store = await newStore();
    const server = serverStore();
    await store.create(server, about);
    const a = await store.putDataset({ name: 'a' }, [1]);
    const b = await store.putDataset({ name: 'b' }, [2]);
    store.close();
    const db = await openDB(store.dbName);
    await db.put('chunks', await db.get('chunks', [a, 0]), [b, 0]);
    db.close();
    const reopened = await LocalStore.open(store.dbName);
    stores.push(reopened);
    await reopened.unlock(server.copy());
    expect(await reopened.getItems(a)).toEqual([1]);
    await expect(reopened.getItems(b)).rejects.toThrow();
  });

  it('deletes datasets and destroys the whole store', async () => {
    const store = await newStore();
    await store.create(serverStore(), about);
    const id = await store.putDataset({ name: 'gone' }, items, 5);
    await store.deleteDataset(id);
    expect(await store.listDatasets()).toEqual([]);
    stores.splice(stores.indexOf(store), 1);
    await store.destroy();
    const again = await LocalStore.open(store.dbName);
    stores.push(again);
    expect(again.exists).toBe(false);
  });
});

const ORIGIN = 'https://combray.example.edu';
const expected = { origin: ORIGIN, projectId: 'willow' };

/** A store with a few datasets, a file, and its server's KEK. */
async function filledStore() {
  const store = await newStore();
  const server = serverStore();
  const salt = newPasswordSalt();
  await store.create(server, { ...about, passwordSalt: salt });
  const a = await store.putDataset({ name: 'history' }, items, 5);
  const b = await store.putDataset({ name: 'empty' }, []);
  const bytes = crypto.getRandomValues(new Uint8Array(3000));
  const f = await store.putFile({ name: 'file' }, new Blob([bytes]), 1024);
  return { store, server, salt, ids: { a, b, f }, bytes };
}

async function restored(file: Blob, into = expected) {
  const target = await newStore();
  await target.restoreBackup(file, into);
  return target;
}

async function problem(file: Blob, into = expected): Promise<string | undefined> {
  const target = await newStore();
  try {
    await target.restoreBackup(file, into);
    return undefined;
  } catch (error) {
    expect(target.exists).toBe(false);
    if (error instanceof BackupError) return error.problem;
    throw error;
  }
}

describe('backup files', () => {
  it('restore a store on another device, still locked, and open with the same KEK', async () => {
    const { store, server, salt, ids, bytes } = await filledStore();
    store.lock();
    // Made while locked: nothing is decrypted.
    const file = await store.exportBackup(ORIGIN);
    const copy = await restored(file);
    expect(copy.exists).toBe(true);
    expect(copy.unlocked).toBe(false);
    expect(copy.storeId).toBe(server.storeId);
    expect(copy.deleteToken).toBe('token');
    expect(copy.participantId).toBe('P1234');
    expect(copy.project).toEqual(about.project);
    expect(copy.passwordSalt).toEqual(salt);
    await expect(copy.unlock(serverStore().kek)).rejects.toBeInstanceOf(WrongKeyError);
    await copy.unlock(server.copy());
    expect(await copy.getItems(ids.a)).toEqual(items);
    expect(await copy.getItems(ids.b)).toEqual([]);
    expect(new Uint8Array(await (await copy.getFile(ids.f)).arrayBuffer())).toEqual(bytes);
    expect((await copy.listDatasets()).map((d) => d.manifest)).toEqual(
      expect.arrayContaining([{ name: 'history' }, { name: 'empty' }, { name: 'file' }]),
    );
  });

  it('contain no plaintext', async () => {
    const { store } = await filledStore();
    const text = new TextDecoder('latin1').decode(await (await store.exportBackup(ORIGIN)).arrayBuffer());
    expect(text).not.toContain('memory 1');
    expect(text).not.toContain('history');
  });

  it("refuse another server's or another project's backup", async () => {
    const { store } = await filledStore();
    const file = await store.exportBackup(ORIGIN);
    expect(await problem(file, { origin: 'https://other.example.org', projectId: 'willow' })).toBe('other-server');
    expect(await problem(file, { origin: ORIGIN, projectId: 'oak' })).toBe('other-project');
  });

  it('refuse other files, and truncated or reshuffled backups', async () => {
    const { store } = await filledStore();
    const file = await store.exportBackup(ORIGIN);
    expect(await problem(new Blob(['takeout.zip contents']))).toBe('not-a-backup');
    expect(await problem(new Blob([]))).toBe('not-a-backup');
    expect(await problem(file.slice(0, file.size - 10))).toBe('damaged');
    // Whole frames missing at the end: the end marker is gone.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let offset = 8;
    const frames: number[] = [];
    while (offset < bytes.length) {
      frames.push(offset);
      offset += 4 + view.getUint32(offset);
    }
    expect(await problem(new Blob([bytes.slice(0, frames.at(-1))]))).toBe('damaged');
    // A frame left out in the middle: the counts do not add up.
    expect(await problem(new Blob([bytes.slice(0, frames[3]), bytes.slice(frames[4])]))).toBe('damaged');
  });

  it('are caught by the data key when a record was changed', async () => {
    const { store, server, ids } = await filledStore();
    const bytes = new Uint8Array(await (await store.exportBackup(ORIGIN)).arrayBuffer());
    // Flip a byte near the end, inside the last chunk's ciphertext (of whichever dataset is last).
    bytes[bytes.length - 60]! ^= 1;
    const copy = await restored(new Blob([bytes]));
    await copy.unlock(server.copy());
    const reads = await Promise.allSettled([copy.getItems(ids.a), copy.getItems(ids.b), copy.getFile(ids.f)]);
    expect(reads.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('are refused when a store already exists', async () => {
    const { store } = await filledStore();
    await expect(store.restoreBackup(await store.exportBackup(ORIGIN), expected)).rejects.toThrow('already exists');
  });
});

describe('passwordForServer', () => {
  it('depends on the password and the salt, and never contains the password', async () => {
    const salt = newPasswordSalt();
    const sent = await passwordForServer('madeleine', salt);
    expect(sent).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await passwordForServer('madeleine', salt)).toBe(sent);
    expect(await passwordForServer('madeleinf', salt)).not.toBe(sent);
    expect(await passwordForServer('madeleine', newPasswordSalt())).not.toBe(sent);
    // The same password typed in another Unicode form is the same password.
    expect(await passwordForServer('cafe\u0301', salt)).toBe(await passwordForServer('caf\u00e9', salt));
  });
});
