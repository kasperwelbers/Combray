/**
 * Local store crypto, WebCrypto only. See docs/privacy-and-encryption.md#local-store.
 *
 * - DEK: a random AES-256-GCM key that encrypts every record. It is only ever held as a
 *   non-extractable CryptoKey once unlocked.
 * - KEK: derived from the passphrase with PBKDF2-SHA-256 (600k iterations, the documented
 *   fallback; Argon2id via WASM can replace it later). The KEK wraps the DEK with AES-KW,
 *   whose integrity check also tells us when a passphrase is wrong.
 * - Records: AES-256-GCM with a random 96-bit nonce and additional data that binds each
 *   ciphertext to its store, dataset and position, so chunks cannot be swapped or replayed.
 */

export const KDF_ITERATIONS = 600_000;

export interface KdfParams {
  name: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  salt: Uint8Array<ArrayBuffer>;
}

export interface EncryptedRecord {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong passphrase');
    this.name = 'WrongPassphraseError';
  }
}

const encoder = new TextEncoder();

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomId(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newKdfParams(iterations = KDF_ITERATIONS): KdfParams {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: randomBytes(16) };
}

export async function deriveKek(passphrase: string, params: KdfParams): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: params.hash, iterations: params.iterations, salt: params.salt },
    material,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** Create a new DEK, wrapped under the KEK. Returns the wrapped bytes and a usable key. */
export async function createDek(kek: CryptoKey): Promise<{ wrapped: ArrayBuffer; dek: CryptoKey }> {
  // The DEK must be extractable for wrapKey; it is unwrapped again as non-extractable and this
  // extractable copy goes out of scope.
  const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const wrapped = await crypto.subtle.wrapKey('raw', extractable, kek, 'AES-KW');
  return { wrapped, dek: await unwrapDek(kek, wrapped) };
}

export async function unwrapDek(kek: CryptoKey, wrapped: ArrayBuffer): Promise<CryptoKey> {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      wrapped,
      kek,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw new WrongPassphraseError();
  }
}

export function aad(...parts: (string | number)[]): Uint8Array<ArrayBuffer> {
  return encoder.encode(parts.join('|'));
}

export async function encrypt(
  dek: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<EncryptedRecord> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, dek, plaintext);
  return { iv, ciphertext };
}

export async function decrypt(
  dek: CryptoKey,
  record: EncryptedRecord,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.iv, additionalData },
    dek,
    record.ciphertext,
  );
  return new Uint8Array(plaintext);
}
