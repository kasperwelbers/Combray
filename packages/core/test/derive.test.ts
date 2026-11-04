import { describe, expect, it } from 'vitest';

import {
  buildTree,
  deriveRows,
  deriveTables,
  extractShape,
  groupTables,
  jsonToTree,
  KEY_COLUMN,
  localize,
  outline,
  setDecision,
  toConfig,
  VALUE_COLUMN,
  valuesAt,
  type ConfigNode,
  type DerivedRow,
  type ProjectNode,
  type TableDef,
} from '../src';
import { watchHistory } from './fixtures';
import { at, nodeAt, treeOf } from './trees';

const base = () => treeOf(extractShape(watchHistory));
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
const tweetTree = () => treeOf(extractShape(tweets));

/** A row's values by column name, for reading tests. */
function named(table: TableDef, row: DerivedRow): Record<string, unknown> {
  return Object.fromEntries(table.columns.filter((c) => c.id in row.values).map((c) => [localize(c.name, 'en') || c.id, row.values[c.id]]));
}

const columnId = (table: TableDef, name: string) => table.columns.find((c) => localize(c.name, 'en') === name)!.id;

describe('deriveTables', () => {
  it('makes every list of objects a table, nested where it sits in another', () => {
    const tree = base();
    const tables = deriveTables(tree);
    expect(tables.map((t) => [t.name, t.where, t.parent])).toEqual([
      ['', ['[*]'], undefined],
      ['subtitles', ['[*]', 'subtitles', '[*]'], 0],
    ]);
    expect(tables[0]!.columns.map((c) => [c.name, c.type])).toEqual([
      ['time', 'value'],
      ['title', 'value'],
      ['titleUrl', 'value'],
      ['subtitles', 'table'],
    ]);
    // Without names, columns are named by the path of ids from the row, and tables by their rows.
    expect(tables[0]!.id).toBe(at(tree, '[*]').join('/'));
    expect(columnId(tables[0]!, 'time')).toBe(at(tree, '[*]', 'time').slice(1).join('/'));
    expect(tables[0]!.columns.find((c) => c.type === 'table')).toMatchObject({ table: 1, id: at(tree, '[*]', 'subtitles', '[*]').slice(1).join('/') });
    expect(tables[1]!.columns.map((c) => c.name)).toEqual(['name', 'url']);
  });

  it('turns objects into more columns, lists of values into list cells, and loose fields into a record', () => {
    const tables = deriveTables(tweetTree());
    expect(tables.map((t) => [t.name, t.where, t.parent])).toEqual([
      ['', [], undefined],
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
    const tree = treeOf(extractShape(jsonToTree('a.json', [{ url: 'x', video: { url: 'y', title: 't' }, author: { url: 'z' } }])));
    expect(deriveTables(tree)[0]!.columns.map((c) => c.name)).toEqual(['author/url', 'url', 'title', 'video/url']);
  });

  it('uses names for tables and columns, and their ids as the ids', () => {
    const tree = base();
    Object.assign(nodeAt(tree, '[*]'), { nameId: 'videos', label: { en: 'Videos' } });
    Object.assign(nodeAt(tree, '[*]', 'time'), { nameId: 'when', label: { en: 'Watched at' } });
    const [videos] = deriveTables(tree);
    expect(videos!.name).toEqual({ en: 'Videos' });
    expect(videos!.id).toBe('videos');
    expect(videos!.columns.find((c) => c.id === 'when')!.name).toEqual({ en: 'Watched at' });
  });

  it('leaves out ignored leaves and tables, and passes donate up to the table', () => {
    let tree = base();
    tree = setDecision(tree, at(tree, '[*]', 'subtitles'), 'ignore');
    tree = setDecision(tree, at(tree, '[*]', 'titleUrl'), 'ignore');
    tree = setDecision(tree, at(tree, '[*]', 'time'), 'donate');
    const tables = deriveTables(tree);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.state).toBe('donate');
    expect(tables[0]!.columns.map((c) => [c.name, c.state])).toEqual([
      ['time', 'donate'],
      ['title', 'show'],
    ]);
  });

  it('makes a table with a key column for maps whose keys are data', () => {
    const tree = treeOf(
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
    const rows = deriveRows(jsonToTree('b.json', [{ text: 'x', comments: { anna: 'hi', bob: 'hey' } }]), tree, tables);
    expect(rows[1]!.map((r) => r.values)).toEqual([
      { [KEY_COLUMN]: 'anna', [VALUE_COLUMN]: 'hi' },
      { [KEY_COLUMN]: 'bob', [VALUE_COLUMN]: 'hey' },
    ]);
    expect(named(tables[0]!, rows[0]![0]!).comments).toBe(2);
  });
});

describe('deriveRows', () => {
  it('extracts rows, list cells and nested counts', () => {
    const tree = tweetTree();
    const tables = deriveTables(tree);
    const [record, rows, comments] = deriveRows(tweets, tree, tables);
    expect(record!.map((r) => named(tables[0]!, r))).toEqual([{ joined: '2020-01-01', name: 'Leonie' }]);
    expect(rows!.map((r) => named(tables[1]!, r))).toEqual([
      { likes: '3', tags: ['baking', 'tea'], text: 'Madeleines today', comments: 2 },
      { likes: '0', tags: [], text: 'Rain again', comments: 0 },
    ]);
    expect(comments!.map((r) => [r.parent, named(tables[2]!, r).by])).toEqual([
      [0, 'Marcel'],
      [0, 'Swann'],
    ]);
  });

  it('converts values as their leaves say, and keeps raw values when asked', () => {
    const tree = tweetTree();
    Object.assign(nodeAt(tree, 'tweets', '[*]', 'stats', 'likes'), { as: 'int' });
    Object.assign(nodeAt(tree, 'tweets', '[*]', 'text'), { transform: ['lowercase'], role: 'title' });
    Object.assign(nodeAt(tree, 'user', 'joined'), { as: 'datetime', format: 'YYYY-MM-DD', role: 'date' });
    const tables = deriveTables(tree);
    expect(tables[1]!.columns.find((c) => c.name === 'text')).toMatchObject({ transform: ['lowercase'], role: 'title' });
    const [record, rows] = deriveRows(tweets, tree, tables);
    expect(named(tables[0]!, record![0]!).joined).toBe('2020-01-01T00:00:00');
    expect(rows!.map((r) => [named(tables[1]!, r).text, named(tables[1]!, r).likes])).toEqual([
      ['madeleines today', 3],
      ['rain again', 0],
    ]);
    const [, raw] = deriveRows(tweets, tree, tables, { raw: true });
    expect(named(tables[1]!, raw![0]!).likes).toBe('3');
  });

  it('leaves out rows that do not meet the filters, with their nested rows', () => {
    const tree = tweetTree();
    const tables0 = deriveTables(tree);
    const text = columnId(tables0[1]!, 'text');
    const item = nodeAt(tree, 'tweets', '[*]');
    item.filter = [{ column: text, test: { matches: '^rain', flags: 'i' }, not: true }];
    const tables = deriveTables(tree);
    const [, rows, comments] = deriveRows(tweets, tree, tables);
    expect(rows!.map((r) => r.values[text])).toEqual(['Madeleines today']);
    expect(comments).toHaveLength(2);
    item.filter = [{ column: text, test: { contains: 'rain' } }];
    const [, rainy, none] = deriveRows(tweets, tree, deriveTables(tree));
    expect(rainy!.map((r) => named(tables[1]!, r).comments)).toEqual([0]);
    expect(none).toEqual([]);
    // A filter on a column the table does not have keeps nothing, rather than everything.
    item.filter = [{ column: 'nope', test: { empty: true } }];
    expect(deriveRows(tweets, tree, deriveTables(tree))[1]).toEqual([]);
    // So does a pattern that does not compile (from a hand-edited file), instead of throwing.
    item.filter = [{ column: text, test: { matches: '(' } }];
    expect(deriveRows(tweets, tree, deriveTables(tree))[1]).toEqual([]);
  });

  it('filters on ignored fields and on nested tables without showing them', () => {
    const tree = tweetTree();
    const all = deriveTables(tree);
    const likes = columnId(all[1]!, 'likes');
    const nested = columnId(all[1]!, 'comments');
    nodeAt(tree, 'tweets', '[*]', 'stats').decision = 'ignore';
    nodeAt(tree, 'tweets', '[*]').filter = [
      { column: likes, test: { min: 1 } },
      { column: nested, test: { min: 1 } },
    ];
    const tables = deriveTables(tree);
    expect(tables[1]!.hidden?.map((c) => [c.id, c.type])).toEqual([[likes, 'value']]);
    const [, rows] = deriveRows(tweets, tree, tables);
    expect(rows!.map((r) => named(tables[1]!, r))).toEqual([{ tags: ['baking', 'tea'], text: 'Madeleines today', comments: 2 }]);
  });

  it('matches renamed keys through a node\'s matches', () => {
    const tree = base();
    nodeAt(tree, '[*]', 'time').match = ['time', 'date'];
    const tables = deriveTables(tree);
    const rows = deriveRows(jsonToTree('mine.json', [{ title: 'a', date: '2024-01-01' }]), tree, tables)[0]!;
    expect(named(tables[0]!, rows[0]!)).toMatchObject({ title: 'a', time: '2024-01-01' });
  });

  it('gives a value to every node that matches it: one field read two ways', () => {
    const config: ConfigNode = {
      id: 'root',
      kind: 'list',
      match: [],
      children: [
        {
          id: 'rows',
          kind: 'map',
          match: ['[*]'],
          children: [
            { id: 'date', kind: 'value', match: ['time'], as: 'datetime', decision: 'show' },
            { id: 'hour', kind: 'value', match: ['time'], transform: [{ match: { pattern: 'T(\\d\\d)', group: 1 } }], decision: 'show' },
          ],
        },
      ],
    };
    const tree = buildTree({ root: config, names: [] }, extractShape(watchHistory)).tree;
    const tables = deriveTables(tree);
    const rows = deriveRows(watchHistory, tree, tables)[0]!;
    expect(rows[0]!.values).toMatchObject({ date: '2024-03-01T09:15:00.000Z', hour: '09' });
  });
});

describe('names that join tables and columns', () => {
  // An English JSON history and a Dutch HTML-like history: different structures, one table.
  const english = jsonToTree('watch-history.json', [{ title: 'Madeleines', time: '2024-03-01' }]);
  const dutch = jsonToTree('kijkgeschiedenis.json', [{ titel: 'Thee', tijdstip: '1 maart 2024' }]);
  const folder = { kind: 'dir' as const, name: '', children: [english, dutch] };
  const config: ConfigNode = {
    id: 'root',
    kind: 'dir',
    match: [],
    children: [
      {
        id: 'en',
        kind: 'list',
        match: ['watch-history.json'],
        nameId: 'history',
        children: [{ id: 'en-rows', kind: 'map', match: ['[*]'], children: [
          { id: 'en-title', kind: 'value', match: ['title'], nameId: 'title', decision: 'show' },
          { id: 'en-time', kind: 'value', match: ['time'], decision: 'donate' },
        ] }],
      },
      {
        id: 'nl',
        kind: 'list',
        match: ['kijkgeschiedenis.json'],
        nameId: 'history',
        children: [{ id: 'nl-rows', kind: 'map', match: ['[*]'], children: [
          { id: 'nl-title', kind: 'value', match: ['titel'], nameId: 'title', decision: 'show' },
          { id: 'nl-time', kind: 'value', match: ['tijdstip'], decision: 'show' },
        ] }],
      },
    ],
  };
  const names = [
    { id: 'history', text: 'Watch history', label: { nl: 'Kijkgeschiedenis' } },
    { id: 'title', text: 'Title' },
  ];

  it('are one table for participants, with one column per name and the rest side by side', () => {
    const tree: ProjectNode = buildTree({ root: config, names }, extractShape(folder)).tree;
    const tables = deriveTables(tree);
    expect(tables.map((t) => t.id)).toEqual(['history', 'history']);
    const grouped = groupTables(tables, deriveRows(folder, tree, tables));
    expect(grouped.tables).toHaveLength(1);
    const [table] = grouped.tables;
    expect(table!.name).toEqual({ en: 'Watch history', nl: 'Kijkgeschiedenis' });
    expect(table!.columns.map((c) => [c.id, c.state])).toEqual([
      ['title', 'show'],
      ['en-time', 'donate'],
      ['nl-time', 'show'],
    ]);
    expect(grouped.rows[0]!.map((r) => r.values)).toEqual([
      { title: 'Madeleines', 'en-time': '2024-03-01' },
      { title: 'Thee', 'nl-time': '1 maart 2024' },
    ]);
    expect(table!.state).toBe('donate');
  });

  it('keep nested rows with their own parent when tables join', () => {
    const a = jsonToTree('a.json', [{ x: 1, tags: [{ t: 'p' }] }]);
    const b = jsonToTree('b.json', [{ x: 2, tags: [{ t: 'q' }, { t: 'r' }] }, { x: 3, tags: [{ t: 's' }] }]);
    const data = { kind: 'dir' as const, name: '', children: [a, b] };
    const nested = (file: string): ConfigNode => ({
      id: file,
      kind: 'list',
      match: [file],
      nameId: 'n',
      children: [{ id: `${file}-rows`, kind: 'map', match: ['[*]'], children: [{ id: `${file}-x`, kind: 'value', match: ['x'], nameId: 'x' }, { id: `${file}-tags`, kind: 'list', match: ['tags'], nameId: 'tags' }] }],
    });
    const tree = buildTree(
      { root: { id: 'root', kind: 'dir', match: [], children: [nested('a.json'), nested('b.json')] }, names: [{ id: 'n', text: 'N' }, { id: 'x', text: 'X' }, { id: 'tags', text: 'Tags' }] },
      extractShape(data),
    ).tree;
    const tables = deriveTables(tree);
    const grouped = groupTables(tables, deriveRows(data, tree, tables));
    expect(grouped.tables.map((t) => [t.id, t.parent])).toEqual([
      ['n', undefined],
      ['tags', 0],
    ]);
    expect(grouped.tables[0]!.columns.filter((c) => c.type === 'table')).toHaveLength(1);
    expect(grouped.rows[1]!.map((r) => [r.parent, Object.values(r.values)[0]])).toEqual([
      [0, 'p'],
      [1, 'q'],
      [1, 'r'],
      [2, 's'],
    ]);
  });
});

describe('column names for HTML', () => {
  const html = (cells: ConfigNode[]): ProjectNode =>
    buildTree({ root: { id: 'root', kind: 'list', match: [], children: [{ id: 'row', kind: 'element', match: ['[*]'], children: cells }] }, names: [] }).tree;
  const cell = (name: string): ConfigNode => ({ id: name, kind: 'element', match: [name], children: [{ id: `${name}-t`, kind: 'value', match: ['#text[0]'] }] });

  it('shorten element names to tag and first class when that keeps them unique', () => {
    const tree = html([cell('div.body.content-cell'), cell('p.title.x')]);
    expect(deriveTables(tree)[0]!.columns.map((c) => c.name)).toEqual(['div.body/#text[0]', 'p.title/#text[0]']);
  });

  it('keep the classes that tell elements apart when the first class does not', () => {
    const tree = html([cell('div.content-cell.mdl-cell.mdl-cell--12-col'), cell('div.content-cell.mdl-cell.mdl-cell--6-col')]);
    expect(deriveTables(tree)[0]!.columns.map((c) => c.name)).toEqual(['div.mdl-cell--12-col/#text[0]', 'div.mdl-cell--6-col/#text[0]']);
  });
});

describe('outline', () => {
  it('lists tables and fields only, with short names, ignored ones included', () => {
    const tree = tweetTree();
    nodeAt(tree, 'user').decision = 'ignore';
    const o = outline(tree);
    expect(o.fields.map((f) => f.name)).toEqual(['joined', 'name']);
    expect(o.groups.map((g) => g.name)).toEqual(['tweets']);
    const tweetsGroup = o.groups[0]!;
    expect(tweetsGroup.fields.map((f) => [f.name, f.path])).toEqual([
      ['likes', at(tree, 'tweets', '[*]', 'stats', 'likes')],
      ['tags', at(tree, 'tweets', '[*]', 'tags', '[*]')],
      ['text', at(tree, 'tweets', '[*]', 'text')],
    ]);
    expect(tweetsGroup.groups[0]!.fields.map((f) => f.name)).toEqual(['by', 'text']);
  });
});

describe('valuesAt', () => {
  it('finds the raw values at a project path, in every item', () => {
    const tree = tweetTree();
    expect(valuesAt(tweets, tree, at(tree, 'tweets', '[*]', 'text'))).toEqual(['Madeleines today', 'Rain again']);
    expect(valuesAt(tweets, tree, at(tree, 'tweets', '[*]', 'comments', '[*]', 'by'))).toEqual(['Marcel', 'Swann']);
    expect(valuesAt(tweets, tree, at(tree, 'user', 'name'))).toEqual(['Leonie']);
    expect(valuesAt(tweets, tree, ['nope'])).toEqual([]);
  });

  it('follows a node with several matches', () => {
    const tree = tweetTree();
    nodeAt(tree, 'user', 'name').match = ['name', 'joined'];
    expect(valuesAt(tweets, tree, at(tree, 'user', 'name')).sort()).toEqual(['2020-01-01', 'Leonie']);
    expect(toConfig(tree).children).toBeUndefined();
  });
});
