/**
 * Test packages of a draft's platform: the structure of a researcher's own export, and its content
 * only when they declare it synthetic or not sensitive. Members only, behind the studio session.
 */
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { startServer, type TestServer } from './harness';
import { setUpResearcher, studioSignIn } from './research';

const ADA = 'ada@uni.example';
const EVE = 'eve@uni.example';
const DECLARATION = 'synthetic-or-not-sensitive';
const BASE = '/api/v1/projects/birch/draft/platforms/tiktok/test-packages';

const SHAPE = { kind: 'map', name: '', children: [{ kind: 'value', name: 'title', types: ['string'] }] };
const OTHER_SHAPE = { kind: 'map', name: '', children: [{ kind: 'value', name: 'time', types: ['date-like'] }] };
const DATA = { kind: 'map', name: '', children: [{ kind: 'value', name: 'title', value: 'Madeleines bakken' }] };

/** A signed-in member of project birch, which has a platform tiktok. */
async function member(s: TestServer, email = ADA): Promise<string> {
  const cookie = await studioSignIn(s, await setUpResearcher(s, email));
  await s.main.post('/api/v1/projects', { id: 'birch', name: 'Birch study' }, cookie);
  await s.main.put('/api/v1/projects/birch/draft/platforms/tiktok', { name: 'TikTok', pack: 'tiktok' }, cookie);
  return cookie;
}

