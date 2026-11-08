import { describe, expect, it } from 'vitest';

import { extractShape, getNode, jsonToTree, renameNode, setDecision, toConfig, versionChanges, type NodePath, type ProjectNode } from '../src';
import { at, nodeAt, rebuild, treeOf } from './trees';

const shape = extractShape(
  jsonToTree('history.json', {
    watched: [{ title: 'Madeleines', time: '2024-03-01', channel: { name: 'Léonie' } }],
    searches: [{ query: 'tea', time: '2024-03-02' }],
  }),
);

/** A first version: titles and times of what was watched donated, searches shown. */
function first(): ProjectNode {
  let tree = treeOf(shape);
  tree = setDecision(tree, at(tree, 'watched', '[*]', 'title'), 'donate');
  tree = rebuild(tree, shape);
  tree = setDecision(tree, at(tree, 'watched', '[*]', 'time'), 'donate');
  tree = rebuild(tree, shape);
  return rebuild(setDecision(tree, at(tree, 'searches', '[*]', 'query'), 'show'), shape);
}

/** A copy of the tree with settings of one node changed. */
function patchNode(tree: ProjectNode, path: NodePath, patch: Partial<ProjectNode>): ProjectNode {
  const copy = structuredClone(tree);
  Object.assign(getNode(copy, path)!, patch);
  return copy;
}

const version = (tree: ProjectNode) => new Map([['takeout', { config: { root: toConfig(tree) }, seen: shape }]]);
const changes = (before: ProjectNode, after: ProjectNode) =>
  versionChanges(version(before), version(after)).map(({ kind, change, table, field, to }) => ({ kind, change, table, ...(field ? { field } : {}), ...(to ? { to } : {}) }));

describe('changes between published versions', () => {
  it('are none when nothing donated changed', () => {
    const tree = first();
    expect(changes(tree, rebuild(setDecision(tree, at(tree, 'searches', '[*]', 'time'), 'show'), shape))).toEqual([]);
  });

  it('are safe when more is asked, narrowing when less is', () => {
    const tree = first();
    const more = rebuild(setDecision(tree, at(tree, 'searches', '[*]', 'query'), 'donate'), shape);
    expect(changes(tree, more)).toEqual([{ kind: 'safe', change: 'added', table: 'searches' }]);
    const less = rebuild(setDecision(tree, at(tree, 'watched', '[*]', 'time'), 'show'), shape);
    expect(changes(tree, less)).toEqual([{ kind: 'narrowing', change: 'no-longer-donated', table: 'watched', field: 'time' }]);
    expect(versionChanges(version(tree), new Map())).toEqual([{ kind: 'narrowing', platform: 'takeout', change: 'platform-removed' }]);
  });

  it('are safe when a donated field is renamed (earlier donations follow), breaking when it is read another way', () => {
    const tree = first();
    const renamed = rebuild(renameNode(tree, at(tree, 'watched', '[*]', 'title'), 'video').tree, shape);
    expect(changes(tree, renamed)).toEqual([{ kind: 'safe', change: 'renamed', table: 'watched', field: 'title', to: 'watched/video' }]);
    // A renamed table: one change, not one per field.
    const table = rebuild(renameNode(tree, at(tree, 'watched'), 'watch_history').tree, shape);
    expect(changes(tree, table)).toEqual([{ kind: 'safe', change: 'renamed', table: 'watched', to: 'watch_history' }]);
    const read = rebuild(patchNode(tree, at(tree, 'watched', '[*]', 'time'), { as: 'datetime' }), shape);
    expect(changes(tree, read)).toEqual([{ kind: 'breaking', change: 'read-differently', table: 'watched', field: 'time' }]);
  });

  it('are breaking when a donated path is no longer matched at all: earlier values there are deprecated', () => {
    const tree = first();
    // The title is matched under another key only: nothing matches where earlier titles were.
    const moved = rebuild(patchNode(tree, at(tree, 'watched', '[*]', 'title'), { match: ['heading'] }), shape);
    expect(changes(tree, moved)).toContainEqual({ kind: 'breaking', change: 'deprecated', table: 'watched', field: 'title' });
  });

  it('take another date format to try after the first as safe', () => {
    const base = first();
    const one = rebuild(patchNode(base, at(base, 'watched', '[*]', 'time'), { as: 'datetime', format: 'iso' }), shape);
    const two = rebuild(patchNode(one, at(one, 'watched', '[*]', 'time'), { format: ['iso', 'dd-MM-yyyy'] }), shape);
    expect(changes(one, two)).toEqual([{ kind: 'safe', change: 'more-formats', table: 'watched', field: 'time' }]);
    expect(changes(two, one)[0]).toMatchObject({ kind: 'breaking', change: 'read-differently' });
    expect(nodeAt(two, 'watched', '[*]', 'time').format).toEqual(['iso', 'dd-MM-yyyy']);
  });

  it('take a filter on a donated table as narrowing', () => {
    const tree = first();
    const filtered = rebuild(patchNode(tree, at(tree, 'watched', '[*]'), { filter: [{ column: 'title', test: { empty: true }, not: true }] }), shape);
    expect(changes(tree, filtered)).toEqual([{ kind: 'narrowing', change: 'filter-added', table: 'watched' }]);
    expect(changes(filtered, tree)).toEqual([{ kind: 'safe', change: 'filter-removed', table: 'watched' }]);
  });
});
