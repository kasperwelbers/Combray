import { describe, expect, it } from 'vitest';

import {
  chartData,
  chartQuery,
  datePart,
  deriveRows,
  deriveTables,
  extractShape,
  jsonToTree,
  projectTreeFromShape,
  queryColumns,
  QueryError,
  runQuery,
  type Query,
} from '../src';

const tree = jsonToTree('tweets.json', {
  tweets: [
    {
      at: '2024-03-01T10:00:00Z',
      text: 'Madeleines today',
      tags: ['baking', 'tea'],
      stats: { likes: 3 },
      comments: [
        { by: 'Marcel', text: 'Lovely' },
        { by: 'Swann', text: 'Save me one' },
      ],
    },
    { at: '2024-03-02T09:00:00Z', text: 'Rain again', tags: [], stats: { likes: 0 }, comments: [] },
    { at: '2024-04-10T21:30:00Z', text: 'Tea', tags: ['tea'], stats: { likes: 5 }, comments: [{ by: 'Marcel', text: 'Yes' }] },
  ],
});
const project = projectTreeFromShape(extractShape(tree));
const tables = deriveTables(project);
const rows = deriveRows(tree, project, tables);
const run = (query: Query) => runQuery(tables, rows, query);

describe('runQuery', () => {
  it('counts rows per month', () => {
    const result = run({
      from: 0,
      steps: [
        { mutate: 'month', from: 'at', fn: { datePart: 'month' } },
        { group: ['month'] },
        { summarise: [{ name: 'n', fn: 'count' }, { name: 'likes', fn: 'sum', column: 'stats/likes' }] },
        { arrange: 'month' },
      ],
    });
    expect(result.columns.map((c) => c.id)).toEqual(['month', 'n', 'likes']);
    expect(result.rows).toEqual([
      { month: '2024-03', n: 2, likes: 3 },
      { month: '2024-04', n: 1, likes: 5 },
    ]);
  });

  it('unnests nested tables with the parent row alongside', () => {
    const result = run({
      from: 0,
      steps: [{ unnest: 1 }, { filter: 'comments/[*]/by', test: { equals: 'Marcel' } }, { select: ['text', 'comments/[*]/text'] }],
    });
    expect(result.rows).toEqual([
      { text: 'Madeleines today', 'comments/[*]/text': 'Lovely' },
      { text: 'Tea', 'comments/[*]/text': 'Yes' },
    ]);
    const kept = run({ from: 0, steps: [{ unnest: 1, keepEmpty: true }, { summarise: [{ name: 'n', fn: 'count' }] }] });
    expect(kept.rows).toEqual([{ n: 4 }]);
  });

  it('unnests list cells and counts distinct values', () => {
    const result = run({
      from: 0,
      steps: [
        { unnestList: 'tags/[*]' },
        { filter: 'tags/[*]', test: { empty: false } },
        { group: ['tags/[*]'] },
        { summarise: [{ name: 'n', fn: 'count' }] },
        { arrange: 'n', desc: true },
        { limit: 1 },
      ],
    });
    expect(result.rows).toEqual([{ 'tags/[*]': 'tea', n: 2 }]);
    const distinct = run({
      from: 0,
      steps: [{ unnest: 1 }, { summarise: [{ name: 'd', fn: 'distinct', column: 'comments/[*]/by' }] }],
    });
    expect(distinct.rows).toEqual([{ d: 2 }]);
  });

  it('filters ranges and negations', () => {
    const n = (steps: Query['steps']) => run({ from: 0, steps: [...steps, { summarise: [{ name: 'n', fn: 'count' }] }] }).rows[0]!.n;
    expect(n([{ filter: 'stats/likes', test: { min: 1 } }])).toBe(2);
    expect(n([{ filter: 'at', test: { min: '2024-03-02', max: '2024-03-31' } }])).toBe(1);
    expect(n([{ filter: 'text', test: { contains: 'TEA' }, not: true }])).toBe(2);
  });

  it('lists the columns available after unnesting', () => {
    expect(queryColumns(tables, 0, 1).map((c) => c.id)).toContain('comments/[*]/by');
  });

  it('reports unknown columns and tables', () => {
    expect(() => run({ from: 0, steps: [{ filter: 'nope', test: { empty: true } }] })).toThrow(QueryError);
    expect(() => run({ from: 0, steps: [{ unnest: 0 }] })).toThrow(QueryError);
  });
});

describe('datePart', () => {
  it.each([
    ['year', '2024'],
    ['month', '2024-03'],
    ['day', '2024-03-06'],
    ['week', '2024-03-04'],
    ['weekday', 3],
    ['hour', 21],
  ] as const)('%s', (part, expected) => {
    expect(datePart('2024-03-06T21:15:00', part)).toBe(expected);
  });
});

describe('charts', () => {
  it('counts rows over time, with empty periods as zero', () => {
    const spec = { table: 0, x: { column: 'at', time: 'month' as const } };
    const data = chartData(run(chartQuery(tables, spec)), spec);
    expect(data.kind).toBe('time');
    expect(data.xs).toEqual(['2024-03', '2024-04']);
    expect(data.points).toEqual([
      { x: '2024-03', series: null, y: 2 },
      { x: '2024-04', series: null, y: 1 },
    ]);
    const days = { table: 0, x: { column: 'at', time: 'day' as const } };
    expect(chartData(run(chartQuery(tables, days)), days).xs).toHaveLength(41);
  });

  it('counts nested rows per category of the parent, split by a column', () => {
    const spec = { table: 1, x: { column: 'text' }, split: 'comments/[*]/by' };
    const query = chartQuery(tables, spec);
    expect(query.steps[0]).toEqual({ unnest: 1 });
    const data = chartData(run(query), spec);
    expect(data.kind).toBe('category');
    expect(data.series).toEqual(['Marcel', 'Swann']);
    expect(data.points).toContainEqual({ x: 'Madeleines today', series: 'Swann', y: 1 });
  });

  it('counts the items of list cells', () => {
    const spec = { table: 0, x: { column: 'tags/[*]' } };
    const data = chartData(run(chartQuery(tables, spec)), spec);
    expect(data.xs).toEqual(['tea', 'baking']);
  });
});
