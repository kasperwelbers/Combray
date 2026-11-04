import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { combineNodes, extractShape, jsonToTree, normalizeTree, parseEntries, suggestCombines } from '../src';
import { keyedTree, rebuild } from './trees';

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
    expect(pairs(suggestCombines(tree, shape))).toEqual([['[*]/~value:date', '[*]/timestamp']]);
  });

  it('does not pair values of different types, nodes that are both present, or unconfigured nodes', () => {
    const tree = keyedTree(extractShape(jsonToTree('a.json', [{ title: 'x', likes: 3 }])));
    expect(suggestCombines(tree, extractShape(jsonToTree('b.json', [{ title: 'y', when: '2024-02-01' }])))).toEqual([]);
    expect(suggestCombines(tree, extractShape(jsonToTree('b.json', [{ title: 'y', likes: 3, extra: 4 }])))).toEqual([]);
  });

  it('pairs translated folders by what is inside them', () => {
    const tree = keyedTree(fixtureShape('tiktok-2023'));
    expect(pairs(suggestCombines(tree, fixtureShape('tiktok-2025')))).toEqual([['~map:user_data_tiktok.json', 'user_data.json']]);
  });

  it('gives paths in the tree laid over both, so combining can be applied, and suggests their keys next', () => {
    const first = extractShape(jsonToTree('a.json', { 'Watch History': [{ Date: '2024-01-01 10:00:00', Link: 'https://t.example/v/1' }] }));
    const second = extractShape(jsonToTree('b.json', { 'Watch history': [{ date: '2024-01-01 10:00:00', link: 'https://t.example/v/1' }] }));
    const tree = rebuild(keyedTree(first), second);
    const [suggestion] = suggestCombines(tree, second);
    expect(suggestion).toMatchObject({ from: ['~list:Watch history'], into: ['Watch History'] });
    const combined = rebuild(combineNodes(tree, [suggestion!.into, suggestion!.from]).tree, second);
    expect(combined.children!.map((c) => [c.name, c.match])).toEqual([['Watch History', ['Watch History', 'Watch history']]]);
    // Their keys now sit side by side below the one node.
    expect(pairs(suggestCombines(combined, second)).sort()).toEqual([
      ['Watch History/[*]/~value:date', 'Watch History/[*]/Date'],
      ['Watch History/[*]/~value:link', 'Watch History/[*]/Link'],
    ]);
  });
});
