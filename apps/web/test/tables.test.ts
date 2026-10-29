import { describe, expect, it } from 'vitest';

import { chooseUnit, localTime, periodKey, rows, timeline, topItems } from '../src/worker/tables';

const data = [
  { title: 'a', date: '2024-03-04T10:00:00', channel: 'Tisane', words: ['tea', 'lime'] },
  { title: 'b', date: '2024-03-05T09:00:00', channel: 'Tisane', words: ['tea'] },
  { title: 'c', date: '2024-03-12T09:00:00', channel: 'Kitchen', words: ['bake'] },
  { title: 'd', date: null, channel: 'Kitchen', words: [] },
];

describe('table queries', () => {
  it('keeps floating dates as they are', () => {
    expect(localTime('2024-03-04T10:00:00')).toBe('2024-03-04T10:00:00');
    expect(localTime(null)).toBeNull();
  });

  it('finds periods', () => {
    expect(periodKey('2024-03-06', 'week')).toBe('2024-03-04');
    expect(periodKey('2024-03-04', 'week')).toBe('2024-03-04');
    expect(periodKey('2024-03-10', 'week')).toBe('2024-03-04');
    expect(periodKey('2024-03-31', 'month')).toBe('2024-03-01');
    expect(chooseUnit('2020-01-01', '2024-01-01')).toBe('month');
    expect(chooseUnit('2024-01-01', '2024-06-01')).toBe('week');
    expect(chooseUnit('2024-01-01', '2024-01-20')).toBe('day');
  });

  it('sorts rows newest first and filters', () => {
    expect(rows(data, 'date', {}, 0, 10).items.map((r) => r.title)).toEqual(['c', 'b', 'a', 'd']);
    expect(rows(data, 'date', { field: 'channel', value: 'Tisane' }, 0, 10).total).toBe(2);
    expect(rows(data, 'date', { field: 'words', value: 'lime' }, 0, 10).items.map((r) => r.title)).toEqual(['a']);
    expect(rows(data, 'date', { from: '2024-03-04', to: '2024-03-05' }, 0, 10).items.map((r) => r.title)).toEqual(['a']);
  });

  it('builds a timeline with empty periods', () => {
    const result = timeline(data, 'date', {}, 'day');
    expect(result.undated).toBe(1);
    expect(result.buckets).toHaveLength(9);
    expect(result.buckets[0]).toEqual({ start: '2024-03-04', end: '2024-03-05', count: 1 });
    expect(result.buckets.reduce((n, b) => n + b.count, 0)).toBe(3);
    expect(timeline(data, 'date', {}, 'week').buckets.map((b) => b.count)).toEqual([2, 1]);
  });

  it('counts top items, each list item once per row', () => {
    expect(topItems(data, 'channel', 'date', {}, 10)).toEqual({
      distinct: 2,
      items: [
        { value: 'Kitchen', count: 2 },
        { value: 'Tisane', count: 2 },
      ],
    });
    expect(topItems(data, 'words', 'date', {}, 1, new Set(['lime'])).items).toEqual([{ value: 'tea', count: 2 }]);
  });
});
