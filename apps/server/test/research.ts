/**
 * Researcher sign-in and donation helpers, built only on the HTTP API, the CLI and the mail
 * outbox, the way a researcher's browser and the server operator would do it.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect } from 'vitest';

import { type Json, SoftAuthenticator } from './authenticator';
import { type Response, type Site, type TestServer, b64, cookie, fill } from './harness';

/** Personal and project public keys are X-Wing keys of this many bytes. */
export const PUBLIC_KEY_BYTES = 1216;

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

/** The pending email sign-in cookie and the session cookie, by site scheme. */
export const LOGIN_COOKIE = 'combray-login';
export const SESSION_COOKIE = 'combray';

/** Ask for an email sign-in code. Returns the `combray-login=…` cookie that ties it to this browser. */
export async function requestCode(site: Site, email: string): Promise<string> {
  const r = await site.post('/api/v1/auth/email', { email });
  expect(r.status, r.text).toBe(202);
  return cookie(r, LOGIN_COOKIE).pair;
}

/** The code from the newest sign-in mail to `email`, as written there ("1234 5678"). */
export async function mailedCode(s: TestServer, email: string): Promise<string> {
  const mail = await s.takeMail(email, 'sign-in code is:');
  expect(mail, 'the mail holds no link').not.toContain('http');
  const match = /sign-in code is:\s+(\d{4} \d{4})/.exec(mail);
  if (!match) throw new Error(`no code in mail: ${mail}`);
  return match[1]!;
}

/** Send a sign-in code from the browser holding `login` (or from one without the cookie). */
export function verifyCode(site: Site, login: string | undefined, code: string): Promise<Response> {
  return site.post('/api/v1/auth/email/verify', { code }, login);
}

/** Sign in with an emailed code on a site. Returns the session cookie pair (`combray=…`). */
export async function emailSignIn(s: TestServer, site: Site, email: string): Promise<string> {
  const login = await requestCode(site, email);
  const code = await mailedCode(s, email);
  const r = await verifyCode(site, login, code);
  expect(r.status, r.text).toBe(200);
  return cookie(r, SESSION_COOKIE).pair;
}

/**
 * Register a passkey with `authenticator`. Returns the response of `/register/finish`, and the
 * session cookie to use afterwards (a new one if the session was upgraded).
 */
