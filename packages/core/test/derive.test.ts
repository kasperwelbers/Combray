import { describe, expect, it } from 'vitest';

import {
  deriveRows,
  deriveTables,
  extractShape,
  jsonToTree,
  projectTreeFromShape,
  setDecision,
  setTable,
  type ProjectNode,
} from '../src';
import { watchHistory } from './fixtures';

const base = () => projectTreeFromShape(extractShape(watchHistory));

describe('deriveTables', () => {
  it('makes implicit tables at repeated nodes, with list cells below none', () => {
    const tables = deriveTables(base());
    expect(tables.map((t) => [t.name, t.rows, t.implicit, t.parent])).toEqual([
      ['', ['[*]'], true, undefined],
      ['subtitles', ['[*]', 'subtitles', '[*]'], true, 0],
    ]);
    expect(tables[0]!.columns.map((c) => [c.id, c.name, c.type])).toEqual([
      ['time', 'time', 'value'],
      ['title', 'title', 'value'],
      ['titleUrl', 'titleUrl', 'value'],
      ['subtitles/[*]', 'subtitles', 'table'],
    ]);
    expect(tables[0]!.columns.find((c) => c.type === 'table')!.table).toBe(1);
  });

  it('puts leaves below a marked table in it, with lists as list cells', () => {
    let tree = setTable(base(), [], true);
    tree = setDecision(tree, ['[*]', 'time'], 'donate');
    const tables = deriveTables({ ...tree, label: { en: 'History' } });
    expect(tables).toHaveLength(1);
    const [history] = tables;
    expect(history!.name).toEqual({ en: 'History' });
    expect(history!.rows).toEqual(['[*]']);
    expect(history!.state).toBe('donate');
    const byId = Object.fromEntries(history!.columns.map((c) => [c.id, c]));
    expect(byId['time']!.state).toBe('donate');
    expect(byId['subtitles/[*]/name']).toMatchObject({ name: 'name', type: 'list', unnest: 'count' });
    expect(byId['subtitles/[*]/url']).toMatchObject({ name: 'url', type: 'list' });
  });

  it('names columns by their shortest unique suffix only when they collide', () => {
    const tree = projectTreeFromShape(
      extractShape(jsonToTree('a.json', [{ url: 'x', video: { url: 'y', title: 't' }, author: { url: 'z' } }])),
    );
    expect(deriveTables(tree)[0]!.columns.map((c) => c.name)).toEqual([
      'author/url',
      'url',
      'title',
      'video/url',
    ]);
  });

  it('supports nested marked tables', () => {
    let tree = setTable(base(), [], true);
    tree = setTable(tree, ['[*]', 'subtitles'], true);
    const tables = deriveTables(tree);
    expect(tables.map((t) => [t.name, t.parent])).toEqual([
      ['', undefined],
      ['subtitles', 0],
    ]);
    expect(tables[1]!.columns.map((c) => c.name)).toEqual(['name', 'url']);
  });

  it('leaves out ignored leaves and tables', () => {
    let tree = setDecision(base(), ['[*]', 'subtitles'], 'ignore');
    tree = setDecision(tree, ['[*]', 'titleUrl'], 'ignore');
    const tables = deriveTables(tree);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.columns.map((c) => c.id)).toEqual(['time', 'title']);
  });

  it('puts leaves outside any repeated node in a single record', () => {
    const tree = projectTreeFromShape(
      extractShape(jsonToTree('profile.json', { user: { name: 'x', joined: '2020-01-01' }, posts: [{ text: 'a' }] })),
    );
    const tables = deriveTables(tree);
    expect(tables.map((t) => [t.name, t.rows])).toEqual([
      ['', undefined],
      ['posts', ['posts', '[*]']],
    ]);
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(['joined', 'name']);
  });
});

describe('deriveRows', () => {
  it('extracts rows, list cells and nested counts, matching aliases', () => {
    const tree: ProjectNode = setTable(base(), [], true);
    const tables = deriveTables(tree);
    const rows = deriveRows(watchHistory, tree, tables)[0]!;
    expect(rows).toHaveLength(3);
    expect(rows[1]!.values).toMatchObject({
      time: '2024-03-02T18:40:00.000Z',
      'subtitles/[*]/name': ['Tisane Channel', 'Combray Kitchen'],
    });
    expect(rows[2]!.values).toMatchObject({ titleUrl: null, 'subtitles/[*]/name': [] });
  });

  it('links nested rows to their parent row and counts them', () => {
    const tables = deriveTables(base());
    const [parents, children] = deriveRows(watchHistory, base(), tables);
    expect(parents!.map((r) => r.values['subtitles/[*]'])).toEqual([1, 2, 0]);
    expect(children!.map((r) => [r.parent, r.values['name']])).toEqual([
      [0, 'Aunt Leonie Bakes'],
      [1, 'Tisane Channel'],
      [1, 'Combray Kitchen'],
    ]);
  });

  it('matches renamed keys through aliases', () => {
    const tree = base();
    tree.children![0]!.children!.find((c) => c.name === 'time')!.aliases = ['date'];
    const other = jsonToTree('mine.json', [{ title: 'a', date: '2024-01-01' }]);
    const rows = deriveRows(other, tree, deriveTables(tree))[0]!;
    expect(rows[0]!.values).toMatchObject({ title: 'a', time: '2024-01-01' });
  });
});

describe('tables with metadata above their rows', () => {
  it('puts leaves above the rows of a marked table in the record above it', () => {
    let tree = projectTreeFromShape(
      extractShape(jsonToTree('a.json', { history: { version: '2', items: [{ url: 'x' }] } })),
    );
    tree = setTable(tree, ['history'], true);
    const tables = deriveTables(tree);
    expect(tables.map((t) => [t.name, t.rows, t.columns.map((c) => c.id)])).toEqual([
      ['', undefined, ['history/version']],
      ['history', ['history', 'items', '[*]'], ['url']],
    ]);
    const rows = deriveRows(jsonToTree('b.json', { history: { version: '3', items: [{ url: 'y' }, { url: 'z' }] } }), tree, tables);
    expect(rows.map((r) => r.map((row) => row.values))).toEqual([[{ 'history/version': '3' }], [{ url: 'y' }, { url: 'z' }]]);
  });
});

describe('column names for HTML', () => {
  it('shorten element names to tag and first class when that keeps them unique', () => {
    const tree: ProjectNode = {
      kind: 'list',
      name: '',
      children: [
        {
          kind: 'element',
          name: '[*]',
          children: [
            { kind: 'element', name: 'div.body.content-cell', children: [{ kind: 'value', name: '#text[0]' }] },
            { kind: 'element', name: 'p.title.x', children: [{ kind: 'value', name: '#text[0]' }] },
          ],
        },
      ],
    };
    expect(deriveTables(tree)[0]!.columns.map((c) => c.name)).toEqual(['div.body/#text[0]', 'p.title/#text[0]']);
  });
});
