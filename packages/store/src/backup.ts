/**
 * The backup file (the "Combray package" of docs/key-design.md): a copy of one store's
 * IndexedDB records exactly as they are on disk. Every record is still encrypted under the
 * store's data key, and the data key is still locked under the server's key, so the file
 * opens only after the server releases that key for the store's password, on any device.
 * Nothing is decrypted or re-encrypted to make it.
 *
 * Layout: the 8 bytes `CMBRYBK1`, then frames of a 4-byte big-endian length followed by that
 * many bytes of MessagePack. The first frame is the header, the last one the end marker:
 *
 *   { t: 'header', kind: 'combray-backup', version: 1, origin, created, meta }
 *   { t: 'index', v: DatasetIndexEntry }
 *   { t: 'manifest', id, iv, data }
 *   { t: 'chunk', id, n, iv, data }
 *   { t: 'end', datasets, chunks }
 *
 * The end marker's counts catch a truncated file. A changed byte inside a record is caught by
 * AES-GCM when the record is read.
 */
import { decode, encode } from '@msgpack/msgpack';

const MAGIC = new TextEncoder().encode('CMBRYBK1');
export const BACKUP_VERSION = 1;
/** No single record is anywhere near this: chunks are at most a few megabytes. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** Parts are gathered into a Blob every so often, so the browser can keep them out of memory. */
const FLUSH_BYTES = 32 * 1024 * 1024;

/** `other-server` and `other-project`: a backup of another study's (or server's) space. */
export type BackupProblem = 'not-a-backup' | 'damaged' | 'newer-version' | 'other-server' | 'other-project';

export class BackupError extends Error {
  constructor(readonly problem: BackupProblem) {
    super(`backup: ${problem}`);
    this.name = 'BackupError';
  }
}

/** Builds a backup file frame by frame. */
export class BackupWriter {
  private parts: Uint8Array<ArrayBuffer>[] = [MAGIC.slice()];
  private pending = MAGIC.byteLength;
  private readonly blobs: Blob[] = [];

  add(frame: Record<string, unknown>): void {
    const body = encode(frame);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, body.byteLength);
    this.parts.push(length, body.slice());
    this.pending += 4 + body.byteLength;
    if (this.pending >= FLUSH_BYTES) this.flush();
  }

  finish(): Blob {
    this.flush();
    return new Blob(this.blobs, { type: 'application/octet-stream' });
  }

  private flush(): void {
    if (this.parts.length > 0) this.blobs.push(new Blob(this.parts));
    this.parts = [];
    this.pending = 0;
  }
}

/** Reads a backup file frame by frame, without loading it whole. */
export async function* readBackup(file: Blob): AsyncGenerator<Record<string, unknown>> {
  if (file.size < MAGIC.byteLength) throw new BackupError('not-a-backup');
  const magic = new Uint8Array(await file.slice(0, MAGIC.byteLength).arrayBuffer());
  if (!magic.every((b, i) => b === MAGIC[i])) throw new BackupError('not-a-backup');
  let offset = MAGIC.byteLength;
  while (offset < file.size) {
    if (offset + 4 > file.size) throw new BackupError('damaged');
    const length = new DataView(await file.slice(offset, offset + 4).arrayBuffer()).getUint32(0);
    offset += 4;
    if (length > MAX_FRAME_BYTES || offset + length > file.size) throw new BackupError('damaged');
    let frame: unknown;
    try {
      frame = decode(new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()));
    } catch {
      throw new BackupError('damaged');
    }
    offset += length;
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) throw new BackupError('damaged');
    yield frame as Record<string, unknown>;
  }
}

/** A copy of the bytes as their own ArrayBuffer (MessagePack gives views into its input). */
export function ownBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) throw new BackupError('damaged');
  return new Uint8Array(value);
}
