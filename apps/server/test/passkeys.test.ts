/**
 * Passkeys on the key page, with a software authenticator (see authenticator.ts): registering,
 * signing in with the passkey alone, the email code then the passkey, and every way an assertion
 * or attestation can be wrong. None of this was tested over HTTP before the port; passkey
 * verification is what a port is most likely to get subtly wrong, so these tests are strict.
 */
import { describe, expect, it } from 'vitest';

import { type Json, SoftAuthenticator, strangerKey, FLAGS, type Tamper } from './authenticator';
import { type TestServer, b64, cookie, fill, startServer } from './harness';
import {
  SESSION_COOKIE,
  authenticatorFor,
  emailSignIn,
  registerPasskey,
  setUpResearcher,
  type Researcher,
} from './research';

const ADA = 'ada@uni.example';
const BOB = 'bob@uni.example';

/** The 16 bytes of a UUID. */
const uuidBytes = (id: string) => Buffer.from(id.replaceAll('-', ''), 'hex');

async function signInStart(s: TestServer) {
  const r = await s.keys.post('/api/v1/auth/passkey/sign-in/start', {});
  expect(r.status, r.text).toBe(200);
  return r.json as { ceremony: string; options: Json };
}

/** Sign in with the passkey alone; `tamper` changes the assertion. */
async function passkeySignIn(s: TestServer, r: Researcher, tamper: Tamper = {}) {
  const start = await signInStart(s);
  const credential = r.authenticator.assert(start.options, undefined, tamper);
  return s.keys.post('/api/v1/auth/passkey/sign-in/finish', { ceremony: start.ceremony, credential });
}

/** Sign in with the email code, then the passkey; `tamper` changes the assertion. */
async function emailThenPasskey(s: TestServer, r: Researcher, tamper: Tamper = {}) {
  const session = await emailSignIn(s, s.keys, r.email);
  const start = await s.keys.post('/api/v1/auth/passkey/start', {}, session);
  expect(start.status, start.text).toBe(200);
  const credential = r.authenticator.assert(start.json, undefined, tamper);
  const finish = await s.keys.post('/api/v1/auth/passkey/finish', { credential }, session);
  return { session, start, finish };
}

