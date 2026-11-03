/**
 * The operator's command line (src/main.ts): researcher accounts and first project members.
 * The CLI runs with the same environment as the server, next to the running server.
 * `reset-link` is tested with the store service (stores.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { startServer } from './harness';
import { emailSignIn, mailedCode, requestCode, setUpResearcher, verifyCode } from './research';

const ADA = 'ada@uni.example';

describe('researcher add', () => {
  it('creates an account that can sign in, once per address', async () => {
    const s = await startServer();
    const added = await s.cli('researcher', 'add', ADA);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain(ADA);
    expect(added.stdout).toContain(s.keys.origin);
    // Addresses are compared in lower case, trimmed: this is the same account.
    expect((await s.cli('researcher', 'add', '  ADA@Uni.example ')).code).toBe(0);
    const list = await s.cliOk('researcher', 'list');
    expect(list.trim().split('\n')).toEqual([`${ADA}\tno key yet\t0 passkey(s)`]);
    await emailSignIn(s, s.keys, ADA);
  });

  it('refuses invalid addresses', async () => {
    const s = await startServer();
    const r = await s.cli('researcher', 'add', 'not-an-email');
    expect(r.code).toBe(1);
    expect(await s.cliOk('researcher', 'list')).toBe('');
  });
});

describe('researcher list', () => {
  it('shows who has set up a key and how many passkeys', async () => {
    const s = await startServer();
    await setUpResearcher(s, ADA);
    await s.cliOk('researcher', 'add', 'bob@uni.example');
    const list = await s.cliOk('researcher', 'list');
    expect(list.trim().split('\n')).toEqual([`${ADA}\tkey set up\t1 passkey(s)`, 'bob@uni.example\tno key yet\t0 passkey(s)']);
  });
});

describe('researcher remove', () => {
  it('deletes the account, its sessions and memberships', async () => {
    const s = await startServer();
    const ada = await setUpResearcher(s, ADA, { project: 'willow' });
    const bob = await setUpResearcher(s, 'bob@uni.example', { project: 'willow' });
    expect((await s.cli('researcher', 'remove', 'Ada@uni.example')).code).toBe(0);
    expect((await s.keys.get('/api/v1/me', ada.session)).status).toBe(401);
    const members = (await s.keys.get('/api/v1/projects/willow', bob.session)).json.members;
    expect(members.map((m: { email: string }) => m.email)).toEqual(['bob@uni.example']);
    // Sign-in codes are no longer mailed, and no code works.
    const login = await requestCode(s.keys, ADA);
    expect((await verifyCode(s.keys, login, '00000000')).status).toBe(403);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.outbox().some((m) => m.text.startsWith(`To: ${ADA}\n`))).toBe(false);
  });

  it('fails for unknown addresses', async () => {
    const s = await startServer();
    expect((await s.cli('researcher', 'remove', ADA)).code).toBe(1);
  });
});

describe('researcher reset-key', () => {
  it('fails for unknown addresses', async () => {
    const s = await startServer();
    expect((await s.cli('researcher', 'reset-key', ADA)).code).toBe(1);
  });
});

describe('project add-researcher', () => {
  it('makes a researcher a member, creating the account if needed', async () => {
    const s = await startServer();
    const r = await s.cli('project', 'add-researcher', 'willow', ADA);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${ADA} is now a member of willow`);
    const login = await requestCode(s.keys, ADA);
    const code = await mailedCode(s, ADA);
    expect((await verifyCode(s.keys, login, code)).status).toBe(200);
    // A second time is harmless, and says so.
    const again = await s.cli('project', 'add-researcher', 'willow', ADA);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`${ADA} is already a member of willow`);
  });

  it('refuses unknown projects and invalid project ids', async () => {
    const s = await startServer();
    for (const project of ['missing', 'Willow', '../willow']) {
      const r = await s.cli('project', 'add-researcher', project, ADA);
      expect(r.code, project).toBe(2);
      expect(r.stderr).toContain(`no such project: ${project}`);
    }
    expect(await s.cliOk('researcher', 'list')).toBe('');
  });
});

describe('the command line', () => {
  it('prints its usage for unknown commands', async () => {
    const s = await startServer();
    for (const args of [['nonsense'], ['researcher'], ['researcher', 'add'], ['project', 'add-researcher', 'willow']]) {
      const r = await s.cli(...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('combray-server project add-researcher <project> <email>');
    }
  });

  it('needs the researcher settings for researcher commands', async () => {
    const s = await startServer({ research: false });
    const r = await s.cli('researcher', 'list');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('COMBRAY_PUBLIC_URL');
  });
});