describe('test packages', () => {
  it('keep a structure once, however often it is added, and content only when declared fine to keep', async () => {
    const s = await startServer();
    const ada = await member(s);

    const first = await s.main.post(BASE, { name: 'Ada fake account', shape: SHAPE }, ada);
    expect(first.status, first.text).toBe(201);
    expect(first.json).toEqual({ id: expect.any(String), new_structure: true, existing: false });
    expect(first.headers['cache-control']).toBe('no-store');

    // The same package again: nothing new.
    const again = await s.main.post(BASE, { name: 'Ada fake account', shape: SHAPE }, ada);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ id: first.json.id, new_structure: false, existing: true });

    // Another package with the same structure is a package of its own, but no new structure.
    const second = await s.main.post(BASE, { name: 'Second fake account', shape: SHAPE }, ada);
    expect(second.status).toBe(201);
    expect(second.json.new_structure).toBe(false);
    const third = await s.main.post(BASE, { name: 'Dutch account', shape: OTHER_SHAPE }, ada);
    expect(third.json.new_structure).toBe(true);
    // The same structure written in another order (keys, children, types) is the same structure.
    const reordered = {
      children: [{ types: ['string'], name: 'title', kind: 'value' }],
      name: '',
      kind: 'map',
    };
    const fourth = await s.main.post(BASE, { name: 'Ada fake account', shape: reordered }, ada);
    expect(fourth.json).toEqual({ id: first.json.id, new_structure: false, existing: true });
    const both = { kind: 'map', name: '', children: [...SHAPE.children, ...OTHER_SHAPE.children] };
    const bothReversed = { kind: 'map', name: '', children: [...OTHER_SHAPE.children, ...SHAPE.children] };
    expect((await s.main.post(BASE, { name: 'Both', shape: both }, ada)).json.new_structure).toBe(true);
    expect((await s.main.post(BASE, { name: 'Both again', shape: bothReversed }, ada)).json.new_structure).toBe(false);

    const list = await s.main.get(BASE, ada);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json.packages).toHaveLength(5);
    expect(list.json.packages[0]).toEqual({
      id: first.json.id,
      name: 'Ada fake account',
      structure_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      has_data: false,
      data_bytes: 0,
      added: expect.any(Number),
      added_by: ADA,
    });
    // Each distinct structure once (stored in its canonical form: the same content, keys sorted).
    expect(list.json.shapes).toHaveLength(3);
    expect(list.json.shapes.map((x: { shape: unknown }) => x.shape)).toEqual([SHAPE, OTHER_SHAPE, expect.objectContaining({ kind: 'map' })]);

    // Without content, there is nothing to download.
    const none = await s.main.get(`${BASE}/${first.json.id}/data`, ada);
    expect(none.status).toBe(404);
    expect(none.json.error).toBe('no_data');

    // Content only with the declaration.
    const undeclared = await s.main.post(BASE, { name: 'With values', shape: SHAPE, data: DATA }, ada);
    expect(undeclared.status).toBe(400);
    expect(undeclared.json.error).toBe('declaration_required');
    const wrong = await s.main.post(BASE, { name: 'With values', shape: SHAPE, data: DATA, declaration: 'yes' }, ada);
    expect(wrong.json.error).toBe('declaration_required');

    // Adding content to a package that had only its structure keeps it one package.
    const withData = await s.main.post(BASE, { name: 'Ada fake account', shape: SHAPE, data: DATA, declaration: DECLARATION }, ada);
    expect(withData.status).toBe(200);
    expect(withData.json).toEqual({ id: first.json.id, new_structure: false, existing: true });
    const listed = (await s.main.get(BASE, ada)).json.packages[0];
    expect(listed.has_data).toBe(true);
    expect(listed.data_bytes).toBe(Buffer.byteLength(JSON.stringify(DATA)));

    const data = await s.main.get(`${BASE}/${first.json.id}/data`, ada);
    expect(data.status).toBe(200);
    expect(data.headers['content-type']).toBe('application/json');
    expect(data.headers['content-encoding']).toBe('gzip');
    expect(data.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(gunzipSync(data.body).toString('utf8'))).toEqual(DATA);

    // Names and content never reach the server's log.
    for (const text of ['Ada fake account', 'Madeleines']) expect(s.logs()).not.toContain(text);
  });

  it('are checked: a name, a shape, and sizes within limits', async () => {
    const s = await startServer();
    const ada = await member(s);
    for (const body of [
      { shape: SHAPE },
      { name: '', shape: SHAPE },
      { name: '   ', shape: SHAPE },
      { name: 'x'.repeat(201), shape: SHAPE },
      { name: 'line\nbreak', shape: SHAPE },
      { name: 'No shape' },
      { name: 'List shape', shape: [SHAPE] },
      { name: 'Text shape', shape: 'map' },
    ]) {
      const r = await s.main.post(BASE, body, ada);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(r.json.error).toBe('invalid');
    }

    const bigShape = { kind: 'map', name: '', children: [], padding: 'x'.repeat(2 * 1024 * 1024) };
    const tooBigShape = await s.main.post(BASE, { name: 'Big', shape: bigShape }, ada);
    expect(tooBigShape.status).toBe(413);
    expect(tooBigShape.json.error).toBe('too_big');

    const bigData = { value: 'x'.repeat(25 * 1024 * 1024) };
    const tooBigData = await s.main.post(BASE, { name: 'Big', shape: SHAPE, data: bigData, declaration: DECLARATION }, ada);
    expect(tooBigData.status).toBe(413);
    expect(tooBigData.json.error).toBe('too_big');
    expect((await s.main.get(BASE, ada)).json.packages).toEqual([]);
  });

  it('keep content for at most ten packages per platform', async () => {
    const s = await startServer();
    const ada = await member(s);
    for (let i = 0; i < 10; i++) {
      const r = await s.main.post(BASE, { name: `Account ${i}`, shape: SHAPE, data: DATA, declaration: DECLARATION }, ada);
      expect(r.status, r.text).toBe(201);
    }
    const eleventh = await s.main.post(BASE, { name: 'Account 10', shape: SHAPE, data: DATA, declaration: DECLARATION }, ada);
    expect(eleventh.status).toBe(409);
    expect(eleventh.json.error).toBe('too_many');
    // A structure alone is still welcome.
    expect((await s.main.post(BASE, { name: 'Account 10', shape: SHAPE }, ada)).status).toBe(201);
  });

  it('are for members only, of platforms that exist', async () => {
    const s = await startServer();
    const ada = await member(s);
    const added = (await s.main.post(BASE, { name: 'Ada fake account', shape: SHAPE, data: DATA, declaration: DECLARATION }, ada)).json;
    const eve = await studioSignIn(s, await setUpResearcher(s, EVE));

    for (const r of [
      await s.main.get(BASE, eve),
      await s.main.post(BASE, { name: 'Eve', shape: SHAPE }, eve),
      await s.main.get(`${BASE}/${added.id}/data`, eve),
      await s.main.delete(`${BASE}/${added.id}`, eve),
    ]) {
      expect(r.status).toBe(404);
    }
    for (const r of [await s.main.get(BASE), await s.main.get(`${BASE}/${added.id}/data`)]) expect(r.status).toBe(401);

    const unknown = '/api/v1/projects/birch/draft/platforms/takeout/test-packages';
    expect((await s.main.get(unknown, ada)).status).toBe(404);
    expect((await s.main.post(unknown, { name: 'X', shape: SHAPE }, ada)).status).toBe(404);
    expect((await s.main.get(`${BASE}/nope/data`, ada)).status).toBe(404);
    expect((await s.main.get(`${BASE}/not%20an%20id/data`, ada)).status).toBe(404);
  });

  it('are deleted one by one, and with their platform', async () => {
    const s = await startServer();
    const ada = await member(s);
    const one = (await s.main.post(BASE, { name: 'One', shape: SHAPE, data: DATA, declaration: DECLARATION }, ada)).json;
    await s.main.post(BASE, { name: 'Two', shape: OTHER_SHAPE }, ada);

    expect((await s.main.delete(`${BASE}/${one.id}`, ada)).status).toBe(204);
    expect((await s.main.delete(`${BASE}/${one.id}`, ada)).status).toBe(404);
    expect((await s.main.get(`${BASE}/${one.id}/data`, ada)).status).toBe(404);
    expect((await s.main.get(BASE, ada)).json.packages.map((p: { name: string }) => p.name)).toEqual(['Two']);

    expect((await s.main.delete('/api/v1/projects/birch/draft/platforms/tiktok', ada)).status).toBe(204);
    await s.main.put('/api/v1/projects/birch/draft/platforms/tiktok', { name: 'TikTok' }, ada);
    expect((await s.main.get(BASE, ada)).json).toEqual({ packages: [], shapes: [] });
  });
});
