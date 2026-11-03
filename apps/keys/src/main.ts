/**
 * The Combray key page: sign-in, personal and project keys, giving colleagues access, and
 * opening donations. It is deliberately small and plain (no framework, no third-party code but
 * the vetted HPKE library), served on its own host name with a strict CSP, and published as a
 * single file with a hash. See docs/researcher-keys.md.
 */
import {
  findRecoveryCode,
  fingerprint,
  fromBase64Url,
  fromRecoveryCode,
  keyCode,
  newMasterSecret,
  newProjectKey,
  personalKey,
  recoverySignInSecret,
  recoveryVerifier,
  sealProjectKey,
  sealedToJson,
  toBase64Url,
  toRecoveryCode,
  unwrapMaster,
  wrapMaster,
} from '@combray/seal';

import { type Me, type Member, type Project, type ProjectSummary, type Site, ApiError, api, projectName } from './api';
import { answersCsv, openAll, safeFileName, toCsv } from './decrypt';
import { action, download, h, message, show } from './dom';
import { authenticate, passkeysAvailable, register, signInWithPasskey } from './passkey';
import * as vault from './vault';

let site: Site = { researchers: true, public_url: '', keys_url: location.origin };

// Screens before sign-in.

function signInScreen(note?: string) {
  show(
    h('h1', {}, 'Sign in to your keys'),
    note && h('p', { class: 'notice' }, note),
    h('p', {}, 'This page holds the keys to your projects’ donations. Sign in with your passkey.'),
    !passkeysAvailable() && noPasskeys(),
    action('Sign in with your passkey', async () => {
      const used = await signInWithPasskey();
      await unlockWith(await api.get<Me>('/me'), used);
    }),
    h(
      'p',
      { class: 'meta' },
      'First time here, no passkey on this device, or lost it? ',
      h('button', { type: 'button', class: 'link', onclick: () => emailScreen() }, 'Sign in with an email code'),
    ),
    h('p', { class: 'meta' }, 'Researcher accounts are created by your server operator or by a colleague on a project.'),
  );
}

function emailScreen(note?: string) {
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true });
  const status = h('p', { role: 'status' });
  const form = h(
    'form',
    {},
    h('label', { for: 'email' }, 'Your email address'),
    email,
    h('button', { type: 'submit' }, 'Email me a sign-in code'),
    status,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    try {
      await api.post('/auth/email', { email: email.value });
      codeScreen(email.value);
    } catch (err) {
      status.textContent = message(err);
    }
  });
  show(
    h('h1', {}, 'Sign in with an email code'),
    note && h('p', { class: 'notice' }, note),
    h('p', {}, 'We email you a code. After it, you set up or use your passkey, or your recovery code.'),
    form,
    h('p', { class: 'meta' }, h('button', { type: 'button', class: 'link', onclick: () => signInScreen() }, 'Back to signing in with a passkey')),
  );
}

/** The emailed code only works in this browser: the server tied it to a cookie set just now. */
function codeScreen(address: string) {
  const code = h('input', {
    id: 'code',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    maxlength: '10',
    required: true,
  });
  const status = h('p', { role: 'status' });
  const form = h(
    'form',
    {},
    h('label', { for: 'code' }, 'Sign-in code'),
    code,
    h('button', { type: 'submit' }, 'Sign in'),
    status,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    try {
      await api.post('/auth/email/verify', { code: code.value });
    } catch (err) {
      status.textContent = message(err);
      return;
    }
    const me = await api.get<Me>('/me');
    if (me.passkeys.length === 0) createPasskeyScreen(me);
    else secondStepScreen(me);
  });
  show(
    h('h1', {}, 'Check your email'),
    h('p', {}, 'If there is a researcher account for ', h('strong', {}, address), ', a code is on its way. Type it here, in this tab. It works for 10 minutes.'),
    site.mail_outbox &&
      h('p', { class: 'notice' }, 'This is a development server: it does not send mail, but writes it to a folder (target/dev/outbox with pnpm serve).'),
    form,
    h('p', { class: 'meta' }, h('button', { type: 'button', class: 'quiet', onclick: () => emailScreen() }, 'Use another address or send a new code')),
  );
  code.focus();
}

function noPasskeys() {
  return h(
    'p',
    { class: 'notice' },
    'This browser cannot use passkeys. Open this page in a recent Chrome, Edge, Safari or Firefox.',
  );
}

