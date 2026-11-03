/**
 * Donations: participants send sealed envelopes, researchers list them, fetch envelopes and
 * sealed keys on the key page, and withdrawals delete the key and leave a tombstone. Ported from
 * the Rust server's tests/ (removed in ADR 0010): research.rs and the unit tests of the Rust src/donations.rs (withdrawal
 * survives restoring a backup of the donation key database; withdrawn ids are not reused).
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type TestServer, b64, cookie, fill, startServer } from './harness';
import {
  type Researcher,
  SESSION_COOKIE,
  createProjectKey,
  donate,
  donationBody,
  emailSignIn,
  envelope,
  recoverySignIn,
  setUpResearcher,
  withdraw,
} from './research';

const ADA = 'ada@uni.example';
const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const SEALED = { enc: b64(fill(1, 1120)), ciphertext: b64(fill(2, 48)) };

/** A server with Ada as the member of willow who created its key (fingerprint `fp`). */
async function withProjectKey(): Promise<{ s: TestServer; ada: Researcher }> {
  const s = await startServer();
  const ada = await setUpResearcher(s, ADA, { project: 'willow' });
  expect((await createProjectKey(s, ada.session, 'willow', 'fp')).status).toBe(201);
  return { s, ada };
}

function sealedKeys(s: TestServer, session: string, ids: string[]) {
  return s.keys.post('/api/v1/projects/willow/donation-keys', { ids }, session);
}

const envelopePath = (s: TestServer, project: string, id: string) => join(s.paths.data, 'donations', project, id);

