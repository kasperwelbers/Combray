/**
 * The web client, project configs and the store key service (participants' store keys).
 * Ported from crates/combray-server/tests/api.rs, plus behaviour from src/keys.rs and
 * src/projects.rs. These servers run without researcher settings, as in api.rs, unless a test
 * needs the reset link (which prints the public URL).
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CSP, MAIN_PERMISSIONS, type TestServer, fill, startServer } from './harness';

const PASSWORD = 'madeleine in tea';

/** POST from a participant's browser behind a proxy that appends their IP. */
function post(s: TestServer, path: string, ip: string, body: unknown) {
  return s.request({ method: 'POST', host: s.mainHost, path, body, headers: { 'x-forwarded-for': `10.0.0.1, ${ip}` } });
}

function get(s: TestServer, path: string) {
  return s.request({ host: s.mainHost, path });
}

async function create(s: TestServer, password = PASSWORD, ip = '192.0.2.1') {
  const r = await post(s, '/api/v1/stores', ip, { project: 'willow', password });
  expect(r.status, r.text).toBe(201);
  expect(r.headers['cache-control']).toBe('no-store');
  return { id: r.json.store_id as string, kek: r.json.kek as string, deleteToken: r.json.delete_token as string };
}

function unlock(s: TestServer, id: string, password: string) {
  return post(s, `/api/v1/stores/${id}/unlock`, '192.0.2.2', { password });
}

function createIn(s: TestServer, project: string, participant?: string | null) {
  return post(s, '/api/v1/stores', '192.0.2.5', { project, participant_id: participant ?? null, password: PASSWORD });
}

function reset(s: TestServer, id: string, token: string, password: string) {
  return post(s, `/api/v1/stores/${id}/reset`, '192.0.2.6', { token, password });
}

/** A one-time reset token from the operator's `reset-link` command. */
async function resetToken(s: TestServer, project: string, participant: string): Promise<string> {
  const r = await s.cli('reset-link', project, participant);
  expect(r.code, r.stderr).toBe(0);
  const link = r.stdout.trim();
  expect(link.startsWith(`${s.main.origin}/p/${project}/#reset=`), link).toBe(true);
  expect(r.stderr).toContain('72 hours');
  return link.split('#reset=')[1]!;
}

