import { describe, expect, it } from 'vitest';

import { findPath, globMatch, parsePath, PathError } from '../src';
import { takeout } from './fixtures';

const locations = (path: string) => findPath(takeout, path).map((m) => m.location.join('/'));
const values = (path: string) =>
  findPath(takeout, path).map((m) =>
    m.type === 'attr' ? m.value : m.node.kind === 'value' || m.node.kind === 'text' ? m.node.value : m.node.name,
  );

describe('parsePath', () => {
  it('parses all segment types', () => {
    const { segments } = parsePath('**/{a.json,b.json}/[*]/[0]/[?type=url]/div#main.x/@href');
    expect(segments.map((s) => s.type)).toEqual([
      'anyDepth',
      'names',
      'anyIndex',
      'index',
      'filter',
      'names',
      'attr',
    ]);
  });

  it('collapses repeated ** and ignores outer slashes', () => {
    expect(parsePath('/**/**/x/').segments).toHaveLength(2);
  });

  it.each(['a//b', '[x]', '{a,b', '@href/x', '[?colour=red]', 'css(div)', 'a"b'])(
    'rejects %s',
    (bad) => {
      expect(() => parsePath(bad)).toThrow(PathError);
    },
  );
});

describe('globMatch', () => {
  it('matches stars and escaped stars', () => {
    expect(globMatch('*.json', 'watch-history.json')).toBe(true);
    expect(globMatch('watch*.json', 'watch-history.html')).toBe(false);
    expect(globMatch('a*b*c', 'aXXbYYc')).toBe(true);
    expect(globMatch('a\\*', 'a*')).toBe(true);
    expect(globMatch('a\\*', 'ab')).toBe(false);
  });
});

describe('findPath', () => {
  it('follows names from the root', () => {
    expect(locations('Takeout/YouTube and YouTube Music/history/watch-history.json')).toEqual([
      'Takeout/YouTube and YouTube Music/history/watch-history.json',
    ]);
  });

  it('finds a file at any depth, with language alternatives', () => {
    expect(locations('**/{watch-history.json,kijkgeschiedenis.json}')).toHaveLength(1);
  });

  it('selects list items and nested lists', () => {
    expect(values('**/watch-history.json/[*]/subtitles/[*]/name')).toEqual([
      'Aunt Leonie Bakes',
      'Tisane Channel',
      'Combray Kitchen',
    ]);
    expect(values('**/watch-history.json/[1]/subtitles/[0]/name')).toEqual(['Tisane Channel']);
  });

  it('filters by kind and type', () => {
    expect(values('**/watch-history.json/[*]/[?type=url]')).toHaveLength(2);
    expect(locations('**/watch-history.json/[0]/[?kind=list]')).toEqual([
      'Takeout/YouTube and YouTube Music/history/watch-history.json/0/subtitles',
    ]);
  });

  it('matches HTML elements by selector, attributes and text', () => {
    const cell = '**/MyActivity.html/html/body/div.outer-cell/div.content-cell';
    expect(findPath(takeout, cell)).toHaveLength(2);
    expect(values(`${cell}/a/@href`)).toEqual([
      'https://www.google.com/search?q=hawthorn',
      'https://www.google.com/search?q=steeple',
    ]);
    expect(values(`${cell}/#text`)).toContain('Mar 4, 2024, 10:20:30 AM CET');
  });

  it('does not match script contents', () => {
    expect(findPath(takeout, '**/script')).toHaveLength(0);
  });

  it('returns nothing for indexes on non-lists', () => {
    expect(findPath(takeout, 'Takeout/[0]')).toHaveLength(0);
  });
});
