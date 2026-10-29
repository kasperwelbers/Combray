import { extractShape, jsonToTree, projectTreeFromShape, setDecision, effectiveStates } from '@combray/core';
import { describe, expect, it } from 'vitest';

import {
  countDecisions,
  decideBelow,
  displayName,
  foldChain,
  fromFiles,
  nodeIcon,
  patchNode,
  toFiles,
  undecidedBelow,
} from '../src/studio/model';

const tree = () =>
  projectTreeFromShape(
    extractShape(
      jsonToTree('export.json', {
        Takeout: { YouTube: { history: [{ title: 'a', time: '2024-01-01' }] }, Chrome: { x: 1 } },
      }),
    ),
  );

describe('studio model', () => {
  it('folds runs of single-child groups, but not into the rows of a table or past a label', () => {
    const t = tree();
    const youtube = t.children![0]!.children!.find((c) => c.name === 'YouTube')!;
    expect(foldChain(youtube, ['Takeout', 'YouTube']).map((c) => c.node.name)).toEqual(['YouTube', 'history']);
    youtube.label = { en: 'YouTube' };
    expect(foldChain(youtube, ['Takeout', 'YouTube'])).toHaveLength(1);
  });

  it('counts decisions and undecided leaves', () => {
    let t = setDecision(tree(), ['Takeout', 'YouTube', 'history', '[*]', 'time'], 'donate');
    t = setDecision(t, ['Takeout', 'Chrome'], 'ignore');
    const states = effectiveStates(t);
    expect(countDecisions(t, states)).toEqual({ leaves: 3, undecided: 1, show: 0, donate: 1, ignore: 1 });
    expect(undecidedBelow(t, states).get(t)).toBe(1);
  });

  it('patches settings and removes empty ones', () => {
    const path = ['Takeout', 'YouTube', 'history', '[*]', 'title'];
    let t = patchNode(tree(), path, { label: { en: 'Title' }, aliases: ['titel'] });
    expect(t.children![0]!.children![1]!.children![0]!.children![0]!.children!.find((c) => c.name === 'title'))
      .toMatchObject({ label: { en: 'Title' }, aliases: ['titel'] });
    t = patchNode(t, path, { aliases: [], label: undefined });
    expect(JSON.stringify(t)).not.toMatch(/titel|Title/);
  });

  it('keeps pending settings when saving and applies them once their path exists', () => {
    const { importer } = toFiles(setDecision(tree(), ['Takeout', 'Chrome', 'x'], 'donate'), []);
    const empty = toFiles(projectTreeFromShape(extractShape(jsonToTree('e.json', {}))), []).structure;
    const first = fromFiles(empty, importer);
    expect(first.pending).toHaveLength(1);
    const later = fromFiles(toFiles(tree(), first.pending).structure, toFiles(tree(), first.pending).importer);
    expect(later.pending).toHaveLength(0);
  });

  it('picks icons for tables, lists of values, objects and leaves by type', () => {
    const t = projectTreeFromShape(
      extractShape(jsonToTree('x.json', { posts: [{ at: 1709284500, tags: ['a'], meta: { url: 'https://x.org' } }] })),
    );
    const posts = t.children![0]!;
    const item = posts.children![0]!;
    const child = (name: string) => item.children!.find((c) => c.name === name)!;
    expect(nodeIcon(posts).kind).toBe('table');
    expect(nodeIcon(item).kind).toBe('row');
    expect(nodeIcon(child('at')).kind).toBe('date');
    expect(nodeIcon(child('tags')).kind).toBe('list');
    expect(nodeIcon(child('meta')).kind).toBe('object');
    expect(nodeIcon(child('meta').children![0]!).kind).toBe('link');
    expect(displayName('[*]', (k) => k)).toBe('studio.eachItem');
  });

  it('sets every field below a node, keeping decisions unless asked not to', () => {
    let t = setDecision(tree(), ['Takeout', 'YouTube', 'history', '[*]', 'time'], 'donate');
    t = decideBelow(t, ['Takeout', 'YouTube'], 'show', true);
    const history = ['Takeout', 'YouTube', 'history', '[*]'];
    const states = effectiveStates(t);
    const node = (name: string) => t.children![0]!.children!.find((c) => c.name === 'YouTube')!.children![0]!.children![0]!.children!.find((c) => c.name === name)!;
    expect(states.get(node('time'))).toBe('donate');
    expect(states.get(node('title'))).toBe('show');
    t = decideBelow(t, history, 'undecided', false);
    expect(countDecisions(t, effectiveStates(t)).undecided).toBe(3);
  });
});