function createPasskeyScreen(me: Me) {
  const name = h('input', { id: 'passkey-name', value: 'My passkey', maxlength: '60' });
  show(
    h('h1', {}, 'Create your passkey'),
    h('p', {}, `Welcome, ${me.email}. A passkey replaces a password: you unlock it with your fingerprint, face or device PIN.`),
    h('h2', {}, 'Your passkey holds the key to your projects’ donations'),
    h(
      'p',
      {},
      'Your passkey does two things: it signs you in, and it unlocks the key that opens the donations in your projects. ',
      'Only researchers on a project can read its donations. Not the server, and not whoever runs it. Your data stays safe even if the server is broken into.',
    ),
    h('p', {}, 'This also means the server cannot get your key back for you. To make sure you never lose access:'),
    h(
      'ul',
      {},
      h('li', {}, h('strong', {}, 'Keep your recovery code safe. '), 'You get it in the next step. With it you can set up a new passkey and keep everything.'),
      h(
        'li',
        {},
        h('strong', {}, 'Add a colleague to each project. '),
        'Once they have set up their own passkey and you have given them access, they can give you access again if you ever lose both your passkey and your recovery code.',
      ),
    ),
    h('h2', {}, 'Which passkey'),
    h(
      'p',
      {},
      'Best is a passkey that syncs: in iCloud Keychain, Google Password Manager or a password manager such as 1Password. ',
      'Then losing a phone does not lose your keys. You can also choose your phone and scan the QR code when your browser asks.',
    ),
    !passkeysAvailable() && noPasskeys(),
    h('label', { for: 'passkey-name' }, 'A name for this passkey, so you can tell it apart later'),
    name,
    action('Create passkey', async () => {
      const created = await register(name.value);
      await setUpKey(me, created.credentialId, created.prf, created.prfEnabled);
    }),
  );
}

/** Make the personal key, store it under the passkey, and show the recovery code once. */
async function setUpKey(me: Me, credentialId: string, prf: Uint8Array | undefined, prfEnabled: boolean) {
  if (!prf && prfEnabled) {
    show(
      h('h1', {}, 'One more touch'),
      h('p', {}, 'Your passkey can hold your key. Use it once more to store your key with it.'),
      action('Use passkey', async () => {
        const used = await authenticate();
        await finishKey(me, used.credentialId, used.prf);
      }),
    );
    return;
  }
  await finishKey(me, credentialId, prf);
}

async function finishKey(me: Me, credentialId: string, prf: Uint8Array | undefined) {
  const master = newMasterSecret();
  const { publicKey } = await personalKey(master);
  await api.post('/me/key', { public_key: toBase64Url(publicKey), recovery_verifier: toBase64Url(await recoveryVerifier(master)) });
  if (prf) {
    const wrapped = await wrapMaster(master, prf, me.id, credentialId);
    prf.fill(0);
    await api.put(`/me/passkeys/${credentialId}/wrapped`, { wrapped_key: toBase64Url(wrapped) });
  }
  await vault.unlock(me.id, master);
  await recoveryCodeScreen(me, !!prf, true);
}

async function recoveryCodeScreen(me: Me, passkeyHoldsKey: boolean, first: boolean) {
  const code = await toRecoveryCode(vault.personal().master);
  const saved = h('input', { type: 'checkbox', id: 'saved' });
  const next = h('button', { type: 'button', disabled: true }, 'Continue');
  saved.addEventListener('change', () => (next.disabled = !saved.checked));
  next.addEventListener('click', () => void home());
  show(
    h('h1', {}, first ? 'Your recovery code' : 'A copy of your recovery code'),
    !passkeyHoldsKey &&
      h(
        'p',
        { class: 'notice' },
        'This passkey cannot hold your key (it does not support the PRF extension). You will need this recovery code every time you open your keys. ',
        'A synced passkey in iCloud Keychain, Google Password Manager or 1Password usually can; you can add one later.',
      ),
    h('p', {}, 'This code is the only way back to your keys if you lose your passkey. Nobody else has it, not even the server. Keep it like a passport:'),
    h(
      'ul',
      {},
      h('li', {}, 'print it and keep it in a locked drawer, or'),
      h('li', {}, "save the file in your password manager or your university's encrypted storage."),
      h('li', {}, 'Do not email it, and do not keep it in a shared drive.'),
    ),
    h('div', { class: 'printable' }, h('p', { class: 'meta' }, `Combray recovery code for ${me.email}`), h('p', { class: 'code' }, code)),
    h(
      'p',
      { class: 'row' },
      h('button', { type: 'button', class: 'quiet', onclick: () => download('combray-recovery-code.txt', recoveryFile(me.email, code), 'text/plain') }, 'Download as a file'),
      h('button', { type: 'button', class: 'quiet', onclick: () => print() }, 'Print'),
    ),
    h('p', {}, saved, ' ', h('label', { for: 'saved' }, 'I have saved my recovery code somewhere safe')),
    next,
  );
}

