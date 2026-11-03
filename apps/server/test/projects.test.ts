/**
 * Projects, members, project keys, the studio handoff and the researcher's own key. Ported from
 * the Rust server's tests/ (removed in ADR 0010): research.rs, plus the unit tests of the Rust src/accounts.rs that are
 * observable over HTTP (the personal key is set once; project keys are created once and granted
 * by members with access; the last member with access cannot be removed).
 *
 * Where the Rust tests wrote to the database, these set up state as researchers do: the operator's
 * CLI for accounts and first members, the key page's API for everything else.
 */
import { describe, expect, it } from 'vitest';

import { b64, cookie, fill, startServer } from './harness';
import {
  PUBLIC_KEY_BYTES,
  SESSION_COOKIE,
  authenticatorFor,
  createProjectKey,
  emailSignIn,
  memberEntry,
  recoverySignIn,
  registerPasskey,
  setUpResearcher,
  sha256,
} from './research';

const ADA = 'ada@uni.example';
const BOB = 'bob@uni.example';
const EVE = 'eve@uni.example';

describe('the studio', () => {
  it('signs in through a handoff from the key page and never sees keys', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    const keysSession = await recoverySignIn(s, ADA, ada.secret);

    const handoff = await s.keys.post('/api/v1/auth/handoff', undefined, keysSession);
    expect(handoff.status).toBe(200);
    expect(handoff.headers['cache-control']).toBe('no-store');
    const code = handoff.json.code as string;
    const redeemed = await s.main.post('/api/v1/auth/handoff/redeem', { code });
    expect(redeemed.status).toBe(204);
    const studio = cookie(redeemed, SESSION_COOKIE);
    expect(studio.header).toContain(`Max-Age=${30 * 24 * 3600}`);
    const again = await s.main.post('/api/v1/auth/handoff/redeem', { code });
    expect(again.status, 'a handoff code works once').toBe(403);
    expect(again.json).toEqual({ error: 'invalid_code' });
    expect((await s.main.post('/api/v1/auth/handoff/redeem', { code: 'not base64!' })).status).toBe(403);

    const me = (await s.main.get('/api/v1/me', studio.pair)).json;
    expect([me.email, me.signed_in]).toEqual([ADA, true]);
    const projects = (await s.main.get('/api/v1/projects', studio.pair)).json;
    expect(projects.projects[0].id).toBe('willow');

    // Set up the project key on the key page, then check what each site gets.
    expect((await createProjectKey(s, keysSession, 'willow', 'fp-willow')).status).toBe(201);
    const onKeys = (await s.keys.get('/api/v1/projects/willow', keysSession)).json;
    expect(onKeys.sealed_key).toEqual({ enc: 'ZQ', ciphertext: 'Yw' });
    const onMain = (await s.main.get('/api/v1/projects/willow', studio.pair)).json;
    expect(onMain.sealed_key).toBeNull();
    expect(onMain.key.fingerprint).toBe('fp-willow');
    expect(onMain.has_access).toBe(true);

    // The studio cookie is not a key page cookie.
    expect((await s.keys.get('/api/v1/me', studio.pair)).status).toBe(401);
  });
});

