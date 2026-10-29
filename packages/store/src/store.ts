/**
 * The encrypted local store: datasets kept in IndexedDB, every record encrypted.
 * See docs/privacy-and-encryption.md#local-store.
 *
 * Layout (database `combray`, format version 1):
 * - `meta`      the store id, KDF parameters and the wrapped DEK. No content.
 * - `index`     per dataset: random id, chunk count, size bucket, format version. No content.
 * - `manifests` per dataset: the encrypted manifest (name, source, dates, summary).
 * - `chunks`    per dataset and chunk index: encrypted MessagePack arrays of items.
 *
 * Only passphrase unlock (browser mode) is implemented so far; server unlock comes with the
 * store-key service in Phase 2.
 */
import { decode, encode } from '@msgpack/msgpack';
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

import {
  aad,
  createDek,
  decrypt,
  deriveKek,
  encrypt,
  newKdfParams,
  randomId,
  unwrapDek,
  type EncryptedRecord,
  type KdfParams,
} from './crypto';

export const FORMAT_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 5000;

interface StoreMeta {
  storeId: string;
  formatVersion: number;
  createdAt: string;
  unlock: { mode: 'passphrase'; kdf: KdfParams; wrappedDek: ArrayBuffer };
}

export interface DatasetIndexEntry {
  id: string;
  chunkCount: number;
  /** Total ciphertext size rounded up to a power of two, so exact sizes are not visible. */
  sizeBucket: number;
  formatVersion: number;
}

interface Schema extends DBSchema {
  meta: { key: string; value: StoreMeta };
  index: { key: string; value: DatasetIndexEntry };
  manifests: { key: string; value: EncryptedRecord };
  chunks: { key: [string, number]; value: EncryptedRecord };
}

export interface Dataset<M> {
  id: string;
  manifest: M;
}

export class StoreLockedError extends Error {
  constructor() {
    super('the store is locked');
    this.name = 'StoreLockedError';
  }
}

function sizeBucket(bytes: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(bytes, 1024)));
}

export class LocalStore<M = unknown> {
  private dek: CryptoKey | undefined;
  private meta: StoreMeta | undefined;

  private constructor(
    private readonly db: IDBPDatabase<Schema>,
    readonly dbName: string,
  ) {}

  static async open<M = unknown>(dbName = 'combray'): Promise<LocalStore<M>> {
    const db = await openDB<Schema>(dbName, 1, {
      upgrade(db) {
        db.createObjectStore('meta');
        db.createObjectStore('index', { keyPath: 'id' });
        db.createObjectStore('manifests');
        db.createObjectStore('chunks');
      },
    });
    const store = new LocalStore<M>(db, dbName);
    store.meta = await db.get('meta', 'store');
    return store;
  }

  get exists(): boolean {
    return this.meta !== undefined;
  }

  get unlocked(): boolean {
    return this.dek !== undefined;
  }

  /** Create a new, empty store protected by a passphrase. Fails if a store exists. */
  async create(passphrase: string, options: { iterations?: number } = {}): Promise<void> {
    if (this.meta) throw new Error('a store already exists on this device');
    const kdf = newKdfParams(options.iterations);
    const { wrapped, dek } = await createDek(await deriveKek(passphrase, kdf));
    const meta: StoreMeta = {
      storeId: randomId(),
      formatVersion: FORMAT_VERSION,
      createdAt: new Date().toISOString().slice(0, 10),
      unlock: { mode: 'passphrase', kdf, wrappedDek: wrapped },
    };
    await this.db.put('meta', meta, 'store');
    this.meta = meta;
    this.dek = dek;
  }

  /** Unlock with the passphrase. Throws `WrongPassphraseError` if it does not match. */
  async unlock(passphrase: string): Promise<void> {
    const meta = this.requireMeta();
    const kek = await deriveKek(passphrase, meta.unlock.kdf);
    this.dek = await unwrapDek(kek, meta.unlock.wrappedDek);
  }

