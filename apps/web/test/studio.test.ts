import {
  buildTree,
  deriveTables,
  effectiveStates,
  emptyConfig,
  extractShape,
  jsonToTree,
  normalizeTree,
  parseFile,
  setDecision,
  setKeysAreData,
  toConfig,
  type ConfigNode,
  type ProjectConfig,
  type ProjectNode,
  type Shape,
} from '@combray/core';
import { describe, expect, it } from 'vitest';

import {
  addSeen,
  asParticipantsSee,
  countDecisions,
  decideBelow,
  displayName,
  filterColumns,
  foldChain,
  fromFiles,
  nodeIcon,
  notSeen,
  patchNode,
  rowInfo,
  shortNames,
  textMarks,
  toFiles,
  undecidedBelow,
  withSameNamesTogether,
} from '../src/studio/model';

/**
 * A configuration with a node for every position of a shape (an upload that is one file), with
 * its key as its id: the file is read by the group `export`, and is `file` in it.
 */
function everything(shape: Shape): ProjectConfig {
  const node = (s: Shape): ConfigNode => ({
    id: s.name,
    kind: s.kind,
    match: [s.name],
    ...(s.children ? { children: s.children.map((c) => node(c)) } : {}),
  });
  const file: ConfigNode = { ...node(shape), id: 'file', match: [] };
  return { root: { id: 'root', kind: 'dir', match: [], children: [{ id: 'export', kind: 'dir', match: ['export'], files: [{ path: [] }], children: [file] }] } };
}

/** Where the content of the file is in a configured tree. */
const F = ['export', 'file'];

/** The project tree of a shape, with every position configured, so paths are its keys. */
const keyed = (shape: Shape) => buildTree(everything(shape), shape).tree;
/** The node of the file in a tree. */
const fileOf = (tree: ProjectNode) => tree.children![0]!.children![0]!;

const shape = () =>
  extractShape(
    jsonToTree('export.json', {
      Takeout: { YouTube: { history: [{ title: 'a', time: '2024-01-01' }] }, Chrome: { x: 1 } },
    }),
  );
const tree = () => keyed(shape());

describe('studio model', () => {
  it('offers ignored fields to row filters', () => {
    const t = setDecision(tree(), [...F, 'Takeout', 'YouTube', 'history', '[*]', 'time'], 'ignore');
    const ids = filterColumns(t, [...F, 'Takeout', 'YouTube', 'history', '[*]']).map((c) => c.id);
    expect(ids.sort()).toEqual(['time', 'title']);
  });

  it('folds runs of single-child groups, but not into the rows of a table or past a name of its own', () => {
    const t = tree();
    const youtube = fileOf(t).children![0]!.children!.find((c) => c.name === 'YouTube')!;
    expect(foldChain(youtube, [...F, 'Takeout', 'YouTube']).map((c) => c.node.name)).toEqual(['YouTube', 'history']);
    youtube.named = 'youtube';
    expect(foldChain(youtube, [...F, 'Takeout', 'YouTube'])).toHaveLength(1);
  });

  it('counts decisions and undecided leaves', () => {
    let t = setDecision(tree(), [...F, 'Takeout', 'YouTube', 'history', '[*]', 'time'], 'donate');
    t = setDecision(t, [...F, 'Takeout', 'Chrome'], 'ignore');
    const states = effectiveStates(t);
    expect(countDecisions(t, states)).toEqual({ leaves: 3, undecided: 1, show: 0, donate: 1, ignore: 1 });
    expect(undecidedBelow(t, states).get(t)).toBe(1);
  });

  it('patches settings and removes empty ones', () => {
    const path = [...F, 'Takeout', 'YouTube', 'history', '[*]', 'title'];
    let t = patchNode(tree(), path, { as: 'url', transform: ['trim'] });
    expect(fileOf(t).children![0]!.children![1]!.children![0]!.children![0]!.children!.find((c) => c.name === 'title'))
      .toMatchObject({ as: 'url', transform: ['trim'] });
    t = patchNode(t, path, { transform: [], as: undefined });
    expect(JSON.stringify(t)).not.toMatch(/"trim"|"as"/);
  });

  it('saves the configuration and the seen structures as files, and keeps settings for parts not seen', () => {
    const config = { root: toConfig(setDecision(tree(), [...F, 'Takeout', 'Chrome', 'x'], 'donate')) };
    const empty = extractShape(jsonToTree('e.json', {}));
    const { structure, importer } = toFiles({ config, seen: empty });
    const back = fromFiles(structure, importer);
    expect(back.config.root).toEqual(config.root);
    // Nothing seen has Chrome: its settings wait, shown as not seen.
    expect(notSeen(buildTree(back.config, back.seen).tree).length).toBeGreaterThan(0);
    expect(notSeen(buildTree(back.config, addSeen(back.seen, shape())).tree)).toEqual([]);
  });

  it('picks icons for tables, lists of values, objects and leaves by type', () => {
    const t = keyed(
      extractShape(jsonToTree('x.json', { posts: [{ at: 1709284500, tags: ['a'], meta: { url: 'https://x.org' } }] })),
    );
    const posts = fileOf(t).children![0]!;
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
    let t = setDecision(tree(), [...F, 'Takeout', 'YouTube', 'history', '[*]', 'time'], 'donate');
    t = decideBelow(t, [...F, 'Takeout', 'YouTube'], 'show', true);
    const history = [...F, 'Takeout', 'YouTube', 'history', '[*]'];
    const states = effectiveStates(t);
    const node = (name: string) => fileOf(t).children![0]!.children!.find((c) => c.name === 'YouTube')!.children![0]!.children![0]!.children!.find((c) => c.name === name)!;
    expect(states.get(node('time'))).toBe('donate');
    expect(states.get(node('title'))).toBe('show');
    t = decideBelow(t, history, 'undecided', false);
    expect(countDecisions(t, effectiveStates(t)).undecided).toBe(3);
  });
});

