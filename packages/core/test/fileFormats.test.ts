// One test per case in docs/formats/, under the same id, with made-up data. A test of an open
// case describes what happens today; it changes when the case is solved.
import { describe, expect, it } from 'vitest';

import { extractShape, normalizeTree, parseEntries, parseFile, mergeDirs, prepareTree, uploadTree, type Shape, type TreeNode } from '../src';
import { treeOf } from './trees';

const bytes = (text: string) => new TextEncoder().encode(text);
const file = (name: string, text: string) => parseFile(name, bytes(text));
/** As the studio reads a researcher's own export: any header text may be a name. */
const studio = (tree: TreeNode) => normalizeTree(tree, { keys: () => true });
/** As a participant's device reads it for a project that knows nothing yet (put back as the upload, to compare). */
const participant = (tree: TreeNode) => extractShape(uploadTree(prepareTree(tree, treeOf(extractShape(studio(tree)))).prepared));

/** The shape at a path of names. */
function at(shape: Shape, ...names: string[]): Shape {
  let s = shape;
  for (const name of names) {
    const next = s.children?.find((c) => c.name === name);
    if (!next) throw new Error(`no ${name} below ${s.name} (${s.children?.map((c) => c.name).join(', ')})`);
    s = next;
  }
  return s;
}
const names = (s: Shape) => (s.children ?? []).map((c) => c.name);

describe('JSON (docs/formats/json.md)', () => {
  it('J1 keys that look like data are screened', () => {
    const shape = extractShape(file('a.json', '{"jan@example.org": 1, "likes": 2, "visits": 3}'));
    expect(names(shape)).toEqual(['<email>', 'likes', 'visits']);
    // When at least half of them look like data, the keys are data (J2).
    expect(extractShape(file('b.json', '{"jan@example.org": 1, "2024-01-03": 2, "visits": 3}')).collapsed).toBe(true);
  });

  it('J2 an object of people with values of the same shape is one position', () => {
    const people = Object.fromEntries(['anna', 'bob', 'carol', 'dave', 'eve'].map((n) => [n, { messages: [{ text: 'hi' }] }]));
    const shape = extractShape(file('a.json', JSON.stringify({ conversations: people })));
    expect(at(shape, 'conversations')).toMatchObject({ collapsed: true });
    expect(names(at(shape, 'conversations'))).toEqual(['{*}']);
  });

  it('J3 a few keys that are data: across many rows they are, in one small object they are not', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ text: `post ${i}`, comments: { [`person${i}`]: 'hi' } }));
    expect(at(extractShape(file('a.json', JSON.stringify(rows))), '[*]', 'comments').collapsed).toBe(true);
    const one = extractShape(file('b.json', '{"comments": {"anna": "hi", "bob": "hey"}}'));
    expect(names(at(one, 'comments'))).toEqual(['anna', 'bob']);
  });

  it('J4 (open) label and value objects are a two-column table', () => {
    const shape = extractShape(file('a.json', '{"label_values": [{"label": "URL", "value": "https://example.com"}, {"label": "Title", "value": "A page"}]}'));
    expect(names(at(shape, 'label_values', '[*]'))).toEqual(['label', 'value']);
  });

  it('J5 null next to a list is the same position', () => {
    const shape = extractShape(file('a.json', '[{"subtitles": null}, {"subtitles": [{"name": "A channel"}]}]'));
    expect(names(at(shape, '[*]'))).toEqual(['subtitles', 'subtitles']);
    expect(at(shape, '[*]').children!.map((c) => c.kind).sort()).toEqual(['list', 'value']);
  });

  it('J6 JSON inside a JavaScript file', () => {
    const tree = file('tweets.js', 'window.YTD.tweets.part0 = [{"text": "hi"}];');
    expect(names(at(extractShape(tree), '[*]'))).toEqual(['text']);
  });
});

