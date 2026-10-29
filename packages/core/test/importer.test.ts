import { describe, expect, it } from 'vitest';

import { createSandbox, matchingImporters, parseFile, parseSpec, runImporter, SpecError } from '../src';
import { takeout } from './fixtures';

const watchHistory = parseSpec(`
id: test/youtube-watch-history
version: 1
name: { en: YouTube watch history, nl: YouTube kijkgeschiedenis }
match:
  file: "**/{watch-history.json,kijkgeschiedenis.json}"
select:
  rows: "[*]"
  fields:
    title:
      path: title
      transform:
        - replace: { pattern: "^Watched ", with: "" }
    url: { path: titleUrl, as: url }
    channel: { path: "subtitles/[0]/name" }
    channels: { path: "subtitles/[*]/name", all: true }
    date: { path: time, as: datetime }
    video_id:
      from: url
      script: "(url) => url?.match(/[?&]v=([^&]+)/)?.[1] ?? null"
where: "url != null"
display: { date: date, title: title, url: url, group_by: [channel] }
`);

const searches = parseSpec(`
id: test/google-search
version: 1
name: Google searches
match: { file: "**/My Activity/Search/MyActivity.html" }
select:
  rows: "**/div.outer-cell"
  fields:
    query: { path: "**/a" }
    url: { path: "**/a/@href" }
    date: { path: "div.content-cell/#text", nth: 1, as: datetime }
`);

describe('runImporter', () => {
  it('selects rows and fields, converts, filters and runs scripts', async () => {
    const sandbox = await createSandbox();
    const result = runImporter(takeout, watchHistory, sandbox);
    sandbox.dispose();
    expect(result.files).toEqual([['Takeout', 'YouTube and YouTube Music', 'history', 'watch-history.json']]);
    expect(result.filtered).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      {
        title: 'How to bake madeleines',
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        channel: 'Aunt Leonie Bakes',
        channels: ['Aunt Leonie Bakes'],
        date: '2024-03-01T09:15:00.000Z',
        video_id: 'aaaaaaaaaaa',
      },
      {
        title: 'Lime blossom tea',
        url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
        channel: 'Tisane Channel',
        channels: ['Tisane Channel', 'Combray Kitchen'],
        date: '2024-03-02T18:40:00.000Z',
        video_id: 'bbbbbbbbbbb',
      },
    ]);
  });

  it('reads HTML exports', () => {
    const result = runImporter(takeout, searches);
    expect(result.rows).toEqual([
      { query: 'hawthorn', url: 'https://www.google.com/search?q=hawthorn', date: '2024-03-04T10:20:30' },
      { query: 'steeple', url: 'https://www.google.com/search?q=steeple', date: '2024-03-05T11:00:00' },
    ]);
  });

  it('works on a single imported file', async () => {
    const file = parseFile('kijkgeschiedenis.json', new TextEncoder().encode('[{"title": "Watched x", "titleUrl": "https://www.youtube.com/watch?v=c"}]'));
    const sandbox = await createSandbox();
    expect(runImporter(file, watchHistory, sandbox).rows).toHaveLength(1);
    sandbox.dispose();
  });

  it('records script errors per row and keeps going', async () => {
    const spec = parseSpec(`
id: t/err
version: 1
name: t
match: { file: "**/watch-history.json" }
select:
  rows: "[*]"
  fields:
    title: { path: title }
    n: { from: title, script: "(t) => t.missing.length" }
`);
    const sandbox = await createSandbox();
    const result = runImporter(takeout, spec, sandbox);
    sandbox.dispose();
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.n === null)).toBe(true);
    expect(result.errors[0]).toMatchObject({ row: 0, field: 'n' });
  });

  it('needs a sandbox for scripts', () => {
    expect(() => runImporter(takeout, watchHistory)).toThrow(/sandbox/);
  });

  it('finds matching importers', () => {
    expect(matchingImporters(takeout, [watchHistory, searches]).map((s) => s.id)).toEqual([
      'test/youtube-watch-history',
      'test/google-search',
    ]);
    expect(matchingImporters({ kind: 'dir', name: 'x', children: [] }, [watchHistory])).toEqual([]);
  });
});

describe('parseSpec', () => {
  const base = `id: t\nversion: 1\nname: t\nmatch: { file: "**/a.json" }\n`;
  it.each([
    ['id: t', /version/],
    [`${base}select: { rows: "[*]", fields: { a: { path: x, from: y } } }`, /exactly one/],
    [`${base}select: { rows: "[*]", fields: { a: { from: b } } }`, /earlier field/],
    [`${base}select: { rows: "[*]", fields: { a: { path: x, as: money } } }`, /unknown type/],
    [`${base}select: { rows: "[*]", fields: { a: { path: x, transform: [shout] } } }`, /unknown transform/],
    [`${base}select: { rows: "[*]", fields: { a: { path: "[x]" } } }`, /invalid path/],
    [`${base}select: { rows: "[*]", fields: { a: { path: x } } }\nwhere: "a =="`, /where/],
    [`${base}select: { rows: "[*]", fields: { a: { path: x } } }\ndisplay: { date: b }`, /not a field/],
  ])('rejects invalid specs (%#)', (source, message) => {
    expect(() => parseSpec(source)).toThrow(SpecError);
    expect(() => parseSpec(source)).toThrow(message);
  });
});
