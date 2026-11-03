/** Small helpers shared by the server's services. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const nowSecs = (): number => Math.floor(Date.now() / 1000);

/** The current day (UTC) as `YYYY-MM-DD`. Donations are dated to the day, never the time. */
export const today = (): string => new Date().toISOString().slice(0, 10);

export const random = (n: number): Buffer => randomBytes(n);

/** A random 256-bit secret for tokens, session ids and codes. */
export const randomToken = (): Buffer => randomBytes(32);

export const sha256 = (...parts: (Uint8Array | string)[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Constant-time comparison; different lengths are simply unequal. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Strict base64url without padding, as the browser sends it. Node's own decoder skips characters
 * it does not know; this one refuses them, so malformed tokens never look like valid ones.
 */
export function fromB64(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  return Buffer.from(value, 'base64url');
}

/** Ids made by clients: 16 random bytes in base64url (22 characters). */
export const validRandomId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id);
