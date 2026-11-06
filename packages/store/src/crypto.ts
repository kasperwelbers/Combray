/**
 * Local store crypto, WebCrypto only. See docs/security.md#local-store.
 *
 * - DEK: a random AES-256-GCM key that encrypts every record. It is only ever held as a
 *   non-extractable CryptoKey once unlocked, and never leaves the device.
 * - KEK: 32 random bytes held by the Combray server's key service, released only for the
 *   store's password. Imported as a non-extractable AES-KW key, it wraps the DEK. AES-KW's
 *   integrity check tells us when a KEK does not match.
 * - Records: AES-256-GCM with a random 96-bit nonce and additional data that binds each
 *   ciphertext to its store, dataset and position, so chunks cannot be swapped or replayed.
 */

export interface EncryptedRecord {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}

/** The KEK does not unwrap this store's DEK (e.g. the server's master key was replaced). */
export class WrongKeyError extends Error {
  constructor() {
    super('the key does not open this store');
    this.name = 'WrongKeyError';
  }
}

const encoder = new TextEncoder();

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomId(): string {
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Import the KEK's raw bytes as a non-extractable AES-KW key, then wipe the bytes. */
export async function importKek(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new WrongKeyError();
  try {
    return await crypto.subtle.importKey('raw', raw, 'AES-KW', false, ['wrapKey', 'unwrapKey']);
  } finally {
    raw.fill(0);
  }
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
    throw new WrongKeyError();
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

/** PBKDF2 iterations for the password the server sees. The server hashes it again with Argon2id. */
export const PASSWORD_ITERATIONS = 100_000;

/** A new random salt for `passwordForServer`, kept with the store (and in its backups). */
export function newPasswordSalt(): Uint8Array<ArrayBuffer> {
  return randomBytes(32);
}

/**
 * What the browser sends to the key service instead of the password itself:
 * PBKDF2-SHA-256(password, salt), base64url. The salt never leaves the device (or the
 * participant's backup file), so the server never learns the password, nor can it test guesses
 * for it, and a password used elsewhere stays private. The server still checks this value with
 * Argon2id and its lockout, exactly as it checked the password. See docs/security.md#store-keys.
 */
export async function passwordForServer(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS }, material, 256);
  return base64Url(new Uint8Array(bits));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
