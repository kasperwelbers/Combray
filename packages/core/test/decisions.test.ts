import { describe, expect, it } from 'vitest';

import {
  buildTree,
  closedNodes,
  compareShape,
  correctedShape,
  DecisionError,
  effectiveStates,
  emptyConfig,
  extractShape,
  getNode,
  ignoreOverrides,
  jsonToTree,
  knownKeys,
  materialise,
  newPositions,
  normalizeTree,
  remapPath,
  requiredPaths,
  setDecision,
  setKeysAreData,
  toConfig,
  unionShape,
  type ConfigNode,
  type ProjectNode,
} from '../src';
import { parseMarkup } from '../src/parse/html';
import { watchHistory } from './fixtures';
import { at, nodeAt, rebuild, treeOf } from './trees';

const shape = extractShape(watchHistory);
const base = () => treeOf(shape);

function state(tree: ProjectNode, ...names: string[]) {
  return effectiveStates(tree).get(nodeAt(tree, ...names));
}

const decide = (tree: ProjectNode, names: string[], decision: Parameters<typeof setDecision>[2]) =>
  setDecision(tree, at(tree, ...names), decision);

/** A configuration with one root and these children. */
const config = (kind: ConfigNode['kind'], children: ConfigNode[]) => ({ root: { id: 'root', kind, match: [], children } });

