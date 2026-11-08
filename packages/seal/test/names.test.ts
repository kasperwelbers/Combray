import { describe, expect, it } from 'vitest';

import { parseNameMap, placements, rowKey, type NameMap } from '../src';

// A history with nested subtitles, tags (plain values), replies whose keys are data, an HTML list
// that may be a single element, and an object read side by side.
const map: NameMap = {
  format: 'combray-names/1',
  root: {
    c: [
      {
        m: ['watch-history.json', { regex: '^kijkgeschiedenis\\.json$', flags: 'i' }],
        c: [
          {
            k: '[*]',
            t: 'watch_history',
            c: [
              { m: ['title'], f: 'title' },
              { m: ['subtitles'], c: [{ k: '[*]', t: 'channels', c: [{ m: ['name'], f: 'name' }] }] },
              { m: ['tags'], c: [{ k: '[*]', f: 'tags', l: 'watch_history_tags' }] },
              { m: ['engagement'], z: 'engagement', c: [{ m: ['liked_by'], c: [{ k: '[*]', f: 'liked_by' }] }, { m: ['shared_by'], c: [{ k: '[*]', f: 'shared_by' }] }] },
            ],
          },
        ],
      },
      { m: ['replies'], c: [{ k: '{*}', t: 'replies', c: [{ m: ['text'], f: 'text' }] }] },
      { m: ['page.html'], c: [{ m: ['div.like'], one: true, c: [{ k: '[*]', t: 'likes', c: [{ m: ['#text[0]'], f: 'who' }] }] }] },
      { m: ['profile.json'], c: [{ m: ['name'], f: 'name' }] },
    ],
  },
};

describe('placements', () => {
  it('places a path by its keys, items and keys that are data, with how its rows are told apart', () => {
    expect(placements(map, ['watch-history.json', '[3]', 'title'])).toEqual([{ table: 'watch_history', field: 'title', rows: [{ table: 'watch_history', steps: 2 }] }]);
    expect(placements(map, ['KijkGeschiedenis.json', '[*]', 'title'])).toHaveLength(1);
    expect(placements(map, ['watch-history.json', '[3]', 'subtitles', '[1]', 'name'])).toEqual([
      { table: 'channels', field: 'name', rows: [{ table: 'watch_history', steps: 2 }, { table: 'channels', steps: 4 }] },
    ]);
    expect(placements(map, ['replies', '{4}', 'text'])).toEqual([{ table: 'replies', field: 'text', rows: [{ table: 'replies', steps: 2 }] }]);
    expect(placements(map, ['replies', '{4}'])).toEqual([{ table: 'replies', field: '{key}', rows: [{ table: 'replies', steps: 2 }] }]);
    expect(placements(map, ['profile.json', 'name'])).toEqual([{ table: '', field: 'name', rows: [] }]);
  });

  it('gives lists of plain values a table, and reads side by side lists as one', () => {
    expect(placements(map, ['watch-history.json', '[0]', 'tags', '[2]'])).toEqual([
      { table: 'watch_history_tags', field: 'tags', rows: [{ table: 'watch_history', steps: 2 }, { table: 'watch_history_tags', steps: 4 }] },
    ]);
    const liked = placements(map, ['watch-history.json', '[0]', 'engagement', 'liked_by', '[2]'])[0]!;
    const shared = placements(map, ['watch-history.json', '[0]', 'engagement', 'shared_by', '[2]'])[0]!;
    expect(liked.table).toBe('engagement');
    // Item 2 of each list is one row.
    const key = (path: string[], p: typeof liked) => rowKey(path, p.rows.at(-1)!);
    expect(key(['watch-history.json', '[0]', 'engagement', 'liked_by', '[2]'], liked)).toBe(key(['watch-history.json', '[0]', 'engagement', 'shared_by', '[2]'], shared));
    expect(key(['watch-history.json', '[0]', 'engagement', 'liked_by', '[1]'], liked)).not.toBe(key(['watch-history.json', '[0]', 'engagement', 'shared_by', '[2]'], shared));
  });

  it('reads a single element where a list is expected as its only item', () => {
    const one = placements(map, ['page.html', 'div.like', '#text[0]'])[0]!;
    const many = placements(map, ['page.html', 'div.like', '[0]', '#text[0]'])[0]!;
    expect(one).toEqual({ table: 'likes', field: 'who', rows: [{ table: 'likes', steps: 2 }] });
    expect(many).toEqual({ table: 'likes', field: 'who', rows: [{ table: 'likes', steps: 3 }] });
  });

  it('places nothing for paths the map does not know: they are deprecated', () => {
    expect(placements(map, ['watch-history.json', '[0]', 'time'])).toEqual([]);
    expect(placements(map, ['replies', 'marcel', 'text'])).toEqual([]);
    expect(placements(map, ['watch-history.json', 'title'])).toEqual([]);
  });
});

describe('parseNameMap', () => {
  it('accepts maps and refuses anything else', () => {
    expect(parseNameMap(JSON.parse(JSON.stringify(map)))).toEqual(map);
    expect(() => parseNameMap({ format: 'other', root: {} })).toThrow('not a name map');
    expect(() => parseNameMap({ format: 'combray-names/1', root: { c: [{ m: [1] }] } })).toThrow('invalid match');
    expect(() => parseNameMap({ format: 'combray-names/1', root: { c: [{ m: [{ regex: 'a', flags: 'g' }] }] } })).toThrow('invalid match');
    expect(() => parseNameMap({ format: 'combray-names/1', root: { t: 'Not A Name' } })).toThrow('invalid name');
    expect(() => parseNameMap({ format: 'combray-names/1', root: { k: '*' } })).toThrow('invalid name map node');
  });
});
