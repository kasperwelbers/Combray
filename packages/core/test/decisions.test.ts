import { describe, expect, it } from 'vitest';

import {
  compareShape,
  DecisionError,
  effectiveStates,
  extractShape,
  getNode,
  ignoreOverrides,
  jsonToTree,
  mergeNodes,
  mergeShape,
  projectTreeFromShape,
  setDecision,
  setKeysAreData,
  normalizeTree,
  type ProjectNode,
} from '../src';
import { parseMarkup } from '../src/parse/html';
import { watchHistory } from './fixtures';

const base = () => projectTreeFromShape(extractShape(watchHistory));

function state(tree: ProjectNode, path: string[]) {
  return effectiveStates(tree).get(getNode(tree, path)!);
}

describe('projectTreeFromShape', () => {
  it('copies structure and leaves every node undecided', () => {
    const tree = base();
    expect(getNode(tree, ['[*]', 'time'])).toEqual({ kind: 'value', name: 'time', types: ['date-like'] });
    expect(JSON.stringify(tree)).not.toContain('decision');
  });
});

describe('effectiveStates', () => {
  it('shows undecided leaves and derives inner states from leaves', () => {
    let tree = base();
    expect(state(tree, ['[*]'])).toBe('show');
    tree = setDecision(tree, ['[*]', 'time'], 'donate');
    expect(state(tree, ['[*]', 'time'])).toBe('donate');
    expect(state(tree, ['[*]'])).toBe('donate');
    expect(state(tree, [])).toBe('donate');
    expect(state(tree, ['[*]', 'subtitles'])).toBe('show');
  });

  it('ignores everything below an ignored node, and ignores parents with only ignored leaves', () => {
    let tree = setDecision(base(), ['[*]', 'subtitles', '[*]', 'name'], 'donate');
    tree = setDecision(tree, ['[*]', 'subtitles'], 'ignore');
    expect(state(tree, ['[*]', 'subtitles', '[*]', 'name'])).toBe('ignore');
    expect(state(tree, ['[*]'])).toBe('show');
    for (const leaf of ['title', 'titleUrl', 'time']) tree = setDecision(tree, ['[*]', leaf], 'ignore');
    expect(state(tree, ['[*]'])).toBe('ignore');
  });
});

describe('setDecision', () => {
  it('allows show and donate on leaves only', () => {
    expect(() => setDecision(base(), ['[*]'], 'show')).toThrow(DecisionError);
    expect(() => setDecision(base(), ['[*]', 'subtitles'], 'donate')).toThrow(DecisionError);
  });

  it('does not change the input tree', () => {
    const tree = base();
    setDecision(tree, ['[*]', 'time'], 'donate');
    expect(JSON.stringify(tree)).not.toMatch(/decision/);
  });

  it('lists the decisions an ignore would override', () => {
    let tree = setDecision(base(), ['[*]', 'subtitles', '[*]', 'name'], 'show');
    tree = setDecision(tree, ['[*]', 'time'], 'donate');
    expect(ignoreOverrides(tree, ['[*]', 'subtitles'])).toEqual([['[*]', 'subtitles', '[*]', 'name']]);
    expect(ignoreOverrides(tree, [])).toHaveLength(2);
  });
});

describe('mergeShape', () => {
  it('adds new positions undecided and keeps decisions', () => {
    const tree = setDecision(base(), ['[*]', 'time'], 'donate');
    const other = extractShape(
      jsonToTree('other.json', [{ title: 'x', time: '2024-01-01', details: [{ name: 'Ad' }] }]),
    );
    const { tree: merged, added } = mergeShape(tree, other);
    expect(added).toEqual([['[*]', 'details']]);
    expect(getNode(merged, ['[*]', 'time'])!.decision).toBe('donate');
    expect(getNode(merged, ['[*]', 'details', '[*]', 'name'])).toBeDefined();
    expect(getNode(tree, ['[*]', 'details'])).toBeUndefined();
  });

  it('matches aliases instead of adding a new node', () => {
    const { tree } = mergeNodes(
      mergeShape(base(), extractShape(jsonToTree('x.json', [{ date: '2024-01-01' }]))).tree,
      ['[*]', 'date'],
      ['[*]', 'time'],
    );
    const again = mergeShape(tree, extractShape(jsonToTree('y.json', [{ date: '2024-02-01' }])));
    expect(again.added).toEqual([]);
  });

  it('matches glob and regular expression aliases', () => {
    const tree: ProjectNode = {
      kind: 'map',
      name: '',
      children: [
        { kind: 'value', name: 'time', aliases: ['tijd*'] },
        { kind: 'value', name: 'url', aliases: [{ regex: '^(link|Link)$' }] },
      ],
    };
    const shape = extractShape(jsonToTree('a.json', { tijdstip: '2024-01-01', Link: 'https://example.com' }));
    expect(mergeShape(tree, shape).added).toEqual([]);
  });
});

