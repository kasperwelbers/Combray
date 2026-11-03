/**
 * Researcher sign-in with an emailed code, the recovery code, sessions and origin checks (codes
 * work once, only in the browser and on the site that asked,
 * five wrong tries; sessions belong to one site and get a new id when sign-in completes).
 *
 * Sign-in mails are limited to 3 per address per 15 minutes and 20 per IP per 10 minutes; every
 * test has its own server and stays within that.
 */
import { describe, expect, it } from 'vitest';

import { b64, cookie, setCookies, startServer } from './harness';
import {
  emailSignIn,
  LOGIN_COOKIE,
  mailedCode,
  requestCode,
  SESSION_COOKIE,
  setUpResearcher,
  studioSignIn,
  verifyCode,
} from './research';

const ADA = 'ada@uni.example';

describe('email sign-in codes', () => {
  it('go only to known researchers and work once, in the same browser', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);

    // The same answer, cookie included, for unknown emails.
    const otherBrowser = await requestCode(s.keys, 'nobody@uni.example');
    const login = await requestCode(s.keys, 'Ada@Uni.example');
    const code = await mailedCode(s, ADA);
    expect(code).toMatch(/^\d{4} \d{4}$/);
    expect(s.outbox().every((m) => !m.text.includes('nobody@uni.example'))).toBe(true);

    // The code is useless without this browser's cookie.
    const noCookie = await verifyCode(s.keys, undefined, code);
    expect(noCookie.status).toBe(403);
    expect(noCookie.json).toEqual({ error: 'invalid_code' });
    expect((await verifyCode(s.keys, otherBrowser, code)).status).toBe(403);

    const ok = await verifyCode(s.keys, login, code);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ email: ADA, has_passkey: false, has_key: false });
    expect(ok.headers['cache-control']).toBe('no-store');
    const session = cookie(ok, SESSION_COOKIE);
    // On the key page, the email code starts a session that needs a second step within 15 minutes.
    expect(session.header).toBe(`${session.pair}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900`);
    expect(
      setCookies(ok).some((c) => c.startsWith(`${LOGIN_COOKIE}=;`) && c.includes('Max-Age=0')),
      'the pending sign-in cookie is cleared',
    ).toBe(true);

    const again = await verifyCode(s.keys, login, code);
    expect(again.status, 'a code works once').toBe(403);

    // The email code alone is not a sign-in.
    const me = await s.keys.get('/api/v1/me', session.pair);
    expect(me.status).toBe(200);
    expect(me.json.signed_in).toBe(false);
    expect(me.json.email).toBe(ADA);
    const projects = await s.keys.get('/api/v1/projects', session.pair);
    expect(projects.status).toBe(401);
    expect(projects.json).toEqual({ error: 'not_signed_in' });
    expect((await s.keys.post('/api/v1/auth/handoff', undefined, session.pair)).status).toBe(401);

    // It does allow registering the first passkey, bound to the key page's host name.
    const options = await s.keys.post('/api/v1/auth/passkey/register/start', undefined, session.pair);
    expect(options.status).toBe(200);
    expect(options.json.publicKey.rp.id).toBe('keys.localhost');
    expect(options.json.publicKey.authenticatorSelection.userVerification).toBe('required');

    // A key page cookie means nothing on the main site.
    expect((await s.main.get('/api/v1/me', session.pair)).status).toBe(401);
  });

  it('set a pending sign-in cookie for ten minutes', async () => {
    const s = await startServer();
    const r = await s.keys.post('/api/v1/auth/email', { email: ADA });
    expect(r.status).toBe(202);
    expect(r.headers['cache-control']).toBe('no-store');
    const login = cookie(r, LOGIN_COOKIE);
    expect(login.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.header).toBe(`${login.pair}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`);
  });

  it('may be typed without the space, or with a dash', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    let login = await requestCode(s.keys, ADA);
    let code = await mailedCode(s, ADA);
    expect((await verifyCode(s.keys, login, code.replace(' ', ''))).status).toBe(200);

    login = await requestCode(s.keys, ADA);
    code = await mailedCode(s, ADA);
    expect((await verifyCode(s.keys, login, code.replace(' ', '-'))).status).toBe(200);
  });

  it('stop working after five wrong tries', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    const login = await requestCode(s.keys, ADA);
    const code = await mailedCode(s, ADA);
    const wrong = code === '0000 0000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++) {
      const r = await verifyCode(s.keys, login, wrong);
      expect(r.status).toBe(403);
      expect(r.json).toEqual({ error: 'invalid_code' });
    }
    expect((await verifyCode(s.keys, login, code)).status).toBe(403);
  });

  it('still work after four wrong tries', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    const login = await requestCode(s.keys, ADA);
    const code = await mailedCode(s, ADA);
    const wrong = code === '0000 0000' ? '11111111' : '00000000';
    for (let i = 0; i < 4; i++) expect((await verifyCode(s.keys, login, wrong)).status).toBe(403);
    expect((await verifyCode(s.keys, login, code)).status).toBe(200);
  });

  it('for unknown addresses never work', async () => {
    const s = await startServer();
    const login = await requestCode(s.keys, 'nobody@uni.example');
    for (const code of ['00000000', '12345678']) {
      expect((await verifyCode(s.keys, login, code)).status).toBe(403);
    }
  });

  it('are only sent to well-formed addresses', async () => {
    const s = await startServer();
    for (const email of ['no-at-sign', 'a@nodot', 'a b@uni.example', '@uni.example', 'a@.uni.example', 'a@uni.example.']) {
      const r = await s.keys.post('/api/v1/auth/email', { email });
      expect(r.status, email).toBe(400);
      expect(r.json).toEqual({ error: 'invalid_email' });
    }
  });

  it('are rate limited per address', async () => {
    const s = await startServer();
    for (let i = 0; i < 3; i++) {
      // From different IPs, so only the per-address limit applies.
      const r = await s.request({
        method: 'POST',
        host: s.keysHost,
        path: '/api/v1/auth/email',
        body: { email: ADA },
        headers: { origin: s.keys.origin, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': `192.0.2.${i + 1}` },
      });
      expect(r.status).toBe(202);
    }
    // Case and spaces do not make it another address.
    const limited = await s.keys.post('/api/v1/auth/email', { email: ' ADA@uni.example ' });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: 'too_many_attempts' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('are rate limited per client IP', async () => {
    const s = await startServer();
    const fromIp = (email: string, ip: string) =>
      s.request({
        method: 'POST',
        host: s.keysHost,
        path: '/api/v1/auth/email',
        body: { email },
        headers: { origin: s.keys.origin, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip },
      });
    for (let i = 0; i < 20; i++) expect((await fromIp(`r${i}@uni.example`, '192.0.2.7')).status).toBe(202);
    const limited = await fromIp('r20@uni.example', '192.0.2.7');
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: 'too_many_attempts' });
    expect((await fromIp('r20@uni.example', '192.0.2.8')).status).toBe(202);
  });
});