describe('projects', () => {
  it('are listed for their members, with names and key fingerprints', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    await s.cliOk('project', 'add-researcher', 'oak', ADA);
    const before = await s.keys.get('/api/v1/projects', ada.session);
    expect(before.status).toBe(200);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(before.json).toEqual({
      projects: [
        { id: 'oak', name: 'oak', has_access: false, fingerprint: null },
        { id: 'willow', name: { en: 'Willow study' }, has_access: false, fingerprint: null },
      ],
    });
    await createProjectKey(s, ada.session, 'willow', 'fp-w');
    const after = (await s.keys.get('/api/v1/projects', ada.session)).json.projects;
    expect(after[1]).toEqual({ id: 'willow', name: { en: 'Willow study' }, has_access: true, fingerprint: 'fp-w' });
  });

  it('show their key, members and the sealed copy on the key page', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow', keyByte: 11 });
    const r = await s.keys.get('/api/v1/projects/willow', ada.session);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json).toMatchObject({
      id: 'willow',
      name: { en: 'Willow study' },
      key: null,
      has_access: false,
      sealed_key: null,
    });
    expect(r.json.members).toHaveLength(1);
    expect(r.json.members[0]).toMatchObject({
      researcher_id: ada.id,
      email: ADA,
      public_key: b64(fill(11, PUBLIC_KEY_BYTES)),
      has_access: false,
    });
    expect(typeof r.json.members[0].added).toBe('number');

    await createProjectKey(s, ada.session, 'willow', 'fp-w');
    const after = (await s.keys.get('/api/v1/projects/willow', ada.session)).json;
    expect(after.key).toMatchObject({ public_key: b64(fill(5, PUBLIC_KEY_BYTES)), fingerprint: 'fp-w' });
    expect(typeof after.key.created).toBe('number');
    expect(after.has_access).toBe(true);
    expect(after.sealed_key).toEqual({ enc: 'ZQ', ciphertext: 'Yw' });
  });

  it('are hidden from non-members, and invalid ids are unknown projects', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    for (const id of ['oak', 'missing', 'Willow', 'a.b']) {
      const r = await s.keys.get(`/api/v1/projects/${id}`, ada.session);
      expect(r.status, id).toBe(404);
      expect(r.json).toEqual({ error: 'no_such_project' });
    }
  });

  it('need a full session', async () => {
    const s = await startServer();
    await s.cliOk('project', 'add-researcher', 'willow', ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    expect((await s.keys.get('/api/v1/projects/willow', emailSession)).status).toBe(401);
    expect((await s.keys.get('/api/v1/projects/willow')).status).toBe(401);
  });

  it('put the public key in the participant config once it exists', async () => {
    const s = await startServer({ env: { COMBRAY_KEY_BACKUP_RETENTION_DAYS: '7' } });
    const before = (await s.main.get('/api/v1/p/willow/config')).json;
    expect(before.donation_key).toBeUndefined();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    await createProjectKey(s, ada.session, 'willow', 'fp-w');
    const config = (await s.main.get('/api/v1/p/willow/config')).json;
    expect(config.donation_key).toEqual({
      public_key: b64(fill(5, PUBLIC_KEY_BYTES)),
      fingerprint: 'fp-w',
      withdrawal_complete_days: 7,
    });
  });
});

describe('project keys', () => {
  it('are created once, by a member, on the key page', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    const bob = await setUpResearcher(s, BOB, { project: 'willow' });
    const eve = await setUpResearcher(s, EVE);

    const stranger = await createProjectKey(s, eve.session, 'willow');
    expect(stranger.status).toBe(404);
    expect(stranger.json).toEqual({ error: 'no_such_project' });

    for (const body of [
      { public_key: b64(fill(5, PUBLIC_KEY_BYTES - 1)), fingerprint: 'fp', sealed_key: { enc: 'ZQ', ciphertext: 'Yw' } },
      { public_key: b64(fill(5, PUBLIC_KEY_BYTES)), fingerprint: 'f'.repeat(65), sealed_key: { enc: 'ZQ', ciphertext: 'Yw' } },
      { public_key: b64(fill(5, PUBLIC_KEY_BYTES)), fingerprint: 'fp', sealed_key: { enc: b64(fill(1, 4097)), ciphertext: 'Yw' } },
      { public_key: 'not base64!', fingerprint: 'fp', sealed_key: { enc: 'ZQ', ciphertext: 'Yw' } },
    ]) {
      const r = await s.keys.post('/api/v1/projects/willow/key', body, ada.session);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: 'invalid' });
    }

    const created = await createProjectKey(s, ada.session, 'willow');
    expect(created.status).toBe(201);
    const twice = await createProjectKey(s, bob.session, 'willow');
    expect(twice.status).toBe(409);
    expect(twice.json).toEqual({ error: 'conflict' });

    expect((await memberEntry(s.keys, ada.session, 'willow', ADA)).has_access).toBe(true);
    expect((await memberEntry(s.keys, ada.session, 'willow', BOB)).has_access).toBe(false);
  });
});

