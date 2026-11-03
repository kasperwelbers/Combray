/**
 * Passkey ceremonies with the PRF extension.
 *
 * The server sends WebAuthn options as JSON (base64url for binary fields); we turn them into
 * the browser's types, add `prf: { eval: { first: salt } }`, and send the result back as JSON.
 *
 * The PRF output is the secret that unlocks the personal key. It must never reach the server,
 * so the JSON we send carries **no client extension results at all**. We build it by hand rather
 * than with `PublicKeyCredential.toJSON()`, which would include them.
 */
import { fromBase64Url, prfSalt, toBase64Url } from '@combray/seal';

import { api } from './api';

type Json = Record<string, unknown>;

const bin = (v: unknown) => fromBase64Url(String(v));

/** Server creation options (`{ publicKey: … }`) to what `navigator.credentials.create` takes. */
export function creationOptions(json: Json, salt: Uint8Array<ArrayBuffer>): CredentialCreationOptions {
  const o = json.publicKey as Json;
  const user = o.user as Json;
  return {
    publicKey: {
      ...(o as unknown as PublicKeyCredentialCreationOptions),
      // Ask for a discoverable passkey, so researchers can sign in with it alone. Synced passkeys
      // always are; a security key that cannot be still works after the email code.
      authenticatorSelection: {
        ...((o.authenticatorSelection as AuthenticatorSelectionCriteria | undefined) ?? {}),
        residentKey: 'preferred',
        requireResidentKey: false,
      },
      challenge: bin(o.challenge),
      user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: bin(user.id) },
      excludeCredentials: ((o.excludeCredentials as Json[] | undefined) ?? []).map((c) => ({
        ...(c as unknown as PublicKeyCredentialDescriptor),
        id: bin(c.id),
      })),
      extensions: { ...((o.extensions as Json | undefined) ?? {}), prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  };
}

/** Server request options to what `navigator.credentials.get` takes. */
export function requestOptions(json: Json, salt: Uint8Array<ArrayBuffer>): CredentialRequestOptions {
  const o = json.publicKey as Json;
  return {
    publicKey: {
      ...(o as unknown as PublicKeyCredentialRequestOptions),
      challenge: bin(o.challenge),
      allowCredentials: ((o.allowCredentials as Json[] | undefined) ?? []).map((c) => ({
        ...(c as unknown as PublicKeyCredentialDescriptor),
        id: bin(c.id),
      })),
      extensions: { ...((o.extensions as Json | undefined) ?? {}), prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  };
}

const b64 = (b: ArrayBuffer | ArrayBufferView) => toBase64Url(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

/** The registration response for the server, without client extension results. */
export function registrationJson(credential: PublicKeyCredential): Json {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: b64(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: b64(response.attestationObject),
      clientDataJSON: b64(response.clientDataJSON),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : undefined,
    },
    extensions: {},
  };
}

/** The assertion for the server, without client extension results. */
export function assertionJson(credential: PublicKeyCredential): Json {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: b64(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: b64(response.authenticatorData),
      clientDataJSON: b64(response.clientDataJSON),
      signature: b64(response.signature),
      userHandle: response.userHandle ? b64(response.userHandle) : null,
    },
    extensions: {},
  };
}

/** The PRF output from a ceremony, if the authenticator gave one. */
export function prfOutput(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | undefined {
  const results = (credential.getClientExtensionResults() as { prf?: { results?: { first?: BufferSource } } }).prf?.results;
  const first = results?.first;
  if (!first) return undefined;
  return first instanceof ArrayBuffer ? new Uint8Array(first.slice(0)) : new Uint8Array((first as ArrayBufferView).buffer.slice(0) as ArrayBuffer);
}

export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials;
}

/** Register a new passkey for the signed-in (or email-verified) researcher. */
export async function register(name: string): Promise<{ credentialId: string; prf?: Uint8Array<ArrayBuffer>; prfEnabled: boolean }> {
  const options = await api.post<Json>('/auth/passkey/register/start');
  const credential = (await navigator.credentials.create(creationOptions(options, await prfSalt()))) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was created.');
  const { credential_id } = await api.post<{ credential_id: string }>('/auth/passkey/register/finish', {
    credential: registrationJson(credential),
    name,
  });
  const ext = credential.getClientExtensionResults() as { prf?: { enabled?: boolean } };
  const prf = prfOutput(credential);
  return { credentialId: credential_id, prf, prfEnabled: !!prf || ext.prf?.enabled === true };
}

/** Sign in with a passkey alone (no email code first). Returns what `authenticate` returns. */
export async function signInWithPasskey(): Promise<{ credentialId: string; prf?: Uint8Array<ArrayBuffer>; wrapped: string | null }> {
  const start = await api.post<{ ceremony: string; options: Json }>('/auth/passkey/sign-in/start');
  const credential = (await navigator.credentials.get(requestOptions(start.options, await prfSalt()))) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was used.');
  const result = await api.post<{ credential_id: string; wrapped_key: string | null }>('/auth/passkey/sign-in/finish', {
    ceremony: start.ceremony,
    credential: assertionJson(credential),
  });
  return { credentialId: result.credential_id, prf: prfOutput(credential), wrapped: result.wrapped_key };
}

/** Use a passkey: signs in, and returns its PRF output and the personal key wrapped under it. */
export async function authenticate(): Promise<{ credentialId: string; prf?: Uint8Array<ArrayBuffer>; wrapped: string | null }> {
  const options = await api.post<Json>('/auth/passkey/start');
  const credential = (await navigator.credentials.get(requestOptions(options, await prfSalt()))) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was used.');
  const result = await api.post<{ credential_id: string; wrapped_key: string | null }>('/auth/passkey/finish', {
    credential: assertionJson(credential),
  });
  return { credentialId: result.credential_id, prf: prfOutput(credential), wrapped: result.wrapped_key };
}
