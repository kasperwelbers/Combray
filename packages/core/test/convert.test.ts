import { describe, expect, it } from 'vitest';

import { applyTransform, convert, parseDate, parseDuration, toDomain, tokenize } from '../src';

describe('parseDate', () => {
  it.each([
    ['2024-03-01T09:15:00.000Z', undefined, '2024-03-01T09:15:00.000Z'],
    ['2024-03-01T10:15:00+01:00', undefined, '2024-03-01T09:15:00.000Z'],
    ['2023-01-15 08:12:44 UTC', undefined, '2023-01-15T08:12:44.000Z'],
    ['2024-03-01 09:15:00', undefined, '2024-03-01T09:15:00'],
    ['2024-03-01', undefined, '2024-03-01T00:00:00'],
    ['04-03-2024 10:20', undefined, '2024-03-04T10:20:00'],
    ['Mar 4, 2024, 10:20:30 AM CET', undefined, '2024-03-04T10:20:30'],
    ['Mar 4, 2024, 10:20:30 PM CET', undefined, '2024-03-04T22:20:30'],
    ['4 mrt 2024, 10:20:30 CET', undefined, '2024-03-04T10:20:30'],
    ['2024/03/04 22.05', 'YYYY/MM/DD HH.mm', '2024-03-04T22:05:00'],
    ['3/4/2024 1:05 PM', 'M/D/YYYY H:mm A', '2024-03-04T13:05:00'],
    ['1709284500', 'epoch-s', '2024-03-01T09:15:00.000Z'],
    ['1709284500000', 'epoch-ms', '2024-03-01T09:15:00.000Z'],
    ['1709284500000000', 'epoch-us', '2024-03-01T09:15:00.000Z'],
    ['not a date', undefined, null],
    ['2024-13-01', undefined, null],
    ['2024-03-04', 'DD-MM-YYYY', null],
  ])('%s (%s) → %s', (raw, format, expected) => {
    expect(parseDate(raw, format)).toBe(expected);
  });
});

describe('conversions', () => {
  it('converts types and keeps nulls', () => {
    expect(convert('42', 'int')).toBe(42);
    expect(convert('4.5', 'float')).toBe(4.5);
    expect(convert('', 'int')).toBeNull();
    expect(convert('yes', 'bool')).toBe(true);
    expect(convert('https://x.org/a', 'url')).toBe('https://x.org/a');
    expect(convert('not a url', 'url')).toBeNull();
    expect(convert(null, 'int')).toBeNull();
    expect(convert(['1', '2'], 'int')).toEqual([1, 2]);
  });

  it('parses durations', () => {
    expect(parseDuration('PT1H2M3S')).toBe(3723);
    expect(parseDuration('2:03')).toBe(123);
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('soon')).toBeNull();
  });

  it('extracts domains', () => {
    expect(toDomain('https://www.youtube.com/watch?v=1')).toBe('youtube.com');
    expect(toDomain('www.tiktok.com/@someone')).toBe('tiktok.com');
    expect(toDomain('')).toBeNull();
  });

  it('tokenizes', () => {
    expect(tokenize("Lime-blossom tea, at Aunt Léonie's!")).toEqual(['lime-blossom', 'tea', 'at', 'aunt', "léonie's"]);
  });

  it('applies transforms', () => {
    expect(applyTransform('How to bake - Google Search', { replace: { pattern: ' - google.*', ignore_case: true } })).toBe(
      'How to bake',
    );
    expect(applyTransform('https://www.tiktok.com/@a/video/123', { match: { pattern: 'video/(\\d+)', group: 1 } })).toBe('123');
    expect(applyTransform('a,b', { split: { by: ',' } })).toEqual(['a', 'b']);
    expect(applyTransform('  Hi ', 'trim')).toBe('Hi');
    expect(applyTransform('Hi', 'lowercase')).toBe('hi');
  });
});