describe('the studio', () => {
  it('has no sign-in of its own: email codes are only for the key page', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    expect((await s.main.post('/api/v1/auth/email', { email: ADA })).status).toBe(404);
    expect((await s.main.post('/api/v1/auth/email/verify', { code: '12345678' })).status).toBe(404);
    // An email code alone gives no studio session either: a handoff needs a passkey sign-in.
    const emailSession = await emailSignIn(s, s.keys, ADA);
    expect((await s.keys.post('/api/v1/auth/handoff', undefined, emailSession)).status).toBe(401);
  });

  it('ends a session after a while without activity, and at most after the maximum', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const idle = await startServer({ env: { COMBRAY_STUDIO_IDLE_SECS: '3' } });
    const ada = await setUpResearcher(idle, ADA);
    let session = await studioSignIn(idle, ada);
    // Activity keeps it open, past the idle limit in total.
    for (let i = 0; i < 3; i++) {
      await sleep(1500);
      expect((await idle.main.get('/api/v1/me', session)).status, `after ${(i + 1) * 1.5}s of activity`).toBe(200);
    }
    await sleep(3500);
    expect((await idle.main.get('/api/v1/me', session)).status, 'after 3.5s without activity').toBe(401);

    const short = await startServer({ env: { COMBRAY_STUDIO_MAX_SECS: '2' } });
    const bob = await setUpResearcher(short, 'bob@uni.example');
    session = await studioSignIn(short, bob);
    const max = (await short.keys.post('/api/v1/auth/handoff', undefined, bob.session)).json.code;
    expect(cookie(await short.main.post('/api/v1/auth/handoff/redeem', { code: max }), SESSION_COOKIE).header).toMatch(/Max-Age=2(;|$)/);
    await sleep(1000);
    expect((await short.main.get('/api/v1/me', session)).status).toBe(200);
    await sleep(2200);
    expect((await short.main.get('/api/v1/me', session)).status, 'past the maximum, however active').toBe(401);
  }, 30_000);
});

