import { describe, expect, it } from 'vitest';

import { extractShape, jsonToTree, mergeNodes, mergeShape, occursIn, projectTreeFromShape, seenTogether, setKeysAreData } from '../src';

const shapeOf = (value: unknown) => extractShape(jsonToTree('a.json', value));

describe('seenTogether', () => {
  const old = shapeOf([{ title: 'x', timestamp: '2024-01-01T10:00:00Z' }]);
  const renamed = shapeOf([{ title: 'y', date: '2024-02-01T11:00:00Z' }]);
  const both = shapeOf([{ title: 'z', date: '2024-02-01', timestamp: '2024-01-01T10:00:00Z' }]);
  const tree = mergeShape(projectTreeFromShape(old), renamed).tree;

  it('counts only exports that have both nodes', () => {
    expect(seenTogether(tree, [old, renamed], ['[*]', 'date'], ['[*]', 'timestamp'])).toBe(0);
    expect(seenTogether(tree, [old, renamed, both], ['[*]', 'date'], ['[*]', 'timestamp'])).toBe(1);
    expect(seenTogether(tree, [old, both], ['[*]', 'title'], ['[*]', 'timestamp'])).toBe(2);
  });

  it('matches aliases, so a merge keeps its evidence', () => {
    const merged = mergeNodes(tree, ['[*]', 'date'], ['[*]', 'timestamp']).tree;
    // `date` is now an alias of `timestamp`: an export with only `date` still has the node.
    expect(occursIn(merged, renamed, ['[*]', 'timestamp'])).toBe(true);
    expect(seenTogether(merged, [renamed], ['[*]', 'title'], ['[*]', 'timestamp'])).toBe(1);
  });

  it('works for nodes in different places and for missing paths', () => {
    const files = shapeOf({ history: [{ url: 'u' }], geschiedenis: [{ url: 'u' }] });
    const t = projectTreeFromShape(files);
    expect(seenTogether(t, [files], ['history'], ['geschiedenis'])).toBe(1);
    expect(seenTogether(t, [files], ['history', '[*]', 'url'], ['geschiedenis', '[*]', 'url'])).toBe(1);
    expect(occursIn(t, files, ['nowhere'])).toBe(false);
  });

  it('matches every key of a map whose keys are data to its one position', () => {
    const diary = shapeOf({ days: { a: { n: 1 }, b: { n: 2 }, c: { n: 3 } } });
    const t = setKeysAreData(projectTreeFromShape(diary), ['days']).tree;
    expect(occursIn(t, diary, ['days', '{*}', 'n'])).toBe(true);
  });
});