describe('HTML and XML (docs/formats/html.md)', () => {
  const html = (body: string) => file('a.html', `<html><body>${body}</body></html>`);
  const body = (tree: TreeNode) => at(extractShape(studio(tree)), 'html', 'body');

  it('H1 repeated elements are a list; two different bare ones are numbered', () => {
    expect(names(body(html('<div class="row">a</div><div class="row">b</div>')))).toEqual(['div.row']);
    expect(at(body(html('<div class="row">a</div><div class="row">b</div>')), 'div.row').kind).toBe('list');
    expect(names(body(html('<div><a href="x">link</a></div><div>just text</div>')))).toEqual(['div[0]', 'div[1]']);
  });

  it('H2 text between links is named by position', () => {
    const cell = body(html('<div class="c">Watched <a href="https://example.com/v">A video</a><br><a href="https://example.com/c">A channel</a><br>3 Jan 2024</div>'));
    expect(names(at(cell, 'div.c'))).toEqual(['#text[0]', '#text[1]', 'a[0]', 'a[1]']);
  });

  it('H3 header text names columns in the studio, and only known names on a participant device', () => {
    const table = html('<table><thead><tr><th>Date</th><th>Title</th></tr></thead><tr><td>2024-01-03</td><td>A</td></tr><tr><td>2024-01-04</td><td>B</td></tr></table>');
    expect(names(at(body(table), 'table', '[*]'))).toEqual(['Date', 'Title']);
    expect(names(at(extractShape(normalizeTree(table)), 'html', 'body', 'table', '[*]'))).toEqual(['#cell[0]', '#cell[1]']);
    expect(names(at(participant(table), 'html', 'body', 'table', '[*]'))).toEqual(['Date', 'Title']);
  });

  it('H4 a first row is the header only with a sign', () => {
    const signed = html('<table><tr><td><b>Date</b></td><td><b>Title</b></td></tr><tr><td>2024-01-03</td><td>A</td></tr><tr><td>2024-01-04</td><td>B</td></tr></table>');
    expect(names(at(body(signed), 'table', '[*]'))).toEqual(['Date', 'Title']);
    const plain = html('<table><tr><td>Name</td><td>Title</td></tr><tr><td>Anna</td><td>A</td></tr><tr><td>Bob</td><td>B</td></tr></table>');
    expect(names(at(body(plain), 'table', '[*]'))).toEqual(['#cell[0]', '#cell[1]']);
  });

  it('H5 definition list terms are names, or positions when not known', () => {
    const dl = html('<dl><dt>URL</dt><dd>https://example.com</dd><dt>Title</dt><dd>A page</dd></dl>');
    expect(names(at(body(dl), 'dl'))).toEqual(['Title', 'URL']);
    expect(names(at(extractShape(normalizeTree(dl)), 'html', 'body', 'dl'))).toEqual(['#dd[0]', '#dd[1]', '#dt[0]', '#dt[1]']);
  });

  it('H6 labels and values that take turns land in one list (until marked, corrections.test.ts)', () => {
    const turns = html('<div class="entry"><span>url</span><span>https://example.com/1</span><span>title</span><span>A page</span></div>');
    expect(at(body(turns), 'div.entry', 'span')).toMatchObject({ kind: 'list' });
  });

  it('H7 labels beside values are two unrelated lists (until marked, corrections.test.ts)', () => {
    const beside = html('<div class="entry"><div><h1>url</h1><h1>title</h1></div><div><span>https://example.com/1</span><span>A page</span></div></div>');
    expect(names(at(body(beside), 'div.entry'))).toEqual(['div[0]', 'div[1]']);
    expect(at(body(beside), 'div.entry', 'div[0]', 'h1').kind).toBe('list');
  });

  it('H8 fixed words are a value of their own', () => {
    const rows = html('<div class="c">Watched <a href="x">A</a></div><div class="c">Searched for <a href="y">B</a></div>');
    expect(names(at(body(rows), 'div.c', '[*]'))).toContain('#text[0]');
  });

  it('H9 classes and ids that are data are screened, and ids that differ per row dropped', () => {
    expect(names(body(html('<div id="post-1700000000"><p>a</p></div>')))).toEqual(['div#<number>']);
    expect(names(body(html('<div class="user-jansmith_1234"><p>a</p></div>')))).toEqual(['div.<id>']);
    expect(names(body(html('<li id="a1">x</li><li id="a2">y</li>')))).toEqual(['li']);
  });

  it('H10 layout classes that differ between rows are dropped from the names inside them', () => {
    const rows = html('<div class="row"><p class="cell w-6">a</p></div><div class="row"><p class="cell w-12">b</p></div>');
    expect(names(at(body(rows), 'div.row', '[*]'))).toEqual(['p.cell']);
  });

  it('X1 (open) XML keeps only the attributes that are data in HTML', () => {
    const xml = file('export.xml', '<?xml version="1.0"?><HealthData><Record type="StepCount" value="1200" startDate="2024-01-03"/><Record type="StepCount" value="900" startDate="2024-01-04"/></HealthData>');
    expect(names(at(extractShape(studio(xml)), 'HealthData', 'Record', '[*]'))).toEqual(['@value']);
  });
});

describe('CSV (docs/formats/csv.md)', () => {
  it('C1 the first line names the columns', () => {
    expect(names(at(extractShape(file('a.csv', 'Date,Title\n2024-01-03,A\n')), '[*]'))).toEqual(['Date', 'Title']);
  });

  it('C2 (open) field and value columns are a two-column table', () => {
    expect(names(at(extractShape(file('a.csv', 'Field,Value\nUsername,jansmith\nCountry,NL\n')), '[*]'))).toEqual(['Field', 'Value']);
  });

  it('C3 empty and repeated headers', () => {
    expect(names(at(extractShape(file('a.csv', 'Date,,Title,Title\n1,2,3,4\n')), '[*]'))).toEqual(['Date', 'Title', 'Title_2', 'column_2']);
  });
});

describe('Files and folders (docs/formats/files.md)', () => {
  const folder = (paths: string[]) => parseEntries('', paths.map((path) => ({ path, bytes: bytes('{"text": "hi"}') })));

  it('F1 folders named after data are screened, and many alike are one position', () => {
    const shape = extractShape(folder(['inbox/anna_1234/message_1.json', 'inbox/bob_5678/message_1.json', 'inbox/carol_9012/message_1.json']));
    expect(at(shape, 'inbox')).toMatchObject({ collapsed: true });
    const days = extractShape(folder(['diary/2024-01-03.json', 'diary/2024-01-04.json']));
    expect(names(at(days, 'diary'))).toEqual(['{*}']);
  });

  it('F3 plain text is a list of lines', () => {
    const tree = file('notes.txt', 'first line\nsecond line\n');
    expect(tree).toMatchObject({ kind: 'list', children: [{ value: 'first line' }, { value: 'second line' }] });
  });

  it('F4 media are kept as a reference only', () => {
    expect(file('IMG_0001.jpg', 'not really a photo')).toEqual({ kind: 'blob', name: 'IMG_0001.jpg', mime: 'image/jpeg', size: 18 });
  });

  it('F5 split zips merge their folders', () => {
    const merged = mergeDirs('', [folder(['Takeout/YouTube/a.json']), folder(['Takeout/Chrome/b.json'])]);
    expect(names(at(extractShape(merged), 'Takeout'))).toEqual(['Chrome', 'YouTube']);
  });

  it('noise from macOS and Windows is left out', () => {
    expect(names(extractShape(folder(['__MACOSX/a.json', '.DS_Store', 'data.json'])))).toEqual(['data.json']);
  });
});