export async function registerPasskey(
  s: TestServer,
  session: string,
  authenticator: SoftAuthenticator,
  name = 'Test passkey',
): Promise<{ finish: Response; session: string; credentialId: string }> {
  const start = await s.keys.post('/api/v1/auth/passkey/register/start', {}, session);
  expect(start.status, start.text).toBe(200);
  const credential = authenticator.register(start.json);
  const finish = await s.keys.post('/api/v1/auth/passkey/register/finish', { credential, name }, session);
  const upgraded = (finish.headers['set-cookie'] ?? []).some((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return {
    finish,
    session: upgraded ? cookie(finish, SESSION_COOKIE).pair : session,
    credentialId: finish.json?.credential_id,
  };
}

export interface Researcher {
  email: string;
  id: string;
  /** A full key page session. */
  session: string;
  /** The recovery sign-in secret; the server holds its SHA-256. */
  secret: Buffer;
  publicKey: Buffer;
  authenticator: SoftAuthenticator;
  credentialId: string;
}

export function authenticatorFor(s: TestServer): SoftAuthenticator {
  return new SoftAuthenticator('keys.localhost', s.keys.origin);
}

/**
 * A researcher with a passkey and a personal key, set up as on the key page: the operator adds
 * the account (and, with `project`, makes them a member), they sign in with the emailed code,
 * register a passkey (which completes sign-in) and store their public key with the verifier of
 * their recovery secret. Uses one sign-in mail.
 */
export async function setUpResearcher(
  s: TestServer,
  email: string,
  options: { project?: string; keyByte?: number } = {},
): Promise<Researcher> {
  if (options.project) await s.cliOk('project', 'add-researcher', options.project, email);
  else await s.cliOk('researcher', 'add', email);
  const emailSession = await emailSignIn(s, s.keys, email);
  const authenticator = authenticatorFor(s);
  const { finish, session, credentialId } = await registerPasskey(s, emailSession, authenticator);
  expect(finish.status, finish.text).toBe(200);
  expect(session, 'registering the first passkey completes sign-in with a new session').not.toBe(emailSession);
  const secret = randomBytes(32);
  const publicKey = fill(options.keyByte ?? 5, PUBLIC_KEY_BYTES);
  const key = await s.keys.post(
    '/api/v1/me/key',
    { public_key: b64(publicKey), recovery_verifier: b64(sha256(secret)) },
    session,
  );
  expect(key.status, key.text).toBe(204);
  const me = await s.keys.get('/api/v1/me', session);
  expect(me.status).toBe(200);
  return { email, id: me.json.id, session, secret, publicKey, authenticator, credentialId };
}

/** Sign in on the key page with the emailed code, then the recovery secret. Uses one sign-in mail. */
export async function recoverySignIn(s: TestServer, email: string, secret: Uint8Array): Promise<string> {
  const emailSession = await emailSignIn(s, s.keys, email);
  const r = await s.keys.post('/api/v1/auth/recovery', { secret: b64(secret) }, emailSession);
  expect(r.status, r.text).toBe(204);
  const full = cookie(r, SESSION_COOKIE).pair;
  expect(full, 'the session id changes when sign-in completes').not.toBe(emailSession);
  return full;
}

/** Create a project's key as its member (on the key page), with a dummy sealed copy. */
export async function createProjectKey(
  s: TestServer,
  session: string,
  project: string,
  fingerprint = 'fp',
  sealed: Json = { enc: 'ZQ', ciphertext: 'Yw' },
): Promise<Response> {
  return s.keys.post(
    `/api/v1/projects/${project}/key`,
    { public_key: b64(fill(5, PUBLIC_KEY_BYTES)), fingerprint, sealed_key: sealed },
    session,
  );
}

/** The member entry of `email` in a project, as a member sees it. */
export async function memberEntry(site: Site, session: string, project: string, email: string): Promise<Json> {
  const r = await site.get(`/api/v1/projects/${project}`, session);
  expect(r.status, r.text).toBe(200);
  const member = (r.json.members as Json[]).find((m) => m.email === email);
  if (!member) throw new Error(`${email} is not a member of ${project}`);
  return member;
}

// Donations.

/** An envelope as packages/seal writes it: magic, header length, header JSON, ciphertext. */
export function envelope(project: string, donation: string, key: string): Buffer {
  const header = Buffer.from(
    JSON.stringify({ v: 1, project, donation, key, chunks: 1, chunkBytes: 1024, created: '2026-11-02' }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([Buffer.from('CMBRDON1'), length, header, Buffer.from([0, 0, 0, 4, 1, 2, 3, 4])]);
}

/** A donation request body: u32 length (big-endian), sealed key JSON, envelope. */
export function donationBody(sealed: Json, env: Buffer): Buffer {
  const meta = Buffer.from(JSON.stringify(sealed));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(meta.length);
  return Buffer.concat([length, meta, env]);
}

/** Donate from the participant app on the main site. */
export function donate(s: TestServer, body: Buffer, project = 'willow', ip?: string): Promise<Response> {
  return s.request({
    method: 'POST',
    host: s.mainHost,
    path: `/api/v1/p/${project}/donations`,
    body,
    headers: {
      origin: s.main.origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/octet-stream',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
  });
}

/** Withdraw with the participant's token, from the main site. */
export function withdraw(s: TestServer, id: string, token: string): Promise<Response> {
  return s.main.post(`/api/v1/donations/${id}/withdraw`, { token });
}

/**
 * A studio session, as researchers get one: signed in on the key page (with the passkey), then
 * sent to the studio with a one-time handoff code. Returns the studio session cookie pair.
 */
export async function studioSignIn(s: TestServer, researcher: Researcher): Promise<string> {
  const handoff = await s.keys.post('/api/v1/auth/handoff', undefined, researcher.session);
  expect(handoff.status, handoff.text).toBe(200);
  const redeemed = await s.main.post('/api/v1/auth/handoff/redeem', { code: handoff.json.code });
  expect(redeemed.status, redeemed.text).toBe(204);
  return cookie(redeemed, SESSION_COOKIE).pair;
}