describe('donations', () => {
  it('are stored, fetched on use and withdrawn', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    const session = await recoverySignIn(s, ADA, ada.secret);

    // No project key yet: nothing can be donated.
    const early = await donate(s, donationBody(SEALED, envelope('willow', ID, 'fp')));
    expect(early.status).toBe(409);
    expect(early.json).toEqual({ error: 'no_project_key' });

    await createProjectKey(s, session, 'willow', 'fp');
    const config = (await s.main.get('/api/v1/p/willow/config')).json;
    expect(config.donation_key.fingerprint).toBe('fp');
    expect(config.donation_key.withdrawal_complete_days).toBe(30);

    // Envelopes for another project or key are refused.
    for (const env of [envelope('oak', ID, 'fp'), envelope('willow', ID, 'other-key')]) {
      const r = await donate(s, donationBody(SEALED, env));
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_donation' });
    }

    const env = envelope('willow', ID, 'fp');
    const receipt = await donate(s, donationBody(SEALED, env));
    expect(receipt.status, receipt.text).toBe(201);
    expect(receipt.headers['cache-control']).toBe('no-store');
    expect(receipt.json.donation).toBe(ID);
    const token = receipt.json.withdrawal_token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const twice = await donate(s, donationBody(SEALED, env));
    expect(twice.status, 'ids are not reused').toBe(409);
    expect(twice.json).toEqual({ error: 'conflict' });

    // The envelope is a file on disk; the index lists it, dated to the day.
    expect(readFileSync(envelopePath(s, 'willow', ID))).toEqual(env);
    const list = await s.keys.get('/api/v1/projects/willow/donations', session);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json.donations).toHaveLength(1);
    expect(list.json.donations[0]).toEqual({ id: ID, day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), bytes: env.length });
    expect(list.json.withdrawn).toEqual([]);

    const fetched = await s.request({
      host: s.keysHost,
      path: `/api/v1/projects/willow/donations/${ID}`,
      headers: { cookie: session, 'sec-fetch-site': 'same-origin' },
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(env);
    expect(fetched.headers['content-type']).toBe('application/octet-stream');
    expect(fetched.headers['cache-control']).toBe('no-store');

    const keys = await sealedKeys(s, session, [ID]);
    expect(keys.status).toBe(200);
    expect(keys.headers['cache-control']).toBe('no-store');
    expect(keys.json).toEqual({ keys: [{ id: ID, key: 'fp', enc: SEALED.enc, ciphertext: SEALED.ciphertext }] });

    // The participant withdraws: the key and envelope are gone, a tombstone remains.
    const wrong = await withdraw(s, ID, b64(fill(0, 32)));
    expect(wrong.status).toBe(403);
    expect(wrong.json).toEqual({ error: 'wrong_token' });
    expect((await withdraw(s, ID, token)).status).toBe(204);
    expect((await sealedKeys(s, session, [ID])).json).toEqual({ keys: [] });
    const after = (await s.keys.get('/api/v1/projects/willow/donations', session)).json;
    expect(after.donations).toEqual([]);
    expect(after.withdrawn).toEqual([{ id: ID, day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    expect(existsSync(envelopePath(s, 'willow', ID))).toBe(false);
    const gone = await s.keys.get(`/api/v1/projects/willow/donations/${ID}`, session);
    expect(gone.status).toBe(404);
    expect(gone.json).toEqual({ error: 'no_such_donation' });
    expect((await withdraw(s, ID, token)).status, 'a withdrawal works once').toBe(404);
    // A withdrawn id cannot be used again.
    expect((await donate(s, donationBody(SEALED, env))).status).toBe(409);
  });

  it('are withdrawn by researchers on a participant\'s behalf', async () => {
    const { s, ada } = await withProjectKey();
    const id = 'BBBBBBBBBBBBBBBBBBBBBB';
    expect((await donate(s, donationBody({ enc: 'ZQ', ciphertext: 'Yw' }, envelope('willow', id, 'fp')))).status).toBe(201);
    const unknown = await s.keys.delete(`/api/v1/projects/willow/donations/${ID}`, ada.session);
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: 'no_such_donation' });
    expect((await s.keys.delete(`/api/v1/projects/willow/donations/${id}`, ada.session)).status).toBe(204);
    const list = (await s.keys.get('/api/v1/projects/willow/donations', ada.session)).json;
    expect(list.withdrawn[0].id).toBe(id);
    expect(existsSync(envelopePath(s, 'willow', id))).toBe(false);
    expect((await s.keys.delete(`/api/v1/projects/willow/donations/${id}`, ada.session)).status).toBe(404);
  });

  it('stay withdrawn when an old backup of the donation key database is restored', async () => {
    const { s, ada } = await withProjectKey();
    const env = envelope('willow', ID, 'fp');
    const receipt = await donate(s, donationBody(SEALED, env));
    expect(receipt.status).toBe(201);

    // Back up the key database while the server is stopped.
    await s.stop();
    const db = s.paths.donationKeysDb;
    const backup = join(s.dir, 'backup');
    copyFileSync(db, `${backup}.sqlite`);
    const hadWal = existsSync(`${db}-wal`);
    if (hadWal) copyFileSync(`${db}-wal`, `${backup}.sqlite-wal`);
    // The backup holds the sealed key (its 1120 bytes of 0x01).
    const backedUp = Buffer.concat([readFileSync(`${backup}.sqlite`), hadWal ? readFileSync(`${backup}.sqlite-wal`) : Buffer.alloc(0)]);
    expect(backedUp.includes(fill(1, 1120))).toBe(true);
    await s.start();
    const session = await recoverySignIn(s, ADA, ada.secret);
    expect((await sealedKeys(s, session, [ID])).json.keys).toHaveLength(1);

    expect((await withdraw(s, ID, receipt.json.withdrawal_token)).status).toBe(204);
    expect((await sealedKeys(s, session, [ID])).json.keys).toEqual([]);

    // Restore the old key database; the server deletes the withdrawn key again on start.
    await s.stop();
    copyFileSync(`${backup}.sqlite`, db);
    rmSync(`${db}-wal`, { force: true });
    rmSync(`${db}-shm`, { force: true });
    if (hadWal) copyFileSync(`${backup}.sqlite-wal`, `${db}-wal`);
    await s.start();
    const again = await recoverySignIn(s, ADA, ada.secret);
    expect((await sealedKeys(s, again, [ID])).json.keys).toEqual([]);
    expect((await donate(s, donationBody(SEALED, env))).status, 'nor can the id be used again').toBe(409);
  });

  it('must be well-formed', async () => {
    const { s } = await withProjectKey();
    const env = envelope('willow', ID, 'fp');
    const lengthPrefix = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    };
    const cases: [string, Buffer][] = [
      ['an empty body', Buffer.alloc(0)],
      ['a short body', Buffer.from([0, 0])],
      ['a sealed key longer than the body', Buffer.concat([lengthPrefix(1000), Buffer.from('{}')])],
      ['a sealed key over 8 KiB', Buffer.concat([lengthPrefix(8 * 1024 + 1), Buffer.alloc(8 * 1024 + 1, 0x20), env])],
      ['a sealed key that is not JSON', Buffer.concat([lengthPrefix(3), Buffer.from('abc'), env])],
      ['no envelope', donationBody(SEALED, Buffer.alloc(0))],
      ['an envelope without the magic', donationBody(SEALED, Buffer.concat([Buffer.from('CMBRDON2'), env.subarray(8)]))],
      ['an envelope cut short', donationBody(SEALED, env.subarray(0, 20))],
      ['an invalid donation id', donationBody(SEALED, envelope('willow', 'not-an-id', 'fp'))],
      ['a sealed key over 2048 bytes', donationBody({ enc: b64(fill(1, 2049)), ciphertext: 'Yw' }, env)],
      ['a ciphertext over 256 bytes', donationBody({ enc: 'ZQ', ciphertext: b64(fill(1, 257)) }, env)],
      ['a sealed key field that is not base64url', donationBody({ enc: 'not base64!', ciphertext: 'Yw' }, env)],
    ];
    for (const [what, body] of cases) {
      const r = await donate(s, body);
      expect(r.status, what).toBe(400);
      // A sealed key field that is not base64url answers `invalid` rather than `invalid_donation`.
      if (what !== 'a sealed key field that is not base64url') expect(r.json, what).toEqual({ error: 'invalid_donation' });
    }
    const v2 = Buffer.from(env);
    const header = JSON.stringify({ v: 2, project: 'willow', donation: ID, key: 'fp', chunks: 1 });
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    const wrongVersion = Buffer.concat([Buffer.from('CMBRDON1'), length, Buffer.from(header), v2.subarray(v2.length - 8)]);
    expect((await donate(s, donationBody(SEALED, wrongVersion))).status, 'version 2').toBe(400);
    // Nothing was stored.
    expect(existsSync(envelopePath(s, 'willow', ID))).toBe(false);
  });

  it('are refused for unknown projects', async () => {
    const { s } = await withProjectKey();
    for (const project of ['missing', 'Willow']) {
      const r = await donate(s, donationBody(SEALED, envelope(project, ID, 'fp')), project);
      expect(r.status, project).toBe(404);
      expect(r.json).toEqual({ error: 'no_such_project' });
    }
  });

  it('are limited in size (COMBRAY_MAX_DONATION_MB, here 1)', async () => {
    const { s } = await withProjectKey();
    const header = envelope('willow', ID, 'fp');
    const big = Buffer.concat([header, Buffer.alloc(1024 * 1024 + 16 * 1024)]);
    const tooBig = await donate(s, donationBody(SEALED, big));
    expect(tooBig.status).toBe(413);
    const justRight = Buffer.concat([header, Buffer.alloc(1024 * 1024 - header.length)]);
    const ok = await donate(s, donationBody(SEALED, justRight));
    expect(ok.status, ok.text).toBe(201);
  });

  it('and withdrawals are rate limited per client IP (60 per 10 minutes)', async () => {
    const { s } = await withProjectKey();
    for (let i = 0; i < 30; i++) expect((await donate(s, Buffer.alloc(0), 'willow', '192.0.2.1')).status).toBe(400);
    const withdrawFrom = (ip: string) =>
      s.request({
        method: 'POST',
        host: s.mainHost,
        path: `/api/v1/donations/${ID}/withdraw`,
        body: { token: b64(fill(0, 32)) },
        headers: { origin: s.main.origin, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip },
      });
    for (let i = 0; i < 30; i++) expect((await withdrawFrom('192.0.2.1')).status).toBe(404);
    const limited = await donate(s, Buffer.alloc(0), 'willow', '192.0.2.1');
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: 'too_many_attempts' });
    expect((await withdrawFrom('192.0.2.1')).status).toBe(429);
    expect((await donate(s, Buffer.alloc(0), 'willow', '192.0.2.2')).status).toBe(400);
  });

  it('come from the participant app, not from other origins', async () => {
    const { s } = await withProjectKey();
    const r = await s.request({
      method: 'POST',
      host: s.mainHost,
      path: '/api/v1/p/willow/donations',
      body: donationBody(SEALED, envelope('willow', ID, 'fp')),
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: 'cross_origin' });
  });
});

