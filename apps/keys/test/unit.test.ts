import { describe, expect, it } from 'vitest';

import { answersCsv, consentCsv, csvCell, donationsCsv, type Opened, questionsCsv, safeFileName, toCsv, valuesCsv } from '../src/decrypt';
import { assertionJson, creationOptions, registrationJson } from '../src/passkey';
import { crc32, zipFiles } from '../src/zip';
import { unzip } from './unzip';

const donation = (id: string, payload: Partial<Opened['payload']> = {}, answers?: Record<string, string>): Opened => ({
  id,
  day: '2026-11-01',
  payload: { format: 'combray-donation/1', tables: [], values: [], ...payload, ...(answers ? { answers } : {}) },
});

const watch = { id: 't', name: 'Watch', fields: [{ id: 'title', name: 'Title' }] };
const value = (row: number, field: string, v: string, more: object = {}) => ({ table: 't', row, field, path: ['w.json', `[${row}]`, field], value: v, ...more });

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

  it('lists each donation with the project version it was made with', () => {
    const csv = donationsCsv([donation('d1', { version: 3, consent: { language: 'nl', statements: [] } }), donation('d2')]);
    expect(csv).toBe('donation,day,version,language\r\nd1,2026-11-01,3,nl\r\nd2,2026-11-01,,\r\n');
  });

  it('pivots values into one table across donations, with fields added later and raw values', () => {
    const out = toCsv([
      donation('d1', { tables: [watch], values: [value(0, 'title', 'one'), value(1, 'title', 'two')] }),
      donation('d2', {
        tables: [{ ...watch, fields: [{ id: 'channel', name: 'Channel' }, { id: 'title', name: 'Title' }] }],
        values: [value(0, 'channel', 'c'), value(0, 'title', 'three', { raw: 'Watched three' })],
      }),
    ]);
    expect(out.get('t')!.csv).toBe(
      'donation,day,row,Title,Title (as in the file),Channel\r\n' +
        'd1,2026-11-01,0,one,,\r\n' +
        'd1,2026-11-01,1,two,,\r\n' +
        'd2,2026-11-01,0,three,Watched three,c\r\n',
    );
  });

  it('keeps nested rows with the row they are in, and lists as JSON', () => {
    const out = toCsv([
      donation('d1', {
        tables: [watch, { id: 'c', name: 'Channels', fields: [{ id: 'name', name: 'Name' }] }],
        values: [
          value(0, 'title', 'one'),
          { table: 'c', row: 0, parent: { table: 't', row: 0 }, field: 'name', path: [], value: 'Proust' },
          { table: 'c', row: 0, parent: { table: 't', row: 0 }, field: 'name', path: [], value: 'Odette' },
        ],
      }),
    ]);
    expect(out.get('c')!.csv).toBe('donation,day,row,in row,Name\r\nd1,2026-11-01,0,0,"[""Proust"",""Odette""]"\r\n');
  });

  it('lists every value with its path in long format', () => {
    const csv = valuesCsv([donation('d1', { tables: [watch], values: [value(0, 'title', '=one', { raw: 'x' })] })]);
    expect(csv).toBe(
      'donation,day,table,row,parent table,parent row,field,path,value,as in the file\r\nd1,2026-11-01,t,0,,,title,w.json/[0]/title,\'=one,x\r\n',
    );
  });

  it('writes one answers row per donation', () => {
    const csv = answersCsv([donation('d1', {}, { q1: 'yes' }), donation('d2', {}, { q2: '=no' })]);
    expect(csv).toBe(`donation,day,q1,q2\r\nd1,2026-11-01,yes,\r\nd2,2026-11-01,,'=no\r\n`);
    expect(answersCsv([donation('d1')])).toBeUndefined();
  });

  it('writes one consent row per statement agreed to, in the language it was read in', () => {
    const csv = consentCsv([
      donation('d1', { consent: { language: 'nl', statements: ['Ik ben 16 of ouder.', 'Ik heb bekeken wat ik deel.'] } }),
      donation('d2'),
    ]);
    expect(csv).toBe('donation,day,language,statement\r\nd1,2026-11-01,nl,Ik ben 16 of ouder.\r\nd1,2026-11-01,nl,Ik heb bekeken wat ik deel.\r\n');
    expect(consentCsv([donation('d2')])).toBeUndefined();
  });

  it('writes the questions as each participant read them', () => {
    const questions = [{ id: 'q1', prompt: 'Hoe vaak?', options: ['Vaak', 'Soms'] }, { id: 'q2', prompt: 'Waarom?' }];
    const csv = questionsCsv([donation('d1', { consent: { language: 'nl', statements: [] }, questions }), donation('d2')]);
    expect(csv).toBe('donation,day,language,question,prompt,options\r\nd1,2026-11-01,nl,q1,Hoe vaak?,Vaak | Soms\r\nd1,2026-11-01,nl,q2,Waarom?,\r\n');
    expect(questionsCsv([donation('d2')])).toBeUndefined();
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

describe('the export zip', () => {
  it('holds the files as they are, with their names in UTF-8', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const zip = zipFiles([
      { name: 'table-watch.csv', text: 'donation,day\r\nd1,2026-11-01\r\n' },
      { name: 'ëxport.json', text: '[]' },
    ]);
    expect(unzip(zip)).toEqual({ 'table-watch.csv': 'donation,day\r\nd1,2026-11-01\r\n', 'ëxport.json': '[]' });
    // The end of the central directory counts the files.
    expect(new DataView(zip.buffer).getUint16(zip.length - 12, true)).toBe(2);
  });
});
