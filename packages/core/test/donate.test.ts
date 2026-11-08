import { placements, rowKey, valuePath } from '@combray/seal';
import { describe, expect, it } from 'vitest';

import {
  combineDonations,
  deriveTables,
  donationPayload,
  donationValues,
  extractShape,
  jsonToTree,
  nameMap,
  normalizeTree,
  setDecision,
  setKeysAreData,
  sideBySideProblem,
  unionShape,
  withoutRows,
  type DonationContent,
  type ProjectNode,
} from '../src';
import { parseMarkup } from '../src/parse/html';
import { at, keyedTree, nodeAt } from './trees';

const data = jsonToTree('', {
  'watch-history.json': [
    { title: 'Watched Madeleines', time: '2024-03-01T10:00:00Z', subtitles: [{ name: 'Proust' }], tags: ['tea', 'cake'] },
    { title: 'Watched Tea', time: '2024-03-02T11:00:00Z', details: [{ name: 'From Google Ads' }] },
  ],
  replies: { marcel: { text: 'hi' }, odette: { text: 'hello' } },
});

/** Every value's own placement is one the project's name map gives for its path. */
function expectPlaced(content: DonationContent, tree: ProjectNode) {
  const map = nameMap(tree);
  for (const v of content.values) {
    const entry = content.entries[v.entry]!;
    expect(placements(map, v.path)).toContainEqual({ table: entry.table, field: entry.field, rows: entry.rows });
    expect(placements(map, entry.path)).toContainEqual({ table: entry.table, field: entry.field, rows: entry.rows });
  }
}