describe('recovery sign-in', () => {
  it('completes sign-in with a new session id; the email-level one stops working', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const emailSession = await emailSignIn(s, s.keys, ADA);
    const r = await s.keys.post('/api/v1/auth/recovery', { secret: b64(ada.secret) }, emailSession);
    expect(r.status).toBe(204);
    const full = cookie(r, SESSION_COOKIE);
    expect(full.pair).not.toBe(emailSession);
    expect(full.header).toBe(`${full.pair}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200`);
    expect((await s.keys.get('/api/v1/me', full.pair)).json.signed_in).toBe(true);
    expect((await s.keys.get('/api/v1/me', emailSession)).status).toBe(401);
  });

  it('needs the right secret, and is limited per researcher', async () => {
    const s = await startServer();
    await setUpResearcher(s, ADA);
    const session = await emailSignIn(s, s.keys, ADA);
    const wrong = await s.keys.post('/api/v1/auth/recovery', { secret: b64(Buffer.alloc(32, 2)) }, session);
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual({ error: 'wrong_recovery_code' });
    for (let i = 0; i < 4; i++) {
      await s.keys.post('/api/v1/auth/recovery', { secret: b64(Buffer.alloc(32, 2)) }, session);
    }
    const limited = await s.keys.post('/api/v1/auth/recovery', { secret: b64(Buffer.alloc(32, 1)) }, session);
    expect(limited.status, 'attempts are limited per researcher').toBe(429);
    expect(limited.json).toEqual({ error: 'too_many_attempts' });
  });

  it('does not work before the researcher has a key', async () => {
    const s = await startServer();
    await s.cliOk('researcher', 'add', ADA);
    const session = await emailSignIn(s, s.keys, ADA);
    const r = await s.keys.post('/api/v1/auth/recovery', { secret: b64(Buffer.alloc(32)) }, session);
    expect(r.status).toBe(401);
  });

  it('needs an email-level session first', async () => {
    const s = await startServer();
    const r = await s.keys.post('/api/v1/auth/recovery', { secret: b64(Buffer.alloc(32)) });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'not_signed_in' });
  });
});

describe('sessions', () => {
  it('end on sign-out, which clears the cookie', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const r = await s.keys.post('/api/v1/auth/logout', {}, ada.session);
    expect(r.status).toBe(204);
    const cleared = cookie(r, SESSION_COOKIE);
    expect(cleared.header).toBe(`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    expect((await s.keys.get('/api/v1/me', ada.session)).status).toBe(401);
    // Signing out without a session is fine too.
    expect((await s.keys.post('/api/v1/auth/logout', {})).status).toBe(204);
  });

  it('are refused for made-up cookies', async () => {
    const s = await startServer();
    for (const value of ['', 'nonsense!', b64(Buffer.alloc(32, 1))]) {
      const r = await s.keys.get('/api/v1/me', `${SESSION_COOKIE}=${value}`);
      expect(r.status, value).toBe(401);
      expect(r.json).toEqual({ error: 'not_signed_in' });
    }
  });

  it('use __Host- cookies marked Secure when the sites are served over HTTPS', async () => {
    const s = await startServer({ scheme: 'https' });
    await s.cliOk('researcher', 'add', ADA);
    const r = await s.keys.post('/api/v1/auth/email', { email: ADA });
    expect(r.status).toBe(202);
    const login = cookie(r, '__Host-combray-login');
    expect(login.header).toBe(`${login.pair}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600; Secure`);
    const code = await mailedCode(s, ADA);
    // The plain cookie name is not read.
    expect((await verifyCode(s.keys, `${LOGIN_COOKIE}=${login.value}`, code)).status).toBe(403);
    const ok = await verifyCode(s.keys, login.pair, code);
    expect(ok.status).toBe(200);
    const session = cookie(ok, '__Host-combray');
    expect(session.header).toBe(`${session.pair}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900; Secure`);
    expect((await s.keys.get('/api/v1/me', session.pair)).status).toBe(200);
    expect((await s.keys.get('/api/v1/me', `${SESSION_COOKIE}=${session.value}`)).status).toBe(401);
  });
});

describe('requests from other origins', () => {
  it('are refused', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA);
    const call = (method: string, path: string, headers: Record<string, string>) =>
      s.request({ method, host: s.keysHost, path, headers: { cookie: ada.session, ...headers } });

    // A page on the main site trying to use the key page's session.
    const handoff = await call('POST', '/api/v1/auth/handoff', { origin: s.main.origin, 'sec-fetch-site': 'same-site' });
    expect(handoff.status).toBe(403);
    expect(handoff.json).toEqual({ error: 'cross_origin' });
    expect((await call('GET', '/api/v1/projects', { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await call('GET', '/api/v1/projects', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // Even with the right Origin, a cross-site fetch is refused.
    expect((await call('GET', '/api/v1/me', { origin: s.keys.origin, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // State changes need an Origin header.
    expect((await call('POST', '/api/v1/auth/handoff', {})).status).toBe(403);
    expect((await call('POST', '/api/v1/auth/handoff', { 'sec-fetch-site': 'same-origin' })).status).toBe(403);

    // Reads without an Origin are fine from the same origin or a typed-in address.
    expect((await call('GET', '/api/v1/me', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await call('GET', '/api/v1/me', { 'sec-fetch-site': 'none' })).status).toBe(200);
    expect((await call('GET', '/api/v1/me', {})).status).toBe(200);
    expect((await call('POST', '/api/v1/auth/handoff', { origin: s.keys.origin })).status).toBe(200);
  });

  it('cannot ask for sign-in codes', async () => {
    const s = await startServer();
    const attempts: Record<string, string>[] = [
      { origin: s.main.origin, 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      {},
    ];
    for (const headers of attempts) {
      const r = await s.request({
        method: 'POST',
        host: s.keysHost,
        path: '/api/v1/auth/email',
        body: { email: ADA },
        headers,
      });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.json).toEqual({ error: 'cross_origin' });
    }
  });
});