describe('buildTree', () => {
  it('lays an empty configuration over a shape: every position virtual, with its structure', () => {
    const tree = base();
    expect(nodeAt(tree, '[*]', 'time')).toEqual({
      id: '~value:time',
      kind: 'value',
      name: 'time',
      match: ['time'],
      virtual: true,
      keys: ['time'],
      types: ['date-like'],
      formats: ['YYYY-MM-DDTHH:mm:ss.SSSZ'],
    });
    expect(JSON.stringify(tree)).not.toContain('decision');
    expect(buildTree(emptyConfig('list'), shape).unmatched).toEqual([['~map:[*]']]);
  });

  it('matches config nodes by exact key or regular expression, and keeps unmatched siblings virtual', () => {
    const built = buildTree(
      config('map', [
        { id: 'a', kind: 'value', match: ['time', 'tijd'] },
        { id: 'b', kind: 'value', match: [{ regex: '^(link|Link)$' }] },
      ]),
      extractShape(jsonToTree('a.json', { tijd: '2024-01-01', Link: 'https://example.com', other: 'x' })),
    );
    const [time, link, other] = built.tree.children!;
    expect(time).toMatchObject({ id: 'a', name: 'time', keys: ['tijd'] });
    expect(link).toMatchObject({ id: 'b', name: 'Link', keys: ['Link'] });
    expect(other).toMatchObject({ id: '~value:other', virtual: true });
    expect(built.unmatched).toEqual([['~value:other']]);
  });

  it('puts siblings in the order of the structure on request, unmatched config nodes after the one before them', () => {
    const cfg = config('map', [
      { id: 't', kind: 'value', match: ['title'] },
      { id: 'gone', kind: 'value', match: ['gone'] },
      { id: 'c', kind: 'value', match: ['channel'] },
    ]);
    const data = extractShape(jsonToTree('a.json', { title: 'x', url: 'u', channel: 'c', about: 'a' }));
    const ids = (structureOrder: boolean) => buildTree(cfg, data, { structureOrder }).tree.children!.map((c) => c.id);
    expect(ids(false)).toEqual(['t', 'gone', 'c', '~value:about', '~value:url']);
    expect(ids(true)).toEqual(['~value:about', 'c', 't', 'gone', '~value:url']);
  });

  it('keeps config nodes the shape does not have, without structure', () => {
    const tree = buildTree(config('map', [{ id: 'a', kind: 'value', match: ['gone'], decision: 'show' }]), extractShape(jsonToTree('a.json', {}))).tree;
    expect(tree.children).toEqual([{ id: 'a', kind: 'value', name: 'gone', match: ['gone'], decision: 'show' }]);
  });

  it('gives a real position to every config node that matches it (duplication)', () => {
    const built = buildTree(
      config('map', [
        { id: 'a', kind: 'value', match: ['time'], as: 'datetime' },
        { id: 'b', kind: 'value', match: ['time'], transform: ['trim'] },
      ]),
      extractShape(jsonToTree('a.json', { time: '2024-01-01' })),
    );
    const [a, b] = built.tree.children!;
    expect(built.tree.children).toHaveLength(2);
    expect(built.shared.get(a!)).toEqual([b]);
    expect(built.shared.get(b!)).toEqual([a]);
  });

  it('flags a node that matches two keys side by side in one position, not in different ones', () => {
    const regex = config('map', [{ id: 'r', kind: 'value', match: [{ regex: '^ti' }] }]);
    const both = buildTree(regex, extractShape(jsonToTree('a.json', { time: 'x', title: 'y' })));
    expect(both.conflicts.has(both.tree.children![0]!)).toBe(true);
    const one = buildTree(regex, extractShape(jsonToTree('a.json', { time: 'x' })));
    expect(one.conflicts.size).toBe(0);
    // A combined folder: its two files each have `url`, in different positions.
    const files = buildTree(
      config('dir', [{ id: 'f', kind: 'list', match: ['watch-history.json', 'kijkgeschiedenis.json'], children: [{ id: 'i', kind: 'map', match: ['[*]'], children: [{ id: 'u', kind: 'value', match: ['url'] }] }] }]),
      unionShape([
        extractShape({ kind: 'dir', name: '', children: [jsonToTree('watch-history.json', [{ url: 'a' }])] }),
        extractShape({ kind: 'dir', name: '', children: [jsonToTree('kijkgeschiedenis.json', [{ url: 'b' }])] }),
      ]),
    );
    expect(files.conflicts.size).toBe(1); // the file node itself: two keys in one folder of the union
    expect([...files.conflicts][0]!.id).toBe('f');
  });

  it('keeps a node\'s name, and gives it back in the configuration', () => {
    const config = { root: { id: 'root', kind: 'map' as const, match: [], children: [{ id: 'a', kind: 'value' as const, match: ['time'], name: 'watched_at' }] } };
    const tree = buildTree(config, extractShape(jsonToTree('a.json', { time: 'x' }))).tree;
    expect(tree.children![0]).toMatchObject({ name: 'time', named: 'watched_at' });
    expect(toConfig(tree).children![0]).toMatchObject({ name: 'watched_at' });
  });

  it('marks positions the seen structures lack as fresh, and skips them below closed nodes', () => {
    const seenShape = extractShape(jsonToTree('h.json', [{ title: 'x' }]));
    const withExtra = extractShape(jsonToTree('h.json', [{ title: 'x', extra: 1 }]));
    const open = buildTree(emptyConfig('list'), withExtra, { seen: seenShape });
    expect([...open.fresh].map((n) => n.name)).toEqual(['extra']);
    expect(at(open.tree, '[*]', 'title')).toBeDefined();
    const closed = { root: { id: 'root', kind: 'list' as const, match: [], newChildren: 'skip' as const } };
    const skipped = buildTree(closed, withExtra, { seen: seenShape });
    // Seen but unmatched positions stay; only the new one is left out.
    expect(skipped.tree.children!.map((c) => c.name)).toEqual(['[*]']);
    expect(skipped.tree.children![0]!.children!.map((c) => c.name)).toEqual(['title']);
    // Without a seen structure (the studio), everything is seen.
    expect(buildTree(closed, withExtra).unmatched).toEqual([['~map:[*]']]);
  });
});

describe('toConfig and materialise', () => {
  it('keep only config nodes, and make the virtual nodes along a path real', () => {
    const tree = base();
    expect(toConfig(tree)).toEqual({ id: 'root', kind: 'list', match: [] });
    const { tree: real, path } = materialise(tree, at(tree, '[*]', 'time'));
    const config = toConfig(real);
    expect(config.children![0]).toMatchObject({ kind: 'map', match: ['[*]'], children: [{ kind: 'value', match: ['time'] }] });
    expect(getNode(real, path)!.virtual).toBeUndefined();
    expect(path[0]).not.toBe('~map:[*]');
    // The selection follows the node.
    expect(remapPath(tree, rebuild(real, shape), at(tree, '[*]', 'time'))).toEqual(path);
  });

  it('keep virtual nodes an edit gave a setting, as config nodes matching their key', () => {
    const tree = structuredClone(base());
    nodeAt(tree, '[*]', 'time').as = 'datetime';
    const config = toConfig(tree);
    expect(config.children![0]).toMatchObject({ kind: 'map', match: ['[*]'], children: [{ kind: 'value', match: ['time'], as: 'datetime' }] });
    expect(config.children![0]!.children).toHaveLength(1);
    expect(config.children![0]!.id).not.toMatch(/^~/);
  });
});