describe('members', () => {
  it('grant access, and only members with access fetch keys', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    await createProjectKey(s, ada.session, 'willow');

    // Ada adds Bob, who gets an account and an email, but no access yet.
    const added = await s.keys.post('/api/v1/projects/willow/members', { email: BOB }, ada.session);
    expect(added.status).toBe(201);
    const invite = await s.takeMail(BOB, 'added you to the project');
    expect(invite).toContain(`${ADA} added you to the project "willow"`);
    expect(invite).toContain(s.keys.origin);

    // Bob sets up his passkey and key, and signs in with his recovery code.
    const bob = await setUpResearcher(s, BOB, { keyByte: 7 });
    const bobSession = await recoverySignIn(s, BOB, bob.secret);
    const keys = await s.keys.post('/api/v1/projects/willow/donation-keys', { ids: [] }, bobSession);
    expect(keys.status, 'a member without access cannot fetch keys').toBe(403);
    expect(keys.json).toEqual({ error: 'no_key_access' });
    const entry = await memberEntry(s.keys, ada.session, 'willow', BOB);
    expect(entry.has_access).toBe(false);
    expect(entry.researcher_id).toBe(bob.id);
    expect(entry.public_key, "Ada's browser seals the key to this").toBe(b64(fill(7, PUBLIC_KEY_BYTES)));

    const grant = `/api/v1/projects/willow/members/${bob.id}/key`;
    const self = await s.keys.put(grant, { enc: 'ZQ', ciphertext: 'Yw' }, bobSession);
    expect(self.status, 'only members with access can grant').toBe(403);
    expect(self.json).toEqual({ error: 'forbidden' });
    expect((await s.keys.put(grant, { enc: 'Ym9i', ciphertext: 'Ym9i' }, ada.session)).status).toBe(204);
    const twice = await s.keys.put(grant, { enc: 'eHg', ciphertext: 'eHg' }, ada.session);
    expect(twice.status, 'a grant is not overwritten').toBe(409);
    const project = (await s.keys.get('/api/v1/projects/willow', bobSession)).json;
    expect(project.sealed_key).toEqual({ enc: 'Ym9i', ciphertext: 'Ym9i' });
    expect(project.has_access).toBe(true);
    expect((await s.keys.post('/api/v1/projects/willow/donation-keys', { ids: [] }, bobSession)).status).toBe(200);

    // Strangers see nothing.
    const eve = await setUpResearcher(s, EVE);
    expect((await s.keys.get('/api/v1/projects/willow', eve.session)).status).toBe(404);
    expect((await s.keys.put(grant, { enc: 'ZQ', ciphertext: 'Yw' }, eve.session)).status).toBe(404);
  });

  it('can only be granted access once they have a personal key', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    await createProjectKey(s, ada.session, 'willow');
    await s.keys.post('/api/v1/projects/willow/members', { email: BOB }, ada.session);
    const bob = await memberEntry(s.keys, ada.session, 'willow', BOB);
    expect(bob.public_key).toBeNull();
    const r = await s.keys.put(`/api/v1/projects/willow/members/${bob.researcher_id}/key`, { enc: 'ZQ', ciphertext: 'Yw' }, ada.session);
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'conflict' });
  });

  it('are added by email, once', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    const invalid = await s.keys.post('/api/v1/projects/willow/members', { email: 'not an email' }, ada.session);
    expect(invalid.status).toBe(400);
    expect(invalid.json).toEqual({ error: 'invalid_email' });
    expect((await s.keys.post('/api/v1/projects/willow/members', { email: 'Bob@Uni.example' }, ada.session)).status).toBe(201);
    const again = await s.keys.post('/api/v1/projects/willow/members', { email: BOB }, ada.session);
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: 'conflict' });
    expect((await s.keys.post('/api/v1/projects/willow/members', { email: ADA }, ada.session)).status).toBe(409);
    // Only members add members.
    const eve = await setUpResearcher(s, EVE);
    expect((await s.keys.post('/api/v1/projects/willow/members', { email: 'carl@uni.example' }, eve.session)).status).toBe(404);
  });

  it('are removed, but never the last one with access', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    const bob = await setUpResearcher(s, BOB, { project: 'willow' });
    await createProjectKey(s, ada.session, 'willow');

    const last = await s.keys.delete(`/api/v1/projects/willow/members/${ada.id}`, ada.session);
    expect(last.status).toBe(409);
    expect(last.json).toEqual({ error: 'conflict' });
    expect((await s.keys.delete(`/api/v1/projects/willow/members/${bob.id}`, ada.session)).status).toBe(204);
    expect((await s.keys.get('/api/v1/projects/willow', bob.session)).status, 'Bob is no longer a member').toBe(404);
    const gone = await s.keys.delete(`/api/v1/projects/willow/members/${bob.id}`, ada.session);
    expect(gone.status).toBe(404);
    expect(gone.json).toEqual({ error: 'not_found' });
  });
});