describe('withdrawing with a token', () => {
  it('needs a known donation and its token', async () => {
    const { s } = await withProjectKey();
    const unknown = await withdraw(s, ID, b64(fill(0, 32)));
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: 'no_such_donation' });
    expect((await withdraw(s, 'not-an-id', b64(fill(0, 32)))).status).toBe(404);
    expect((await donate(s, donationBody(SEALED, envelope('willow', ID, 'fp')))).status).toBe(201);
    const malformed = await withdraw(s, ID, 'not base64!');
    expect(malformed.status).toBe(403);
    expect(malformed.json).toEqual({ error: 'wrong_token' });
  });
});

describe('researchers reading donations', () => {
  it('in the studio may list them, but not fetch envelopes or keys', async () => {
    const { s, ada } = await withProjectKey();
    expect((await donate(s, donationBody(SEALED, envelope('willow', ID, 'fp')))).status).toBe(201);
    const handoff = (await s.keys.post('/api/v1/auth/handoff', {}, ada.session)).json.code;
    const redeemed = await s.main.post('/api/v1/auth/handoff/redeem', { code: handoff });
    const studio = cookie(redeemed, SESSION_COOKIE).pair;
    const list = await s.main.get('/api/v1/projects/willow/donations', studio);
    expect(list.status).toBe(200);
    expect(list.json.donations[0].id).toBe(ID);
    expect((await s.main.get(`/api/v1/projects/willow/donations/${ID}`, studio)).status).toBe(404);
    expect((await s.main.post('/api/v1/projects/willow/donation-keys', { ids: [ID] }, studio)).status).toBe(404);
    expect((await s.main.delete(`/api/v1/projects/willow/donations/${ID}`, studio)).status).toBe(404);
  });

  it('must be members; members without access may list but not fetch keys', async () => {
    const { s, ada } = await withProjectKey();
    expect((await donate(s, donationBody(SEALED, envelope('willow', ID, 'fp')))).status).toBe(201);
    const bob = await setUpResearcher(s, 'bob@uni.example', { project: 'willow' });
    const eve = await setUpResearcher(s, 'eve@uni.example');
    expect((await s.keys.get('/api/v1/projects/willow/donations', bob.session)).status).toBe(200);
    expect((await sealedKeys(s, bob.session, [ID])).status).toBe(403);
    for (const r of [
      await s.keys.get('/api/v1/projects/willow/donations', eve.session),
      await s.keys.get(`/api/v1/projects/willow/donations/${ID}`, eve.session),
      await sealedKeys(s, eve.session, [ID]),
      await s.keys.delete(`/api/v1/projects/willow/donations/${ID}`, eve.session),
    ]) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: 'no_such_project' });
    }
    expect((await sealedKeys(s, ada.session, [ID])).json.keys).toHaveLength(1);
  });

  it('fetch sealed keys for at most 1000 ids, leaving out unknown ones', async () => {
    const { s, ada } = await withProjectKey();
    expect((await donate(s, donationBody(SEALED, envelope('willow', ID, 'fp')))).status).toBe(201);
    const tooMany = await sealedKeys(s, ada.session, Array.from({ length: 1001 }, () => ID));
    expect(tooMany.status).toBe(400);
    expect(tooMany.json).toEqual({ error: 'too_many_ids' });
    const some = await sealedKeys(s, ada.session, ['BBBBBBBBBBBBBBBBBBBBBB', '../x', ID]);
    expect(some.json.keys.map((k: { id: string }) => k.id)).toEqual([ID]);
  });

  it('need a full key page session for envelopes and keys', async () => {
    const { s } = await withProjectKey();
    expect((await donate(s, donationBody(SEALED, envelope('willow', ID, 'fp')))).status).toBe(201);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    expect((await s.keys.get(`/api/v1/projects/willow/donations/${ID}`, emailSession)).status).toBe(401);
    expect((await sealedKeys(s, emailSession, [ID])).status).toBe(401);
  });
});