describe('donationValues', () => {
  it('gives each asked-for value with its table, row, field and path, as read and raw on request', () => {
    let tree = keyedTree(extractShape(data));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'donate');
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'time'), 'show');
    const title = nodeAt(tree, 'watch-history.json', '[*]', 'title');
    title.transform = [{ replace: { pattern: '^Watched ', with: '' } }];
    title.raw = true;
    const content = donationValues(data, tree, deriveTables(tree), 'youtube');
    // Only what is asked for: the time is shown, not donated.
    expect(content.values).toEqual([
      { table: 'watch_history', row: 0, field: 'title', path: ['watch-history.json', '[0]', 'title'], value: 'Madeleines', raw: 'Watched Madeleines', source: 'Watched Madeleines', entry: 0 },
      { table: 'watch_history', row: 1, field: 'title', path: ['watch-history.json', '[1]', 'title'], value: 'Tea', raw: 'Watched Tea', source: 'Watched Tea', entry: 0 },
    ]);
    expect(content.entries).toEqual([
      { platform: 'youtube', path: ['watch-history.json', '[*]', 'title'], table: 'watch_history', field: 'title', rows: [{ table: 'watch_history', steps: 2 }] },
    ]);
    expect(content.tables).toEqual([{ id: 'watch_history', name: 'Watch history', fields: [{ id: 'title', name: 'Title' }] }]);
    expectPlaced(content, tree);
  });

  it('links nested rows to their parent row, and leaves filtered rows out', () => {
    let tree = keyedTree(extractShape(data));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'subtitles', '[*]', 'name'), 'donate');
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'donate');
    nodeAt(tree, 'watch-history.json', '[*]').filter = [{ column: 'details', test: { equals: 0 } }];
    const content = donationValues(data, tree, deriveTables(tree));
    expect(content.values.map((v) => [v.table, v.row, v.field, v.value, v.parent])).toEqual([
      ['watch_history', 0, 'title', 'Watched Madeleines', undefined],
      ['subtitles', 0, 'name', 'Proust', { table: 'watch_history', row: 0 }],
    ]);
    // The nested table's rows are told apart by their own item, within the item of the history.
    expect(content.entries[1]!.rows).toEqual([
      { table: 'watch_history', steps: 2 },
      { table: 'subtitles', steps: 4 },
    ]);
    expectPlaced(content, tree);
  });

  it('makes a list of plain values a table of its own for the export', () => {
    let tree = keyedTree(extractShape(data));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'tags', '[*]'), 'donate');
    const content = donationValues(data, tree, deriveTables(tree));
    expect(content.values.map((v) => [v.field, v.value, v.path.join('/')])).toEqual([
      ['tags', 'tea', 'watch-history.json/[0]/tags/[0]'],
      ['tags', 'cake', 'watch-history.json/[0]/tags/[1]'],
    ]);
    expect(content.entries[0]!.rows).toEqual([
      { table: 'watch_history', steps: 2 },
      { table: 'watch_history_tags', steps: 4 },
    ]);
    expectPlaced(content, tree);
  });

  it('writes keys that are data by position in paths, and donates them only as a key column', () => {
    let tree = keyedTree(extractShape(data));
    tree = setKeysAreData(tree, at(tree, 'replies'));
    tree = setDecision(tree, at(tree, 'replies', '{*}', 'text'), 'donate');
    const content = donationValues(data, tree, deriveTables(tree));
    expect(content.values.map((v) => v.path)).toEqual([
      ['replies', '{0}', 'text'],
      ['replies', '{1}', 'text'],
    ]);
    expect(JSON.stringify(content.values.map(({ source: _, ...v }) => v))).not.toMatch(/marcel|odette/);
    expect(JSON.stringify(content.entries)).not.toMatch(/marcel|odette/);
    tree = setDecision(tree, at(tree, 'replies', '{*}'), 'donate');
    const withKeys = donationValues(data, tree, deriveTables(tree));
    expect(withKeys.values.filter((v) => v.field === '{key}').map((v) => [v.value, v.path])).toEqual([
      ['marcel', ['replies', '{0}']],
      ['odette', ['replies', '{1}']],
    ]);
    expectPlaced(withKeys, tree);
  });

  it('never writes a key that looks like data into a path', () => {
    const mail = jsonToTree('', { contacts: { 'aunt.leonie@example.org': { since: '2020' } } });
    let tree = keyedTree(extractShape(mail));
    const contact = nodeAt(tree, 'contacts').children![0]!;
    tree = setDecision(tree, [...at(tree, 'contacts'), contact.id, contact.children![0]!.id], 'donate');
    const content = donationValues(mail, tree, deriveTables(tree));
    expect(JSON.stringify(content.entries) + JSON.stringify(content.values.map((v) => v.path))).not.toMatch(/leonie/);
  });

  it('gives HTML elements their shape name, and a single element where others have a list the item [0]', () => {
    const page = (cells: string) => normalizeTree(parseMarkup('page.html', `<html><body><div class="post"><p class="title">A</p>${cells}</div></body></html>`));
    const two = page('<div class="like">x</div><div class="like">y</div>');
    const one = page('<div class="like">z</div>');
    let tree = keyedTree(unionShape([extractShape(two), extractShape(one)])!);
    tree = setDecision(tree, at(tree, 'html', 'body', 'div.post', 'div.like', '[*]', '#text[0]'), 'donate');
    tree = setDecision(tree, at(tree, 'html', 'body', 'div.post', 'p.title', '#text[0]'), 'donate');
    const fromOne = donationValues(one, tree, deriveTables(tree));
    expect(fromOne.values.map((v) => v.path.join('/'))).toEqual(['html/body/div.post/p.title/#text[0]', 'html/body/div.post/div.like/[0]/#text[0]']);
    const fromTwo = donationValues(two, tree, deriveTables(tree));
    expect(fromTwo.values.map((v) => v.path.join('/'))).toContain('html/body/div.post/div.like/[1]/#text[0]');
    expectPlaced(fromOne, tree);
    // A donation made before the list was known, without the item step, still finds the table.
    const map = nameMap(tree);
    expect(placements(map, ['html', 'body', 'div.post', 'div.like', '#text[0]'])[0]).toMatchObject({ rows: [{ steps: 4 }] });
  });

  it('lists the rows with their paths and hashes, to leave some out, nested rows with them', () => {
    let tree = keyedTree(extractShape(data));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'subtitles', '[*]', 'name'), 'donate');
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'donate');
    const content = donationValues(data, tree, deriveTables(tree));
    expect(content.rows.map((r) => [r.table, r.row, r.path])).toEqual([
      ['watch_history', 0, ['watch-history.json', '[0]']],
      ['watch_history', 1, ['watch-history.json', '[1]']],
      ['subtitles', 0, ['watch-history.json', '[0]', 'subtitles', '[0]']],
    ]);
    // Leaving out the first video leaves out its subtitles too.
    const left = withoutRows(content, (r) => r.path.join('/') === 'watch-history.json/[0]');
    expect(left.values.map((v) => v.value)).toEqual(['Watched Tea']);
    expect(left.tables.map((t) => t.id)).toEqual(['watch_history']);
    expect(left.rows).toHaveLength(1);
  });

  it('knows a row by what it is: the same after asking for more, or after a new upload with more rows', () => {
    let tree = keyedTree(extractShape(data));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'donate');
    const before = donationValues(data, tree, deriveTables(tree)).rows.map((r) => r.hash);
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'time'), 'donate');
    expect(donationValues(data, tree, deriveTables(tree)).rows.map((r) => r.hash)).toEqual(before);
    const more = jsonToTree('', {
      'watch-history.json': [{ title: 'Watched Lime blossoms', time: '2024-02-01T10:00:00Z' }, ...(JSON.parse(JSON.stringify(rowsOf(data))) as object[])],
    });
    const after = donationValues(more, tree, deriveTables(tree)).rows.map((r) => r.hash);
    expect(after.slice(1)).toEqual(before);
    expect(new Set(after).size).toBe(3);
  });

  it('combines uploads into one donation, numbering rows on and sharing entries', () => {
    let tree = keyedTree(extractShape(data));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'subtitles', '[*]', 'name'), 'donate');
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'donate');
    const one = donationValues(data, tree, deriveTables(tree));
    const both = combineDonations([one, one]);
    expect(both.tables).toEqual(one.tables);
    expect(both.entries).toEqual(one.entries);
    expect(both.values.filter((v) => v.field === 'title').map((v) => v.row)).toEqual([0, 1, 2, 3]);
    expect(both.values.filter((v) => v.field === 'name').map((v) => [v.row, v.parent])).toEqual([
      [0, { table: 'watch_history', row: 0 }],
      [1, { table: 'watch_history', row: 2 }],
    ]);
  });
});

