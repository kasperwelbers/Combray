/**
 * The encrypted local store: datasets and files kept in IndexedDB, every record encrypted.
 * IndexedDB is used as a key-value store for encrypted blobs, never queried by content.
 * See docs/security.md#local-store.
 *
 * One store per project per device, in database `combray-{project id}` (format version 2):
 * - `meta`      the project (id and public name), the participant id if any, the store id
 *               (issued by the server), the wrapped DEK and the delete token. No content.
 * - `index`     per dataset: random id, kind, chunk count, size bucket, format version.
 * - `manifests` per dataset: the encrypted manifest (name, source, dates, summary).
 * - `chunks`    per dataset and chunk index: encrypted MessagePack arrays of items (`items`),
 *               or encrypted slices of a file's raw bytes (`bytes`).
 *
 * The store never talks to the server itself: the caller fetches the KEK from the key service
 * and passes its raw bytes to `create` or `unlock`.
 *
 * `exportBackup` and `restoreBackup` copy these records, still encrypted, to and from a backup
 * file (see ./backup.ts).
 */
import { decode, encode } from '@msgpack/msgpack';
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';

import { BACKUP_VERSION, BackupError, BackupWriter, ownBytes, readBackup } from './backup';
import {
  aad,
  createDek,
  decrypt,
  encrypt,
  importKek,
  randomId,
  unwrapDek,
  type EncryptedRecord,
} from './crypto';

export const FORMAT_VERSION = 2;
export const DEFAULT_CHUNK_SIZE = 5000;
/** Files are stored as one logical blob, encrypted in slices of this many bytes. */
export const DEFAULT_SLICE_BYTES = 4 * 1024 * 1024;

interface StoreMeta {
  storeId: string;
  formatVersion: number;
  createdAt: string;
  unlock: { mode: 'server'; wrappedDek: ArrayBuffer };
  /** Lets this device ask the server to forget the KEK, without the password. */
  deleteToken: string;
  project: StoreProject;
  /** The participant id from the study link, if the project uses them. */
  participantId?: string;
  /**
   * The salt for `passwordForServer`: the server only ever sees the password derived with it.
   * Stores made before it was added send the password itself.
   */
  passwordSalt?: Uint8Array<ArrayBuffer>;
}

/** The project a store belongs to. The name is public (from the project config). */
export interface StoreProject {
  id: string;
  name?: unknown;
}

/** What the key service returns for a new store. */
export interface ServerStore {
  storeId: string;
  kek: Uint8Array<ArrayBuffer>;
  deleteToken: string;
}