describe('shortNames', () => {
  const html = (body: string) =>
    keyed(extractShape(normalizeTree(parseFile('a.html', new TextEncoder().encode(`<html><body>${body}</body></html>`)))));

  it('names the text of an element by the element, with as little of it as tells it apart', () => {
    const tree = html(
      '<div class="row"><div class="mdl-cell mdl-cell--12-col caption">x</div><div class="mdl-cell mdl-cell--6-col body">y</div></div>' +
        '<div class="row"><div class="mdl-cell mdl-cell--12-col caption">x</div><div class="mdl-cell mdl-cell--6-col body">y</div></div>',
    );
    const row = [...F, 'html', 'body', 'div.row', '[*]'];
    const cells = ['div.caption.mdl-cell.mdl-cell--12-col', 'div.body.mdl-cell.mdl-cell--6-col'].map((c) => [...row, c, '#text[0]']);
    const names = shortNames(tree, cells, row);
    expect(names.map((n) => n.short)).toEqual(['div.caption', 'div.body']);
    expect(names.every((n) => n.shortened)).toBe(true);
  });

  it('keeps a name that is already short, and adds steps only where names would clash', () => {
    const tree = keyed(extractShape(jsonToTree('e.json', { a: { title: 'x', id: 1 }, b: { title: 'y' } })));
    const names = shortNames(tree, [[...F, 'a', 'title'], [...F, 'a', 'id'], [...F, 'b', 'title']], F);
    expect(names.map((n) => n.short)).toEqual(['a / title', 'id', 'b / title']);
    expect(names[0]!.shortened).toBe(false);
    expect(names[1]!.shortened).toBe(true);
  });
});

describe('asParticipantsSee', () => {
  const columns = (t: ReturnType<typeof tree>) => deriveTables(t).flatMap((table) => table.columns.map((c) => c.id));

  it('leaves out undecided fields, so the preview shows what participants see', () => {
    const t = setDecision(tree(), [...F, 'Takeout', 'YouTube', 'history', '[*]', 'title'], 'show');
    expect(columns(asParticipantsSee(t))).toEqual(['title']);
    expect(columns(asParticipantsSee(tree()))).toEqual([]);
  });

  it('keeps undecided fields when the platform lets participants see them', () => {
    const t = { ...tree(), undecided: 'show' as const };
    expect(columns(asParticipantsSee(t)).sort()).toEqual(columns(t).sort());
  });
});