function recoveryFile(email: string, code: string): string {
  return [
    'Combray recovery code',
    '',
    `Account: ${email}`,
    `Key page: ${site.keys_url}`,
    '',
    code,
    '',
    'This code opens your Combray keys if you lose your passkey. Keep it safe and private:',
    'whoever has it and can read your email can read your projects’ donations.',
    '',
  ].join('\n');
}

function secondStepScreen(me: Me) {
  show(
    h('h1', {}, 'Use your passkey'),
    h('p', {}, me.signed_in ? `Signed in as ${me.email}. Unlock your keys with your passkey.` : `Signed in by email as ${me.email}. Now confirm it is you with your passkey.`),
    !passkeysAvailable() && noPasskeys(),
    action('Use passkey', async () => {
      const used = await authenticate();
      await unlockWith(await api.get<Me>('/me'), used);
    }),
    h('p', { class: 'meta' }, h('button', { type: 'button', class: 'link', onclick: () => recoveryScreen(me, true) }, 'I lost my passkey: use my recovery code')),
  );
}

async function unlockWith(me: Me, used: { credentialId: string; prf?: Uint8Array; wrapped: string | null }) {
  if (!me.public_key) return setUpKey(me, used.credentialId, used.prf, !!used.prf);
  if (used.prf && used.wrapped) {
    const master = await unwrapMaster(fromBase64Url(used.wrapped), used.prf, me.id, used.credentialId);
    used.prf.fill(0);
    await vault.unlock(me.id, master, me.public_key);
    return home();
  }
  // Signed in, but this passkey does not hold the key.
  recoveryScreen(me, false);
}

/** Enter the recovery code: to sign in without a passkey (`signIn`), or to unlock the keys. */
function recoveryScreen(me: Me, signIn: boolean) {
  const input = h('textarea', { id: 'code', rows: '3', autocomplete: 'off', spellcheck: 'false' });
  const file = h('input', { type: 'file', id: 'code-file', accept: '.txt,text/plain' });
  file.addEventListener('change', async () => {
    const text = await file.files?.[0]?.text();
    input.value = (text && findRecoveryCode(text)) ?? '';
  });
  show(
    h('h1', {}, signIn ? 'Sign in with your recovery code' : 'Unlock with your recovery code'),
    h('p', {}, signIn ? 'Type or load the recovery code you saved when you set up your key.' : 'This passkey does not hold your key. Type or load your recovery code to open your keys.'),
    h('label', { for: 'code' }, 'Recovery code'),
    input,
    h('label', { for: 'code-file' }, 'or load the recovery file'),
    file,
    action('Continue', async () => {
      const master = await fromRecoveryCode(input.value);
      if (signIn) await api.post('/auth/recovery', { secret: toBase64Url(await recoverySignInSecret(master)) });
      await vault.unlock(me.id, master, me.public_key);
      if (signIn) return newPasskeyAfterRecovery(me);
      return home();
    }),
    signIn && h('p', { class: 'meta' }, h('button', { type: 'button', class: 'link', onclick: () => resetScreen() }, 'I lost my recovery code too')),
  );
}