describe('mergeNodes', () => {
  it('adds the name as an alias, merges children and reports conflicts', () => {
    let tree = mergeShape(
      base(),
      extractShape(jsonToTree('x.json', [{ channels: [{ name: 'a', id: 'b' }] }])),
    ).tree;
    tree = setDecision(tree, ['[*]', 'subtitles', '[*]', 'name'], 'donate');
    tree = setDecision(tree, ['[*]', 'channels', '[*]', 'name'], 'show');
    const { tree: merged, conflicts } = mergeNodes(tree, ['[*]', 'channels'], ['[*]', 'subtitles']);
    const subtitles = getNode(merged, ['[*]', 'subtitles'])!;
    expect(subtitles.aliases).toEqual(['channels']);
    expect(getNode(merged, ['[*]', 'channels'])).toBeUndefined();
    expect(getNode(merged, ['[*]', 'subtitles', '[*]', 'id'])).toBeDefined();
    expect(getNode(merged, ['[*]', 'subtitles', '[*]', 'name'])!.decision).toBe('donate');
    expect(conflicts).toEqual([{ path: ['[*]', 'subtitles', '[*]', 'name'], field: 'decision' }]);
  });

  it('refuses different kinds and merging into a descendant', () => {
    expect(() => mergeNodes(base(), ['[*]', 'time'], ['[*]', 'subtitles'])).toThrow(DecisionError);
    expect(() => mergeNodes(base(), ['[*]'], ['[*]', 'subtitles'])).toThrow(DecisionError);
  });
});

describe('compareShape', () => {
  const tree = setDecision(setDecision(base(), ['[*]', 'time'], 'donate'), ['[*]', 'subtitles'], 'ignore');

  it('finds unknown positions and missing donated leaves, ignoring the root name', () => {
    const shape = extractShape(
      jsonToTree('kaspers_history.json', [{ title: 'x', watched_at: '2024-01-01', subtitles: [{ extra: 1 }] }]),
    );
    expect(compareShape(tree, shape)).toEqual({
      unknown: [{ path: ['[*]', 'watched_at'], shape: { kind: 'value', name: 'watched_at', types: ['date-like'] } }],
      missing: [['[*]', 'time']],
    });
  });

  it('finds nothing for a shape the tree already covers', () => {
    expect(compareShape(tree, extractShape(watchHistory))).toEqual({ unknown: [], missing: [] });
  });
});

describe('lifters', () => {
  it('make an inner node a leaf whose one decision covers its output', () => {
    let tree = base();
    tree.children![0]!.children!.find((c) => c.name === 'subtitles')!.lifter = '(node) => ({})';
    tree = setDecision(tree, ['[*]', 'subtitles'], 'donate');
    const states = effectiveStates(tree);
    expect(states.get(getNode(tree, ['[*]', 'subtitles'])!)).toBe('donate');
    expect(states.get(getNode(tree, ['[*]', 'subtitles', '[*]', 'name'])!)).toBe('ignore');
    expect(state(tree, ['[*]'])).toBe('donate');
  });
});