describe('the web client and project configs', () => {
  it('answers the health check', async () => {
    const s = await startServer({ research: false });
    const r = await get(s, '/api/v1/health');
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('ok');
    expect(typeof r.json.version).toBe('string');
  });

  it('serves project configs', async () => {
    const s = await startServer({ research: false });
    const willow = await get(s, '/api/v1/p/willow/config');
    expect(willow.status).toBe(200);
    expect(willow.text).toContain('Willow study');

    const missing = await get(s, '/api/v1/p/missing/config');
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: 'no_such_project' });

    const broken = await get(s, '/api/v1/p/broken/config');
    expect(broken.status).toBe(500);
    expect(broken.json).toEqual({ error: 'invalid_config' });
  });

  it('rejects path traversal and invalid characters in project ids', async () => {
    const s = await startServer({ research: false });
    for (const path of [
      '/api/v1/p/..%2F..%2Fweb%2Findex/config',
      '/api/v1/p/Willow/config',
      '/api/v1/p/a.b/config',
      `/api/v1/p/${'a'.repeat(65)}/config`,
    ]) {
      expect((await get(s, path)).status, path).toBe(404);
    }
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const s = await startServer({ research: false });
    const r = await get(s, '/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: 'not_found' });
  });

  it('serves the web client, with index.html for client-side routes', async () => {
    const s = await startServer({ research: false });
    const asset = await get(s, '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.text).toBe('console.log(1)');
    expect(asset.headers['content-security-policy']).toBe(CSP);

    const route = await get(s, '/p/willow');
    expect(route.status).toBe(200);
    expect(route.text).toContain('<title>Combray</title>');
  });

  it('sets security headers on API responses', async () => {
    const s = await startServer({ research: false });
    const r = await get(s, '/api/v1/health');
    expect(r.headers['content-security-policy']).toBe(CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['permissions-policy']).toBe(MAIN_PERMISSIONS);
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('treats configs with an invalid participant policy as broken', async () => {
    const s = await startServer({ research: false });
    const projects = join(s.paths.data, 'projects');
    writeFileSync(join(projects, 'ash.json'), JSON.stringify({ id: 'ash', participants: { mode: 'sometimes' } }));
    writeFileSync(join(projects, 'fir.json'), JSON.stringify({ id: 'fir', participants: { pattern: '(' } }));
    for (const project of ['ash', 'fir']) {
      const config = await get(s, `/api/v1/p/${project}/config`);
      expect(config.status, project).toBe(500);
      expect(config.json).toEqual({ error: 'invalid_config' });
      expect((await createIn(s, project, 'P1234')).status, project).toBe(500);
    }
  });

  it('serves the config without the participant pattern', async () => {
    const s = await startServer({ research: false });
    const r = await get(s, '/api/v1/p/oak/config');
    expect(r.status).toBe(200);
    expect(r.text).toContain('required');
    expect(r.text).not.toContain('P[0-9]');
    expect(r.json.participants).toEqual({ mode: 'required' });
  });
});

describe('store keys', () => {
  it('creates stores and releases the KEK only for the right password', async () => {
    const s = await startServer({ research: false });
    const { id, kek, deleteToken } = await create(s);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(kek).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(deleteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const right = await unlock(s, id, PASSWORD);
    expect(right.status).toBe(200);
    expect(right.json).toEqual({ kek });
    expect(right.headers['cache-control']).toBe('no-store');

    const wrong = await unlock(s, id, 'wrong password');
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual({ error: 'wrong_password' });
    expect(wrong.headers['retry-after']).toBeUndefined();

    // A second store gets a different KEK.
    const other = await create(s);
    expect(other.id).not.toBe(id);
    expect(other.kek).not.toBe(kek);
  });

  it('keeps KEKs across a restart, but not with a new store master key', async () => {
    const s = await startServer({ research: false });
    const { id, kek } = await create(s);

    // The master key file was created: 32 bytes, readable by the server's user only.
    const stat = statSync(s.paths.masterKey);
    expect(stat.size).toBe(32);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);

    await s.restart();
    expect((await unlock(s, id, PASSWORD)).json.kek).toBe(kek);

    await s.stop();
    writeFileSync(s.paths.masterKey, fill(7, 32));
    await s.start();
    const rekeyed = await unlock(s, id, PASSWORD);
    expect(rekeyed.status).toBe(200);
    expect(rekeyed.json.kek).not.toBe(kek);
  });

  it('refuses to start with a store master key file of the wrong size', async () => {
    const s = await startServer({ research: false });
    await s.stop();
    writeFileSync(s.paths.masterKey, fill(7, 31));
    await expect(s.start()).rejects.toThrow(/exited/);
  });

  it('rejects short and overlong passwords and unknown stores', async () => {
    const s = await startServer({ research: false });
    for (const password of ['short', 'é'.repeat(7), 'x'.repeat(1025)]) {
      const r = await post(s, '/api/v1/stores', '192.0.2.1', { project: 'willow', password });
      expect(r.status, password).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_password' });
    }
    // Eight characters is enough, however many bytes.
    await create(s, 'é'.repeat(8));

    const unknown = await unlock(s, 'AAAAAAAAAAAAAAAAAAAAAA', PASSWORD);
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: 'no_such_store' });
    expect((await unlock(s, '..', PASSWORD)).status).toBe(404);

    const { id } = await create(s);
    const overlong = await unlock(s, id, 'x'.repeat(1025));
    expect(overlong.status).toBe(400);
    expect(overlong.json).toEqual({ error: 'invalid_password' });
  });

  it('locks a store out after repeated wrong passwords', async () => {
    const s = await startServer({ research: false });
    const { id } = await create(s);
    for (let i = 0; i < 4; i++) {
      const r = await unlock(s, id, 'a wrong guess');
      expect(r.status).toBe(401);
      expect(r.headers['retry-after']).toBeUndefined();
    }
    const fifth = await unlock(s, id, 'a wrong guess');
    expect(fifth.status).toBe(401);
    expect(fifth.headers['retry-after']).toBe('30');
    // Even the right password waits until the lockout ends.
    const right = await unlock(s, id, PASSWORD);
    expect(right.status).toBe(429);
    expect(right.json).toEqual({ error: 'too_many_attempts' });
    expect(Number(right.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rate limits new stores per client IP (60 per 10 minutes)', async () => {
    const s = await startServer({ research: false });
    // In parallel: each one hashes a password at the production cost.
    await Promise.all(Array.from({ length: 60 }, () => create(s)));
    const limited = await post(s, '/api/v1/stores', '192.0.2.1', { project: 'willow', password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: 'too_many_attempts' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Another IP is not affected. The proxy's own address (the first entry) is the same: the
    // last entry of the header is the client.
    const other = await post(s, '/api/v1/stores', '192.0.2.9', { project: 'willow', password: PASSWORD });
    expect(other.status).toBe(201);
  });

  it('rate limits unlock attempts per client IP (120 per 10 minutes)', async () => {
    const s = await startServer({ research: false });
    const unknown = 'AAAAAAAAAAAAAAAAAAAAAA';
    for (let i = 0; i < 120; i++) {
      expect((await unlock(s, unknown, PASSWORD)).status).toBe(404);
    }
    const limited = await unlock(s, unknown, PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: 'too_many_attempts' });
    const other = await post(s, `/api/v1/stores/${unknown}/unlock`, '192.0.2.99', { password: PASSWORD });
    expect(other.status).toBe(404);
  });

  it('crypto-shreds a store when it is deleted with its delete token', async () => {
    const s = await startServer({ research: false });
    const { id, deleteToken } = await create(s);
    const path = `/api/v1/stores/${id}/delete`;
    for (const wrong of ['', 'not base64!', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']) {
      const r = await post(s, path, '192.0.2.3', { delete_token: wrong });
      expect(r.status, wrong).toBe(401);
    }
    const deleted = await post(s, path, '192.0.2.3', { delete_token: deleteToken });
    expect(deleted.status).toBe(204);
    expect((await unlock(s, id, PASSWORD)).status).toBe(404);
    expect((await post(s, path, '192.0.2.3', { delete_token: deleteToken })).status).toBe(404);
  });

  it('keeps no keys or passwords in the database', async () => {
    const s = await startServer({ research: false });
    const { kek } = await create(s);
    const files = [s.paths.db, `${s.paths.db}-wal`];
    for (const file of files) {
      let text = '';
      try {
        text = readFileSync(file).toString('latin1');
      } catch {
        continue;
      }
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(kek);
    }
  });

  it('creates stores only for projects that exist', async () => {
    const s = await startServer({ research: false });
    for (const project of ['missing', 'api', '../oak', 'Oak']) {
      const r = await createIn(s, project);
      expect(r.status, project).toBe(404);
      expect(r.json).toEqual({ error: 'no_such_project' });
    }
    const broken = await createIn(s, 'broken');
    expect(broken.status).toBe(500);
  });

  it("enforces the project's participant policy", async () => {
    const s = await startServer({ research: false });
    const missing = await createIn(s, 'oak');
    expect(missing.status).toBe(400);
    expect(missing.json).toEqual({ error: 'participant_required' });
    for (const bad of ['Q1234', 'P123', 'P1234 ', 'P1234\nP', 'xP1234', 'P12345']) {
      const r = await createIn(s, 'oak', bad);
      expect(r.status, bad).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_participant' });
    }
    expect((await createIn(s, 'oak', 'P1234')).status).toBe(201);
    // Anonymous projects ignore ids; optional ones accept any well-formed id.
    expect((await createIn(s, 'elm', 'P1234')).status).toBe(201);
    expect((await createIn(s, 'willow', 'anything-1')).status).toBe(201);
    expect((await createIn(s, 'willow')).status).toBe(201);
    for (const bad of ['a b', 'a/b', 'x'.repeat(65)]) {
      const r = await createIn(s, 'willow', bad);
      expect(r.status, bad).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_participant' });
    }
  });
});

describe('password reset links', () => {
  it('set a new password and keep the KEK', async () => {
    const s = await startServer();
    const mine = await createIn(s, 'oak', 'P1234');
    const id = mine.json.store_id as string;
    const kek = mine.json.kek as string;
    const other = (await createIn(s, 'oak', 'P9999')).json.store_id as string;
    // Lock the store out first: a reset also lifts the lockout.
    for (let i = 0; i < 6; i++) await unlock(s, id, 'forgotten it');
    expect((await unlock(s, id, 'forgotten it')).status).toBe(429);

    const token = await resetToken(s, 'oak', 'P1234');

    // Not for another participant's store, and not with a made-up token.
    const wrongStore = await reset(s, other, token, 'a new password');
    expect(wrongStore.status).toBe(403);
    expect(wrongStore.json).toEqual({ error: 'invalid_reset_token' });
    const otherProject = await resetToken(s, 'willow', 'P1234');
    expect((await reset(s, id, otherProject, 'a new password')).status).toBe(403);
    expect((await reset(s, id, 'nonsense', 'a new password')).status).toBe(403);
    const short = await reset(s, id, token, 'short');
    expect(short.status).toBe(400);
    expect(short.json).toEqual({ error: 'invalid_password' });

    const done = await reset(s, id, token, 'a new password');
    expect(done.status, done.text).toBe(200);
    expect(done.json).toEqual({ kek });
    expect(done.headers['cache-control']).toBe('no-store');
    expect((await unlock(s, id, 'a new password')).json.kek).toBe(kek);
    expect((await unlock(s, id, PASSWORD)).status).toBe(401);
    // Used up.
    expect((await reset(s, id, token, 'another one!')).status).toBe(403);
  });

  it('do not work for anonymous stores', async () => {
    const s = await startServer();
    const id = (await createIn(s, 'elm')).json.store_id as string;
    const token = await resetToken(s, 'elm', 'P1234');
    const r = await reset(s, id, token, 'a new password');
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'invalid_reset_token' });
  });

  it('do not work for unknown stores', async () => {
    const s = await startServer();
    const token = await resetToken(s, 'oak', 'P1234');
    const r = await reset(s, 'AAAAAAAAAAAAAAAAAAAAAA', token, 'a new password');
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: 'no_such_store' });
  });

  it('are only made for valid project and participant ids', async () => {
    const s = await startServer();
    for (const [project, participant] of [
      ['Oak', 'P1234'],
      ['../oak', 'P1234'],
      ['oak', 'P 1234'],
      ['oak', 'x'.repeat(65)],
    ] as const) {
      const r = await s.cli('reset-link', project, participant);
      expect(r.code, `${project} ${participant}`).toBe(2);
      expect(r.stdout).toBe('');
    }
  });
});