describe('effectiveStates', () => {
  it('shows undecided leaves and derives inner states from leaves', () => {
    let tree = base();
    expect(state(tree, '[*]')).toBe('show');
    tree = decide(tree, ['[*]', 'time'], 'donate');
    expect(state(tree, '[*]', 'time')).toBe('donate');
    expect(state(tree, '[*]')).toBe('donate');
    expect(effectiveStates(tree).get(tree)).toBe('donate');
    expect(state(tree, '[*]', 'subtitles')).toBe('show');
  });

  it('ignores everything below an ignored node, and ignores parents with only ignored leaves', () => {
    let tree = decide(base(), ['[*]', 'subtitles', '[*]', 'name'], 'donate');
    tree = decide(tree, ['[*]', 'subtitles'], 'ignore');
    expect(state(tree, '[*]', 'subtitles', '[*]', 'name')).toBe('ignore');
    expect(state(tree, '[*]')).toBe('show');
    for (const leaf of ['title', 'titleUrl', 'time']) tree = decide(tree, ['[*]', leaf], 'ignore');
    expect(state(tree, '[*]')).toBe('ignore');
  });
});

describe('setDecision', () => {
  it('allows show and donate on leaves only', () => {
    expect(() => decide(base(), ['[*]'], 'show')).toThrow(DecisionError);
    expect(() => decide(base(), ['[*]', 'subtitles'], 'donate')).toThrow(DecisionError);
  });

  it('does not change the input tree, and makes the node real', () => {
    const tree = base();
    const decided = decide(tree, ['[*]', 'time'], 'donate');
    expect(JSON.stringify(tree)).not.toMatch(/decision/);
    expect(nodeAt(decided, '[*]', 'time')).toMatchObject({ decision: 'donate', match: ['time'] });
    expect(nodeAt(decided, '[*]', 'time').virtual).toBeUndefined();
  });

  it('lists the decisions an ignore would override', () => {
    let tree = decide(base(), ['[*]', 'subtitles', '[*]', 'name'], 'show');
    tree = decide(tree, ['[*]', 'time'], 'donate');
    expect(ignoreOverrides(tree, at(tree, '[*]', 'subtitles'))).toEqual([at(tree, '[*]', 'subtitles', '[*]', 'name')]);
    expect(ignoreOverrides(tree, [])).toHaveLength(2);
  });
});

describe('compareShape', () => {
  let tree = decide(base(), ['[*]', 'time'], 'donate');
  tree = decide(tree, ['[*]', 'subtitles'], 'ignore');

  it('finds missing donated leaves, ignoring the root name', () => {
    const other = extractShape(jsonToTree('kaspers_history.json', [{ title: 'x', watched_at: '2024-01-01' }]));
    expect(compareShape(tree, other)).toEqual({ missing: [at(tree, '[*]', 'time')], missingRequired: [] });
    expect(compareShape(tree, shape)).toEqual({ missing: [], missingRequired: [] });
  });

  it('lists required nodes that are missing, present by any of their matches', () => {
    const required = structuredClone(tree);
    Object.assign(nodeAt(required, '[*]', 'time'), { required: true, match: ['time', 'watched_at'] });
    const renamed = extractShape(jsonToTree('h.json', [{ title: 'x', watched_at: '2024-01-01' }]));
    expect(compareShape(required, renamed).missingRequired).toEqual([]);
    const without = extractShape(jsonToTree('h.json', [{ title: 'x' }]));
    expect(compareShape(required, without).missingRequired).toEqual([at(tree, '[*]', 'time')]);
    expect(requiredPaths(required)).toEqual([at(tree, '[*]', 'time')]);
  });
});

describe('newPositions', () => {
  it('are the top-most positions of a shape the seen structure does not have', () => {
    const other = extractShape(jsonToTree('h.json', [{ title: 'x', time: 't', details: [{ name: 'Ad' }] }]));
    const found = [...newPositions(shape, other)];
    expect(found.map((s) => s.name)).toEqual(['details']);
    expect(newPositions(shape, shape).size).toBe(0);
    expect(newPositions(undefined, other).size).toBe(1);
  });
});