/** Lost both passkey and recovery code: start over with a new key, if colleagues can give access again. */
function resetScreen() {
  const result = h('div', {});
  show(
    h('h1', {}, 'Start over with a new key'),
    h('p', {}, 'If you have lost both your passkey and your recovery code, you can set up a new key. This is what happens:'),
    h(
      'ul',
      {},
      h('li', {}, 'Your old passkeys and key stop working, and you are signed out everywhere.'),
      h('li', {}, 'You create a new passkey and get a new recovery code.'),
      h('li', {}, 'A colleague on each of your projects gives you access again, after you compare a short code with them.'),
    ),
    h('p', {}, 'This only works if another researcher on each of your projects has access. We check that first, so nothing is lost.'),
    action('Start over with a new key', async () => {
      result.replaceChildren();
      try {
        await api.post('/me/reset-key');
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'sole_access') throw e;
        const projects = (e.details.projects as { id: string; name: unknown }[] | undefined) ?? [];
        result.replaceChildren(
          h('p', { class: 'notice' }, 'You are the only researcher with access to these projects, so starting over would make their donations unreadable for good:'),
          h('ul', {}, ...projects.map((p) => h('li', {}, projectName(p.name, p.id)))),
          h(
            'p',
            {},
            'Look for your recovery code once more: as a file named combray-recovery-code.txt, or on paper. ',
            'If it is really gone, your server operator can reset your key, but nobody will be able to open these projects’ donations again.',
          ),
        );
        return;
      }
      createPasskeyScreen(await api.get<Me>('/me'));
    }),
    result,
    h('p', { class: 'meta' }, h('button', { type: 'button', class: 'link', onclick: () => signInScreen() }, 'Back to signing in')),
  );
}

function newPasskeyAfterRecovery(me: Me) {
  const name = h('input', { id: 'passkey-name', value: 'New passkey', maxlength: '60' });
  show(
    h('h1', {}, 'Add a new passkey'),
    h('p', {}, 'You are signed in with your recovery code. Add a passkey now, so next time you can sign in without it.'),
    h('label', { for: 'passkey-name' }, 'A name for this passkey'),
    name,
    action('Create passkey', async () => {
      await addPasskey(me, name.value);
      await home();
    }),
    h('p', {}, h('button', { type: 'button', class: 'link', onclick: () => void home() }, 'Not now')),
  );
}

/** Register another passkey and store the key under it too. */
async function addPasskey(me: Me, name: string) {
  const created = await register(name);
  let prf = created.prf;
  let credentialId = created.credentialId;
  if (!prf && created.prfEnabled) {
    const used = await authenticate();
    if (used.credentialId === created.credentialId) prf = used.prf;
    credentialId = used.credentialId;
  }
  if (prf) {
    const wrapped = await wrapMaster(vault.personal().master, prf, me.id, credentialId);
    prf.fill(0);
    await api.put(`/me/passkeys/${credentialId}/wrapped`, { wrapped_key: toBase64Url(wrapped) });
  }
}

// Signed in and unlocked.

