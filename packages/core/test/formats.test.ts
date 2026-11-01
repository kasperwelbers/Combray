import { describe, expect, it } from 'vitest';

import { dateFormats, extractShape, inferType, isFormat, jsonToTree, parseDate, valueFormat } from '../src';

describe('valueFormat', () => {
  it.each([
    ['2010-12-05', 'YYYY-MM-DD'],
    ['2021-03-04T10:20:30Z', 'YYYY-MM-DDTHH:mm:ssZ'],
    ['2021-03-04 10:20:30', 'YYYY-MM-DD HH:mm:ss'],
    ['2021-03-04T10:20:30.123+01:00', 'YYYY-MM-DDTHH:mm:ss.SSSZ'],
    ['2023-01-15 08:12:44 UTC', 'YYYY-MM-DD HH:mm:ss Z'],
    ['24-03-2021', 'D-M-YYYY'],
    ['03/24/2021', 'M/D/YYYY'],
    ['4/3/2021 10:20', 'X/X/YYYY H:mm'],
    ['Mar 4, 2021, 10:20:30 AM CET', 'MMM D, YYYY, H:mm:ss A Z'],
    ['5 mrt 2024, 11:00:00 CET', 'D MMM YYYY, H:mm:ss Z'],
    ['4. März 2024, 9:20:30 MEZ', 'D. MMM YYYY, H:mm:ss Z'],
    ['4 févr. 2024', 'D MMM. YYYY'],
  ])('%s -> %s', (raw, format) => {
    expect(valueFormat(raw, inferType(raw))).toBe(format);
    expect(isFormat(format)).toBe(true);
  });

  it('round-trips through parseDate', () => {
    for (const raw of ['2021-03-04T10:20:30.123+01:00', 'Mar 4, 2021, 10:20:30 PM CET', '24-03-2021', '4 févr. 2024']) {
      const format = valueFormat(raw, 'date-like')!;
      expect(parseDate(raw, format)).not.toBeNull();
    }
    expect(parseDate('2021-03-04T10:20:30+01:00', 'YYYY-MM-DDTHH:mm:ssZ')).toBe('2021-03-04T09:20:30.000Z');
    expect(parseDate('Mar 4, 2021, 9:20:30 PM CET', 'MMM D, YYYY, H:mm:ss A Z')).toBe('2021-03-04T21:20:30');
  });

  it('finds timestamps in numbers', () => {
    expect(valueFormat('1709284500', 'int')).toBe('epoch-s');
    expect(valueFormat('1709284500123', 'int')).toBe('epoch-ms');
    expect(valueFormat('1709284500.5', 'float')).toBe('epoch-s');
    expect(valueFormat('42', 'int')).toBeUndefined();
  });

  it('gives no format when any part is not a known token', () => {
    expect(valueFormat('Meeting on 2021-03-04', 'date-like')).toBeUndefined();
    expect(valueFormat('hello', 'string')).toBeUndefined();
    expect(isFormat('Marcel 2021')).toBe(false);
  });

  it('resolves the day and month order from other values', () => {
    expect(dateFormats(['D/M/YYYY', 'X/X/YYYY'])).toEqual(['D/M/YYYY']);
    expect(dateFormats(['X/X/YYYY'])).toEqual(['D/M/YYYY', 'M/D/YYYY']);
  });
});

describe('formats in shapes', () => {
  it('records formats of values and keys, never values', () => {
    const tree = jsonToTree('x.json', {
      posts: [{ at: '2024-03-01T10:00:00Z', ts: 1709284500 }, { at: '2024-03-02T11:00:00Z', ts: 1709284600 }],
      days: { '2024-03-01': 3, '2024-03-02': 5, '2024-03-03': 1, '2024-03-04': 2, '2024-03-05': 4 },
    });
    const shape = extractShape(tree);
    const json = JSON.stringify(shape);
    expect(json).not.toContain('2024-03-01');
    expect(json).not.toContain('1709284500');
    const posts = shape.children!.find((c) => c.name === 'posts')!.children![0]!;
    expect(posts.children!.find((c) => c.name === 'at')!.formats).toEqual(['YYYY-MM-DDTHH:mm:ssZ']);
    expect(posts.children!.find((c) => c.name === 'ts')!.formats).toEqual(['epoch-s']);
    const days = shape.children!.find((c) => c.name === 'days')!;
    expect(days.collapsed).toBe(true);
    expect(days.keyTypes).toEqual(['date-like']);
    expect(days.keyFormats).toEqual(['YYYY-MM-DD']);
  });
});