describe('row notes', () => {
  const folder = (files: Record<string, unknown>) => extractShape({ kind: 'dir', name: '', children: Object.entries(files).map(([name, json]) => jsonToTree(name, json)) });
  const english = folder({ 'watch-history.json': [{ title: 'a' }] });
  const dutch = folder({ 'kijkgeschiedenis.json': [{ title: 'b' }] });
  const seen = addSeen(undefined, english, dutch)!;

  it('flag a node that matches two keys side by side in one package, not in the union', () => {
    const one = (item: Record<string, string>) => folder({ 'h.json': [item] });
    const config: ProjectConfig = {
      root: {
        id: 'root',
        kind: 'dir',
        match: [],
        children: [
          {
            id: 'h',
            kind: 'dir',
            match: ['history'],
            files: [{ path: ['h.json'] }],
            children: [{ id: 'f', kind: 'list', match: [], children: [{ id: 'i', kind: 'map', match: ['[*]'], children: [{ id: 't', kind: 'value', match: [{ regex: '^tit' }] }] }] }],
          },
        ],
      },
    };
    const [english, dutch, both] = [one({ title: 'a' }), one({ titel: 'b' }), one({ title: 'a', titel: 'b' })];
    const built = buildTree(config, addSeen(undefined, english, dutch));
    const node = built.tree.children![0]!.children![0]!.children![0]!.children![0]!;
    expect(node.keys).toHaveLength(2);
    // Each package has one of the two keys: no conflict.
    expect(rowInfo(built, config, [english, dutch]).get(node)?.conflicts).toBeUndefined();
    // A package with both does.
    expect(rowInfo(built, config, [both]).get(node)?.conflicts).toBe(1);
  });

  it('flag config nodes nothing matches, and same-named nodes with different decisions', () => {
    const group = (id: string, file: string, decision?: 'show' | 'donate'): ConfigNode => ({
      id,
      kind: 'dir',
      match: [id],
      files: [{ path: [file] }],
      ...(decision
        ? { children: [{ id: `${id}-f`, kind: 'list', match: [], name: 'watch_history', children: [{ id: 'i', kind: 'map', match: ['[*]'], children: [{ id: 't', kind: 'value', match: ['title'], name: 'title', decision }] }] }] }
        : {}),
    });
    const config: ProjectConfig = {
      root: { id: 'root', kind: 'dir', match: [], children: [group('a', 'watch-history.json', 'show'), group('b', 'kijkgeschiedenis.json', 'donate'), group('c', 'other.json')] },
    };
    const built = buildTree(config, seen);
    const info = rowInfo(built, config, []);
    const [a, b, c] = built.tree.children!;
    expect(info.get(c!)?.notSeen).toBe(true);
    expect(info.get(a!)?.notSeen).toBeUndefined();
    const title = (g: ProjectNode) => g.children![0]!.children![0]!.children![0]!;
    expect(info.get(title(a!))?.nameMismatch).toBe(true);
    expect(info.get(title(b!))?.nameMismatch).toBe(true);
    const [fa, fb] = [a!.children![0]!, b!.children![0]!];
    expect(withSameNamesTogether([c!, fa, { ...c!, id: 'd' }, fb]).map((n) => n.id)).toEqual(['c', 'a-f', 'b-f', 'd']);
  });
});

describe('corrections in the saved files', () => {
  it('saves the seen structures without the keys a researcher says are data', () => {
    const seen = extractShape(jsonToTree('a.json', [{ comments: { anna: 'hi', bob: 'hey' } }]));
    const tree = buildTree(emptyConfig(seen.kind), seen).tree;
    const item = fileOf(tree).children![0]!;
    const keyed = setKeysAreData(tree, [tree.children![0]!.id, fileOf(tree).id, item.id, item.children![0]!.id]);
    const { structure } = toFiles({ config: { root: toConfig(keyed) }, seen });
    expect(JSON.stringify(structure)).not.toMatch(/anna|bob/);
  });

  it('notices where texts are names, so packages are read again', () => {
    const shape = extractShape(normalizeTree(parseFile('a.html', new TextEncoder().encode('<div><span>url</span><span>x</span></div>'))));
    const tree = buildTree(emptyConfig(shape.kind), shape).tree;
    expect(textMarks(tree)).toBe('');
    expect(textMarks(patchNode(tree, [tree.children![0]!.id, fileOf(tree).id, fileOf(tree).children![0]!.id], { textNames: 'pairs' }))).not.toBe('');
  });
});
