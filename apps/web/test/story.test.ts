import { parseStory, type DataBlock } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { donatedAnswers } from '../src/worker/donate';
import { storyView } from '../src/worker/story';

const block = (view: DataBlock['view'], extra: Partial<DataBlock> = {}): DataBlock => ({ type: 'data', id: 'b', platform: 'p', table: 't', view, ...extra });

// Floating local times (no zone), as the participant's device reads them.
const rows = [
  { time: '2024-01-01T09:15:00', channel: 'Proust Reads', words: ['tea', 'madeleine'] },
  { time: '2024-01-01T23:05:00', channel: 'Proust Reads', words: ['tea'] },
  { time: '2024-03-10T23:40:00', channel: 'Combray TV', words: ['church'] },
  { time: '2024-03-11T08:00:00', channel: 'Proust Reads', words: [] },
  { time: '', channel: 'Elsewhere', words: [] },
];

describe('story views', () => {
  it('count rows, with the days they span', () => {
    expect(storyView(block('amount'), rows, 'time')).toEqual({ view: 'amount', count: 5, first: '2024-01-01', last: '2024-03-11', days: 71 });
    expect(storyView(block('amount'), rows, undefined)).toEqual({ view: 'amount', count: 5 });
    expect(storyView(block('amount'), [], 'time')).toBeUndefined();
  });

  it('rank the values of a column, list items one by one, leaving out words', () => {
    expect(storyView(block('top', { column: 'channel', top: 3 }), rows, 'time')).toEqual({
      view: 'top',
      items: [
        { value: 'Proust Reads', count: 3 },
        { value: 'Combray TV', count: 1 },
        { value: 'Elsewhere', count: 1 },
      ],
      distinct: 3,
    });
    const words = storyView(block('top', { column: 'words' }), rows, 'time', new Set(['tea']));
    expect(words).toEqual({ view: 'top', items: [{ value: 'church', count: 1 }, { value: 'madeleine', count: 1 }], distinct: 2 });
    expect(storyView(block('top', { column: 'missing' }), rows, 'time')).toBeUndefined();
  });

  it('count per week over time, with the empty weeks in between', () => {
    const view = storyView(block('over-time'), rows, 'time');
    expect(view?.view === 'over-time' && view.unit).toBe('week');
    if (view?.view !== 'over-time') throw new Error('no view');
    expect(view.buckets[0]).toEqual({ start: '2024-01-01', count: 2 });
    expect(view.buckets.at(-1)).toEqual({ start: '2024-03-11', count: 1 });
    expect(view.buckets.reduce((n, b) => n + b.count, 0)).toBe(4);
    expect(storyView(block('over-time'), rows, undefined)).toBeUndefined();
  });

  it('count by hour of the day, or by weekday from Monday', () => {
    const hours = storyView(block('rhythm'), rows, 'time');
    if (hours?.view !== 'rhythm') throw new Error('no view');
    expect(hours.counts).toHaveLength(24);
    expect(hours.counts[23]).toBe(2);
    expect(hours.counts[9]).toBe(1);
    const days = storyView(block('rhythm', { by: 'weekday' }), rows, 'time');
    if (days?.view !== 'rhythm') throw new Error('no view');
    // 1 January and 11 March 2024 were Mondays, 10 March a Sunday.
    expect(days.counts).toEqual([3, 0, 0, 0, 0, 0, 1]);
    // Dates without a time say nothing about the hour.
    expect(storyView(block('rhythm'), [{ time: '2024-01-01' }], 'time')).toBeUndefined();
  });
});

describe('answers in a donation', () => {
  const story = parseStory({
    slides: [
      {
        id: 's',
        blocks: [
          { type: 'question', id: 'often', kind: 'choice', prompt: { en: 'How often?', nl: 'Hoe vaak?' }, options: [{ en: 'Often', nl: 'Vaak' }, { en: 'Rarely', nl: 'Zelden' }] },
          { type: 'question', id: 'hours', kind: 'number', prompt: 'Hours?', min: 0, max: 24 },
          { type: 'question', id: 'why', kind: 'open', prompt: 'Why?' },
        ],
      },
    ],
  });

  it('go with the questions as the participant read them, and only when they fit', () => {
    const asked = donatedAnswers(story, { often: 'Often', hours: 30, why: 'Because', gone: 'An old question' }, 'nl');
    expect(asked.answers).toEqual({ often: 'Often', why: 'Because' });
    expect(asked.questions).toEqual([
      { id: 'often', prompt: 'Hoe vaak?', options: ['Vaak', 'Zelden'] },
      { id: 'why', prompt: 'Why?' },
    ]);
    expect(donatedAnswers(undefined, { often: 'Often' }, 'en')).toEqual({ answers: {}, questions: [] });
  });
});
