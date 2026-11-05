import { buildTree, emptyConfig, extractShape, getNode, jsonToTree, toConfig, type Name, type ProjectNode } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { keysBehind, nameTaken, rowName, saveMatch, unmatch } from '../src/studio/naming';

const t = (key: string) => key;

const shape = extractShape(jsonToTree('a.json', [{ title: 'x', titleText: 'y', time: '2024-01-01' }]));

/** The tree after an edit, as the studio rebuilds it. */
const rebuild = (tree: ProjectNode, names: Name[]) => buildTree({ root: toConfig(tree), names }, shape, { structureOrder: true }).tree;

const start = () => buildTree(emptyConfig('list'), shape, { structureOrder: true }).tree;
const item = (tree: ProjectNode) => tree.children![0]!;
const child = (tree: ProjectNode, key: string) => item(tree).children!.find((c) => c.keys?.includes(key))!;
const pathTo = (tree: ProjectNode, key: string) => [item(tree).id, child(tree, key).id];

describe('names in the tree editor', () => {
  it('matches a part by its key: no name of its own, and a decision', () => {
    const tree = start();
    expect(child(tree, 'title').virtual).toBe(true);
    const out = saveMatch(tree, [], pathTo(tree, 'title'), { text: 'title', decision: 'show' }, t);
    const after = rebuild(out.tree, out.names);
    expect(out.names).toEqual([]);
    expect(child(after, 'title')).toMatchObject({ decision: 'show', match: ['title'] });
    expect(child(after, 'title').virtual).toBeUndefined();
    expect(rowName(child(after, 'title'), out.names, t)).toBe('title');
    // Rows stay where they were.
    expect(item(after).children!.map((c) => c.name)).toEqual(['time', 'title', 'titleText']);
  });

  it('gives a part a name of its own, and shows the key behind it', () => {
    const tree = start();
    const out = saveMatch(tree, [], pathTo(tree, 'title'), { text: 'Video title', decision: 'donate' }, t);
    const after = rebuild(out.tree, out.names);
    expect(out.names.map((n) => n.text)).toEqual(['Video title']);
    const node = child(after, 'title');
    expect(rowName(node, out.names, t)).toBe('Video title');
    expect(keysBehind(node, 'Video title')).toEqual(['title']);
    expect(keysBehind(child(after, 'time'), 'time')).toEqual([]);
  });

  it('merges a part into the node with that name: one node, both keys', () => {
    let tree = start();
    let out = saveMatch(tree, [], pathTo(tree, 'title'), { text: 'Video title', decision: 'donate' }, t);
    tree = rebuild(out.tree, out.names);
    const taken = nameTaken(tree, pathTo(tree, 'titleText'), out.names, 'video title', t);
    expect(taken?.sibling).toEqual(pathTo(tree, 'title'));
    out = saveMatch(tree, out.names, pathTo(tree, 'titleText'), { text: 'Video title', join: 'merge' }, t);
    const after = rebuild(out.tree, out.names);
    const merged = child(after, 'title');
    expect(merged).toBe(child(after, 'titleText'));
    expect(merged.match).toEqual(['title', 'titleText']);
    expect(merged.decision).toBe('donate');
    expect(item(after).children).toHaveLength(2);
  });

  it('or gives it the same name, as a node of its own with its own decision', () => {
    let tree = start();
    let out = saveMatch(tree, [], pathTo(tree, 'title'), { text: 'title', decision: 'donate' }, t);
    tree = rebuild(out.tree, out.names);
    out = saveMatch(tree, out.names, pathTo(tree, 'titleText'), { text: 'title', join: 'same-name', decision: 'show' }, t);
    const after = rebuild(out.tree, out.names);
    expect(out.names).toHaveLength(1);
    const [a, b] = [child(after, 'title'), child(after, 'titleText')];
    expect(a).not.toBe(b);
    expect(a.nameId).toBe(out.names[0]!.id);
    expect(b.nameId).toBe(out.names[0]!.id);
    expect([a.decision, b.decision]).toEqual(['donate', 'show']);
  });

  it('renames a shared name for all, or gives one part a name of its own', () => {
    let tree = start();
    let out = saveMatch(tree, [], pathTo(tree, 'title'), { text: 'Title', decision: 'show' }, t);
    tree = rebuild(out.tree, out.names);
    out = saveMatch(tree, out.names, pathTo(tree, 'titleText'), { text: 'Title', join: 'same-name', decision: 'show' }, t);
    tree = rebuild(out.tree, out.names);
    const all = saveMatch(tree, out.names, pathTo(tree, 'title'), { text: 'Heading' }, t);
    expect(all.names.map((n) => n.text)).toEqual(['Heading']);
    const one = saveMatch(tree, out.names, pathTo(tree, 'title'), { text: 'Heading', renameAll: false }, t);
    expect(one.names.map((n) => n.text).sort()).toEqual(['Heading', 'Title']);
  });

  it('unmatches a part: its settings and its name go', () => {
    let tree = start();
    const out = saveMatch(tree, [], pathTo(tree, 'title'), { text: 'Video title', decision: 'show' }, t);
    tree = rebuild(out.tree, out.names);
    const gone = unmatch(tree, out.names, pathTo(tree, 'title'));
    const after = rebuild(gone.tree, gone.names);
    expect(gone.names).toEqual([]);
    expect(child(after, 'title').virtual).toBe(true);
    expect(getNode(after, pathTo(after, 'title'))?.decision).toBeUndefined();
  });
});
