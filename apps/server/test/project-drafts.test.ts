/**
 * Projects in the database: researchers create them in the studio, edit the draft in parts
 * (details, platforms with their trees), and publish it on the key page. Participants only ever get
 * the published version.
 */
import { describe, expect, it } from 'vitest';

import { startServer, type TestServer } from './harness';
import { createProjectKey, setUpResearcher, studioSignIn } from './research';

const ADA = 'ada@uni.example';
const EVE = 'eve@uni.example';

const STRUCTURE = { format: 'combray-structure/1', root: { kind: 'object', children: {} } };
const IMPORTER = { format: 'combray-importer/1', nodes: [] };

/** A researcher signed in to the studio: passkey on the key page, then the handoff. */
async function studio(s: TestServer, email: string): Promise<string> {
  return studioSignIn(s, await setUpResearcher(s, email));
}

describe('creating a project', () => {
  it('is done by a researcher in the studio, who becomes its first member', async () => {
    const s = await startServer();
    const ada = await studio(s, ADA);
    const created = await s.main.post('/api/v1/projects', { id: 'birch', name: { en: 'Birch study', nl: 'Berkstudie' } }, ada);
    expect(created.status, created.text).toBe(201);

    const list = (await s.main.get('/api/v1/projects', ada)).json.projects;
    expect(list).toEqual([expect.objectContaining({ id: 'birch', name: { en: 'Birch study', nl: 'Berkstudie' }, has_access: false })]);

    const draft = await s.main.get('/api/v1/projects/birch/draft', ada);
    expect(draft.status).toBe(200);
    expect(draft.json).toEqual({
      id: 'birch',
      details: { name: { en: 'Birch study', nl: 'Berkstudie' }, participants: { mode: 'optional' } },
      platforms: [],
      published: null,
      unpublished_changes: true,
    });
    // Not published yet: participants cannot open it.
    expect((await s.main.get('/api/v1/p/birch/config')).status).toBe(404);
  });

  it('needs a valid, free id and a name', async () => {
    const s = await startServer();
    const ada = await studio(s, ADA);
    for (const id of ['Birch', 'a b', '', 'x'.repeat(65)]) {
      expect((await s.main.post('/api/v1/projects', { id, name: 'Birch' }, ada)).status, id).toBe(400);
    }
    expect((await s.main.post('/api/v1/projects', { id: 'birch' }, ada)).status).toBe(400);
    expect((await s.main.post('/api/v1/projects', { id: 'willow', name: 'Taken' }, ada)).status).toBe(409);
    expect((await s.main.post('/api/v1/projects', { id: 'birch', name: 'Birch' })).status).toBe(401);
  });
});