async function home() {
  const me = await api.get<Me>('/me');
  if (!vault.isUnlocked()) return secondStepScreen(me);
  const code = await keyCode(vault.personal().publicKey);
  const { projects } = await api.get<{ projects: ProjectSummary[] }>('/projects');
  const sections = await Promise.all(projects.map((p) => projectSection(p.id)));
  show(
    h(
      'header',
      { class: 'bar' },
      h('div', {}, h('h1', {}, 'Your keys'), h('p', { class: 'meta' }, `Signed in as ${me.email}`)),
      h(
        'div',
        { class: 'row' },
        action('Open the studio', openStudio, { class: 'quiet' }),
        h('button', { type: 'button', class: 'quiet', onclick: () => vault.lock() }, 'Lock'),
        action('Sign out', signOut, { class: 'quiet' }),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Your key code'),
      h('p', { class: 'code' }, code),
      h('p', { class: 'meta' }, 'When a colleague gives you access to a project, they ask you to read this code to them. It is not secret.'),
    ),
    ...(sections.length > 0
      ? sections
      : [h('section', { class: 'card' }, h('h2', {}, 'No projects yet'), h('p', {}, 'Ask your server operator or a colleague to add you to a project.'))]),
    accountSection(me),
  );
}

async function openStudio() {
  const { code } = await api.post<{ code: string }>('/auth/handoff');
  location.assign(`${site.public_url}/studio/#handoff=${code}`);
}

async function signOut() {
  // End the session first: locking re-renders the page, which must already find it signed out.
  await api.post('/auth/logout').catch(() => undefined);
  vault.lock();
  signInScreen();
}

async function projectSection(id: string): Promise<HTMLElement> {
  const project = await api.get<Project>(`/projects/${id}`);
  const name = projectName(project.name, id);
  const body: (Node | string)[] = [h('h2', {}, name), h('p', { class: 'meta' }, `Project id: ${id}`)];
  const refresh = async () => section.replaceWith(await projectSection(id));

  if (!project.key) {
    body.push(
      h('p', {}, 'This project has no key yet. Create it once: participants’ donations are sealed to it, and you can then give colleagues access.'),
      action('Create the project key', async () => {
        const key = await newProjectKey();
        const me = vault.personal();
        const sealed = await sealProjectKey(key.seed, me.publicKey, id, me.researcherId);
        await api.post(`/projects/${id}/key`, {
          public_key: toBase64Url(key.publicKey),
          fingerprint: await fingerprint(key.publicKey),
          sealed_key: sealedToJson(sealed),
        });
        vault.rememberProjectKey(id, key);
        await refresh();
      }),
    );
  } else if (!project.has_access) {
    body.push(
      h('p', {}, 'A colleague on this project needs to give you access. When they ask, read them your key code (at the top of this page).'),
    );
  } else {
    try {
      const key = await vault.projectKey(project);
      const link = `${site.public_url}/p/${id}/#k=${await fingerprint(key.publicKey)}`;
      body.push(
        h('h3', {}, 'Participant link'),
        h('p', {}, h('code', { class: 'wrap' }, link)),
        h(
          'p',
          { class: 'meta' },
          'The part after # tells participants’ browsers which key to seal donations to, so the server cannot swap it. Always share the link with it. ',
          'For participant ids, add them as &id=…',
        ),
        h('button', { type: 'button', class: 'quiet', onclick: () => void navigator.clipboard.writeText(link) }, 'Copy link'),
        membersBlock(project, refresh),
        await donationsBlock(project, key.seed),
      );
    } catch (e) {
      body.push(h('p', { class: 'error', role: 'alert' }, message(e)));
    }
  }
  const section = h('section', { class: 'card' }, ...body);
  return section;
}

function memberStatus(m: Member): string {
  if (m.has_access) return 'has access';
  if (!m.public_key) return 'has not signed in and set up a key yet';
  return 'waiting for access';
}

function membersBlock(project: Project, refresh: () => Promise<void>): HTMLElement {
  const me = vault.personal();
  const rows = project.members.map((m) => {
    const cells: (Node | string)[] = [h('span', {}, m.email), h('span', { class: 'meta' }, memberStatus(m))];
    if (!m.has_access && m.public_key) {
      cells.push(h('button', { type: 'button', onclick: () => void grantPanel(project, m, refresh, row) }, 'Give access'));
    }
    if (m.researcher_id !== me.researcherId) {
      cells.push(
        action(
          'Remove',
          async () => {
            if (!confirm(`Remove ${m.email} from this project? Their copy of the project key is deleted.`)) return;
            await api.delete(`/projects/${project.id}/members/${m.researcher_id}`);
            await refresh();
          },
          { class: 'quiet' },
        ),
      );
    }
    const row = h('li', { class: 'member' }, ...cells);
    return row;
  });
  const email = h('input', { type: 'email', id: `add-${project.id}`, autocomplete: 'off' });
  return h(
    'div',
    {},
    h('h3', {}, 'Researchers'),
    h('ul', { class: 'members' }, ...rows),
    h('label', { for: `add-${project.id}` }, 'Add a colleague by email'),
    h(
      'p',
      { class: 'row' },
      email,
      action('Add', async () => {
        await api.post(`/projects/${project.id}/members`, { email: email.value });
        await refresh();
      }),
    ),
    h('p', { class: 'meta' }, 'They get an email, sign in and set up their key. Then you give them access here, after comparing a short code.'),
  );
}

async function grantPanel(project: Project, member: Member, refresh: () => Promise<void>, row: HTMLElement) {
  if (!member.public_key) return;
  const publicKey = fromBase64Url(member.public_key);
  const code = await keyCode(publicKey);
  const panel = h(
    'div',
    { class: 'grant' },
    h('p', {}, `Call or meet ${member.email} and ask them to read the key code at the top of their key page. Only continue if it is exactly:`),
    h('p', { class: 'code' }, code),
    h('p', { class: 'meta' }, 'This check makes sure the key you give access to really is theirs, and not one the server slipped in.'),
    action('The codes match: give access', async () => {
      const key = await vault.projectKey(project);
      const sealed = await sealProjectKey(key.seed, publicKey, project.id, member.researcher_id);
      await api.put(`/projects/${project.id}/members/${member.researcher_id}/key`, sealedToJson(sealed));
      await refresh();
    }),
    h('button', { type: 'button', class: 'quiet', onclick: () => panel.remove() }, 'Cancel'),
  );
  row.after(panel);
}

async function donationsBlock(project: Project, seed: Uint8Array): Promise<HTMLElement> {
  const list = await api.get<{ donations: { id: string }[]; withdrawn: { id: string }[] }>(`/projects/${project.id}/donations`);
  const status = h('p', { role: 'status' });
  const withdrawId = h('input', { id: `withdraw-${project.id}`, autocomplete: 'off' });
  return h(
    'div',
    {},
    h('h3', {}, 'Donations'),
    h('p', {}, `${list.donations.length} donation(s), ${list.withdrawn.length} withdrawn.`),
    list.donations.length > 0 &&
      action('Open and download', async () => {
        const result = await openAll(project.id, seed, (done, total) => (status.textContent = `Opening ${done} of ${total}…`));
        const base = safeFileName(project.id);
        for (const [id, t] of toCsv(result.opened)) download(`${base}-${safeFileName(id)}.csv`, t.csv, 'text/csv');
        const answers = answersCsv(result.opened);
        if (answers) download(`${base}-answers.csv`, answers, 'text/csv');
        download(`${base}-donations.json`, JSON.stringify(result.opened, null, 2), 'application/json');
        status.textContent =
          `Opened ${result.opened.length} donation(s).` + (result.failed.length ? ` ${result.failed.length} could not be opened: ${result.failed.map((f) => `${f.id} (${f.reason})`).join(', ')}.` : '');
      }),
    status,
    h(
      'p',
      { class: 'meta' },
      'The files you download are decrypted. You are responsible for them under the GDPR: keep them on encrypted storage, and delete rows of donations that are later withdrawn. Open the donations here again to get a fresh export without them.',
    ),
    h('details', {}, h('summary', {}, 'Withdraw a donation for a participant'),
      h('label', { for: `withdraw-${project.id}` }, 'Donation id (from the participant’s receipt)'),
      withdrawId,
      action('Withdraw', async () => {
        if (!confirm('Withdraw this donation? Its key is deleted on the server and it can never be opened again.')) return;
        await api.delete(`/projects/${project.id}/donations/${encodeURIComponent(withdrawId.value.trim())}`);
        status.textContent = 'Withdrawn.';
      }),
    ),
  );
}

function accountSection(me: Me): HTMLElement {
  const name = h('input', { id: 'new-passkey', value: 'Another passkey', maxlength: '60' });
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Your passkeys'),
    h(
      'ul',
      { class: 'members' },
      ...me.passkeys.map((p) =>
        h(
          'li',
          { class: 'member' },
          h('span', {}, p.name),
          h('span', { class: 'meta' }, p.unlocks_key ? 'holds your key' : 'signs in only; needs the recovery code to unlock'),
          me.passkeys.length > 1 &&
            action(
              'Remove',
              async () => {
                if (!confirm(`Remove the passkey "${p.name}"?`)) return;
                await api.delete(`/me/passkeys/${p.id}`);
                await home();
              },
              { class: 'quiet' },
            ),
        ),
      ),
    ),
    h('label', { for: 'new-passkey' }, 'Add a passkey, for example on a second device'),
    h(
      'p',
      { class: 'row' },
      name,
      action('Add passkey', async () => {
        await addPasskey(me, name.value);
        await home();
      }),
    ),
    h('button', { type: 'button', class: 'quiet', onclick: () => void recoveryCodeScreen(me, true, false) }, 'Show my recovery code again'),
  );
}

// Start.

async function start() {
  vault.watchIdle(() => void home().catch(() => signInScreen()));
  try {
    site = await api.get<Site>('/site');
  } catch {
    // The page still works for sign-in; links to the studio need the site info.
  }
  let me: Me;
  try {
    me = await api.get<Me>('/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return signInScreen();
    throw e;
  }
  if (me.passkeys.length === 0 && !me.signed_in) return createPasskeyScreen(me);
  return secondStepScreen(me);
}

function failed(e: unknown) {
  show(h('h1', {}, 'Something went wrong'), h('p', { class: 'error' }, message(e)));
}

start().catch(failed);
