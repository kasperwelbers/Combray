/**
 * The key page end to end, in Chromium with a virtual passkey that supports PRF, against a real
 * Combray server. Run with `pnpm e2e`, which builds the web client and the page first.
 *
 * Covers: email sign-in, passkey creation, key setup and recovery code, the project key, a
 * donation sealed in Node and opened on the page, adding a colleague and granting access after
 * comparing key codes, unlocking after a reload, and signing in with the recovery code; and a
 * participant who uploads a Takeout, leaves some rows out, donates and withdraws again.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { donationRequest, encodePayload, fromBase64Url, sealDonation } from '@combray/seal';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixtureZip } from '../../../importers/test/load';

const enabled = process.env.COMBRAY_E2E === '1';
const repo = join(__dirname, '../../..');
/** The server, run from its TypeScript sources. */
const command = process.execPath;
const commandArgs = ['--disable-warning=ExperimentalWarning', join(repo, 'apps/server/src/main.ts')];
const port = 18_000 + Math.floor(Math.random() * 1000);
const MAIN = `http://localhost:${port}`;
const KEYS = `http://keys.localhost:${port}`;
/** The built web client, for the studio handoff (`pnpm --filter @combray/web build`). */
const WEB = join(repo, 'apps/web/dist');
const hasWeb = existsSync(join(WEB, 'index.html'));

let dir: string;
let server: ChildProcess;
let browser: Browser;
const consoleErrors: string[] = [];

function env() {
  return {
    ...process.env,
    COMBRAY_BIND: `127.0.0.1:${port}`,
    COMBRAY_PUBLIC_URL: MAIN,
    COMBRAY_KEYS_URL: KEYS,
    COMBRAY_DATA_DIR: join(dir, 'data'),
    COMBRAY_WEB_DIR: WEB,
    COMBRAY_KEYS_PAGE: join(repo, 'apps/keys/dist/index.html'),
    COMBRAY_STORE_MASTER_KEY_FILE: join(dir, 'store-master.key'),
    COMBRAY_MAIL_OUTBOX: join(dir, 'outbox'),
    RUST_LOG: 'warn',
  };
}

