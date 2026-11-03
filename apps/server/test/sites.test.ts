/**
 * The two host names: the main site (participant app and studio) and the key page. Ported from
 * `the_key_page_is_served_only_on_its_own_host` in crates/combray-server/tests/research.rs, plus
 * the behaviour of src/lib.rs (key page headers, site info, disabled features).
 */
import { describe, expect, it } from 'vitest';

import { KEYS_PAGE_CSP, KEYS_PERMISSIONS, MAIN_PERMISSIONS, startServer } from './harness';

describe('the key page', () => {
  it('is served only on its own host, with its own headers', async () => {
    const s = await startServer();
    const page = await s.request({ host: s.keysHost, path: '/' });
    expect(page.status).toBe(200);
    expect(page.text).toContain('<title>Keys</title>');
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('no-cache');
    // The policy from the page's <meta> tag, plus what a <meta> tag cannot express.
    expect(page.headers['content-security-policy']).toBe(`${KEYS_PAGE_CSP}; frame-ancestors 'none'`);
    expect(page.headers['permissions-policy']).toBe(KEYS_PERMISSIONS);
    expect(page.headers['permissions-policy']).toContain('publickey-credentials-get=(self)');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(page.headers['cross-origin-resource-policy']).toBe('same-origin');

    // Nothing else on the key page's host: not the participant app, not the store service.
    for (const path of ['/willow/', '/studio/', '/assets/app.js', '/api/v1/stores', '/api/v1/p/willow/config']) {
      const r = await s.request({ host: s.keysHost, path });
      expect(r.status, path).toBe(404);
      expect(r.json).toEqual({ error: 'not_found' });
    }
    const store = await s.request({
      method: 'POST',
      host: s.keysHost,
      path: '/api/v1/stores',
      body: { project: 'willow', password: 'madeleine in tea' },
    });
    expect(store.status).toBe(404);
    // The host name is matched without regard to case.
    const upper = await s.request({ host: s.keysHost.toUpperCase(), path: '/' });
    expect(upper.text).toContain('<title>Keys</title>');
  });

  it('answers 503 when it is not built', async () => {
    const s = await startServer({ env: { COMBRAY_KEYS_PAGE: '/nonexistent/keys/index.html' } });
    const r = await s.request({ host: s.keysHost, path: '/' });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ error: 'key_page_not_built' });
    // The API still works.
    expect((await s.keys.get('/api/v1/health')).status).toBe(200);
  });
});

describe('the main site', () => {
  it('cannot use passkeys and has no passkey or key routes', async () => {
    const s = await startServer();
    const health = await s.main.get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.headers['permissions-policy']).toBe(MAIN_PERMISSIONS);
    expect(health.headers['permissions-policy']).toContain('publickey-credentials-get=()');

    for (const path of [
      '/api/v1/auth/passkey/register/start',
      '/api/v1/auth/passkey/register/finish',
      '/api/v1/auth/passkey/sign-in/start',
      '/api/v1/auth/passkey/sign-in/finish',
      '/api/v1/auth/passkey/start',
      '/api/v1/auth/passkey/finish',
      '/api/v1/auth/recovery',
      '/api/v1/auth/handoff',
      '/api/v1/me/key',
      '/api/v1/me/reset-key',
      '/api/v1/projects/willow/key',
      '/api/v1/projects/willow/members',
      '/api/v1/projects/willow/donation-keys',
    ]) {
      const r = await s.main.post(path, {});
      expect(r.status, path).toBe(404);
      expect(r.json, path).toEqual({ error: 'not_found' });
    }
    // And the key page has no handoff redemption (that is the studio's).
    expect((await s.keys.post('/api/v1/auth/handoff/redeem', { code: 'x' })).status).toBe(404);
  });
});

describe('site information', () => {
  it('tells each site where the other is', async () => {
    const s = await startServer();
    const expected = {
      researchers: true,
      public_url: s.main.origin,
      keys_url: s.keys.origin,
      mail_outbox: true,
    };
    expect((await s.main.get('/api/v1/site')).json).toEqual(expected);
    expect((await s.keys.get('/api/v1/site')).json).toEqual(expected);
  });

  it('says whether mails go to an outbox', async () => {
    const s = await startServer({ mail: false });
    expect((await s.main.get('/api/v1/site')).json.mail_outbox).toBe(false);
  });

  it('says when researcher features are off, and their routes answer researchers_disabled', async () => {
    const s = await startServer({ research: false });
    expect((await s.main.get('/api/v1/site')).json).toEqual({ researchers: false });
    for (const [method, path] of [
      ['GET', '/api/v1/me'],
      ['POST', '/api/v1/auth/email'],
      ['GET', '/api/v1/projects'],
    ] as const) {
      const r = await s.request({
        method,
        host: s.mainHost,
        path,
        body: method === 'POST' ? { email: 'ada@uni.example' } : undefined,
        headers: { origin: s.main.origin, 'sec-fetch-site': 'same-origin' },
      });
      expect(r.status, path).toBe(404);
      expect(r.json, path).toEqual({ error: 'researchers_disabled' });
    }
  });
});

describe('sign-in without mail settings', () => {
  it('is unavailable', async () => {
    const s = await startServer({ mail: false });
    await s.cliOk('researcher', 'add', 'ada@uni.example');
    for (const site of [s.keys, s.main]) {
      const r = await site.post('/api/v1/auth/email', { email: 'ada@uni.example' });
      expect(r.status).toBe(503);
      expect(r.json).toEqual({ error: 'mail_disabled' });
    }
  });
});
