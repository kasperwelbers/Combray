import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalStore, StoreLockedError, WrongPassphraseError } from '../src';

// Low iteration count to keep tests fast; production uses KDF_ITERATIONS.
const iterations = 1000;
let n = 0;
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
    await store.create('lime blossom tea', { iterations });
    const id = await store.putDataset({ name: 'Synthetic history' }, items, 5);
    expect(await store.getItems(id)).toEqual(items);
    expect(await store.listDatasets()).toEqual([{ id, manifest: { name: 'Synthetic history' } }]);
  });

  it('stores empty datasets', async () => {
    const store = await newStore();
    await store.create('pw', { iterations });
    const id = await store.putDataset({ name: 'empty' }, []);
    expect(await store.getItems(id)).toEqual([]);
  });

  it('locks, and unlocks only with the right passphrase', async () => {
    const store = await newStore();
    await store.create('right passphrase', { iterations });
    const id = await store.putDataset({ name: 'x' }, items);
    store.lock();
    await expect(store.getItems(id)).rejects.toBeInstanceOf(StoreLockedError);
    await expect(store.unlock('wrong passphrase')).rejects.toBeInstanceOf(WrongPassphraseError);
    await store.unlock('right passphrase');
    expect(await store.getItems(id)).toEqual(items);
  });

  it('survives reopening the database', async () => {
    const first = await newStore();
    await first.create('pw', { iterations });
    const id = await first.putDataset({ name: 'kept' }, items);
    first.close();
    const second = await LocalStore.open(first.dbName);
    stores.push(second);
    expect(second.exists).toBe(true);
    expect(second.unlocked).toBe(false);
    await second.unlock('pw');
    expect(await second.getItems(id)).toEqual(items);
  });

  it('keeps no plaintext in IndexedDB', async () => {
    const store = await newStore();
    await store.create('pw', { iterations });
    await store.putDataset({ name: 'Secret dataset name' }, [{ title: 'very private search' }]);
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
    const reopened = await LocalStore.open(store.dbName);
    stores.push(reopened);
  });

  it('rejects chunks moved between datasets', async () => {
    const store = await newStore();
    await store.create('pw', { iterations });
    const a = await store.putDataset({ name: 'a' }, [1]);
    const b = await store.putDataset({ name: 'b' }, [2]);
    store.close();
    const db = await openDB(store.dbName);
    await db.put('chunks', await db.get('chunks', [a, 0]), [b, 0]);
    db.close();
    const reopened = await LocalStore.open(store.dbName);
    stores.push(reopened);
    await reopened.unlock('pw');
    expect(await reopened.getItems(a)).toEqual([1]);
    await expect(reopened.getItems(b)).rejects.toThrow();
  });

  it('deletes datasets and destroys the whole store', async () => {
    const store = await newStore();
    await store.create('pw', { iterations });
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