describe('registering a passkey', () => {
  it('binds it to the key page and completes sign-in after the email code', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    const me = (await s.keys.get('/api/v1/me', emailSession)).json;
    expect(me.signed_in).toBe(false);
    expect(me.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const start = await s.keys.post('/api/v1/auth/passkey/register/start', {}, emailSession);
    expect(start.status).toBe(200);
    expect(start.headers['cache-control']).toBe('no-store');
    const o = start.json.publicKey;
    expect(o.rp).toEqual({ id: 'keys.localhost', name: 'Combray' });
    // The user handle is the researcher id: sign-in with the passkey alone relies on it, and
    // passkeys registered before a port must keep working.
    expect(Buffer.from(o.user.id, 'base64url')).toEqual(uuidBytes(me.id));
    expect(o.user.name).toBe(ADA);
    expect(Buffer.from(o.challenge, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(o.pubKeyCredParams.map((p: Json) => p.alg)).toContain(-7);
    expect(o.authenticatorSelection.userVerification).toBe('required');
    expect(o.excludeCredentials ?? []).toEqual([]);

    const authenticator = authenticatorFor(s);
    const credential = authenticator.register(start.json);
    const finish = await s.keys.post('/api/v1/auth/passkey/register/finish', { credential, name: '  Laptop  ' }, emailSession);
    expect(finish.status, finish.text).toBe(200);
    expect(finish.json).toEqual({ credential_id: credential.rawId });
    expect(finish.headers['cache-control']).toBe('no-store');
    const full = cookie(finish, SESSION_COOKIE);
    expect(full.pair).not.toBe(emailSession);
    expect(full.header).toBe(`${full.pair}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200`);

    expect((await s.keys.get('/api/v1/me', emailSession)).status, 'the email-level session is gone').toBe(401);
    const after = (await s.keys.get('/api/v1/me', full.pair)).json;
    expect(after.signed_in).toBe(true);
    expect(after.passkeys).toHaveLength(1);
    expect(after.passkeys[0]).toMatchObject({ id: credential.rawId, name: 'Laptop', last_used: null, unlocks_key: false });
    expect(typeof after.passkeys[0].created).toBe('number');
    expect((await s.keys.get('/api/v1/projects', full.pair)).status).toBe(200);
  });

  it('names a passkey "Passkey" by default and keeps at most 60 characters', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    const authenticator = authenticatorFor(s);
    const first = await registerPasskey(s, emailSession, authenticator, '');
    expect(first.finish.status).toBe(200);
    const second = await registerPasskey(s, first.session, authenticator, 'x'.repeat(80));
    expect(second.finish.status).toBe(200);
    const names = (await s.keys.get('/api/v1/me', first.session)).json.passkeys.map((p: Json) => p.name);
    expect(names).toEqual(['Passkey', 'x'.repeat(60)]);
  });

  it('needs a full session to add a second passkey, and excludes the existing ones', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);

    // With only the email code, no passkey can be added to an account that has one.
    const emailSession = await emailSignIn(s, s.keys, ADA);
    const refused = await s.keys.post('/api/v1/auth/passkey/register/start', {}, emailSession);
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: 'passkey_required' });

    const start = await s.keys.post('/api/v1/auth/passkey/register/start', {}, ada.session);
    expect(start.status).toBe(200);
    expect(start.json.publicKey.excludeCredentials.map((c: Json) => c.id)).toEqual([ada.credentialId]);
    const second = await registerPasskey(s, ada.session, ada.authenticator, 'Phone');
    expect(second.finish.status).toBe(200);
    expect(second.session, 'a full session is not replaced').toBe(ada.session);
    expect((await s.keys.get('/api/v1/me', ada.session)).json.passkeys).toHaveLength(2);
  });

  it('allows at most ten passkeys', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    for (let i = 2; i <= 10; i++) expect((await registerPasskey(s, ada.session, ada.authenticator)).finish.status).toBe(200);
    const eleventh = await registerPasskey(s, ada.session, ada.authenticator);
    expect(eleventh.finish.status).toBe(409);
    expect(eleventh.finish.json).toEqual({ error: 'conflict' });
  });

  it('rejects attestations that are wrong in any checked field', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    const authenticator = authenticatorFor(s);
    const cases: [string, Tamper][] = [
      ['another origin', { origin: s.main.origin }],
      ['another port', { origin: `http://keys.localhost:${s.port + 1}` }],
      ['another RP id', { rpId: 'localhost' }],
      ['the type of an assertion', { type: 'webauthn.get' }],
      ['another challenge', { challenge: b64(fill(1, 32)) }],
      ['no user verification', { flags: FLAGS.UP | FLAGS.AT }],
      ['no user presence', { flags: FLAGS.UV | FLAGS.AT }],
    ];
    for (const [what, tamper] of cases) {
      const start = await s.keys.post('/api/v1/auth/passkey/register/start', {}, emailSession);
      expect(start.status, what).toBe(200);
      const credential = authenticator.register(start.json, tamper);
      const r = await s.keys.post('/api/v1/auth/passkey/register/finish', { credential }, emailSession);
      expect(r.status, what).toBe(400);
      expect(r.json, what).toEqual({ error: 'passkey_rejected' });
      expect(r.headers['set-cookie'], what).toBeUndefined();
    }
    // None of them was stored, and the session is still at the email level.
    const me = (await s.keys.get('/api/v1/me', emailSession)).json;
    expect(me.passkeys).toEqual([]);
    expect(me.signed_in).toBe(false);
  });

  it('needs a ceremony, used once', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    const authenticator = authenticatorFor(s);

    const fake = authenticator.register({
      publicKey: { challenge: b64(fill(1, 32)), user: { id: b64(fill(2, 16)) } },
    });
    const none = await s.keys.post('/api/v1/auth/passkey/register/finish', { credential: fake }, emailSession);
    expect(none.status).toBe(400);
    expect(none.json).toEqual({ error: 'no_ceremony' });

    const start = await s.keys.post('/api/v1/auth/passkey/register/start', {}, emailSession);
    const credential = authenticator.register(start.json);
    const ok = await s.keys.post('/api/v1/auth/passkey/register/finish', { credential }, emailSession);
    expect(ok.status).toBe(200);
    const full = cookie(ok, SESSION_COOKIE).pair;
    const replay = await s.keys.post('/api/v1/auth/passkey/register/finish', { credential }, full);
    expect(replay.status).toBe(400);
    expect(replay.json).toEqual({ error: 'no_ceremony' });
  });

  it('needs a session', async () => {
    const s = await startServer();
    const r = await s.keys.post('/api/v1/auth/passkey/register/start', {});
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'not_signed_in' });
  });
});