describe('the draft', () => {
  it('is edited in parts: details and platforms, each with its own tree', async () => {
    const s = await startServer();
    const ada = await studio(s, ADA);
    await s.main.post('/api/v1/projects', { id: 'birch', name: 'Birch study' }, ada);

    const details = await s.main.put(
      '/api/v1/projects/birch/draft/details',
      { name: 'Birch study', description: { en: 'About memories' }, participants: { mode: 'required', pattern: 'B-[0-9]{3}' } },
      ada,
    );
    expect(details.status, details.text).toBe(204);
    const tiktok = await s.main.put(
      '/api/v1/projects/birch/draft/platforms/tiktok',
      { name: 'TikTok', pack: 'tiktok', structure: STRUCTURE, importer: IMPORTER },
      ada,
    );
    expect(tiktok.status, tiktok.text).toBe(204);
    await s.main.put('/api/v1/projects/birch/draft/platforms/takeout', { name: 'Google Takeout', pack: 'google-takeout' }, ada);

    const draft = (await s.main.get('/api/v1/projects/birch/draft', ada)).json;
    expect(draft.details).toEqual({ name: 'Birch study', description: { en: 'About memories' }, participants: { mode: 'required', pattern: 'B-[0-9]{3}' } });
    expect(draft.platforms).toEqual([
      { id: 'tiktok', name: 'TikTok', pack: 'tiktok', position: 0, has_tree: true },
      { id: 'takeout', name: 'Google Takeout', pack: 'google-takeout', position: 1, has_tree: false },
    ]);
    const platform = (await s.main.get('/api/v1/projects/birch/draft/platforms/tiktok', ada)).json;
    expect(platform).toEqual({ id: 'tiktok', name: 'TikTok', pack: 'tiktok', position: 0, structure: STRUCTURE, importer: IMPORTER });

    // Saving one platform's tree leaves the other parts alone.
    await s.main.put('/api/v1/projects/birch/draft/platforms/tiktok', { name: 'TikTok', pack: 'tiktok', structure: { ...STRUCTURE, v: 2 } }, ada);
    const after = (await s.main.get('/api/v1/projects/birch/draft', ada)).json;
    expect(after.details.description).toEqual({ en: 'About memories' });
    expect(after.platforms[1].id).toBe('takeout');

    expect((await s.main.delete('/api/v1/projects/birch/draft/platforms/takeout', ada)).status).toBe(204);
    expect((await s.main.delete('/api/v1/projects/birch/draft/platforms/takeout', ada)).status).toBe(404);
    expect((await s.main.get('/api/v1/projects/birch/draft', ada)).json.platforms.map((p: { id: string }) => p.id)).toEqual(['tiktok']);
  });

  it('refuses invalid details, platform ids and oversized trees', async () => {
    const s = await startServer();
    const ada = await studio(s, ADA);
    await s.main.post('/api/v1/projects', { id: 'birch', name: 'Birch study' }, ada);
    for (const body of [
      { name: '' },
      { name: 'Birch', participants: { mode: 'sometimes' } },
      { name: 'Birch', participants: { pattern: '(a+)+' } },
      { name: { 'not a language': 'x' } },
    ]) {
      expect((await s.main.put('/api/v1/projects/birch/draft/details', body, ada)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await s.main.put('/api/v1/projects/birch/draft/platforms/Tik%20Tok', { name: 'TikTok' }, ada)).status).toBe(400);
    const big = { name: 'TikTok', structure: { blob: 'x'.repeat(2 * 1024 * 1024 + 10) } };
    expect([400, 413]).toContain((await s.main.put('/api/v1/projects/birch/draft/platforms/tiktok', big, ada)).status);
  });

  it('is only for members', async () => {
    const s = await startServer();
    const ada = await studio(s, ADA);
    const eve = await studio(s, EVE);
    await s.main.post('/api/v1/projects', { id: 'birch', name: 'Birch study' }, ada);
    expect((await s.main.get('/api/v1/projects/birch/draft', eve)).status).toBe(404);
    expect((await s.main.put('/api/v1/projects/birch/draft/details', { name: 'Mine' }, eve)).status).toBe(404);
    expect((await s.main.put('/api/v1/projects/birch/draft/platforms/x', { name: 'X' }, eve)).status).toBe(404);
  });
});

describe('publishing', () => {
  it('happens on the key page only, and is what participants get', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const studioSession = await studioSignIn(s, ada);
    await s.main.post('/api/v1/projects', { id: 'birch', name: 'Birch study' }, studioSession);
    await s.main.put('/api/v1/projects/birch/draft/details', { name: 'Birch study', participants: { mode: 'required', pattern: 'B-[0-9]{3}' } }, studioSession);
    await s.main.put('/api/v1/projects/birch/draft/platforms/tiktok', { name: 'TikTok', pack: 'tiktok', structure: STRUCTURE, importer: IMPORTER }, studioSession);
    // Publishing needs access to the project's encryption key, which Ada creates first.
    expect((await s.keys.post('/api/v1/projects/birch/publish', {}, ada.session)).status).toBe(403);
    expect((await createProjectKey(s, ada.session, 'birch')).status).toBe(201);

    // The studio cannot publish: only the key page, with the passkey.
    expect((await s.main.post('/api/v1/projects/birch/publish', {}, studioSession)).status).toBe(404);

    const published = await s.keys.post('/api/v1/projects/birch/publish', {}, ada.session);
    expect(published.status, published.text).toBe(200);
    expect(published.json).toEqual({ version: 1 });

    const config = await s.main.get('/api/v1/p/birch/config');
    expect(config.status).toBe(200);
    const { donation_key: donationKey, ...served } = config.json;
    expect(donationKey).toEqual(expect.objectContaining({ fingerprint: 'fp' }));
    expect(served).toEqual({
      id: 'birch',
      name: 'Birch study',
      participants: { mode: 'required' },
      uploads: [{ id: 'tiktok', name: 'TikTok', pack: 'tiktok', structure: STRUCTURE, importer: IMPORTER }],
    });
    expect(config.text).not.toContain('B-[0-9]');
    const draft = (await s.keys.get('/api/v1/projects/birch/draft', ada.session)).json;
    expect(draft.published).toEqual({ version: 1, at: expect.any(Number) });
    expect(draft.unpublished_changes).toBe(false);
  });

  it('copies the draft: later edits reach participants only after publishing again', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const studioSession = await studioSignIn(s, ada);
    await s.main.post('/api/v1/projects', { id: 'birch', name: 'Birch study' }, studioSession);
    await createProjectKey(s, ada.session, 'birch');
    expect((await s.keys.post('/api/v1/projects/birch/publish', {}, ada.session)).status).toBe(200);

    const store = (participant?: string) =>
      s.main.post('/api/v1/stores', { project: 'birch', password: 'madeleine in tea', ...(participant ? { participant_id: participant } : {}) });
    expect((await store()).status).toBe(201);

    // The draft now asks for participant ids; the live version does not yet.
    await s.main.put('/api/v1/projects/birch/draft/details', { name: 'Birch study', participants: { mode: 'required' } }, studioSession);
    expect((await s.main.get('/api/v1/projects/birch/draft', studioSession)).json.unpublished_changes).toBe(true);
    expect((await store()).status).toBe(201);

    expect((await s.keys.post('/api/v1/projects/birch/publish', {}, ada.session)).json).toEqual({ version: 2 });
    const refused = await store();
    expect(refused.status).toBe(400);
    expect(refused.json).toEqual({ error: 'participant_required' });
    expect((await store('P1')).status).toBe(201);
  });

  it('is only for members with access to the encryption key', async () => {
    const s = await startServer();
    await setUpResearcher(s, ADA, { project: 'willow' });
    const eve = await setUpResearcher(s, EVE);
    expect((await s.keys.post('/api/v1/projects/willow/publish', {}, eve.session)).status).toBe(404);
    // A member without access yet (nobody has created the project's key): not allowed to publish.
    const bob = await setUpResearcher(s, 'bob@uni.example', { project: 'willow' });
    const refused = await s.keys.post('/api/v1/projects/willow/publish', {}, bob.session);
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: 'no_key_access' });
  });
});

describe('importing a project config', () => {
  it('creates or replaces the draft from the file and publishes it', async () => {
    const s = await startServer({ research: false });
    // The harness imported willow, oak and elm before the server started.
    const oak = await s.main.get('/api/v1/p/oak/config');
    expect(oak.json).toEqual({ id: 'oak', name: 'oak', participants: { mode: 'required' }, uploads: [] });
  });
});