describe('knownKeys', () => {
  it('are the keys config nodes match and the keys of the seen structure', () => {
    const tree = buildTree(config('map', [{ id: 'a', kind: 'value', match: ['Titel', { regex: '^Datum' }] }]), extractShape(jsonToTree('a.json', { Kanaal: 'x' }))).tree;
    const known = knownKeys(tree);
    expect(['Titel', 'Datum en tijd', 'Kanaal'].every(known)).toBe(true);
    expect(known('Anna')).toBe(false);
  });
});

describe('new children', () => {
  it('are passed down until a node sets its own', () => {
    const tree = buildTree(
      { root: { id: 'root', kind: 'map', match: [], newChildren: 'skip', children: [{ id: 'a', kind: 'map', match: ['a'], children: [{ id: 'b', kind: 'map', match: ['b'], newChildren: 'ask' }] }] } },
    ).tree;
    const closed = closedNodes(tree);
    expect([tree, getNode(tree, ['a'])!].every((n) => closed.has(n))).toBe(true);
    expect(closed.has(getNode(tree, ['a', 'b'])!)).toBe(false);
  });
});

describe('lifters', () => {
  it('make an inner node a leaf whose one decision covers its output', () => {
    let tree = base();
    nodeAt(tree, '[*]', 'subtitles').lifter = '(node) => ({})';
    tree = decide(tree, ['[*]', 'subtitles'], 'donate');
    const states = effectiveStates(tree);
    expect(states.get(nodeAt(tree, '[*]', 'subtitles'))).toBe('donate');
    expect(states.get(nodeAt(tree, '[*]', 'subtitles', '[*]', 'name'))).toBe('ignore');
    expect(state(tree, '[*]')).toBe('donate');
  });
});

describe('null values', () => {
  it('keep one node when a key is null in one record and a list in another', () => {
    const tree = treeOf(extractShape(jsonToTree('a.json', [{ tags: null }, { tags: ['x'] }])));
    expect(nodeAt(tree, '[*]').children!.map((c) => c.kind)).toEqual(['list']);
    const union = unionShape([extractShape(jsonToTree('b.json', [{ tags: null }])), extractShape(jsonToTree('c.json', [{ tags: ['y'] }]))])!;
    expect(nodeAt(treeOf(union), '[*]').children!.map((c) => c.kind)).toEqual(['list']);
    // A configured list is not joined by a null-only twin.
    const configured = decide(treeOf(union), ['[*]', 'tags', '[*]'], 'show');
    expect(nodeAt(rebuild(configured, extractShape(jsonToTree('d.json', [{ tags: null }]))), '[*]').children).toHaveLength(1);
  });
});

describe('single and repeated elements', () => {
  const list = (n: number) =>
    `<div class="row">${Array.from({ length: n }, (_, i) => `<a href="https://example.com/${i}">x</a>`).join('')}</div>`;
  const shapeOf = (html: string) => extractShape(normalizeTree(parseMarkup('a.html', html)));

  it('are one node in the union, whichever was seen first', () => {
    for (const shapes of [
      [shapeOf(list(1)), shapeOf(list(3))],
      [shapeOf(list(3)), shapeOf(list(1))],
    ]) {
      const tree = treeOf(unionShape(shapes)!);
      expect(nodeAt(tree, 'div.row').children!.map((c) => [c.kind, c.name])).toEqual([['list', 'a']]);
    }
  });

  it('match a configured list when a participant has a single element, and the other way round', () => {
    const repeated = decide(treeOf(shapeOf(list(3))), ['div.row', 'a', '[*]', '@href'], 'donate');
    const single = buildTree({ root: toConfig(repeated) }, shapeOf(list(1)));
    expect(nodeAt(single.tree, 'div.row').children!.map((c) => [c.kind, c.virtual])).toEqual([['list', undefined]]);
    expect(nodeAt(single.tree, 'div.row', 'a', '[*]', '@href').keys).toEqual(['@href']);
    const one = decide(treeOf(shapeOf(list(1))), ['div.row', 'a', '@href'], 'donate');
    const many = buildTree({ root: toConfig(one) }, shapeOf(list(3)));
    expect(nodeAt(many.tree, 'div.row').children!.map((c) => [c.kind, c.virtual])).toEqual([['element', undefined]]);
    expect(nodeAt(many.tree, 'div.row', 'a', '@href').keys).toEqual(['@href']);
  });
});

