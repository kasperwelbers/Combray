import { describe, expect, it } from 'vitest';

import {
  CHUNK_BYTES,
  InvalidEnvelope,
  InvalidRecoveryCode,
  WrongPasskey,
  concat,
  decodePayload,
  encodePayload,
  fingerprint,
  findRecoveryCode,
  fromBase32,
  fromRecoveryCode,
  keyCode,
  newMasterSecret,
  newProjectKey,
  openDonation,
  openProjectKey,
  personalKey,
  randomBytes,
  readHeader,
  recoverySignInSecret,
  recoveryVerifier,
  sealDonation,
  sealProjectKey,
  sha256,
  toBase32,
  toRecoveryCode,
  unwrapMaster,
  wrapMaster,
} from '../src';

describe('base32', () => {
  it('round trips and forgives confusable letters', () => {
    const bytes = randomBytes(32);
    const text = toBase32(bytes);
    expect(text).toHaveLength(52);
    expect(fromBase32(text.toLowerCase(), 32)).toEqual(bytes);
    expect(fromBase32('O1', 1)).toEqual(fromBase32('0I', 1));
  });
});

describe('recovery code', () => {
  it('round trips the master secret and catches typos', async () => {
    const master = newMasterSecret();
    const code = await toRecoveryCode(master);
    expect(code).toMatch(/^([0-9A-Z]{6}-){8}[0-9A-Z]{6}$/);
    expect(await fromRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toEqual(master);

    const typo = (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
    await expect(fromRecoveryCode(typo)).rejects.toBeInstanceOf(InvalidRecoveryCode);
    await expect(fromRecoveryCode('too short')).rejects.toBeInstanceOf(InvalidRecoveryCode);
  });

  it('is found in a recovery file', async () => {
    const code = await toRecoveryCode(newMasterSecret());
    expect(findRecoveryCode(`Your Combray recovery code\n\n${code}\n\nKeep it safe.`)).toBe(code);
  });

  it('derives a personal key and a separate sign-in secret', async () => {
    const master = newMasterSecret();
    const a = await personalKey(master);
    const b = await personalKey(await fromRecoveryCode(await toRecoveryCode(master)));
    expect(a.publicKey).toEqual(b.publicKey);
    expect(a.publicKey).toHaveLength(1216);
    const secret = await recoverySignInSecret(master);
    expect(secret).not.toEqual(a.seed);
    expect(await recoveryVerifier(master)).toEqual(await sha256(secret));
  });
});

describe('passkey wrapping', () => {
  it('opens only with the same PRF output, researcher and credential', async () => {
    const master = newMasterSecret();
    const prf = randomBytes(32);
    const wrapped = await wrapMaster(master, prf, 'r1', 'cred1');
    expect(await unwrapMaster(wrapped, prf, 'r1', 'cred1')).toEqual(master);
    await expect(unwrapMaster(wrapped, randomBytes(32), 'r1', 'cred1')).rejects.toBeInstanceOf(WrongPasskey);
    await expect(unwrapMaster(wrapped, prf, 'r2', 'cred1')).rejects.toBeInstanceOf(WrongPasskey);
    await expect(unwrapMaster(wrapped, prf, 'r1', 'cred2')).rejects.toBeInstanceOf(WrongPasskey);
  });
});

describe('key codes', () => {
  it('are short, stable and differ per key', async () => {
    const a = await personalKey(newMasterSecret());
    const b = await personalKey(newMasterSecret());
    const code = await keyCode(a.publicKey);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(await keyCode(a.publicKey)).toBe(code);
    expect(await keyCode(b.publicKey)).not.toBe(code);
    expect(await fingerprint(a.publicKey)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('project keys', () => {
  it('are sealed to one member and bound to project and researcher', async () => {
    const member = await personalKey(newMasterSecret());
    const other = await personalKey(newMasterSecret());
    const project = await newProjectKey();
    const sealed = await sealProjectKey(project.seed, member.publicKey, 'willow', 'r1');
    const opened = await openProjectKey(sealed, member.seed, 'willow', 'r1');
    expect(opened.seed).toEqual(project.seed);
    expect(opened.publicKey).toEqual(project.publicKey);
    await expect(openProjectKey(sealed, other.seed, 'willow', 'r1')).rejects.toThrow();
    await expect(openProjectKey(sealed, member.seed, 'oak', 'r1')).rejects.toThrow();
    await expect(openProjectKey(sealed, member.seed, 'willow', 'r2')).rejects.toThrow();
  });
});

describe('donation envelopes', () => {
  const payload = encodePayload({
    format: 'combray-donation/1',
    tables: [{ id: 'watch', name: 'Watch history', fields: [{ id: 'title', name: 'Title' }] }],
    values: [{ table: 'watch', row: 0, field: 'title', path: ['watch-history.json', '[0]', 'title'], value: 'A video' }],
    answers: { q1: 'yes' },
  });

  it('round trips, in several chunks', async () => {
    const project = await newProjectKey();
    const big = concat(payload, randomBytes(2500));
    const d = await sealDonation(big, { projectId: 'willow', projectPublicKey: project.publicKey, chunkBytes: 1000 });
    expect(d.header.chunks).toBe(Math.ceil(big.byteLength / 1000));
    expect(d.header.key).toBe(await fingerprint(project.publicKey));
    expect(d.header.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const opened = await openDonation(d.envelope, d.sealedKey, project.seed, { projectId: 'willow', donationId: d.header.donation });
    expect(opened.payload).toEqual(big);
  });

  it('decodes the payload', async () => {
    const project = await newProjectKey();
    const d = await sealDonation(payload, { projectId: 'willow', projectPublicKey: project.publicKey });
    expect(d.header.chunkBytes).toBe(CHUNK_BYTES);
    const { payload: out } = await openDonation(d.envelope, d.sealedKey, project.seed, { projectId: 'willow', donationId: d.header.donation });
    expect(decodePayload(out).values[0]?.value).toBe('A video');
  });

  it('refuses payloads that are not in the long format', () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const base = { format: 'combray-donation/1', tables: [], values: [] };
    expect(decodePayload(bytes(base)).values).toEqual([]);
    expect(() => decodePayload(bytes({ ...base, values: undefined, rows: [] }))).toThrow('unknown payload format');
    expect(() => decodePayload(bytes({ ...base, values: [{ table: 't', row: -1, field: 'f', path: [], value: 1 }] }))).toThrow('invalid value');
    expect(() => decodePayload(bytes({ ...base, values: [{ table: 't', row: 0, field: 'f', path: [], value: { x: 1 } }] }))).toThrow('invalid value');
    expect(() => decodePayload(bytes({ ...base, tables: [{ id: 't', name: 'T', columns: [] }] }))).toThrow('invalid table');
    const consent = { language: 'nl', information: 'Over het onderzoek', statements: ['Ik ben 16 of ouder.'] };
    expect(decodePayload(bytes({ ...base, consent })).consent).toEqual(consent);
    expect(() => decodePayload(bytes({ ...base, consent: { language: 'nl', statements: [1] } }))).toThrow('invalid consent');
    expect(() => decodePayload(bytes({ ...base, consent: { statements: [] } }))).toThrow('invalid consent');
    const questions = [{ id: 'q1', prompt: 'Hoe vaak?', options: ['Vaak', 'Soms'] }, { id: 'q2', prompt: 'Waarom?' }];
    expect(decodePayload(bytes({ ...base, answers: { q1: 'Often', q2: 'Daarom' }, questions })).questions).toEqual(questions);
    expect(() => decodePayload(bytes({ ...base, questions: [{ id: 'q1' }] }))).toThrow('invalid questions');
    expect(() => decodePayload(bytes({ ...base, questions: [{ id: 'q1', prompt: 'x', options: [1] }] }))).toThrow('invalid questions');
  });

  it('refuses tampering, truncation, the wrong key and the wrong donation', async () => {
    const project = await newProjectKey();
    const other = await newProjectKey();
    const d = await sealDonation(concat(payload, randomBytes(3000)), {
      projectId: 'willow',
      projectPublicKey: project.publicKey,
      chunkBytes: 1000,
    });
    const expect_ = { projectId: 'willow', donationId: d.header.donation };

    const flipped = concat(d.envelope);
    flipped[flipped.length - 5]! ^= 1;
    await expect(openDonation(flipped, d.sealedKey, project.seed, expect_)).rejects.toBeInstanceOf(InvalidEnvelope);

    const { offset } = readHeader(d.envelope);
    const firstChunkEnd = offset + 4 + new DataView(d.envelope.buffer).getUint32(offset);
    await expect(openDonation(d.envelope.slice(0, firstChunkEnd), d.sealedKey, project.seed, expect_)).rejects.toBeInstanceOf(
      InvalidEnvelope,
    );

    await expect(openDonation(d.envelope, d.sealedKey, other.seed, expect_)).rejects.toThrow();
    await expect(
      openDonation(d.envelope, d.sealedKey, project.seed, { projectId: 'willow', donationId: 'someone-else' }),
    ).rejects.toBeInstanceOf(InvalidEnvelope);

    // A sealed key from another donation does not open this one.
    const e = await sealDonation(payload, { projectId: 'willow', projectPublicKey: project.publicKey });
    await expect(openDonation(d.envelope, e.sealedKey, project.seed, expect_)).rejects.toThrow();
  });

  it('refuses payloads it does not understand', () => {
    expect(() => decodePayload(new TextEncoder().encode('{"format":"other"}'))).toThrow();
    expect(() =>
      decodePayload(new TextEncoder().encode('{"format":"combray-donation/1","tables":[{"id":"a","name":"a","columns":[],"rows":[[{}]]}]}')),
    ).toThrow();
  });
});
