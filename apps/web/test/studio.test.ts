import { deriveTables, extractShape, jsonToTree, normalizeTree, parseFile, projectTreeFromShape, setDecision, effectiveStates } from '@combray/core';
import { describe, expect, it } from 'vitest';

import {
  asParticipantsSee,
  countDecisions,
  decideBelow,
  displayName,
  filterColumns,
  foldChain,
  fromFiles,
  nodeIcon,
  patchNode,
  shortNames,
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
  it('offers ignored fields to row filters', () => {
    const t = setDecision(tree(), ['Takeout', 'YouTube', 'history', '[*]', 'time'], 'ignore');
    const ids = filterColumns(t, ['Takeout', 'YouTube', 'history', '[*]']).map((c) => c.id);
    expect(ids.sort()).toEqual(['time', 'title']);
  });

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

describe('shortNames', () => {
  const html = (body: string) =>
    projectTreeFromShape(extractShape(normalizeTree(parseFile('a.html', new TextEncoder().encode(`<html><body>${body}</body></html>`)))));

  it('names the text of an element by the element, with as little of it as tells it apart', () => {
    const tree = html(
      '<div class="row"><div class="mdl-cell mdl-cell--12-col caption">x</div><div class="mdl-cell mdl-cell--6-col body">y</div></div>' +
        '<div class="row"><div class="mdl-cell mdl-cell--12-col caption">x</div><div class="mdl-cell mdl-cell--6-col body">y</div></div>',
    );
    const row = ['html', 'body', 'div.row', '[*]'];
    const cells = ['div.caption.mdl-cell.mdl-cell--12-col', 'div.body.mdl-cell.mdl-cell--6-col'].map((c) => [...row, c, '#text[0]']);
    const names = shortNames(tree, cells, row);
    expect(names.map((n) => n.short)).toEqual(['div.caption', 'div.body']);
    expect(names.every((n) => n.shortened)).toBe(true);
  });

  it('keeps a name that is already short, and adds steps only where names would clash', () => {
    const tree = projectTreeFromShape(
      extractShape(jsonToTree('e.json', { a: { title: 'x', id: 1 }, b: { title: 'y' } })),
    );
    const names = shortNames(tree, [['e.json', 'a', 'title'], ['e.json', 'a', 'id'], ['e.json', 'b', 'title']], ['e.json']);
    expect(names.map((n) => n.short)).toEqual(['a / title', 'id', 'b / title']);
    expect(names[0]!.shortened).toBe(false);
    expect(names[1]!.shortened).toBe(true);
  });
});

describe('asParticipantsSee', () => {
  const columns = (t: ReturnType<typeof tree>) => deriveTables(t).flatMap((table) => table.columns.map((c) => c.id));

  it('leaves out undecided fields, so the preview shows what participants see', () => {
    const t = setDecision(tree(), ['Takeout', 'YouTube', 'history', '[*]', 'title'], 'show');
    expect(columns(asParticipantsSee(t))).toEqual(['title']);
    expect(columns(asParticipantsSee(tree()))).toEqual([]);
  });

  it('keeps undecided fields when the platform lets participants see them', () => {
    const t = { ...tree(), undecided: 'show' as const };
    expect(columns(asParticipantsSee(t)).sort()).toEqual(columns(t).sort());
  });
});
