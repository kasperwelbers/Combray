import { buildTree, emptyConfig, extractShape, getNode, jsonToTree, toConfig, type ProjectNode } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { keysBehind, nameInfo, nameTaken, rowName, saveMatch, sharedNames, unmatch } from '../src/studio/naming';

const t = (key: string) => key;

const shape = extractShape(jsonToTree('a.json', [{ title: 'x', titleText: 'y', time: '2024-01-01', comments: [{ text: 'z' }] }]));

/** The tree after an edit, as the studio rebuilds it. */
const rebuild = (tree: ProjectNode) => buildTree({ root: toConfig(tree) }, shape, { structureOrder: true }).tree;

const start = () => buildTree(emptyConfig('list'), shape, { structureOrder: true }).tree;
const item = (tree: ProjectNode) => tree.children![0]!;
const child = (tree: ProjectNode, key: string) => item(tree).children!.find((c) => c.keys?.includes(key))!;
const pathTo = (tree: ProjectNode, key: string) => [item(tree).id, child(tree, key).id];

describe('names in the tree editor', () => {
  it('matches a field by its key: the name its key gives, and a decision', () => {
    const tree = start();
    expect(child(tree, 'title').virtual).toBe(true);
    expect(nameInfo(tree, pathTo(tree, 'title'))).toMatchObject({ kind: 'field', name: 'title', own: false });
    const out = saveMatch(tree, pathTo(tree, 'title'), { name: 'title', decision: 'show' });
    const after = rebuild(out.tree);
    expect(out.renamed).toBeUndefined();
    expect(child(after, 'title')).toMatchObject({ decision: 'show', match: ['title'] });
    expect(child(after, 'title').virtual).toBeUndefined();
    expect(rowName(child(after, 'title'), t)).toBe('title');
    // Rows stay where they were.
    expect(item(after).children!.map((c) => c.name)).toEqual(['comments', 'time', 'title', 'titleText']);
  });

  it('gives a field a name of its own, and shows the key behind it', () => {
    const tree = start();
    const out = saveMatch(tree, pathTo(tree, 'titleText'), { name: 'video_title', decision: 'donate' });
    expect(out.renamed).toEqual({ kind: 'field', from: 'title_text', to: 'video_title', table: 'table', references: true });
    const after = rebuild(out.tree);
    const node = child(after, 'titleText');
    expect(rowName(node, t)).toBe('video_title');
    expect(keysBehind(node, 'video_title')).toEqual(['titleText']);
    expect(keysBehind(child(after, 'time'), 'time')).toEqual([]);
  });

  it('has no name for parts that are not tables or fields', () => {
    const tree = start();
    expect(nameInfo(tree, [item(tree).id])).toBeUndefined();
    expect(nameInfo(tree, pathTo(tree, 'comments'))).toMatchObject({ kind: 'table', name: 'comments' });
  });

  it('combines a field with the one next to it that has the name: one node, both keys', () => {
    let tree = start();
    tree = rebuild(saveMatch(tree, pathTo(tree, 'title'), { name: 'title', decision: 'donate' }).tree);
    const taken = nameTaken(tree, pathTo(tree, 'titleText'), 'title');
    expect(taken).toEqual({ sibling: pathTo(tree, 'title'), others: [pathTo(tree, 'title')], count: 1 });
    const out = saveMatch(tree, pathTo(tree, 'titleText'), { name: 'title', join: 'combine' });
    const after = rebuild(out.tree);
    const combined = child(after, 'title');
    expect(combined).toBe(child(after, 'titleText'));
    expect(combined.match).toEqual(['title', 'titleText']);
    expect(combined.decision).toBe('donate');
    expect(item(after).children).toHaveLength(3);
  });

  it('or gives it the same name, as a node of its own with its own decision, numbered', () => {
    let tree = start();
    tree = rebuild(saveMatch(tree, pathTo(tree, 'title'), { name: 'title', decision: 'donate' }).tree);
    tree = rebuild(saveMatch(tree, pathTo(tree, 'titleText'), { name: 'title', join: 'same-name', decision: 'show' }).tree);
    const [a, b] = [child(tree, 'title'), child(tree, 'titleText')];
    expect(a).not.toBe(b);
    expect([a.named, b.named]).toEqual(['title', 'title']);
    expect([a.decision, b.decision]).toEqual(['donate', 'show']);
    const shared = sharedNames(tree);
    expect(shared.get(pathTo(tree, 'title').join('/'))).toMatchObject({ number: 1, name: 'title' });
    expect(shared.get(pathTo(tree, 'titleText').join('/'))).toMatchObject({ number: 2, name: 'title' });
  });

  it('renames a shared name for all, or splits one part off', () => {
    let tree = start();
    tree = rebuild(saveMatch(tree, pathTo(tree, 'title'), { name: 'title', decision: 'show' }).tree);
    tree = rebuild(saveMatch(tree, pathTo(tree, 'titleText'), { name: 'title', join: 'same-name', decision: 'show' }).tree);
    const all = saveMatch(tree, pathTo(tree, 'title'), { name: 'heading' });
    expect(all.renamed).toMatchObject({ from: 'title', to: 'heading', references: true });
    const afterAll = rebuild(all.tree);
    expect([child(afterAll, 'title').named, child(afterAll, 'titleText').named]).toEqual(['heading', 'heading']);

    const one = saveMatch(tree, pathTo(tree, 'title'), { name: 'heading', renameAll: false });
    expect(one.renamed).toMatchObject({ from: 'title', to: 'heading', references: false });
    const afterOne = rebuild(one.tree);
    expect([child(afterOne, 'title').named, child(afterOne, 'titleText').named]).toEqual(['heading', 'title']);
    expect(saveMatch(tree, pathTo(tree, 'title'), { name: 'heading', renameAll: false, moveReferences: true }).renamed?.references).toBe(true);
  });

  it('unmatches a part: its settings and its name go', () => {
    let tree = start();
    tree = rebuild(saveMatch(tree, pathTo(tree, 'title'), { name: 'video_title', decision: 'show' }).tree);
    const after = rebuild(unmatch(tree, pathTo(tree, 'title')));
    expect(child(after, 'title').virtual).toBe(true);
    expect(child(after, 'title').named).toBeUndefined();
    expect(getNode(after, pathTo(after, 'title'))?.decision).toBeUndefined();
  });
});
