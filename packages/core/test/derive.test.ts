import { describe, expect, it } from 'vitest';

import {
  deriveRows,
  deriveTables,
  extractShape,
  jsonToTree,
  KEY_COLUMN,
  projectTreeFromShape,
  setDecision,
  VALUE_COLUMN,
  type ProjectNode,
} from '../src';
import { watchHistory } from './fixtures';

const base = () => projectTreeFromShape(extractShape(watchHistory));
const tweets = jsonToTree('tweets.json', {
  user: { name: 'Leonie', joined: '2020-01-01' },
  tweets: [
    {
      text: 'Madeleines today',
      tags: ['baking', 'tea'],
      stats: { likes: 3 },
      comments: [
        { by: 'Marcel', text: 'Lovely' },
        { by: 'Swann', text: 'Save me one' },
      ],
    },
    { text: 'Rain again', tags: [], stats: { likes: 0 }, comments: [] },
  ],
});

describe('deriveTables', () => {
  it('makes every list of objects a table, nested where it sits in another', () => {
    const tables = deriveTables(base());
    expect(tables.map((t) => [t.name, t.rows, t.parent])).toEqual([
      ['', ['[*]'], undefined],
      ['subtitles', ['[*]', 'subtitles', '[*]'], 0],
    ]);
    expect(tables[0]!.columns.map((c) => [c.id, c.name, c.type])).toEqual([
      ['time', 'time', 'value'],
      ['title', 'title', 'value'],
      ['titleUrl', 'titleUrl', 'value'],
      ['subtitles/[*]', 'subtitles', 'table'],
    ]);
    expect(tables[0]!.columns.find((c) => c.type === 'table')!.table).toBe(1);
    expect(tables[1]!.columns.map((c) => c.name)).toEqual(['name', 'url']);
  });

  it('turns objects into more columns, lists of values into list cells, and loose fields into a record', () => {
    const tables = deriveTables(projectTreeFromShape(extractShape(tweets)));
    expect(tables.map((t) => [t.name, t.rows, t.parent])).toEqual([
      ['', undefined, undefined],
      ['tweets', ['tweets', '[*]'], undefined],
      ['comments', ['tweets', '[*]', 'comments', '[*]'], 1],
    ]);
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(['joined', 'name']);
    expect(tables[1]!.columns.map((c) => [c.name, c.type])).toEqual([
      ['likes', 'value'],
      ['tags', 'list'],
      ['text', 'value'],
      ['comments', 'table'],
    ]);
  });

  it('names columns by their shortest unique suffix only when they collide', () => {
    const tree = projectTreeFromShape(
      extractShape(jsonToTree('a.json', [{ url: 'x', video: { url: 'y', title: 't' }, author: { url: 'z' } }])),
    );
    expect(deriveTables(tree)[0]!.columns.map((c) => c.name)).toEqual(['author/url', 'url', 'title', 'video/url']);
  });

  it('uses labels for tables and columns', () => {
    const tree = base();
    tree.children![0]!.label = { en: 'Videos' };
    tree.children![0]!.children!.find((c) => c.name === 'time')!.label = { en: 'Watched at' };
    const [videos] = deriveTables(tree);
    expect(videos!.name).toEqual({ en: 'Videos' });
    expect(videos!.columns.find((c) => c.id === 'time')!.name).toEqual({ en: 'Watched at' });
  });

  it('leaves out ignored leaves and tables, and passes donate up to the table', () => {
    let tree = setDecision(base(), ['[*]', 'subtitles'], 'ignore');
    tree = setDecision(tree, ['[*]', 'titleUrl'], 'ignore');
    tree = setDecision(tree, ['[*]', 'time'], 'donate');
    const tables = deriveTables(tree);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.state).toBe('donate');
    expect(tables[0]!.columns.map((c) => [c.id, c.state])).toEqual([
      ['time', 'donate'],
      ['title', 'show'],
    ]);
  });

  it('makes a table with a key column for maps whose keys are data', () => {
    const tree = projectTreeFromShape(
      extractShape(
        jsonToTree(
          'a.json',
          Array.from({ length: 4 }, (_, i) => ({ text: 't', comments: { [`u${i}a`]: 'hey', [`u${i}b`]: 'yo' } })),
        ),
      ),
    );
    const tables = deriveTables(tree);
    expect(tables.map((t) => [t.name, t.keyed, t.parent])).toEqual([
      ['', undefined, undefined],
      ['comments', true, 0],
    ]);
    expect(tables[1]!.columns.map((c) => [c.id, c.type])).toEqual([
      [KEY_COLUMN, 'key'],
      [VALUE_COLUMN, 'value'],
    ]);
    const rows = deriveRows(
      jsonToTree('b.json', [{ text: 'x', comments: { anna: 'hi', bob: 'hey' } }]),
      tree,
      tables,
    );
    expect(rows[1]!.map((r) => r.values)).toEqual([
      { [KEY_COLUMN]: 'anna', [VALUE_COLUMN]: 'hi' },
      { [KEY_COLUMN]: 'bob', [VALUE_COLUMN]: 'hey' },
    ]);
    expect(rows[0]![0]!.values['comments/{*}']).toBe(2);
  });
});

describe('deriveRows', () => {
  it('extracts rows, list cells and nested counts', () => {
    const tree = projectTreeFromShape(extractShape(tweets));
    const tables = deriveTables(tree);
    const [record, rows, comments] = deriveRows(tweets, tree, tables);
    expect(record!.map((r) => r.values)).toEqual([{ 'user/joined': '2020-01-01', 'user/name': 'Leonie' }]);
    expect(rows!.map((r) => r.values)).toEqual([
      { 'stats/likes': '3', 'tags/[*]': ['baking', 'tea'], text: 'Madeleines today', 'comments/[*]': 2 },
      { 'stats/likes': '0', 'tags/[*]': [], text: 'Rain again', 'comments/[*]': 0 },
    ]);
    expect(comments!.map((r) => [r.parent, r.values['by']])).toEqual([
      [0, 'Marcel'],
      [0, 'Swann'],
    ]);
  });

  it('matches renamed keys through aliases', () => {
    const tree: ProjectNode = base();
    tree.children![0]!.children!.find((c) => c.name === 'time')!.aliases = ['date'];
    const other = jsonToTree('mine.json', [{ title: 'a', date: '2024-01-01' }]);
    const rows = deriveRows(other, tree, deriveTables(tree))[0]!;
    expect(rows[0]!.values).toMatchObject({ title: 'a', time: '2024-01-01' });
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
