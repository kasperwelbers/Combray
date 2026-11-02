/**
 * Donation envelopes ([privacy-and-encryption.md](../../../docs/privacy-and-encryption.md#envelope-format)).
 *
 *   "CMBRDON1" | u32 header length | header (JSON) | chunk* (u32 length | AES-256-GCM ciphertext)
 *
 * - A fresh random 256-bit **donation key** encrypts the payload in chunks. Chunk i uses the nonce
 *   (11-byte big-endian i || 1 byte, 1 on the last chunk and 0 otherwise) and the additional data
 *   SHA-256(magic || header). Reordered, dropped, added or truncated chunks fail to open: the
 *   header names the chunk count, and only the last chunk carries the last flag.
 * - The donation key is sealed with HPKE to the project public key, with
 *   info = "combray/donation-key/v1" \0 project id \0 donation id and the same header hash as
 *   additional data. The sealed key travels next to the envelope, never inside it: the server
 *   keeps it in a separate key database, and deleting it withdraws every copy of the envelope
 *   ([ADR 0006](../../../docs/decisions/0006-revocable-donation-keys.md)).
 */
import { type Bytes, concat, fromUtf8, randomBytes, sha256, toBase64Url, utf8 } from './bytes';
import { type Sealed, fingerprint, info, open, seal } from './hpke';

const MAGIC = utf8('CMBRDON1');
export const CHUNK_BYTES = 1024 * 1024;
/** Envelopes larger than this are refused when opened, so a corrupt header cannot exhaust memory. */
const MAX_HEADER_BYTES = 16 * 1024;

export interface EnvelopeHeader {
  v: 1;
  project: string;
  donation: string;
  /** Fingerprint of the project public key the donation key is sealed to. */
  key: string;
  chunkBytes: number;
  chunks: number;
  /** The day the donation was made (UTC), never a time. */
  created: string;
}

export interface Donation {
  envelope: Bytes;
  header: EnvelopeHeader;
  sealedKey: Sealed;
}

/** A random 128-bit donation id, base64url. */
export function newDonationId(): string {
  return toBase64Url(randomBytes(16));
}

function nonce(i: number, last: boolean): Bytes {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setUint32(7, i);
  n[11] = last ? 1 : 0;
  return n;
}

function u32(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

const keyInfo = (header: EnvelopeHeader) => info('combray/donation-key/v1', header.project, header.donation);

/** Encrypt a payload for a project. Runs entirely in the participant's browser. */
export async function sealDonation(
  payload: Uint8Array,
  opts: { projectId: string; projectPublicKey: Uint8Array; donationId?: string; day?: string; chunkBytes?: number },
): Promise<Donation> {
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const chunks = Math.max(1, Math.ceil(payload.byteLength / chunkBytes));
  const header: EnvelopeHeader = {
    v: 1,
    project: opts.projectId,
    donation: opts.donationId ?? newDonationId(),
    key: await fingerprint(opts.projectPublicKey),
    chunkBytes,
    chunks,
    created: opts.day ?? new Date().toISOString().slice(0, 10),
  };
  const headerBytes = utf8(JSON.stringify(header));
  const aad = await sha256(MAGIC, headerBytes);

  const raw = randomBytes(32);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const parts: Uint8Array[] = [MAGIC, u32(headerBytes.byteLength), headerBytes];
  for (let i = 0; i < chunks; i++) {
    const plain = payload.subarray(i * chunkBytes, (i + 1) * chunkBytes);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(i, i === chunks - 1), additionalData: aad }, key, concat(plain)),
    );
    parts.push(u32(ct.byteLength), ct);
  }
  const sealedKey = await seal(opts.projectPublicKey, keyInfo(header), raw, aad);
  raw.fill(0);
  return { envelope: concat(...parts), header, sealedKey };
}

export class InvalidEnvelope extends Error {
  constructor(reason: string) {
    super(`invalid donation envelope: ${reason}`);
    this.name = 'InvalidEnvelope';
  }
}

/** Read the header without decrypting anything. */
export function readHeader(envelope: Uint8Array): { header: EnvelopeHeader; headerBytes: Bytes; offset: number } {
  if (envelope.byteLength < 12 || !MAGIC.every((b, i) => envelope[i] === b)) throw new InvalidEnvelope('not an envelope');
  const length = new DataView(envelope.buffer, envelope.byteOffset).getUint32(8);
  if (length > MAX_HEADER_BYTES || 12 + length > envelope.byteLength) throw new InvalidEnvelope('header');
  const headerBytes = concat(envelope.subarray(12, 12 + length));
  let header: EnvelopeHeader;
  try {
    header = JSON.parse(fromUtf8(headerBytes)) as EnvelopeHeader;
  } catch {
    throw new InvalidEnvelope('header');
  }
  if (header.v !== 1 || !Number.isInteger(header.chunks) || header.chunks < 1) throw new InvalidEnvelope('version');
  return { header, headerBytes, offset: 12 + length };
}

/**
 * Open a donation with the project's private key seed. Checks that the envelope is for the
 * expected project and donation, so the server cannot pass off one donation as another.
 */
export async function openDonation(
  envelope: Uint8Array,
  sealedKey: Sealed,
  projectSeed: Uint8Array,
  expect: { projectId: string; donationId: string },
): Promise<{ header: EnvelopeHeader; payload: Bytes }> {
  const { header, headerBytes, offset } = readHeader(envelope);
  if (header.project !== expect.projectId || header.donation !== expect.donationId) throw new InvalidEnvelope('wrong donation');
  const aad = await sha256(MAGIC, headerBytes);
  const raw = await open(projectSeed, keyInfo(header), sealedKey, aad);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  raw.fill(0);

  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const out: Uint8Array[] = [];
  let at = offset;
  for (let i = 0; i < header.chunks; i++) {
    if (at + 4 > envelope.byteLength) throw new InvalidEnvelope('truncated');
    const length = view.getUint32(at);
    at += 4;
    if (at + length > envelope.byteLength) throw new InvalidEnvelope('truncated');
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce(i, i === header.chunks - 1), additionalData: aad },
        key,
        concat(envelope.subarray(at, at + length)),
      );
      out.push(new Uint8Array(pt));
    } catch {
      throw new InvalidEnvelope(`chunk ${i}`);
    }
    at += length;
  }
  if (at !== envelope.byteLength) throw new InvalidEnvelope('trailing bytes');
  return { header, payload: concat(...out) };
}

/**
 * The body of `POST /api/v1/p/{project}/donations`: the sealed key and the envelope in one
 * request, which the server stores apart.
 *
 *   u32 big-endian length | sealed donation key as JSON ({ enc, ciphertext }, base64url) | envelope
 */
export function donationRequest(donation: Pick<Donation, 'envelope' | 'sealedKey'>): Uint8Array<ArrayBuffer> {
  const key = utf8(JSON.stringify({ enc: toBase64Url(donation.sealedKey.enc), ciphertext: toBase64Url(donation.sealedKey.ciphertext) }));
  const body = new Uint8Array(4 + key.length + donation.envelope.length);
  new DataView(body.buffer).setUint32(0, key.length);
  body.set(key, 4);
  body.set(donation.envelope, 4 + key.length);
  return body;
}