describe('keys that are data', () => {
  const tweets = (n: number) =>
    jsonToTree(
      't.json',
      Array.from({ length: n }, (_, i) => ({ text: `t${i}`, comments: { [`user${i}a`]: 'hey', [`user${i}b`]: 'yo' } })),
    );

  it('are collapsed automatically when keys differ across rows', () => {
    const tree = treeOf(extractShape(tweets(4)));
    const comments = nodeAt(tree, '[*]', 'comments');
    expect(comments.collapsed).toBe(true);
    expect(comments.children!.map((c) => c.name)).toEqual(['{*}']);
    expect(JSON.stringify(tree)).not.toContain('user');
  });

  it('can be set by hand, without keeping the keys as matches', () => {
    const s = extractShape(jsonToTree('a.json', [{ comments: { anna: 'hi', bob: 'hey' } }]));
    const tree = treeOf(s);
    expect(nodeAt(tree, '[*]', 'comments', 'anna')).toBeDefined();
    const keyed = setKeysAreData(tree, at(tree, '[*]', 'comments'));
    expect(nodeAt(keyed, '[*]', 'comments').children!.map((c) => c.name)).toEqual(['{*}']);
    expect(JSON.stringify(toConfig(keyed))).not.toMatch(/anna|bob/);
    // New keys in later shapes map to the same position, and are never added by name.
    const later = buildTree({ root: toConfig(keyed) }, extractShape(jsonToTree('b.json', [{ comments: { carl: 'yo' } }])));
    expect(later.unmatched).toEqual([]);
    expect(JSON.stringify(toConfig(later.tree))).not.toContain('carl');
  });

  it('are not new on a participant device when the seen structures still have the old keys', () => {
    const seen = extractShape(jsonToTree('a.json', [{ comments: { anna: 'hi', bob: 'hey' } }]));
    const keyed = { root: toConfig(setKeysAreData(treeOf(seen), at(treeOf(seen), '[*]', 'comments'))) };
    const later = extractShape(jsonToTree('b.json', [{ comments: { carl: 'yo' } }]));
    expect(buildTree(keyed, later, { seen }).fresh.size).toBe(0);
    // A part that really is new still is.
    const other = extractShape(jsonToTree('c.json', [{ comments: { carl: 'yo' }, likes: 3 }]));
    expect([...buildTree(keyed, other, { seen }).fresh].map((n) => n.name)).toEqual(['likes']);
  });

  it('are left out of the structures passed on, and compare as one position', () => {
    const seen = extractShape(jsonToTree('a.json', [{ comments: { anna: 'hi', bob: 'hey', 'carol@example.org': 'yo' } }]));
    const keyed = { root: toConfig(setKeysAreData(treeOf(seen), at(treeOf(seen), '[*]', 'comments'))) };
    const corrected = correctedShape(keyed, seen);
    expect(JSON.stringify(corrected)).not.toMatch(/anna|<email>/);
    const comments = corrected.children![0]!.children![0]!;
    expect(comments).toMatchObject({ collapsed: true, keyTypes: ['email-like', 'string'] });
    expect(comments.children!.map((c) => c.name)).toEqual(['{*}']);
    // The corrected structure still fits the configuration, and new keys add no new positions.
    expect(buildTree(keyed, corrected).unmatched).toEqual([]);
    const later = extractShape(jsonToTree('b.json', [{ comments: { carl: 'yo' } }]));
    expect(newPositions(corrected, correctedShape(keyed, later)).size).toBe(0);
    // Without corrections a shape comes back as it was.
    expect(correctedShape({ root: toConfig(treeOf(seen)) }, seen)).toBe(seen);
  });

  it('take a decision of their own for the keys', () => {
    const tree = treeOf(extractShape(tweets(4)));
    const decided = decide(tree, ['[*]', 'comments', '{*}'], 'donate');
    expect(effectiveStates(decided).get(nodeAt(decided, '[*]'))).toBe('donate');
  });
});
