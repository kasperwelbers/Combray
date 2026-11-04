import { describe, expect, it } from 'vitest';

import { deriveTables, donationValues, extractShape, jsonToTree, setDecision, setKeysAreData } from '../src';
import { at, keyedTree, nodeAt } from './trees';

const data = jsonToTree('', {
  'watch-history.json': [
    { title: 'Watched Madeleines', time: '2024-03-01T10:00:00Z', subtitles: [{ name: 'Proust' }] },
    { title: 'Watched Tea', time: '2024-03-02T11:00:00Z', details: [{ name: 'From Google Ads' }] },
  ],
  replies: { marcel: { text: 'hi' }, odette: { text: 'hello' } },
});

describe('donationValues', () => {
  it('gives each asked-for value with its table, row, field and path, as read and raw on request', () => {
    let tree = keyedTree(extractShape(data));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'donate');
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'time'), 'show');
    const title = nodeAt(tree, 'watch-history.json', '[*]', 'title');
    title.transform = [{ replace: { pattern: '^Watched ', with: '' } }];
    title.raw = true;
    const { tables, values } = donationValues(data, tree, deriveTables(tree));
    // Only what is asked for: the time is shown, not donated.
    expect(values).toEqual([
      { table: 'watch-history.json/[*]', row: 0, field: 'title', path: ['watch-history.json', '[0]', 'title'], value: 'Madeleines', raw: 'Watched Madeleines' },
      { table: 'watch-history.json/[*]', row: 1, field: 'title', path: ['watch-history.json', '[1]', 'title'], value: 'Tea', raw: 'Watched Tea' },
    ]);
    expect(tables).toEqual([{ id: 'watch-history.json/[*]', name: 'watch-history.json', fields: [{ id: 'title', name: 'title' }] }]);
  });

  it('links nested rows to their parent row, and leaves filtered rows out', () => {
    let tree = keyedTree(extractShape(data));
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'subtitles', '[*]', 'name'), 'donate');
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'donate');
    nodeAt(tree, 'watch-history.json', '[*]').filter = [{ column: 'details/[*]', test: { equals: 0 } }];
    const { values } = donationValues(data, tree, deriveTables(tree));
    expect(values.map((v) => [v.table, v.row, v.field, v.value, v.parent])).toEqual([
      ['watch-history.json/[*]', 0, 'title', 'Watched Madeleines', undefined],
      ['watch-history.json/[*]/subtitles/[*]', 0, 'name', 'Proust', { table: 'watch-history.json/[*]', row: 0 }],
    ]);
  });

  it('writes keys that are data by position in paths, and donates them only as a key column', () => {
    let tree = keyedTree(extractShape(data));
    tree = setKeysAreData(tree, at(tree, 'replies'));
    tree = setDecision(tree, at(tree, 'replies', '{*}', 'text'), 'donate');
    const { values } = donationValues(data, tree, deriveTables(tree));
    expect(values.map((v) => v.path)).toEqual([
      ['replies', '{0}', 'text'],
      ['replies', '{1}', 'text'],
    ]);
    expect(JSON.stringify(values)).not.toMatch(/marcel|odette/);
    tree = setDecision(tree, at(tree, 'replies', '{*}'), 'donate');
    const withKeys = donationValues(data, tree, deriveTables(tree)).values;
    expect(withKeys.filter((v) => v.field === '{key}').map((v) => [v.value, v.path])).toEqual([
      ['marcel', ['replies', '{0}']],
      ['odette', ['replies', '{1}']],
    ]);
  });
});
