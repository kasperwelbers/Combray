import { describe, expect, it } from 'vitest';

import {
  addMatch,
  buildTree,
  combineConflicts,
  combineNodes,
  combineProblem,
  deriveRows,
  deriveTables,
  extractShape,
  groupTables,
  jsonToTree,
  nameGroup,
  renameNode,
  removeMatch,
  setDecision,
  setName,
  splitByKey,
  toConfig,
  unionShape,
} from '../src';
import { at, nodeAt, rebuild, treeOf } from './trees';

// One export in English and one in Dutch: the same history, with translated keys.
const english = jsonToTree('', { 'watch-history.json': [{ title: 'Madeleines', timestamp: '2024-03-01 10:00' }] });
const dutch = jsonToTree('', { 'kijkgeschiedenis.json': [{ title: 'Thee', tijdstip: '01-03-2024 10:00' }] });
const shapes = [extractShape(english), extractShape(dutch)];
const seen = unionShape(shapes)!;

describe('combining into one node', () => {
  it('gives one node all the matches, with one subtree for the children of both', () => {
    let tree = treeOf(seen);
    tree = setDecision(tree, at(tree, 'watch-history.json', '[*]', 'title'), 'show');
    tree = rebuild(tree, seen);
    const { tree: combined, path } = combineNodes(tree, [at(tree, 'watch-history.json'), at(tree, 'kijkgeschiedenis.json')]);
    const again = rebuild(combined, seen);
    expect(again.children!.map((c) => [c.name, c.match, c.virtual])).toEqual([['watch-history.json', ['watch-history.json', 'kijkgeschiedenis.json'], undefined]]);
    expect(again.children![0]!.id).toBe(path[0]);
    // The children of both files are below the one node: the title once, both time keys virtual.
    expect(nodeAt(again, 'watch-history.json', '[*]').children!.map((c) => [c.name, c.decision])).toEqual([
      ['title', 'show'],
      ['tijdstip', undefined],
      ['timestamp', undefined],
    ]);
    // And the configured title gets the values of both.
    const tables = deriveTables(again);
    expect(deriveRows({ kind: 'map', name: '', children: [...(english as unknown as { children: [] }).children] }, again, tables)[0]).toHaveLength(1);
  });

  it('is refused for nodes that are not siblings of one kind, or that occur side by side', () => {
    const tree = treeOf(seen);
    expect(combineProblem(tree, [at(tree, 'watch-history.json')])).toMatch('two or more');
    expect(combineProblem(tree, [at(tree, 'watch-history.json', '[*]', 'title'), at(tree, 'kijkgeschiedenis.json')])).toMatch('same parent');
    const both = treeOf(extractShape(jsonToTree('a.json', [{ title: 'x', time: 'y', tags: ['a'] }])));
    expect(combineProblem(both, [at(both, '[*]', 'title'), at(both, '[*]', 'tags')])).toMatch('different kinds');
    // Title and time are in the same row: one node cannot hold both.
    const shape = extractShape(jsonToTree('a.json', [{ title: 'x', time: 'y' }]));
    expect(combineConflicts(both, [shape], [at(both, '[*]', 'title'), at(both, '[*]', 'time')])).toBe(1);
    // The two files are never in one export.
    const files = treeOf(seen);
    expect(combineConflicts(files, shapes, [at(files, 'watch-history.json'), at(files, 'kijkgeschiedenis.json')])).toBe(0);
  });

  it('can be split again by taking a match off', () => {
    const tree = treeOf(seen);
    const combined = rebuild(combineNodes(tree, [at(tree, 'watch-history.json'), at(tree, 'kijkgeschiedenis.json')]).tree, seen);
    const split = rebuild(removeMatch(combined, at(combined, 'watch-history.json'), 'kijkgeschiedenis.json'), seen);
    expect(split.children!.map((c) => [c.name, c.virtual])).toEqual([
      ['watch-history.json', undefined],
      ['kijkgeschiedenis.json', true],
    ]);
    // Taking off the last match removes the node: the real one is unmatched again.
    const gone = rebuild(removeMatch(split, at(split, 'watch-history.json'), 'watch-history.json'), seen);
    expect(gone.children!.every((c) => c.virtual)).toBe(true);
  });

  it('adds a match by hand, and splits a node with several keys into one per key', () => {
    const tree = treeOf(seen);
    const { tree: matched } = addMatch(tree, at(tree, 'watch-history.json'), { regex: '^kijk' });
    const built = rebuild(matched, seen);
    expect(built.children!.map((c) => c.name)).toEqual(['watch-history.json']);
    expect(built.children![0]!.keys).toEqual(['kijkgeschiedenis.json', 'watch-history.json']);
    const split = rebuild(splitByKey(built, at(built, 'watch-history.json')), seen);
    expect(split.children!.map((c) => [c.name, c.match, c.virtual])).toEqual([
      ['kijkgeschiedenis.json', ['kijkgeschiedenis.json'], undefined],
      ['watch-history.json', ['watch-history.json'], undefined],
    ]);
  });
});

describe('giving the same name', () => {
  it('keeps nodes and their settings apart, and joins them for participants', () => {
    const tree = treeOf(seen);
    const named = setName(tree, [at(tree, 'watch-history.json'), at(tree, 'kijkgeschiedenis.json')], 'watch_history');
    const built = buildTree({ root: toConfig(named) }, seen).tree;
    expect(nameGroup(built, at(built, 'watch-history.json'))).toHaveLength(2);
    const both = { kind: 'dir' as const, name: '', children: [...(english as unknown as { children: [] }).children, ...(dutch as unknown as { children: [] }).children] };
    const tables = deriveTables(built);
    const grouped = groupTables(tables, deriveRows(both, built, tables));
    expect(grouped.tables.map((t) => [t.id, t.name])).toEqual([['watch_history', 'Watch history']]);
    expect(grouped.rows[0]).toHaveLength(2);
    // Giving one its own name again splits them.
    const apart = buildTree({ root: toConfig(renameNode(built, at(built, 'kijkgeschiedenis.json'), 'kijkgeschiedenis', { all: false }).tree) }, seen).tree;
    expect(nameGroup(apart, at(apart, 'watch-history.json'))).toHaveLength(1);
  });
});