function cli(...args: string[]) {
  execFileSync(command, [...commandArgs, ...args], { env: env(), stdio: 'pipe' });
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${MAIN}/api/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

/** The code from the newest sign-in mail to this address, as written there ("1234 5678"). */
async function loginCode(email: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const mails = readdirSync(join(dir, 'outbox'), { withFileTypes: true })
      .map((e) => ({ path: join(dir, 'outbox', e.name), text: readFileSync(join(dir, 'outbox', e.name), 'utf8') }))
      .filter((m) => m.text.startsWith(`To: ${email}\n`) && m.text.includes('sign-in code is:'));
    if (mails.length > 0) {
      for (const m of mails) rmSync(m.path);
      return mails.at(-1)!.text.match(/sign-in code is:\s+(\d{4} \d{4})/)![1]!;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail for ${email}`);
}

/** A browser context with its own virtual authenticator (a passkey that supports PRF). */
async function researcherBrowser(): Promise<{ context: BrowserContext; page: Page; authenticator: string; cdp: import('playwright').CDPSession }> {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  return { context, page, authenticator: authenticatorId, cdp };
}

async function signInByEmail(page: Page, email: string) {
  await page.goto(KEYS);
  await page.getByRole('button', { name: 'Sign in with an email code' }).click();
  await page.getByLabel('Your email address').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Sign-in code').fill(await loginCode(email));
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** First sign-in: passkey, key, recovery code. Returns the recovery code. */
async function setUp(page: Page, email: string): Promise<string> {
  await signInByEmail(page, email);
  await page.getByRole('button', { name: 'Create passkey' }).click();
  const oneMore = page.getByRole('button', { name: 'Use passkey' });
  const code = page.locator('.printable .code');
  await Promise.race([oneMore.waitFor(), code.waitFor()]);
  if (await oneMore.isVisible()) await oneMore.click();
  await code.waitFor();
  const recovery = (await code.textContent())!;
  expect(await page.getByText('This passkey cannot unlock your project encryption keys').count()).toBe(0);
  await page.getByLabel('I have saved my recovery code somewhere safe').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  return recovery;
}

const CONSENT = {
  information: { en: 'We study how people remember.\n\nQuestions? Write to willow@uni.example.' },
  statements: [{ en: 'I am 16 or older.' }],
};

/** A Takeout upload point that asks for everything the pack shows. */
function takeoutAskingAll() {
  const pack = join(repo, 'importers/google-takeout');
  const importer = JSON.parse(readFileSync(join(pack, 'importer.json'), 'utf8'));
  const visit = (node: { decision?: string; children?: unknown[] }) => {
    if (node.decision === 'show') node.decision = 'donate';
    (node.children ?? []).forEach((c) => visit(c as typeof node));
  };
  visit(importer.root);
  return { id: 'takeout', name: { en: 'Google Takeout' }, structure: JSON.parse(readFileSync(join(pack, 'structure.json'), 'utf8')), importer };
}

describe.skipIf(!enabled)('key page', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'combray-e2e-'));
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'willow.json'), JSON.stringify({ id: 'willow', name: { en: 'Willow study' }, consent: CONSENT, uploads: [takeoutAskingAll()] }));
    cli('project', 'import', join(dir, 'willow.json'));
    cli('researcher', 'add', 'ada@uni.example');
    cli('project', 'add-researcher', 'willow', 'ada@uni.example');
    server = spawn(command, commandArgs, { env: env(), stdio: 'inherit' });
    await waitForServer();
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  let adaRecovery = '';
  let ada: Awaited<ReturnType<typeof researcherBrowser>>;

  it('signs in, creates the personal key and the project key', async () => {
    ada = await researcherBrowser();
    adaRecovery = await setUp(ada.page, 'ada@uni.example');
    expect(adaRecovery).toMatch(/^([0-9A-Z]{6}-){8}[0-9A-Z]{6}$/);

    await ada.page.getByRole('button', { name: 'Create the encryption key' }).click();
    const link = ada.page.locator('code.wrap');
    await link.waitFor();
    expect(await link.textContent()).toMatch(new RegExp(`^${MAIN}/p/willow/#k=[A-Za-z0-9_-]{22}$`));
    const config = await (await fetch(`${MAIN}/api/v1/p/willow/config`)).json();
    expect((await link.textContent())!.endsWith(config.donation_key.fingerprint)).toBe(true);
  }, 60_000);

  it('signs in again with the passkey alone', async () => {
    await ada.page.getByRole('button', { name: 'Sign out' }).click();
    await ada.page.getByRole('button', { name: 'Use your passkey' }).click();
    await ada.page.getByRole('heading', { name: 'Your projects' }).waitFor();
  }, 30_000);

  it('opens a donation and exports it as CSV', async () => {
    const config = await (await fetch(`${MAIN}/api/v1/p/willow/config`)).json();
    const payload = encodePayload({
      format: 'combray-donation/1',
      tables: [{ id: 'watch', name: 'Watch history', fields: [{ id: 'title', name: 'title' }, { id: 'day', name: 'day' }] }],
      values: [
        { table: 'watch', row: 0, field: 'title', path: ['watch.json', '[0]', 'title'], value: '=HYPERLINK("x")' },
        { table: 'watch', row: 0, field: 'day', path: ['watch.json', '[0]', 'day'], value: '2026-10-01' },
        { table: 'watch', row: 1, field: 'title', path: ['watch.json', '[1]', 'title'], value: 'A video' },
        { table: 'watch', row: 1, field: 'day', path: ['watch.json', '[1]', 'day'], value: '2026-10-02' },
      ],
      answers: { q1: 'yes' },
    });
    const donation = await sealDonation(payload, { projectId: 'willow', projectPublicKey: fromBase64Url(config.donation_key.public_key) });
    const response = await fetch(`${MAIN}/api/v1/p/willow/donations`, { method: 'POST', headers: { origin: MAIN }, body: donationRequest(donation) });
    expect(response.status).toBe(201);

    await ada.page.reload();
    await ada.page.getByRole('button', { name: 'Use passkey' }).click();
    await ada.page.getByRole('heading', { name: 'Your projects' }).waitFor();
    await ada.page.getByText('1 donation(s), 0 withdrawn.').waitFor();

    const downloads: Record<string, string> = {};
    ada.page.on('download', async (d) => {
      downloads[d.suggestedFilename()] = readFileSync((await d.path())!, 'utf8');
    });
    await ada.page.getByRole('button', { name: 'Open and download' }).click();
    await ada.page.getByText('Opened 1 donation(s).').waitFor();
    await expect
      .poll(() => Object.keys(downloads).sort())
      .toEqual(['willow-Watch-history.csv', 'willow-answers.csv', 'willow-donations.json', 'willow-values.csv']);
    const csv = downloads['willow-Watch-history.csv']!;
    expect(csv).toContain('donation,day,row,title,day');
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).toContain('A video,2026-10-02');
    expect(downloads['willow-values.csv']).toContain('watch.json/[1]/title');
  }, 60_000);

  it.skipIf(!hasWeb)('takes a donation from a participant, without what they left out, until they withdraw it', async () => {
    const config = await (await fetch(`${MAIN}/api/v1/p/willow/config`)).json();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('dialog', (d) => void d.accept());
    await page.goto(`${MAIN}/p/willow/#k=${config.donation_key.fingerprint}`);
    await page.getByLabel('Password', { exact: true }).fill('a long participant password');
    await page.getByLabel('Type it once more').fill('a long participant password');
    await page.getByRole('button', { name: 'Create my space' }).click();
    const zip = join(dir, 'takeout.zip');
    writeFileSync(zip, fixtureZip('google-takeout-en'));
    await page.locator('input[type=file]').first().setInputFiles(zip);
    await page.getByRole('button', { name: 'See what you would share' }).click();
    await page.getByText(/rows will be shared/).waitFor();

    await page.getByLabel('Leave out everything that contains a word, a name or a site').fill('madeleines');
    await page.getByRole('button', { name: 'Leave out', exact: true }).click();
    await page.getByText(/^Left out \d+ rows? that contains? “madeleines”/).waitFor();
    await page.getByText('Questions? Write to willow@uni.example.').waitFor();
    await page.getByLabel('I have looked at what will be shared').check();
    // Every statement of the study must be ticked too.
    expect(await page.getByRole('button', { name: 'Share', exact: true }).isDisabled()).toBe(true);
    await page.getByLabel('I am 16 or older.').check();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('heading', { name: 'Thank you for sharing!' }).waitFor();
    expect(await page.locator('.receipt-code code').textContent()).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);

    // The researcher opens it: the Takeout's tables, without the rows that were left out.
    await ada.page.reload();
    await ada.page.getByRole('button', { name: 'Use passkey' }).click();
    await ada.page.getByText('2 donation(s), 0 withdrawn.').waitFor();
    const downloads: Record<string, string> = {};
    ada.page.on('download', async (d) => {
      downloads[d.suggestedFilename()] = readFileSync((await d.path())!, 'utf8');
    });
    await ada.page.getByRole('button', { name: 'Open and download' }).click();
    await ada.page.getByText('Opened 2 donation(s).').waitFor();
    await expect.poll(() => Object.keys(downloads)).toContain('willow-YouTube-watch-history.csv');
    await expect.poll(() => Object.keys(downloads)).toContain('willow-values.csv');
    await expect.poll(() => Object.keys(downloads)).toContain('willow-consent.csv');
    expect(downloads['willow-consent.csv']).toContain('en,I am 16 or older.');
    expect(downloads['willow-YouTube-watch-history.csv']).toContain('Lime blossom tea');
    expect(downloads['willow-values.csv']!.toLowerCase()).not.toContain('madeleines');

    // Withdrawn from the participant's own page.
    await page.getByRole('button', { name: 'Withdraw' }).click();
    await page.getByText(/^Withdrawn on/).waitFor();
    await ada.page.reload();
    await ada.page.getByRole('button', { name: 'Use passkey' }).click();
    await ada.page.getByText('1 donation(s), 1 withdrawn.').waitFor();
    await context.close();
  }, 90_000);

  it.skipIf(!hasWeb)('opens the studio with a one-time handoff, without key material', async () => {
    const page = ada.page;
    await page.getByRole('button', { name: 'Open the studio' }).click();
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
    await page.getByText('Signed in as ada@uni.example').waitFor();
    await page.getByText('ready for donations').waitFor();
    expect(page.url()).toBe(`${MAIN}/studio/`);
    // The studio session cannot fetch envelopes or keys: those are for the key page only.
    const status = await page.evaluate(async () => (await fetch('/api/v1/projects/willow/donation-keys', { method: 'POST', body: '{"ids":[]}', headers: { 'content-type': 'application/json' } })).status);
    expect([404, 405]).toContain(status);
    // Leaving the key page locked the keys: unlock again for the next steps.
    await page.goto(KEYS);
    await page.getByRole('button', { name: 'Use passkey' }).click();
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  }, 60_000);

  it.skipIf(!hasWeb)('takes a researcher from the studio to the key page and straight back, signed in', async () => {
    const page = ada.page;
    // Ada's key page session is still fresh: arriving from the studio goes straight back.
    await page.goto(`${MAIN}/`);
    await page.goto(`${KEYS}/#studio=/studio/p/willow/data/`);
    await page.waitForURL(`${MAIN}/studio/p/willow/data/`);
    await page.getByRole('heading', { name: 'Willow study' }).waitFor();
    // Only paths in the studio: anything else is ignored, and the key page stays.
    await page.goto(`${MAIN}/`);
    await page.goto(`${KEYS}/#studio=https://elsewhere.example/`);
    await page.getByRole('heading', { name: 'Use your passkey' }).or(page.getByRole('heading', { name: 'Your projects' })).waitFor();
    expect(page.url().startsWith(KEYS)).toBe(true);
    await page.goto(KEYS);
    await page.getByRole('button', { name: 'Use passkey' }).or(page.getByRole('heading', { name: 'Your projects' })).first().waitFor();
    if (await page.getByRole('button', { name: 'Use passkey' }).isVisible()) await page.getByRole('button', { name: 'Use passkey' }).click();
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  }, 60_000);

  it('gives a colleague access after comparing key codes', async () => {
    await ada.page.getByLabel('Add a colleague by email').fill('bob@uni.example');
    await ada.page.getByRole('button', { name: 'Add', exact: true }).click();
    await ada.page.getByText('has not signed in and set up a key yet').waitFor();

    const bob = await researcherBrowser();
    await setUp(bob.page, 'bob@uni.example');
    await bob.page.getByText('A colleague on this project needs to give you access').waitFor();
    const bobCode = await bob.page.locator('section.card .code').first().textContent();

    await ada.page.reload();
    await ada.page.getByRole('button', { name: 'Use passkey' }).click();
    await ada.page.getByRole('button', { name: 'Give access' }).click();
    expect(await ada.page.locator('.grant .code').textContent()).toBe(bobCode);
    await ada.page.getByRole('button', { name: 'The codes match: give access' }).click();
    await ada.page.getByText('has access').nth(1).waitFor();

    await bob.page.reload();
    await bob.page.getByRole('button', { name: 'Use passkey' }).click();
    await bob.page.getByText('1 donation(s), 1 withdrawn.').waitFor();
    await bob.context.close();
  }, 90_000);

  it('signs in with the recovery code when the passkey is lost', async () => {
    const lost = await researcherBrowser();
    await signInByEmail(lost.page, 'ada@uni.example');
    await lost.page.getByRole('button', { name: 'I lost my passkey: use my recovery code' }).click();
    await lost.page.getByLabel('Recovery code').fill(adaRecovery.toLowerCase());
    await lost.page.getByRole('button', { name: 'Continue' }).click();
    await lost.page.getByRole('heading', { name: 'Add a new passkey' }).waitFor();
    await lost.page.getByRole('button', { name: 'Create passkey' }).click();
    await lost.page.getByRole('heading', { name: 'Your projects' }).waitFor();
    await lost.page.getByText('1 donation(s), 1 withdrawn.').waitFor();
    await lost.context.close();
  }, 60_000);

  it('starts over with a new key, but not while alone with access', async () => {
    const startOver = async (email: string) => {
      const b = await researcherBrowser();
      await signInByEmail(b.page, email);
      await b.page.getByRole('button', { name: 'I lost my passkey: use my recovery code' }).click();
      await b.page.getByRole('button', { name: 'I lost my recovery code too' }).click();
      await b.page.getByRole('button', { name: 'Start over', exact: true }).click();
      return b;
    };
    // Bob also has access to willow, so Ada can start over; Bob can give her access again.
    const ada2 = await startOver('ada@uni.example');
    await ada2.page.getByRole('heading', { name: 'Set up your passkey' }).waitFor();
    await ada2.context.close();
    // Her first browser still holds her old passkey, which the server no longer knows: the page
    // says so, instead of a bare refusal.
    await ada.page.goto(KEYS);
    await ada.page.getByRole('button', { name: 'Use your passkey' }).click();
    await ada.page.getByText('This passkey is not linked to an account on this server').waitFor();
    // Now Bob is the only one with access: starting over would lose willow's donations.
    const bob2 = await startOver('bob@uni.example');
    await bob2.page.getByText('You are the only researcher with access to these projects').waitFor();
    await bob2.page.getByText('Willow study').first().waitFor();
    // And who could give access again (nobody else has it now).
    await bob2.page.getByRole('heading', { name: 'Who can give you access again' }).waitFor();
    await bob2.context.close();
  }, 90_000);

  it.skipIf(!hasWeb)('signs a new researcher in from the studio: key page, email code, passkey, and back', async () => {
    cli('project', 'add-researcher', 'willow', 'cleo@uni.example');
    const cleo = await researcherBrowser();
    const page = cleo.page;
    await page.goto(`${MAIN}/studio/p/willow/`);
    await page.getByRole('heading', { name: 'Sign in to the researcher workspace' }).waitFor();
    await page.getByRole('link', { name: 'Sign in with your passkey' }).click();
    // On the key page, which says why: arriving from the studio.
    await page.getByRole('heading', { name: 'Confirm it’s you' }).waitFor();
    await page.getByRole('button', { name: 'Sign in with an email code' }).click();
    await page.getByLabel('Your email address').fill('cleo@uni.example');
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await page.getByLabel('Sign-in code').fill(await loginCode('cleo@uni.example'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Set up your passkey' }).waitFor();
    await page.getByRole('button', { name: 'Create passkey' }).click();
    const oneMore = page.getByRole('button', { name: 'Use passkey' });
    const code = page.locator('.printable .code');
    await Promise.race([oneMore.waitFor(), code.waitFor()]);
    if (await oneMore.isVisible()) await oneMore.click();
    await code.waitFor();
    await page.getByLabel('I have saved my recovery code somewhere safe').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    // Straight back to the project in the studio, signed in.
    await page.waitForURL(`${MAIN}/studio/p/willow/`);
    await page.getByRole('heading', { name: 'Willow study' }).waitFor();
    // Willow has an encryption key (Ada made it), which Cleo has no access to yet.
    await page.getByText('a colleague needs to give you access to its encryption key').waitFor();
    // Willow is set up (key, platforms, published), so there is no checklist of steps to take.
    expect(await page.getByRole('heading', { name: 'Set up this project' }).count()).toBe(0);
    await cleo.context.close();
  }, 90_000);

  it('ran without CSP violations or script errors', () => {
    // 401: probing for a session; 404: the studio probing for key routes it must not have;
    // 409: refusing to start over while alone with access.
    expect(consoleErrors.filter((e) => !/status of 40[149]/.test(e))).toEqual([]);
  });
});
