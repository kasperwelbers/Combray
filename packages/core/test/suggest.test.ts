import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { combineNodes, extractShape, includeAll, jsonToTree, normalizeTree, parseEntries, suggestCombines, suggestGroups, unionShape } from '../src';
import { fileOf, keyedTree, rebuild, treeOf } from './trees';

const fixtures = new URL('../../../importers/fixtures/', import.meta.url).pathname;

function fixtureShape(name: string) {
  const input = join(fixtures, name, 'input');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const tree = parseEntries(
    name,
    files(input).map((path) => ({ path: relative(input, path), bytes: new Uint8Array(readFileSync(path)) })),
  );
  // The fixture's input folder as a picked folder: the folder is the nameless root.
  return extractShape(normalizeTree({ ...tree, name: '' }));
}

const pairs = (s: { from: string[]; into: string[] }[]) => s.map((x) => [x.from.join('/'), x.into.join('/')]);

describe('suggestCombines', () => {
  it('pairs a renamed key with the configured key it replaces', () => {
    const tree = keyedTree(extractShape(jsonToTree('a.json', [{ title: 'x', timestamp: '2024-01-01T10:00:00Z' }])));
    const shape = extractShape(jsonToTree('b.json', [{ title: 'y', date: '2024-02-01T11:00:00Z' }]));
    // Inside the content of the file that is the upload (the group `export`).
    expect(pairs(suggestCombines(tree, shape))).toEqual([['export/export/[*]/~value:date', 'export/export/[*]/timestamp']]);
  });

  it('pairs with parts seen before that nobody has configured yet', () => {
    const tree = treeOf(extractShape(jsonToTree('a.json', [{ title: 'x', timestamp: '2024-01-01T10:00:00Z' }])));
    const shape = extractShape(jsonToTree('b.json', [{ title: 'y', date: '2024-02-01T11:00:00Z' }]));
    expect(pairs(suggestCombines(tree, shape))).toEqual([['g-export/~list:export/~map:[*]/~value:date', 'g-export/~list:export/~map:[*]/~value:timestamp']]);
  });

  it('does not pair values of different types, or nodes that are both present', () => {
    const tree = keyedTree(extractShape(jsonToTree('a.json', [{ title: 'x', likes: 3 }])));
    expect(suggestCombines(tree, extractShape(jsonToTree('b.json', [{ title: 'y', when: '2024-02-01' }])))).toEqual([]);
    expect(suggestCombines(tree, extractShape(jsonToTree('b.json', [{ title: 'y', likes: 3, extra: 4 }])))).toEqual([]);
  });

  it('suggests the group a renamed file belongs to, by what is inside it', () => {
    const first = fixtureShape('tiktok-2023');
    const seen = unionShape([first, fixtureShape('tiktok-2025')])!;
    expect(suggestGroups(includeAll(first).root, seen)).toEqual([{ file: ['user_data_tiktok.json'], group: 'user_data', score: expect.any(Number) }]);
    // Files every group reads get no suggestion.
    expect(suggestGroups(includeAll(seen).root, seen)).toEqual([]);
  });

  it('gives paths in the tree laid over both, so combining can be applied, and suggests their keys next', () => {
    const first = extractShape(jsonToTree('a.json', { 'Watch History': [{ Date: '2024-01-01 10:00:00', Link: 'https://t.example/v/1' }] }));
    const second = extractShape(jsonToTree('b.json', { 'Watch history': [{ date: '2024-01-01 10:00:00', link: 'https://t.example/v/1' }] }));
    const tree = rebuild(keyedTree(first), second);
    const [suggestion] = suggestCombines(tree, second);
    expect(suggestion).toMatchObject({ from: ['export', 'export', '~list:Watch history'], into: ['export', 'export', 'Watch History'] });
    const combined = rebuild(combineNodes(tree, [suggestion!.into, suggestion!.from]).tree, second);
    expect(fileOf(combined).children!.map((c) => [c.name, c.match])).toEqual([['Watch History', ['Watch History', 'Watch history']]]);
    // Their keys now sit side by side below the one node.
    expect(pairs(suggestCombines(combined, second)).sort()).toEqual([
      ['export/export/Watch History/[*]/~value:date', 'export/export/Watch History/[*]/Date'],
      ['export/export/Watch History/[*]/~value:link', 'export/export/Watch History/[*]/Link'],
    ]);
  });
});