  /** Drop the key from memory. Data stays on disk, encrypted. */
  lock(): void {
    this.dek = undefined;
  }

  /** Delete the whole database from this device. */
  async destroy(): Promise<void> {
    this.lock();
    this.db.close();
    await deleteDB(this.dbName);
    this.meta = undefined;
  }

  close(): void {
    this.lock();
    this.db.close();
  }

  /** Store a dataset: an encrypted manifest plus its items in encrypted chunks. */
  async putDataset(manifest: M, items: unknown[], chunkSize = DEFAULT_CHUNK_SIZE): Promise<string> {
    const { dek, storeId } = this.requireUnlocked();
    const id = randomId();
    const encryptedManifest = await encrypt(
      dek,
      encode(manifest),
      aad('combray', FORMAT_VERSION, storeId, id, 'manifest'),
    );
    // Encrypt everything first: an IndexedDB transaction closes when we await other promises.
    const chunks: EncryptedRecord[] = [];
    for (let i = 0; i * chunkSize < Math.max(items.length, 1); i++) {
      const slice = items.slice(i * chunkSize, (i + 1) * chunkSize);
      chunks.push(await encrypt(dek, encode(slice), aad('combray', FORMAT_VERSION, storeId, id, i)));
    }
    const bytes = chunks.reduce((n, c) => n + c.ciphertext.byteLength, 0);
    const tx = this.db.transaction(['index', 'manifests', 'chunks'], 'readwrite');
    await Promise.all([
      tx.objectStore('index').put({
        id,
        chunkCount: chunks.length,
        sizeBucket: sizeBucket(bytes),
        formatVersion: FORMAT_VERSION,
      }),
      tx.objectStore('manifests').put(encryptedManifest, id),
      ...chunks.map((c, i) => tx.objectStore('chunks').put(c, [id, i])),
      tx.done,
    ]);
    return id;
  }

  async listDatasets(): Promise<Dataset<M>[]> {
    const { dek, storeId } = this.requireUnlocked();
    const entries = await this.db.getAll('index');
    return Promise.all(
      entries.map(async (entry) => {
        const record = await this.db.get('manifests', entry.id);
        if (!record) throw new Error(`missing manifest for ${entry.id}`);
        const plaintext = await decrypt(
          dek,
          record,
          aad('combray', entry.formatVersion, storeId, entry.id, 'manifest'),
        );
        return { id: entry.id, manifest: decode(plaintext) as M };
      }),
    );
  }

  /** Decrypt and return all items of a dataset, in order. */
  async getItems<T = unknown>(id: string): Promise<T[]> {
    const { dek, storeId } = this.requireUnlocked();
    const entry = await this.db.get('index', id);
    if (!entry) throw new Error(`no dataset ${id}`);
    const items: T[] = [];
    for (let i = 0; i < entry.chunkCount; i++) {
      const record = await this.db.get('chunks', [id, i]);
      if (!record) throw new Error(`missing chunk ${i} of ${id}`);
      const plaintext = await decrypt(dek, record, aad('combray', entry.formatVersion, storeId, id, i));
      for (const item of decode(plaintext) as T[]) items.push(item);
    }
    return items;
  }

  async deleteDataset(id: string): Promise<void> {
    const entry = await this.db.get('index', id);
    if (!entry) return;
    const tx = this.db.transaction(['index', 'manifests', 'chunks'], 'readwrite');
    await Promise.all([
      tx.objectStore('index').delete(id),
      tx.objectStore('manifests').delete(id),
      tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity])),
      tx.done,
    ]);
  }

  private requireMeta(): StoreMeta {
    if (!this.meta) throw new Error('no store on this device yet');
    return this.meta;
  }

  private requireUnlocked(): { dek: CryptoKey; storeId: string } {
    const meta = this.requireMeta();
    if (!this.dek) throw new StoreLockedError();
    return { dek: this.dek, storeId: meta.storeId };
  }
}