export interface DatasetIndexEntry {
  id: string;
  /** `items`: MessagePack arrays of items. `bytes`: a file's raw bytes. */
  kind: 'items' | 'bytes';
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
    const db = await openDB<Schema>(dbName, FORMAT_VERSION, {
      upgrade(db, oldVersion) {
        // Format 1 (passphrase unlock, before any release) is not migrated: its stores are
        // dropped. Later formats must migrate instead.
        if (oldVersion > 0 && oldVersion < 2) {
          for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        }
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

  /** The store's id at the key service, once a store exists. */
  get storeId(): string | undefined {
    return this.meta?.storeId;
  }

  get deleteToken(): string | undefined {
    return this.meta?.deleteToken;
  }

  get project(): StoreProject | undefined {
    return this.meta?.project;
  }

  get participantId(): string | undefined {
    return this.meta?.participantId;
  }

  get passwordSalt(): Uint8Array<ArrayBuffer> | undefined {
    return this.meta?.passwordSalt;
  }

  /**
   * Create a new, empty store whose DEK is wrapped under the server's KEK. Fails if a store
   * exists. The KEK bytes are wiped after import.
   */
  async create(
    server: ServerStore,
    about: { project: StoreProject; participantId?: string | undefined; passwordSalt?: Uint8Array<ArrayBuffer> },
  ): Promise<void> {
    if (this.meta) throw new Error('a store already exists on this device');
    const { wrapped, dek } = await createDek(await importKek(server.kek));
    const meta: StoreMeta = {
      storeId: server.storeId,
      formatVersion: FORMAT_VERSION,
      createdAt: new Date().toISOString().slice(0, 10),
      unlock: { mode: 'server', wrappedDek: wrapped },
      deleteToken: server.deleteToken,
      project: about.project,
    };
    if (about.participantId) meta.participantId = about.participantId;
    if (about.passwordSalt) meta.passwordSalt = about.passwordSalt;
    await this.db.put('meta', meta, 'store');
    this.meta = meta;
    this.dek = dek;
  }

  /** Unlock with the KEK from the server. Throws `WrongKeyError` if it does not match. */
  async unlock(kek: Uint8Array<ArrayBuffer>): Promise<void> {
    const meta = this.requireMeta();
    this.dek = await unwrapDek(await importKek(kek), meta.unlock.wrappedDek);
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
    await this.write({ id, kind: 'items', chunks, manifest: encryptedManifest });
    return id;
  }

  /**
   * Store a file's raw bytes as one logical blob, encrypted in slices so that no single
   * WebCrypto call or IndexedDB value has to hold a whole multi-gigabyte export.
   */
  async putFile(manifest: M, file: Blob, sliceBytes = DEFAULT_SLICE_BYTES): Promise<string> {
    const { dek, storeId } = this.requireUnlocked();
    const id = randomId();
    const encryptedManifest = await encrypt(
      dek,
      encode(manifest),
      aad('combray', FORMAT_VERSION, storeId, id, 'manifest'),
    );
    const chunks: EncryptedRecord[] = [];
    for (let i = 0; i * sliceBytes < Math.max(file.size, 1); i++) {
      const slice = new Uint8Array(await file.slice(i * sliceBytes, (i + 1) * sliceBytes).arrayBuffer());
      chunks.push(await encrypt(dek, slice, aad('combray', FORMAT_VERSION, storeId, id, 'bytes', i)));
    }
    await this.write({ id, kind: 'bytes', chunks, manifest: encryptedManifest });
    return id;
  }

  /** Decrypt a stored file back into a Blob. */
  async getFile(id: string, type = ''): Promise<Blob> {
    const { dek, storeId } = this.requireUnlocked();
    const entry = await this.db.get('index', id);
    if (entry?.kind !== 'bytes') throw new Error(`no file ${id}`);
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let i = 0; i < entry.chunkCount; i++) {
      const record = await this.db.get('chunks', [id, i]);
      if (!record) throw new Error(`missing chunk ${i} of ${id}`);
      parts.push(await decrypt(dek, record, aad('combray', entry.formatVersion, storeId, id, 'bytes', i)));
    }
    return new Blob(parts, { type });
  }

  private async write(dataset: {
    id: string;
    kind: DatasetIndexEntry['kind'];
    chunks: EncryptedRecord[];
    manifest: EncryptedRecord;
  }): Promise<void> {
    const { id, kind, chunks, manifest } = dataset;
    const bytes = chunks.reduce((n, c) => n + c.ciphertext.byteLength, 0);
    const tx = this.db.transaction(['index', 'manifests', 'chunks'], 'readwrite');
    await Promise.all([
      tx.objectStore('index').put({
        id,
        kind,
        chunkCount: chunks.length,
        sizeBucket: sizeBucket(bytes),
        formatVersion: FORMAT_VERSION,
      }),
      tx.objectStore('manifests').put(manifest, id),
      ...chunks.map((c, i) => tx.objectStore('chunks').put(c, [id, i])),
      tx.done,
    ]);
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
    if (entry?.kind !== 'items') throw new Error(`no dataset ${id}`);
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

  /**
   * Copy the whole store, as it is on disk, into a backup file. Works while locked: nothing is
   * decrypted. `origin` is the Combray server the store belongs to.
   */
  async exportBackup(origin: string): Promise<Blob> {
    const meta = this.requireMeta();
    const out = new BackupWriter();
    out.add({ t: 'header', kind: 'combray-backup', version: BACKUP_VERSION, origin, created: new Date().toISOString().slice(0, 10), meta: metaFrame(meta) });
    const entries = await this.db.getAll('index');
    let chunks = 0;
    for (const entry of entries) {
      out.add({ t: 'index', v: entry });
      const manifest = await this.db.get('manifests', entry.id);
      if (!manifest) throw new Error(`missing manifest for ${entry.id}`);
      out.add({ t: 'manifest', id: entry.id, iv: manifest.iv, data: new Uint8Array(manifest.ciphertext) });
      for (let n = 0; n < entry.chunkCount; n++) {
        const record = await this.db.get('chunks', [entry.id, n]);
        if (!record) throw new Error(`missing chunk ${n} of ${entry.id}`);
        out.add({ t: 'chunk', id: entry.id, n, iv: record.iv, data: new Uint8Array(record.ciphertext) });
        chunks += 1;
      }
    }
    out.add({ t: 'end', datasets: entries.length, chunks });
    return out.finish();
  }

  /**
   * Fill this empty database from a backup file. The store stays locked: it opens with the
   * password as usual. Throws `BackupError` (and leaves the database empty) if the file is not
   * a backup, is damaged, or belongs to another server or project.
   */
  async restoreBackup(file: Blob, expected: { origin: string; projectId: string }): Promise<void> {
    if (this.meta) throw new Error('a store already exists on this device');
    try {
      await this.readInto(file, expected);
    } catch (error) {
      await this.clear();
      throw error;
    }
  }

  private async readInto(file: Blob, expected: { origin: string; projectId: string }): Promise<void> {
    let meta: StoreMeta | undefined;
    const index = new Map<string, DatasetIndexEntry>();
    const manifests = new Set<string>();
    let chunks = 0;
    let ended = false;
    for await (const frame of readBackup(file)) {
      if (ended) throw new BackupError('damaged');
      if (!meta) {
        if (frame.t !== 'header' || frame.kind !== 'combray-backup') throw new BackupError('not-a-backup');
        if (typeof frame.version !== 'number' || frame.version > BACKUP_VERSION) throw new BackupError('newer-version');
        if (frame.origin !== expected.origin) throw new BackupError('other-server');
        meta = parseMeta(frame.meta);
        if (meta.project.id !== expected.projectId) throw new BackupError('other-project');
        continue;
      }
      switch (frame.t) {
        case 'index': {
          const entry = parseIndexEntry(frame.v);
          if (index.has(entry.id)) throw new BackupError('damaged');
          index.set(entry.id, entry);
          await this.db.put('index', entry);
          break;
        }
        case 'manifest': {
          const id = knownId(frame.id, index);
          manifests.add(id);
          await this.db.put('manifests', record(frame), id);
          break;
        }
        case 'chunk': {
          const id = knownId(frame.id, index);
          const n = frame.n;
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= index.get(id)!.chunkCount) throw new BackupError('damaged');
          await this.db.put('chunks', record(frame), [id, n]);
          chunks += 1;
          break;
        }
        case 'end': {
          const expectedChunks = [...index.values()].reduce((sum, e) => sum + e.chunkCount, 0);
          if (frame.datasets !== index.size || frame.chunks !== chunks || chunks !== expectedChunks || manifests.size !== index.size) {
            throw new BackupError('damaged');
          }
          ended = true;
          break;
        }
        default:
          throw new BackupError('damaged');
      }
    }
    if (!meta) throw new BackupError('not-a-backup');
    if (!ended) throw new BackupError('damaged');
    // Last, so that a store only exists once everything else is in place.
    await this.db.put('meta', meta, 'store');
    this.meta = meta;
  }

  private async clear(): Promise<void> {
    const tx = this.db.transaction(['meta', 'index', 'manifests', 'chunks'], 'readwrite');
    await Promise.all([
      tx.objectStore('meta').clear(),
      tx.objectStore('index').clear(),
      tx.objectStore('manifests').clear(),
      tx.objectStore('chunks').clear(),
      tx.done,
    ]);
    this.meta = undefined;
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

/** The store's metadata as written to a backup: byte fields as Uint8Array. */
function metaFrame(meta: StoreMeta): Record<string, unknown> {
  return { ...meta, unlock: { mode: meta.unlock.mode, wrappedDek: new Uint8Array(meta.unlock.wrappedDek) } };
}

const isString = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DATASET_ID = /^[0-9a-f]{32}$/;

function parseMeta(value: unknown): StoreMeta {
  if (!isRecord(value) || !isRecord(value.unlock) || !isRecord(value.project)) throw new BackupError('damaged');
  const { storeId, formatVersion, createdAt, unlock, deleteToken, project, participantId, passwordSalt } = value;
  if (typeof formatVersion === 'number' && formatVersion > FORMAT_VERSION) throw new BackupError('newer-version');
  if (
    !isString(storeId, 64) ||
    formatVersion !== FORMAT_VERSION ||
    !isString(createdAt, 32) ||
    unlock.mode !== 'server' ||
    !isString(deleteToken, 128) ||
    !isString(project.id, 64) ||
    (participantId !== undefined && !isString(participantId, 64))
  ) {
    throw new BackupError('damaged');
  }
  const meta: StoreMeta = {
    storeId,
    formatVersion,
    createdAt,
    unlock: { mode: 'server', wrappedDek: ownBytes(unlock.wrappedDek).buffer },
    deleteToken,
    project: { id: project.id, ...(project.name !== undefined ? { name: project.name } : {}) },
  };
  if (participantId !== undefined) meta.participantId = participantId;
  if (passwordSalt !== undefined) meta.passwordSalt = ownBytes(passwordSalt);
  return meta;
}

function parseIndexEntry(value: unknown): DatasetIndexEntry {
  if (!isRecord(value)) throw new BackupError('damaged');
  const { id, kind, chunkCount, sizeBucket, formatVersion } = value;
  if (
    typeof id !== 'string' ||
    !DATASET_ID.test(id) ||
    (kind !== 'items' && kind !== 'bytes') ||
    typeof chunkCount !== 'number' ||
    !Number.isInteger(chunkCount) ||
    chunkCount < 0 ||
    typeof sizeBucket !== 'number' ||
    typeof formatVersion !== 'number' ||
    formatVersion > FORMAT_VERSION
  ) {
    throw new BackupError('damaged');
  }
  return { id, kind, chunkCount, sizeBucket, formatVersion };
}

function knownId(value: unknown, index: Map<string, DatasetIndexEntry>): string {
  if (typeof value !== 'string' || !index.has(value)) throw new BackupError('damaged');
  return value;
}

function record(frame: Record<string, unknown>): EncryptedRecord {
  const iv = ownBytes(frame.iv);
  if (iv.byteLength !== 12) throw new BackupError('damaged');
  return { iv, ciphertext: ownBytes(frame.data).buffer };
}
