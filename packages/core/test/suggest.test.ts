import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractShape,
  getNode,
  jsonToTree,
  mergeNodes,
  mergeShape,
  normalizeTree,
  parseEntries,
  projectTreeFromShape,
  suggestAfterMerge,
  suggestMerges,
  uploadRoot,
} from '../src';

const fixtures = new URL('../../../importers/fixtures/', import.meta.url).pathname;

function fixtureShape(name: string) {
  const input = join(fixtures, name, 'input');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const tree = parseEntries(
    name,
    files(input).map((path) => ({ path: relative(input, path), bytes: new Uint8Array(readFileSync(path)) })),
  );
  return extractShape(normalizeTree(uploadRoot(tree, true)));
}

describe('suggestMerges', () => {
  it('pairs a renamed key with the known key it replaces', () => {
    const tree = projectTreeFromShape(extractShape(jsonToTree('a.json', [{ title: 'x', timestamp: '2024-01-01T10:00:00Z' }])));
    const shape = extractShape(jsonToTree('b.json', [{ title: 'y', date: '2024-02-01T11:00:00Z' }]));
    expect(suggestMerges(tree, shape)).toEqual([
      expect.objectContaining({ from: ['[*]', 'date'], into: ['[*]', 'timestamp'] }),
    ]);
  });

  it('does not pair values of different types, or nodes that are both present', () => {
    const tree = projectTreeFromShape(extractShape(jsonToTree('a.json', [{ title: 'x', likes: 3 }])));
    expect(suggestMerges(tree, extractShape(jsonToTree('b.json', [{ title: 'y', when: '2024-02-01' }])))).toEqual([]);
    expect(suggestMerges(tree, extractShape(jsonToTree('b.json', [{ title: 'y', likes: 3, extra: 4 }])))).toEqual([]);
  });

  it('pairs translated folders by what is inside them', () => {
    const tree = projectTreeFromShape(fixtureShape('tiktok-2023'));
    const suggestions = suggestMerges(tree, fixtureShape('tiktok-2025'));
    expect(suggestions.map((s) => [s.from.join('/'), s.into.join('/')])).toEqual([
      ['user_data_tiktok.json', 'user_data.json'],
    ]);
  });

  it('gives paths that exist once the shape is merged, so the merge can be applied', () => {
    const tree = projectTreeFromShape(extractShape(jsonToTree('a.json', { 'Watch History': [{ Date: '2024-01-01 10:00:00', Link: 'https://t.example/v/1' }] })));
    const shape = extractShape(jsonToTree('b.json', { 'Watch history': [{ date: '2024-01-01 10:00:00', link: 'https://t.example/v/1' }] }));
    const [suggestion] = suggestMerges(tree, shape);
    expect(suggestion).toMatchObject({ from: ['Watch history'], into: ['Watch History'] });
    const added = mergeShape(tree, shape).tree;
    // Merging them puts their keys side by side; those are suggested next.
    const next = suggestAfterMerge(added, suggestion!.from, suggestion!.into);
    const merged = mergeNodes(added, suggestion!.from, suggestion!.into).tree;
    expect(getNode(merged, ['Watch History'])!.aliases).toEqual(['Watch history']);
    expect(next.map((s) => [s.from.join('/'), s.into.join('/')]).sort()).toEqual([
      ['Watch History/[*]/date', 'Watch History/[*]/Date'],
      ['Watch History/[*]/link', 'Watch History/[*]/Link'],
    ]);
    for (const s of next) expect(getNode(merged, s.from)).toBeDefined();
  });
});