describe('donationPayload', () => {
  const many = jsonToTree('', {
    'watch-history.json': ['a', 'b', 'c', 'd', 'e'].map((title) => ({ title, subtitles: [{ name: `${title}1` }, { name: `${title}2` }] })),
  });

  it('sends each path once, and numbers positions again without gaps, keeping their order', () => {
    let tree = keyedTree(extractShape(many));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'donate');
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'subtitles', '[*]', 'name'), 'donate');
    const content = donationValues(many, tree, deriveTables(tree), 'youtube');
    // The participant leaves out videos b and d, and the first subtitle of e.
    const kept = withoutRows(content, (r) => ['watch-history.json/[1]', 'watch-history.json/[3]', 'watch-history.json/[4]/subtitles/[0]'].includes(r.path.join('/')));
    const payload = donationPayload(kept, { version: 3 });
    expect(payload.format).toBe('combray-donation/2');
    expect(payload.version).toBe(3);
    expect(payload.entries.map((e) => e.path.join('/'))).toEqual(['watch-history.json/[*]/title', 'watch-history.json/[*]/subtitles/[*]/name']);
    const sent = payload.values.map(([entry, positions, value]) => [valuePath(payload.entries[entry]!, positions).join('/'), value]);
    expect(sent).toEqual([
      ['watch-history.json/[0]/title', 'a'],
      ['watch-history.json/[1]/title', 'c'],
      ['watch-history.json/[2]/title', 'e'],
      ['watch-history.json/[0]/subtitles/[0]/name', 'a1'],
      ['watch-history.json/[0]/subtitles/[1]/name', 'a2'],
      ['watch-history.json/[1]/subtitles/[0]/name', 'c1'],
      ['watch-history.json/[1]/subtitles/[1]/name', 'c2'],
      ['watch-history.json/[2]/subtitles/[0]/name', 'e2'],
    ]);
    // Nothing of the rows left out, and nothing only for this device.
    expect(JSON.stringify(payload)).not.toMatch(/"b"|"d"|e1|hash|source/);
  });
});