describe('null values', () => {
  it('keep one node when a key is null in one record and a list in another', () => {
    const shape = extractShape(jsonToTree('a.json', [{ tags: null }, { tags: ['x'] }]));
    const tree = projectTreeFromShape(shape);
    expect(getNode(tree, ['[*]'])!.children!.map((c) => c.kind)).toEqual(['list']);
    const later = mergeShape(
      projectTreeFromShape(extractShape(jsonToTree('b.json', [{ tags: null }]))),
      extractShape(jsonToTree('c.json', [{ tags: ['y'] }])),
    );
    expect(getNode(later.tree, ['[*]'])!.children!.map((c) => c.kind)).toEqual(['list']);
    expect(later.added).toEqual([['[*]', 'tags']]);
    expect(mergeShape(tree, extractShape(jsonToTree('d.json', [{ tags: null }]))).added).toEqual([]);
  });
});

describe('single and repeated elements', () => {
  const list = (n: number) =>
    `<div class="row">${Array.from({ length: n }, (_, i) => `<a href="https://example.com/${i}">x</a>`).join('')}</div>`;
  const shapeOf = (html: string) => extractShape(normalizeTree(parseMarkup('a.html', html)));

  it('are one node, whichever was seen first', () => {
    const one = shapeOf(list(1));
    const many = shapeOf(list(3));
    for (const [first, second] of [
      [one, many],
      [many, one],
    ] as const) {
      const { tree, added } = mergeShape(projectTreeFromShape(first!), second!);
      expect(added).toEqual([]);
      const row = getNode(tree, ['div.row'])!;
      expect(row.children!.map((c) => [c.kind, c.name])).toEqual([['list', 'a']]);
      expect(compareShape(tree, one).unknown).toEqual([]);
      expect(compareShape(tree, many).unknown).toEqual([]);
    }
  });

  it('keep decisions when a single element turns out to repeat', () => {
    let tree = projectTreeFromShape(shapeOf(list(1)));
    tree = setDecision(tree, ['div.row', 'a', '@href'], 'donate');
    const merged = mergeShape(tree, shapeOf(list(3))).tree;
    expect(getNode(merged, ['div.row', 'a', '[*]', '@href'])!.decision).toBe('donate');
  });
});

describe('keys that are data', () => {
  const tweets = (n: number) =>
    jsonToTree(
      't.json',
      Array.from({ length: n }, (_, i) => ({ text: `t${i}`, comments: { [`user${i}a`]: 'hey', [`user${i}b`]: 'yo' } })),
    );

  it('are collapsed automatically when keys differ across rows', () => {
    const tree = projectTreeFromShape(extractShape(tweets(4)));
    const comments = getNode(tree, ['[*]', 'comments'])!;
    expect(comments.collapsed).toBe(true);
    expect(comments.children!.map((c) => c.name)).toEqual(['{*}']);
    expect(JSON.stringify(tree)).not.toContain('user');
  });

  it('can be set by hand, without keeping the keys as aliases', () => {
    const shape = extractShape(jsonToTree('a.json', [{ comments: { anna: 'hi', bob: 'hey' } }]));
    const tree = projectTreeFromShape(shape);
    expect(getNode(tree, ['[*]', 'comments', 'anna'])).toBeDefined();
    const { tree: keyed } = setKeysAreData(tree, ['[*]', 'comments']);
    expect(getNode(keyed, ['[*]', 'comments'])!.children!.map((c) => c.name)).toEqual(['{*}']);
    expect(JSON.stringify(keyed)).not.toMatch(/anna|bob/);
    // New keys in later shapes map to the same position, and are never added by name.
    const later = mergeShape(keyed, extractShape(jsonToTree('b.json', [{ comments: { carl: 'yo' } }])));
    expect(later.added).toEqual([]);
    expect(JSON.stringify(later.tree)).not.toContain('carl');
    const compared = compareShape(keyed, extractShape(jsonToTree('c.json', [{ comments: { dora: { x: 1 } } }])));
    expect(JSON.stringify(compared)).not.toContain('dora');
  });

  it('take a decision of their own for the keys', () => {
    const tree = projectTreeFromShape(extractShape(tweets(4)));
    const decided = setDecision(tree, ['[*]', 'comments', '{*}'], 'donate');
    expect(effectiveStates(decided).get(getNode(decided, ['[*]'])!)).toBe('donate');
  });
});