describe("a researcher's personal key", () => {
  it('is set once, with a recovery verifier of 32 bytes', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { keyByte: 1 });
    const again = await s.keys.post(
      '/api/v1/me/key',
      { public_key: b64(fill(2, PUBLIC_KEY_BYTES)), recovery_verifier: b64(sha256(ada.secret)) },
      ada.session,
    );
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: 'conflict' });
    expect((await s.keys.get('/api/v1/me', ada.session)).json.public_key).toBe(b64(fill(1, PUBLIC_KEY_BYTES)));
  });

  it('must be an X-Wing public key with a SHA-256 verifier', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    // Not before the passkey: the email code alone is not enough.
    const early = await s.keys.post(
      '/api/v1/me/key',
      { public_key: b64(fill(1, PUBLIC_KEY_BYTES)), recovery_verifier: b64(fill(1, 32)) },
      emailSession,
    );
    expect(early.status).toBe(401);
    const { session } = await registerPasskey(s, emailSession, authenticatorFor(s));
    for (const [publicKey, verifier] of [
      [PUBLIC_KEY_BYTES - 1, 32],
      [PUBLIC_KEY_BYTES + 1, 32],
      [PUBLIC_KEY_BYTES, 31],
      [PUBLIC_KEY_BYTES, 33],
    ] as const) {
      const r = await s.keys.post(
        '/api/v1/me/key',
        { public_key: b64(fill(1, publicKey)), recovery_verifier: b64(fill(1, verifier)) },
        session,
      );
      expect(r.status, `${publicKey} ${verifier}`).toBe(400);
      expect(r.json).toEqual({ error: 'invalid' });
    }
    expect((await s.keys.get('/api/v1/me', session)).json.public_key).toBeNull();
  });

  it('is forgotten when the operator resets it, with passkeys, sessions and access', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    const bob = await setUpResearcher(s, BOB, { project: 'willow' });
    await createProjectKey(s, bob.session, 'willow');
    await s.keys.put(`/api/v1/projects/willow/members/${ada.id}/key`, { enc: 'ZQ', ciphertext: 'Yw' }, bob.session);
    expect((await memberEntry(s.keys, bob.session, 'willow', ADA)).has_access).toBe(true);

    await s.cliOk('researcher', 'reset-key', ADA);
    expect((await s.keys.get('/api/v1/me', ada.session)).status).toBe(401);
    const entry = await memberEntry(s.keys, bob.session, 'willow', ADA);
    expect(entry.has_access).toBe(false);
    expect(entry.public_key).toBeNull();

    const emailSession = await emailSignIn(s, s.keys, ADA);
    const me = (await s.keys.get('/api/v1/me', emailSession)).json;
    expect(me.public_key).toBeNull();
    expect(me.passkeys).toEqual([]);
    // The old recovery code no longer works.
    expect((await s.keys.post('/api/v1/auth/recovery', { secret: b64(ada.secret) }, emailSession)).status).toBe(401);
  });
});

describe('researchers resetting their own key', () => {
  it('may do so unless they alone have access to a project', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    await createProjectKey(s, ada.session, 'willow');
    const full = ada.session;

    // Lost passkey and recovery code: only the email code.
    const emailSession = await emailSignIn(s, s.keys, ADA);
    const refused = await s.keys.post('/api/v1/me/reset-key', {}, emailSession);
    expect(refused.status, 'Ada alone can open willow').toBe(409);
    expect(refused.json).toEqual({ error: 'sole_access', projects: [{ id: 'willow', name: { en: 'Willow study' } }] });
    expect(refused.headers['cache-control']).toBe('no-store');
    expect((await memberEntry(s.keys, full, 'willow', ADA)).has_access).toBe(true);

    // With Bob on the project, Ada can reset; Bob can give her access again.
    const bob = await setUpResearcher(s, BOB, { project: 'willow' });
    expect((await s.keys.put(`/api/v1/projects/willow/members/${bob.id}/key`, { enc: 'ZQ', ciphertext: 'Yw' }, full)).status).toBe(204);
    const reset = await s.keys.post('/api/v1/me/reset-key', {}, emailSession);
    expect(reset.status).toBe(204);
    const after = cookie(reset, SESSION_COOKIE);
    expect(after.header).toContain('Max-Age=900');
    expect((await memberEntry(s.keys, bob.session, 'willow', ADA)).has_access).toBe(false);
    expect((await memberEntry(s.keys, bob.session, 'willow', BOB)).has_access).toBe(true);

    // Her old sessions are gone; the new one is at the email level, without a key.
    for (const session of [full, emailSession]) {
      expect((await s.keys.get('/api/v1/me', session)).status).toBe(401);
    }
    const me = await s.keys.get('/api/v1/me', after.pair);
    expect(me.status).toBe(200);
    expect(me.json.signed_in).toBe(false);
    expect(me.json.public_key).toBeNull();
    expect(me.json.passkeys).toEqual([]);

    // And she is told by mail.
    const mail = await s.takeMail(ADA, 'was reset');
    expect(mail).toContain('Subject: Your Combray key was reset');
  });

  it('can set up a new passkey and key afterwards', async () => {
    const s = await startServer();
    await setUpResearcher(s, ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    const reset = await s.keys.post('/api/v1/me/reset-key', {}, emailSession);
    expect(reset.status).toBe(204);
    const session = cookie(reset, SESSION_COOKIE).pair;
    const { finish, session: full } = await registerPasskey(s, session, authenticatorFor(s));
    expect(finish.status).toBe(200);
    const key = await s.keys.post(
      '/api/v1/me/key',
      { public_key: b64(fill(3, PUBLIC_KEY_BYTES)), recovery_verifier: b64(fill(3, 32)) },
      full,
    );
    expect(key.status).toBe(204);
  });
});