function rowsOf(tree: ReturnType<typeof jsonToTree>): unknown[] {
  const list = (tree as { children: { name: string; children: unknown[] }[] }).children.find((c) => c.name === 'watch-history.json')!;
  const plain = (n: { kind: string; value?: unknown; children?: { name: string }[] }): unknown =>
    n.kind === 'list'
      ? (n.children ?? []).map((c) => plain(c as never))
      : n.kind === 'map'
        ? Object.fromEntries((n.children ?? []).map((c) => [c.name, plain(c as never)]))
        : n.value;
  return plain(list as never) as unknown[];
}

describe('lists side by side', () => {
  const engagement = jsonToTree('', {
    'posts.json': [
      { text: 'Tea', engagement: { count: '3', liked_by: ['bob', 'ann', 'kim'], shared_by: [{ name: 'eve' }] } },
      { text: 'Cake', engagement: { count: 0, liked_by: [], shared_by: [] } },
    ],
  });

  function sideBySide() {
    let tree = keyedTree(extractShape(engagement));
    for (const leaf of [['liked_by', '[*]'], ['shared_by', '[*]', 'name'], ['count']]) {
      tree = setDecision(tree, at(tree, 'posts.json', '[*]', 'engagement', ...leaf), 'donate');
    }
    tree = setDecision(tree, at(tree, 'posts.json', '[*]', 'text'), 'donate');
    nodeAt(tree, 'posts.json', '[*]', 'engagement').sideBySide = true;
    return tree;
  }

  it('reads an object with two lists as one table, item i of each list in row i, nothing repeated', () => {
    const tree = sideBySide();
    const tables = deriveTables(tree);
    const table = tables.find((t) => t.sideBySide)!;
    expect(table.id).toBe('engagement');
    expect(table.columns.map((c) => [c.id, c.type])).toEqual([
      ['count', 'value'],
      ['liked_by', 'value'],
      ['name', 'value'],
    ]);
    const content = donationValues(engagement, tree, tables, 'x');
    const rows = (row: number) => Object.fromEntries(content.values.filter((v) => v.table === 'engagement' && v.row === row).map((v) => [v.field, v.value]));
    expect(rows(0)).toEqual({ count: '3', liked_by: 'bob', name: 'eve' });
    expect(rows(1)).toEqual({ liked_by: 'ann' });
    expect(rows(2)).toEqual({ liked_by: 'kim' });
    // The second post has no items, but its count is a row of its own.
    expect(rows(3)).toEqual({ count: '0' });
    expect(content.values.find((v) => v.field === 'liked_by' && v.value === 'ann')?.parent).toEqual({ table: 'posts', row: 0 });
    expectPlaced(content, tree);
  });

  it('places side-by-side values in the same rows on the key page', () => {
    const tree = sideBySide();
    const content = donationValues(engagement, tree, deriveTables(tree), 'x');
    const map = nameMap(tree);
    const key = (path: string[]) => {
      const [p] = placements(map, path).filter((p) => p.table === 'engagement');
      return p!.rows.map((g) => rowKey(path, g)).join('|');
    };
    const bob = content.values.find((v) => v.value === 'bob')!;
    const eve = content.values.find((v) => v.value === 'eve')!;
    const count = content.values.find((v) => v.field === 'count' && v.value === '3')!;
    const ann = content.values.find((v) => v.value === 'ann')!;
    expect(key(bob.path)).toBe(key(eve.path));
    expect(key(bob.path)).toBe(key(count.path));
    expect(key(ann.path)).not.toBe(key(bob.path));
  });

  it('gives each row its own hash, and is only offered for objects with two or more flat lists', () => {
    const tree = sideBySide();
    const content = donationValues(engagement, tree, deriveTables(tree), 'x');
    const hashes = content.rows.filter((r) => r.table === 'engagement').map((r) => r.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(sideBySideProblem(nodeAt(tree, 'posts.json', '[*]', 'engagement'))).toBeUndefined();
    expect(sideBySideProblem(nodeAt(tree, 'posts.json', '[*]'))).toBeDefined();
    expect(sideBySideProblem(nodeAt(tree, 'posts.json', '[*]', 'engagement', 'liked_by'))).toBeDefined();
  });
});
