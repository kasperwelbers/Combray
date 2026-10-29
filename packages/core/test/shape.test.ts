import { describe, expect, it } from 'vitest';

import { countBucket, extractShape, flatten, screenName, type Shape } from '../src';
import { inbox, takeout, watchHistory } from './fixtures';

function allValues(node: unknown, out: string[] = []): string[] {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'value' && typeof v === 'string') out.push(v);
      allValues(v, out);
    }
  }
  return out;
}

describe('screenName', () => {
  it.each([
    ['title', 'title'],
    ['watch-history.json', 'watch-history.json'],
    ['someone@example.com', '<email>'],
    ['https://example.com', '<url>'],
    ['2024-03-01', '<date>'],
    ['12345', '<number>'],
    ['+31 6 1234 5678', '<number>'],
    ['photo_20240301_101010.jpg', '<number>.jpg'],
    ['marcel_1871', '<id>'],
    ['marcel_1871.json', '<id>.json'],
    ['0123456789abcdef0123', '<token>'],
    ['message_1.json', 'message_1.json'],
    ['takeout-20240310T101010Z-001.zip', '<token>.zip'],
  ])('%s -> %s', (name, expected) => {
    expect(screenName(name)).toBe(expected);
  });
});

describe('countBucket', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [7, '2-10'],
    [100, '11-100'],
    [101, '101-1k'],
    [5000, '>1k'],
  ])('%i -> %s', (n, bucket) => expect(countBucket(n)).toBe(bucket));
});

describe('extractShape', () => {
  it('merges list items into one item shape with bucketed counts and types', () => {
    const shape = extractShape(watchHistory);
    expect(shape).toEqual<Shape>({
      kind: 'list',
      name: 'watch-history.json',
      count: '2-10',
      children: [
        {
          kind: 'map',
          name: '[*]',
          children: [
            {
              kind: 'list',
              name: 'subtitles',
              count: '2-10',
              children: [
                {
                  kind: 'map',
                  name: '[*]',
                  children: [
                    { kind: 'value', name: 'name', types: ['string'] },
                    { kind: 'value', name: 'url', types: ['url-like'] },
                  ],
                },
              ],
            },
            { kind: 'value', name: 'time', types: ['date-like'], formats: ['YYYY-MM-DDTHH:mm:ss.SSSZ'] },
            { kind: 'value', name: 'title', types: ['string'] },
            { kind: 'value', name: 'titleUrl', types: ['url-like'] },
          ],
        },
      ],
    });
  });

  it('never contains values', () => {
    const shape = extractShape(takeout);
    const json = JSON.stringify(shape);
    for (const value of allValues(flatten(takeout))) {
      if (value.length > 3) expect(json).not.toContain(value);
    }
  });

  it('keeps HTML tags and classes, without text', () => {
    const json = JSON.stringify(extractShape(takeout));
    expect(json).toContain('div.mdl-cell.outer-cell');
    expect(json).not.toContain('hawthorn');
  });

  it('collapses dictionary-like directories such as usernames', () => {
    const shape = extractShape(inbox);
    expect(shape.collapsed).toBe(true);
    expect(shape.count).toBe('2-10');
    expect(shape.children?.map((c) => c.name)).toEqual(['{*}']);
    expect(JSON.stringify(shape)).not.toMatch(/marcel|gilberte|swann/);
  });

  it('collapses maps keyed by dates', () => {
    const shape = extractShape({
      kind: 'map',
      name: 'daily',
      children: ['2024-01-01', '2024-01-02', '2024-01-03'].map((d) => ({
        kind: 'value' as const,
        name: d,
        value: '3',
        type: 'int' as const,
      })),
    });
    expect(shape).toEqual<Shape>({
      kind: 'map',
      name: 'daily',
      collapsed: true,
      count: '2-10',
      keyTypes: ['date-like'],
      keyFormats: ['YYYY-MM-DD'],
      children: [{ kind: 'value', name: '{*}', types: ['int'] }],
    });
  });

  it('does not collapse ordinary records', () => {
    const shape = extractShape(watchHistory.kind === 'list' ? watchHistory.children[0]! : watchHistory);
    expect(shape.collapsed).toBeUndefined();
  });
});