describe('signing in with the passkey alone', () => {
  it('starts without a session and needs its ceremony', async () => {
    const s = await startServer();
    const start = await s.keys.post('/api/v1/auth/passkey/sign-in/start', {});
    expect(start.status, start.text).toBe(200);
    expect(start.headers['cache-control']).toBe('no-store');
    expect(start.headers['set-cookie']).toBeUndefined();
    expect(start.json.ceremony.length).toBeGreaterThanOrEqual(43);
    const o = start.json.options.publicKey;
    expect(typeof o.challenge).toBe('string');
    expect(o.userVerification).toBe('required');
    // The browser offers whichever passkeys it has for the key page.
    expect(o.allowCredentials ?? []).toEqual([]);

    const unknown = await s.keys.post('/api/v1/auth/passkey/sign-in/finish', { ceremony: b64(fill(7, 32)), credential: {} });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
  });

  it('gives a full session and the personal key wrapped under that passkey', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);

    // Without a wrapped key yet (the passkey does not support PRF).
    const plain = await passkeySignIn(s, ada);
    expect(plain.status, plain.text).toBe(200);
    expect(plain.json).toEqual({ credential_id: ada.credentialId, wrapped_key: null });

    // The key page stores the personal key wrapped under the passkey's PRF output.
    const wrapped = fill(9, 60);
    const put = await s.keys.put(`/api/v1/me/passkeys/${ada.credentialId}/wrapped`, { wrapped_key: b64(wrapped) }, ada.session);
    expect(put.status).toBe(204);

    const r = await passkeySignIn(s, ada);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ credential_id: ada.credentialId, wrapped_key: b64(wrapped) });
    expect(r.headers['cache-control']).toBe('no-store');
    const session = cookie(r, SESSION_COOKIE);
    expect(session.header).toBe(`${session.pair}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200`);

    const me = (await s.keys.get('/api/v1/me', session.pair)).json;
    expect(me.signed_in).toBe(true);
    expect(me.email).toBe(ADA);
    expect(me.passkeys[0].unlocks_key).toBe(true);
    expect(typeof me.passkeys[0].last_used).toBe('number');
    expect((await s.keys.get('/api/v1/projects', session.pair)).status).toBe(200);
    expect((await s.keys.post('/api/v1/auth/handoff', {}, session.pair)).status).toBe(200);
  });

  it('works for each of several researchers, by user handle', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const bob = await setUpResearcher(s, BOB);
    for (const r of [ada, bob, ada]) {
      const res = await passkeySignIn(s, r);
      expect(res.status).toBe(200);
      const me = (await s.keys.get('/api/v1/me', cookie(res, SESSION_COOKIE).pair)).json;
      expect(me.email).toBe(r.email);
    }
  });

  it('rejects assertions that are wrong in any checked field', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const bob = await setUpResearcher(s, BOB);
    const other = await signInStart(s);
    // A passkey the server does not know: on another account, or on none.
    const unknown: [string, Tamper][] = [
      ["another researcher's user handle", { userHandle: uuidBytes(bob.id) }],
      ['an unknown user handle', { userHandle: fill(3, 16) }],
      ['no user handle', { userHandle: null }],
    ];
    for (const [what, tamper] of unknown) {
      const r = await passkeySignIn(s, ada, tamper);
      expect(r.status, what).toBe(401);
      expect(r.json, what).toEqual({ error: 'unknown_passkey' });
      expect(r.headers['set-cookie'], what).toBeUndefined();
    }
    const cases: [string, Tamper][] = [
      ['a bad signature', { badSignature: true }],
      ['a signature by another key', { signingKey: strangerKey() }],
      ['another origin', { origin: s.main.origin }],
      ['another RP id', { rpId: 'localhost' }],
      ['the type of a registration', { type: 'webauthn.create' }],
      ["another ceremony's challenge", { challenge: other.options.publicKey.challenge }],
      ['no user verification', { flags: FLAGS.UP }],
      ['no user presence', { flags: FLAGS.UV }],
    ];
    for (const [what, tamper] of cases) {
      const r = await passkeySignIn(s, ada, tamper);
      expect(r.status, what).toBe(401);
      expect(r.json, what).toEqual({ error: 'passkey_rejected' });
      expect(r.headers['set-cookie'], what).toBeUndefined();
    }
    // A passkey the server never registered.
    const stranger = authenticatorFor(s);
    stranger.register({ publicKey: { challenge: b64(fill(1, 32)), user: { id: b64(uuidBytes(ada.id)) } } });
    const start = await signInStart(s);
    const never = await s.keys.post('/api/v1/auth/passkey/sign-in/finish', {
      ceremony: start.ceremony,
      credential: stranger.assert(start.options),
    });
    expect(never.status).toBe(401);
    expect(never.json).toEqual({ error: 'unknown_passkey' });

    // And after all that, the real passkey still works.
    expect((await passkeySignIn(s, ada)).status).toBe(200);
  });

  it("rejects one researcher's passkey presented as another's", async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const bob = await setUpResearcher(s, BOB);
    // Bob's credential id and user handle, with Ada's key: Bob's stored public key does not match.
    const start = await signInStart(s);
    const credential = bob.authenticator.assert(start.options, undefined, { signingKey: ada.authenticator.credentials[0]!.privateKey });
    const r = await s.keys.post('/api/v1/auth/passkey/sign-in/finish', { ceremony: start.ceremony, credential });
    expect(r.status).toBe(401);
  });

  it('rejects a signature counter that went backwards', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    expect((await passkeySignIn(s, ada, { signCount: 5 })).status).toBe(200);
    expect((await passkeySignIn(s, ada, { signCount: 6 })).status).toBe(200);
    const cloned = await passkeySignIn(s, ada, { signCount: 6 });
    expect(cloned.status).toBe(401);
    expect(cloned.json).toEqual({ error: 'passkey_rejected' });
    expect((await passkeySignIn(s, ada, { signCount: 7 })).status).toBe(200);
  });

  it('accepts authenticators that always report a zero counter', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    for (let i = 0; i < 2; i++) expect((await passkeySignIn(s, ada, { signCount: 0 })).status).toBe(200);
  });

  it('uses each ceremony once', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const start = await signInStart(s);
    const credential = ada.authenticator.assert(start.options);
    const ok = await s.keys.post('/api/v1/auth/passkey/sign-in/finish', { ceremony: start.ceremony, credential });
    expect(ok.status).toBe(200);
    const replay = await s.keys.post('/api/v1/auth/passkey/sign-in/finish', { ceremony: start.ceremony, credential });
    expect(replay.status).toBe(400);
    expect(replay.json).toEqual({ error: 'no_ceremony' });
  });

  it('is rate limited per client IP (60 starts per 10 minutes)', async () => {
    const s = await startServer();
    const startFrom = (ip: string) =>
      s.request({
        method: 'POST',
        host: s.keysHost,
        path: '/api/v1/auth/passkey/sign-in/start',
        body: {},
        headers: { origin: s.keys.origin, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip },
      });
    for (let i = 0; i < 60; i++) expect((await startFrom('192.0.2.1')).status).toBe(200);
    const limited = await startFrom('192.0.2.1');
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: 'too_many_attempts' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await startFrom('192.0.2.2')).status).toBe(200);
  });

  it('stops working once the operator resets the key', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    await s.cliOk('researcher', 'reset-key', ADA);
    expect((await s.keys.get('/api/v1/me', ada.session)).status, 'sessions end').toBe(401);
    const r = await passkeySignIn(s, ada);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'unknown_passkey' });
  });
});

