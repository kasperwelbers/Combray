import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalStore, StoreLockedError, WrongKeyError, type ServerStore } from '../src';

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
