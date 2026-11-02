/**
 * HPKE (RFC 9180, base mode) with X-Wing (draft-connolly-cfrg-xwing-kem-06), HKDF-SHA-256 and
 * AES-256-GCM, from hpke-js. Every key pair in Combray is X-Wing: the project key that donations
 * are sealed to, and each researcher's personal key that project keys are sealed to.
 *
 * An X-Wing private key is a 32-byte seed. We keep keys as seeds and turn them into CryptoKeys
 * only for the call that needs them.
 */
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { XWing } from '@hpke/hybridkem-x-wing';

import { type Bytes, concat, randomBytes, sha256, toBase64Url, utf8 } from './bytes';

export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 1216;

let cached: { suite: CipherSuite; kem: XWing } | undefined;
function hpke(): { suite: CipherSuite; kem: XWing } {
  if (!cached) {
    const kem = new XWing();
    cached = { kem, suite: new CipherSuite({ kem, kdf: new HkdfSha256(), aead: new Aes256Gcm() }) };
  }
  return cached;
}

export interface Sealed {
  /** The KEM encapsulation (1120 bytes for X-Wing). */
  enc: Bytes;
  ciphertext: Bytes;
}

export function newSeed(): Bytes {
  return randomBytes(SEED_BYTES);
}

/** The public key for a private key seed. */
export async function publicKeyOf(seed: Uint8Array): Promise<Bytes> {
  const { kem } = hpke();
  const pair = await kem.generateKeyPairDerand(concat(seed));
  return new Uint8Array(await kem.serializePublicKey(pair.publicKey));
}

/**
 * A short, stable name for a public key: base64url of the first 16 bytes of its SHA-256. Goes
 * into participant links (`#k=…`), so the browser can check the key it is about to seal to.
 */
export async function fingerprint(publicKey: Uint8Array): Promise<string> {
  return toBase64Url((await sha256(utf8('combray/key-fingerprint/v1\0'), publicKey)).slice(0, 16));
}

/** HPKE `info` strings: labels and ids separated by NUL bytes, so no two can be confused. */
export function info(label: string, ...ids: string[]): Bytes {
  return utf8([label, ...ids].join('\0'));
}

export async function seal(publicKey: Uint8Array, infoBytes: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Sealed> {
  const { suite, kem } = hpke();
  const recipientPublicKey = await kem.deserializePublicKey(concat(publicKey));
  const { ct, enc } = await suite.seal({ recipientPublicKey, info: concat(infoBytes) }, concat(plaintext), aad ? concat(aad) : undefined);
  return { enc: new Uint8Array(enc), ciphertext: new Uint8Array(ct) };
}

/** Open a sealed message with the recipient's private key seed. Throws if anything was changed. */
export async function open(seed: Uint8Array, infoBytes: Uint8Array, sealed: Sealed, aad?: Uint8Array): Promise<Bytes> {
  const { suite, kem } = hpke();
  const pair = await kem.generateKeyPairDerand(concat(seed));
  const plaintext = await suite.open(
    { recipientKey: pair, enc: concat(sealed.enc), info: concat(infoBytes) },
    concat(sealed.ciphertext),
    aad ? concat(aad) : undefined,
  );
  return new Uint8Array(plaintext);
}