describe('the email code, then the passkey', () => {
  it('completes sign-in with a new session and returns the wrapped key', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    await s.keys.put(`/api/v1/me/passkeys/${ada.credentialId}/wrapped`, { wrapped_key: b64(fill(4, 60)) }, ada.session);

    const { session, start, finish } = await emailThenPasskey(s, ada);
    expect(start.headers['cache-control']).toBe('no-store');
    expect(start.json.publicKey.allowCredentials.map((c: Json) => c.id)).toEqual([ada.credentialId]);
    expect(start.json.publicKey.userVerification).toBe('required');
    expect(finish.status, finish.text).toBe(200);
    expect(finish.json).toEqual({ credential_id: ada.credentialId, wrapped_key: b64(fill(4, 60)) });
    const full = cookie(finish, SESSION_COOKIE);
    expect(full.pair).not.toBe(session);
    expect(full.header).toContain('Max-Age=7200');
    expect((await s.keys.get('/api/v1/me', full.pair)).json.signed_in).toBe(true);
    expect((await s.keys.get('/api/v1/me', session)).status).toBe(401);
  });

  it('with a full session confirms the passkey without a new session', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const start = await s.keys.post('/api/v1/auth/passkey/start', {}, ada.session);
    const credential = ada.authenticator.assert(start.json);
    const finish = await s.keys.post('/api/v1/auth/passkey/finish', { credential }, ada.session);
    expect(finish.status).toBe(200);
    expect(finish.headers['set-cookie']).toBeUndefined();
    expect((await s.keys.get('/api/v1/me', ada.session)).status).toBe(200);
  });

  it("rejects a bad signature and another researcher's passkey", async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const bob = await setUpResearcher(s, BOB);

    const bad = await emailThenPasskey(s, ada, { badSignature: true });
    expect(bad.finish.status).toBe(401);
    expect(bad.finish.json).toEqual({ error: 'passkey_rejected' });
    expect(bad.finish.headers['set-cookie']).toBeUndefined();
    expect((await s.keys.get('/api/v1/me', bad.session)).json.signed_in).toBe(false);

    // Bob signs in by email, then presents Ada's passkey (with Ada's user handle or his own).
    const session = await emailSignIn(s, s.keys, BOB);
    for (const userHandle of [uuidBytes(ada.id), uuidBytes(bob.id)]) {
      const start = await s.keys.post('/api/v1/auth/passkey/start', {}, session);
      expect(start.status).toBe(200);
      const credential = ada.authenticator.assert(start.json, ada.authenticator.credentials[0], { userHandle });
      const r = await s.keys.post('/api/v1/auth/passkey/finish', { credential }, session);
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ error: 'passkey_rejected' });
    }
    expect((await s.keys.get('/api/v1/me', session)).json.signed_in).toBe(false);
  });

  it('rejects another origin, RP id, challenge or missing user verification', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const session = await emailSignIn(s, s.keys, ADA);
    const cases: [string, Tamper][] = [
      ['another origin', { origin: s.main.origin }],
      ['another RP id', { rpId: 'localhost' }],
      ['another challenge', { challenge: b64(fill(1, 32)) }],
      ['no user verification', { flags: FLAGS.UP }],
    ];
    for (const [what, tamper] of cases) {
      const start = await s.keys.post('/api/v1/auth/passkey/start', {}, session);
      const credential = ada.authenticator.assert(start.json, undefined, tamper);
      const r = await s.keys.post('/api/v1/auth/passkey/finish', { credential }, session);
      expect(r.status, what).toBe(401);
    }
  });

  it('needs a passkey, a session and a ceremony', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    expect((await s.keys.post('/api/v1/auth/passkey/start', {})).status).toBe(401);
    const session = await emailSignIn(s, s.keys, ADA);
    const none = await s.keys.post('/api/v1/auth/passkey/start', {}, session);
    expect(none.status).toBe(409);
    expect(none.json).toEqual({ error: 'no_passkey' });
    const authenticator = authenticatorFor(s);
    const { session: full } = await registerPasskey(s, session, authenticator);
    const credential = authenticator.assert({ publicKey: { challenge: b64(fill(1, 32)) } });
    const noCeremony = await s.keys.post('/api/v1/auth/passkey/finish', { credential }, full);
    expect(noCeremony.status).toBe(400);
    expect(noCeremony.json).toEqual({ error: 'no_ceremony' });
  });
});

