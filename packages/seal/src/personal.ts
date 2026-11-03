/**
 * A researcher's personal key, and the two ways to unlock it.
 *
 * Everything comes from one 32-byte **master secret**, made in the browser at sign-up:
 *
 *   personal private key (X-Wing seed) = HKDF(master, "combray/personal-key/v1")
 *   recovery sign-in secret            = HKDF(master, "combray/recovery-sign-in/v1")
 *
 * The master secret is shown once as the **recovery code**. For everyday use it is also stored
 * on the server wrapped under each of the researcher's passkeys:
 *
 *   wrap key = HKDF(WebAuthn PRF output, "combray/personal-key-wrap/v1")
 *   wrapped  = nonce || AES-256-GCM(wrap key, nonce, master, aad = researcher id || credential id)
 *
 * The PRF output never leaves the authenticator and the key page, so the server holds a blob it
 * cannot open. The recovery sign-in secret lets a researcher who lost every passkey prove they
 * hold the recovery code; the server stores only its SHA-256. See docs/researcher-keys.md.
 */
import {
  type Bytes,
  concat,
  fromBase32,
  group,
  hkdf,
  randomBytes,
  sha256,
  toBase32,
  utf8,
} from './bytes';
import { publicKeyOf } from './hpke';

export const MASTER_BYTES = 32;

/** The salt the key page asks every passkey to evaluate its PRF on. Not secret. */
export async function prfSalt(): Promise<Bytes> {
  return sha256(utf8('combray/prf-salt/v1'));
}

export function newMasterSecret(): Bytes {
  return randomBytes(MASTER_BYTES);
}

export interface PersonalKey {
  /** The X-Wing private key seed. Keep in memory only. */
  seed: Bytes;
  publicKey: Bytes;
}

export async function personalKey(master: Uint8Array): Promise<PersonalKey> {
  const seed = await hkdf(master, 'combray/personal-key/v1');
  return { seed, publicKey: await publicKeyOf(seed) };
}

/** Sent to the server only when signing in with the recovery code. */
export async function recoverySignInSecret(master: Uint8Array): Promise<Bytes> {
  return hkdf(master, 'combray/recovery-sign-in/v1');
}

/** What the server stores at sign-up, to check a recovery sign-in later. */
export async function recoveryVerifier(master: Uint8Array): Promise<Bytes> {
  return sha256(await recoverySignInSecret(master));
}

// Recovery code: the master secret in Crockford base32 (52 characters) plus a 2-character
// check from its SHA-256, in nine groups of six. The check catches typing mistakes; it is not
// a secret and adds nothing to the strength.

async function check(master: Uint8Array): Promise<string> {
  return toBase32((await sha256(utf8('combray/recovery-check/v1'), master)).slice(0, 2)).slice(0, 2);
}

export async function toRecoveryCode(master: Uint8Array): Promise<string> {
  return group(toBase32(master) + (await check(master)), 6);
}

export class InvalidRecoveryCode extends Error {
  constructor() {
    super('this is not a valid recovery code');
    this.name = 'InvalidRecoveryCode';
  }
}

export async function fromRecoveryCode(code: string): Promise<Bytes> {
  const clean = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (clean.length !== 54) throw new InvalidRecoveryCode();
  let master: Bytes;
  try {
    master = fromBase32(clean.slice(0, 52), MASTER_BYTES);
  } catch {
    throw new InvalidRecoveryCode();
  }
  const expected = await check(master);
  const given = clean.slice(52).replace(/[IL]/g, '1').replace(/O/g, '0');
  if (given !== expected) throw new InvalidRecoveryCode();
  return master;
}

/** Find a recovery code in a pasted text or an uploaded recovery file. */
export function findRecoveryCode(text: string): string | undefined {
  return text.match(/(?:[0-9A-Za-z]{6}[\s-]?){8}[0-9A-Za-z]{6}/)?.[0];
}

// Passkey wrapping.

async function wrapKey(prfOutput: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const raw = await hkdf(prfOutput, 'combray/personal-key-wrap/v1');
  try {
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
  } finally {
    raw.fill(0);
  }
}

function wrapAad(researcherId: string, credentialId: string): Bytes {
  return utf8(`combray/personal-key-wrap/v1\0${researcherId}\0${credentialId}`);
}

export async function wrapMaster(
  master: Uint8Array,
  prfOutput: Uint8Array,
  researcherId: string,
  credentialId: string,
): Promise<Bytes> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: wrapAad(researcherId, credentialId) },
    await wrapKey(prfOutput, 'encrypt'),
    concat(master),
  );
  return concat(iv, new Uint8Array(ct));
}

export class WrongPasskey extends Error {
  constructor() {
    super('this passkey does not unlock the key');
    this.name = 'WrongPasskey';
  }
}

export async function unwrapMaster(
  wrapped: Uint8Array,
  prfOutput: Uint8Array,
  researcherId: string,
  credentialId: string,
): Promise<Bytes> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: concat(wrapped.subarray(0, 12)), additionalData: wrapAad(researcherId, credentialId) },
      await wrapKey(prfOutput, 'decrypt'),
      concat(wrapped.subarray(12)),
    );
    return new Uint8Array(pt);
  } catch {
    throw new WrongPasskey();
  }
}

/**
 * The code two researchers compare before one grants the other access to a project: 80 bits of
 * the SHA-256 of the receiving researcher's public key, as four groups of four characters.
 * A server that swapped in its own key would have to find a key with the same code, which takes
 * about 2^80 tries.
 */
export async function keyCode(publicKey: Uint8Array): Promise<string> {
  return group(toBase32((await sha256(utf8('combray/key-code/v1\0'), publicKey)).slice(0, 10)), 4);
}
