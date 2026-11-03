/**
 * A software passkey authenticator, for testing the server's WebAuthn checks over HTTP.
 *
 * It behaves like a platform authenticator in a browser on the key page: ES256 (P-256) keys,
 * attestation format `none`, user presence and user verification, a signature counter, and the
 * user handle from registration (so it works for sign-in with the passkey alone). It produces
 * the same JSON the key page sends (`registrationJson` and `assertionJson` in
 * apps/keys/src/passkey.ts): base64url fields and no client extension results.
 *
 * Every field that the server must check can be tampered with through the `Tamper` options.
 *
 * WebAuthn references: authenticator data (https://www.w3.org/TR/webauthn-3/#sctn-authenticator-data),
 * attestation object, client data, COSE keys (RFC 9052/9053), CBOR (RFC 8949).
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// A minimal CBOR encoder: unsigned and negative integers, byte and text strings, and maps.

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('only integers');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const parts = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

// Helpers.

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/** Authenticator data flags. */
export const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 } as const;

export interface Credential {
  id: Buffer;
  privateKey: KeyObject;
  /** The COSE public key, as registered. */
  cosePublicKey: Buffer;
  /** The `user.id` the server gave at registration. */
  userHandle: Buffer;
  signCount: number;
}

/** Ways to make a ceremony response wrong, one field at a time. */
export interface Tamper {
  /** clientDataJSON `origin` (default: the key page's origin). */
  origin?: string;
  /** clientDataJSON `type` (default `webauthn.create` or `webauthn.get`). */
  type?: string;
  /** clientDataJSON `challenge`, base64url (default: the server's challenge). */
  challenge?: string;
  /** The RP id whose SHA-256 goes into the authenticator data (default: the key page host name). */
  rpId?: string;
  /** Authenticator data flags (default UP | UV, plus AT for registration). */
  flags?: number;
  /** Signature counter to report (default: the credential's counter plus one). */
  signCount?: number;
  /** Flip a bit in the signature. */
  badSignature?: boolean;
  /** Sign with this key instead of the credential's own. */
  signingKey?: KeyObject;
  /** The user handle to return (default: the one from registration); null to leave it out. */
  userHandle?: Buffer | null;
}

export type Json = Record<string, any>;

export class SoftAuthenticator {
  readonly credentials: Credential[] = [];

  /**
   * @param rpId the key page's host name, without port (`keys.localhost`)
   * @param origin the key page's origin (`http://keys.localhost:1234`)
   */
  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {}

  private clientData(type: string, challenge: string, t: Tamper): Buffer {
    // As a browser writes it: the challenge re-encoded as base64url without padding.
    return Buffer.from(
      JSON.stringify({
        type: t.type ?? type,
        challenge: t.challenge ?? b64url(Buffer.from(challenge, 'base64url')),
        origin: t.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
  }

  /**
   * Create a passkey for the server's creation options (`{ publicKey: … }`), as
   * `navigator.credentials.create` would. Returns the JSON the key page sends as `credential`.
   */
  register(options: Json, t: Tamper = {}): Json {
    const o = options.publicKey;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    // COSE_Key: kty EC2 (2), alg ES256 (-7), crv P-256 (1), x, y.
    const cosePublicKey = cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const id = randomBytes(32);
    const credential: Credential = {
      id,
      privateKey,
      cosePublicKey,
      userHandle: Buffer.from(o.user.id, 'base64url'),
      signCount: 0,
    };
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const attestedCredentialData = Buffer.concat([Buffer.alloc(16) /* AAGUID */, idLength, id, cosePublicKey]);
    const authData = this.authData(t, FLAGS.UP | FLAGS.UV | FLAGS.AT, t.signCount ?? 0, attestedCredentialData);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    this.credentials.push(credential);
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: 'public-key',
      response: {
        attestationObject: b64url(attestationObject),
        clientDataJSON: b64url(this.clientData('webauthn.create', o.challenge, t)),
        transports: ['internal'],
      },
      extensions: {},
    };
  }

  /**
   * Use a passkey for the server's request options (`{ publicKey: … }`), as
   * `navigator.credentials.get` would. Without `allowCredentials` (sign-in with the passkey
   * alone), it uses `credential` or the only one it holds. Returns the JSON the key page sends.
   */
  assert(options: Json, credential?: Credential, t: Tamper = {}): Json {
    const o = options.publicKey;
    const allowed: string[] = (o.allowCredentials ?? []).map((c: Json) => b64url(Buffer.from(c.id, 'base64url')));
    const cred =
      credential ??
      (allowed.length > 0 ? this.credentials.find((c) => allowed.includes(b64url(c.id))) : this.credentials.at(-1));
    if (!cred) throw new Error('the authenticator has no passkey for these options');
    const signCount = t.signCount ?? cred.signCount + 1;
    cred.signCount = signCount;
    const authData = this.authData(t, FLAGS.UP | FLAGS.UV, signCount);
    const clientDataJSON = this.clientData('webauthn.get', o.challenge, t);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), t.signingKey ?? cred.privateKey);
    if (t.badSignature) signature[signature.length - 1]! ^= 0x01;
    const userHandle = t.userHandle === undefined ? cred.userHandle : t.userHandle;
    return {
      id: b64url(cred.id),
      rawId: b64url(cred.id),
      type: 'public-key',
      response: {
        authenticatorData: b64url(authData),
        clientDataJSON: b64url(clientDataJSON),
        signature: b64url(signature),
        userHandle: userHandle ? b64url(userHandle) : null,
      },
      extensions: {},
    };
  }

  private authData(t: Tamper, defaultFlags: number, signCount: number, attested?: Buffer): Buffer {
    const flags = Buffer.from([t.flags ?? defaultFlags]);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    return Buffer.concat([sha256(t.rpId ?? this.rpId), flags, counter, ...(attested ? [attested] : [])]);
  }
}

/** A P-256 key that belongs to no registered passkey, for forged signatures. */
export function strangerKey(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}