describe('managing passkeys', () => {
  it('removes a passkey, but never the last one', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const last = await s.keys.delete(`/api/v1/me/passkeys/${ada.credentialId}`, ada.session);
    expect(last.status).toBe(409);
    expect(last.json).toEqual({ error: 'conflict' });

    const phone = new SoftAuthenticator('keys.localhost', s.keys.origin);
    const second = await registerPasskey(s, ada.session, phone, 'Phone');
    expect(second.finish.status).toBe(200);
    expect((await s.keys.delete(`/api/v1/me/passkeys/${b64(fill(1, 32))}`, ada.session)).status).toBe(404);
    expect((await s.keys.delete(`/api/v1/me/passkeys/${ada.credentialId}`, ada.session)).status).toBe(204);

    // The removed passkey no longer signs in; the other one does.
    expect((await passkeySignIn(s, ada)).status).toBe(401);
    expect((await passkeySignIn(s, { ...ada, authenticator: phone })).status).toBe(200);
  });

  it('stores wrapped keys of 60 bytes, for own passkeys only', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const bob = await setUpResearcher(s, BOB);
    const path = `/api/v1/me/passkeys/${ada.credentialId}/wrapped`;
    for (const length of [59, 61, 0]) {
      const r = await s.keys.put(path, { wrapped_key: b64(fill(1, length)) }, ada.session);
      expect(r.status, String(length)).toBe(400);
      expect(r.json).toEqual({ error: 'invalid' });
    }
    expect((await s.keys.put(path, { wrapped_key: 'not base64!' }, ada.session)).status).toBe(400);
    const theirs = await s.keys.put(path, { wrapped_key: b64(fill(1, 60)) }, bob.session);
    expect(theirs.status).toBe(404);
    expect((await s.keys.put(path, { wrapped_key: b64(fill(1, 60)) }, ada.session)).status).toBe(204);
  });

  it('needs a full session', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    expect((await s.keys.delete(`/api/v1/me/passkeys/${ada.credentialId}`, emailSession)).status).toBe(401);
    const put = await s.keys.put(`/api/v1/me/passkeys/${ada.credentialId}/wrapped`, { wrapped_key: b64(fill(1, 60)) }, emailSession);
    expect(put.status).toBe(401);
  });
});
