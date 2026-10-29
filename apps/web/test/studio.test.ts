import { extractShape, jsonToTree, projectTreeFromShape, setDecision, effectiveStates } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { countDecisions, foldChain, fromFiles, patchNode, toFiles, undecidedBelow } from '../src/studio/model';

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
});
