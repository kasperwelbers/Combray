import { describe, expect, it } from 'vitest';

import { answersCsv, csvCell, type Opened, safeFileName, toCsv } from '../src/decrypt';
import { assertionJson, creationOptions, registrationJson } from '../src/passkey';

const donation = (id: string, tables: Opened['payload']['tables'], answers?: Record<string, string>): Opened => ({
  id,
  day: '2026-11-01',
  payload: { format: 'combray-donation/1', tables, answers },
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas and quotes when needed', () => {
    expect(csvCell('=SUM(A1)')).toBe(`'=SUM(A1)`);
    expect(csvCell('+31 6')).toBe(`'+31 6`);
    expect(csvCell('-1')).toBe(`'-1`);
    expect(csvCell('@user')).toBe(`'@user`);
    expect(csvCell('\tx')).toBe(`'\tx`);
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(null)).toBe('');
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
  });

  it('merges tables across donations and pads columns added later', () => {
    const out = toCsv([
      donation('d1', [{ id: 't', name: 'Watch', columns: ['title'], rows: [['one']] }]),
      donation('d2', [{ id: 't', name: 'Watch', columns: ['channel', 'title'], rows: [['c', 'two']] }]),
    ]);
    expect(out.get('t')!.csv).toBe('donation,day,title,channel\r\nd1,2026-11-01,one,\r\nd2,2026-11-01,two,c\r\n');
  });

  it('writes one answers row per donation', () => {
    const csv = answersCsv([donation('d1', [], { q1: 'yes' }), donation('d2', [], { q2: '=no' })]);
    expect(csv).toBe(`donation,day,q1,q2\r\nd1,2026-11-01,yes,\r\nd2,2026-11-01,,'=no\r\n`);
    expect(answersCsv([donation('d1', [])])).toBeUndefined();
  });

  it('makes safe file names', () => {
    expect(safeFileName('../Watch history/2026')).toBe('Watch-history-2026');
    expect(safeFileName('???')).toBe('table');
  });
});

describe('passkey JSON', () => {
  const buffer = (...bytes: number[]) => new Uint8Array(bytes).buffer;

  it('never sends client extension results (the PRF output) to the server', () => {
    const credential = {
      id: 'AQI',
      rawId: buffer(1, 2),
      type: 'public-key',
      response: { attestationObject: buffer(3), clientDataJSON: buffer(4), getTransports: () => ['internal'] },
      getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: buffer(9, 9, 9) } } }),
    } as unknown as PublicKeyCredential;
    const json = registrationJson(credential);
    expect(json.extensions).toEqual({});
    expect(JSON.stringify(json)).not.toContain('prf');

    const assertion = {
      id: 'AQI',
      rawId: buffer(1, 2),
      type: 'public-key',
      response: { authenticatorData: buffer(5), clientDataJSON: buffer(6), signature: buffer(7), userHandle: null },
      getClientExtensionResults: () => ({ prf: { results: { first: buffer(9) } } }),
    } as unknown as PublicKeyCredential;
    expect(assertionJson(assertion)).toEqual({
      id: 'AQI',
      rawId: 'AQI',
      type: 'public-key',
      response: { authenticatorData: 'BQ', clientDataJSON: 'Bg', signature: 'Bw', userHandle: null },
      extensions: {},
    });
  });

  it('adds the PRF salt to the server options', () => {
    const salt = new Uint8Array(32).fill(7);
    const options = creationOptions(
      { publicKey: { challenge: 'AQ', user: { id: 'Ag', name: 'a', displayName: 'a' }, rp: { id: 'keys.example', name: 'x' }, extensions: { credProps: true } } },
      salt,
    );
    expect(new Uint8Array(options.publicKey!.challenge as ArrayBuffer)).toEqual(new Uint8Array([1]));
    expect(options.publicKey!.extensions).toEqual({ credProps: true, prf: { eval: { first: salt } } });
  });
});
