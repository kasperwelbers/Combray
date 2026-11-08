import type { DonationEntry, NameMap } from '@combray/seal';
import { describe, expect, it } from 'vitest';

import { answersCsv, consentCsv, csvCell, donationsCsv, type Opened, questionsCsv, safeFileName } from '../src/decrypt';
import { exportDonations } from '../src/export';
import { assertionJson, creationOptions, registrationJson } from '../src/passkey';
import { crc32, zipFiles } from '../src/zip';
import { unzip } from './unzip';

const donation = (id: string, payload: Partial<Opened['payload']> = {}, answers?: Record<string, string>): Opened => ({
  id,
  day: '2026-11-01',
  payload: { format: 'combray-donation/2', entries: [], values: [], ...payload, ...(answers ? { answers } : {}) },
});

// A history with nested channels and tags, as donated with version 1.
const entries: DonationEntry[] = [
  { platform: 'yt', path: ['w.json', '[*]', 'title'], table: 'watch', field: 'title', rows: [{ table: 'watch', steps: 2 }], as: 'text' },
  { platform: 'yt', path: ['w.json', '[*]', 'subs', '[*]', 'name'], table: 'channels', field: 'name', rows: [{ table: 'watch', steps: 2 }, { table: 'channels', steps: 4 }] },
  { platform: 'yt', path: ['w.json', '[*]', 'tags', '[*]'], table: 'watch_tags', field: 'tags', rows: [{ table: 'watch', steps: 2 }, { table: 'watch_tags', steps: 4 }] },
  { platform: 'yt', path: ['w.json', '[*]', 'time'], table: 'watch', field: 'time', rows: [{ table: 'watch', steps: 2 }] },
];
const v1 = (id: string, values: Opened['payload']['values']) => donation(id, { version: 1, entries, values });

// The newest version calls the history `videos` and its title `video`, and no longer matches `time`.
const newest: NameMap = {
  format: 'combray-names/1',
  root: {
    c: [
      {
        m: ['w.json'],
        c: [
          {
            k: '[*]',
            t: 'videos',
            c: [
              { m: ['title'], f: 'video' },
              { m: ['subs'], c: [{ k: '[*]', t: 'channels', c: [{ m: ['name'], f: 'name' }] }] },
              { m: ['tags'], c: [{ k: '[*]', f: 'tags', l: 'videos_tags' }] },
            ],
          },
        ],
      },
    ],
  },
};

describe('the export', () => {
  const opened = [
    v1('d1', [
      [0, [0], 'one', 'Watched one'],
      [0, [1], 'two'],
      [1, [0, 0], 'Proust'],
      [1, [0, 1], 'Odette'],
      [2, [1, 0], 'tea'],
      [3, [0], '2024-03-01'],
    ]),
    v1('d2', [[0, [0], 'three']]),
  ];

  it('places values under the newest names, in relational tables with the ids of the rows they are in', () => {
    const out = exportDonations(opened, new Map([['yt', newest]]));
    expect([...out.tables.keys()]).toEqual(['yt-videos', 'yt-channels', 'yt-videos_tags']);
    expect(out.tables.get('yt-videos')!.csv).toBe(
      '.donation,.day,.version,.id,video,video (as in the file)\r\n' + 'd1,2026-11-01,1,1,one,Watched one\r\n' + 'd1,2026-11-01,1,2,two,\r\n' + 'd2,2026-11-01,1,1,three,\r\n',
    );
    expect(out.tables.get('yt-channels')!.csv).toBe('.donation,.day,.version,.id,.videos_id,name\r\nd1,2026-11-01,1,1,1,Proust\r\nd1,2026-11-01,1,2,1,Odette\r\n');
    expect(out.tables.get('yt-videos_tags')!.csv).toBe('.donation,.day,.version,.id,.videos_id,tags\r\nd1,2026-11-01,1,1,2,tea\r\n');
    // The time is deprecated: nothing in the newest version matches it, so it is left out.
    expect(out.values).not.toContain('2024-03-01');
    expect(out.deprecated).toEqual({ count: 1, leftOut: 1 });
    expect(out.fields).toContain('yt,videos,video,1,text\r\n');
  });

  it('gives deprecated values and the names values were donated as, when asked', () => {
    const out = exportDonations(opened, new Map([['yt', newest]]), { deprecated: true, original: true });
    const lines = out.values.split('\r\n');
    expect(lines[0]).toBe('donation,day,version,platform,table,field,row,path,value,as in the file,deprecated,donated table,donated field');
    expect(lines).toContain('d1,2026-11-01,1,yt,videos,video,1,w.json/[0]/title,one,Watched one,false,watch,title');
    expect(lines).toContain('d1,2026-11-01,1,yt,watch,time,,w.json/[0]/time,2024-03-01,,true,watch,time');
    expect(out.deprecated).toEqual({ count: 1, leftOut: 0 });
    // Deprecated values stay out of the tables.
    expect([...out.tables.values()].map((t) => t.csv).join('')).not.toContain('2024-03-01');
  });

  it('keeps the names values were donated with when there is no name map', () => {
    const out = exportDonations(opened, new Map());
    expect([...out.tables.keys()]).toEqual(['yt-watch', 'yt-channels', 'yt-watch_tags']);
    expect(out.tables.get('yt-watch')!.csv.split('\r\n')[0]).toBe('.donation,.day,.version,.id,title,title (as in the file),time');
    expect(out.deprecated.count).toBe(0);
  });

  it('neutralises formulas in the long list', () => {
    const out = exportDonations([v1('d1', [[0, [0], '=one']])], new Map([['yt', newest]]));
    expect(out.values.split('\r\n')[1]).toBe("d1,2026-11-01,1,yt,videos,video,1,w.json/[0]/title,'=one,");
  });
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

  it('lists each donation with the project version it was made with', () => {
    const csv = donationsCsv([donation('d1', { version: 3, consent: { language: 'nl', statements: [] } }), donation('d2')]);
    expect(csv).toBe('donation,day,version,language\r\nd1,2026-11-01,3,nl\r\nd2,2026-11-01,,\r\n');
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
