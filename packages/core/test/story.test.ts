import { describe, expect, it } from 'vitest';

import {
  fillText,
  optionValue,
  parseStory,
  renameInStory,
  slideFromTemplate,
  storyQuestions,
  storyReferences,
  validAnswer,
  type DataBlock,
  type QuestionBlock,
  type Story,
} from '../src';

describe('parseStory', () => {
  it('keeps the blocks that are right and leaves out the rest', () => {
    const story = parseStory({
      slides: [
        {
          id: 'intro',
          title: { en: 'Your year', nl: 'Jouw jaar' },
          blocks: [
            { type: 'text', id: 't1', text: 'Hello' },
            { type: 'text', id: 't2', text: '   ' },
            { type: 'data', id: 'd1', platform: 'takeout', table: 'watch-history', view: 'amount', text: 'You watched {count} videos.' },
            { type: 'data', id: 'd2', platform: 'takeout', table: 'watch-history', view: 'top' },
            { type: 'data', id: 'd3', platform: 'takeout', table: 'watch-history', view: 'pie' },
            { type: 'data', id: 'd4', platform: 'takeout', table: 'watch-history', view: 'top', column: 'channel', top: 50, by: 'hour' },
            { type: 'question', id: 'q1', kind: 'choice', prompt: 'Pick', options: ['One'] },
          ],
        },
        { id: 'empty', blocks: [{ type: 'unknown', id: 'x' }] },
        { id: 'bad id!', blocks: [{ type: 'text', id: 't', text: 'Hi' }] },
        {
          id: 'questions',
          blocks: [
            { type: 'question', id: 'q2', kind: 'number', prompt: 'How many hours?', min: 0, max: 24, required: true },
            { type: 'question', id: 'q2', kind: 'open', prompt: 'Again' },
            { type: 'question', id: 'q3', kind: 'number', prompt: 'Wrong bounds', min: 5, max: 1 },
          ],
        },
      ],
    });
    expect(story?.slides.map((s) => s.id)).toEqual(['intro', 'questions']);
    expect(story!.slides[0]!.blocks.map((b) => b.id)).toEqual(['t1', 'd1', 'd4']);
    // Settings that do not belong to a view are dropped, and `top` is kept within bounds.
    expect(story!.slides[0]!.blocks[2]).toEqual({ type: 'data', id: 'd4', platform: 'takeout', table: 'watch-history', view: 'top', column: 'channel', top: 10 });
    // The first question with an id wins.
    expect(storyQuestions(story).map((q) => [q.id, q.kind])).toEqual([['q2', 'number']]);
    expect(storyQuestions(story)[0]!.required).toBe(true);
  });

  it('gives nothing for a story without slides', () => {
    expect(parseStory(undefined)).toBeUndefined();
    expect(parseStory({ slides: [] })).toBeUndefined();
    expect(parseStory({ slides: [{ id: 's', blocks: [] }] })).toBeUndefined();
  });

  it('takes the templates back as they are made', () => {
    const slides = (['amount', 'top', 'over-time', 'rhythm', 'question'] as const).map((t) =>
      slideFromTemplate(t, { platform: 'takeout', table: 'watch-history', column: 'channel' }),
    );
    expect(parseStory({ slides })?.slides).toEqual(slides);
    // Ids are new each time.
    expect(new Set(slides.map((s) => s.id)).size).toBe(slides.length);
  });
});

describe('answers', () => {
  const choice: QuestionBlock = { type: 'question', id: 'q', kind: 'choice', prompt: 'Pick', options: [{ en: 'Yes', nl: 'Ja' }, 'Maybe'] };

  it('are one of the options, kept by their English text', () => {
    expect(optionValue({ en: 'Yes', nl: 'Ja' })).toBe('Yes');
    expect(optionValue({ nl: 'Ja' })).toBe('Ja');
    expect(validAnswer(choice, 'Yes')).toBe(true);
    expect(validAnswer(choice, 'Maybe')).toBe(true);
    expect(validAnswer(choice, 'Ja')).toBe(false);
  });

  it('are numbers within bounds, or text that is not empty', () => {
    const number: QuestionBlock = { type: 'question', id: 'n', kind: 'number', prompt: 'How many?', min: 0, max: 10 };
    expect(validAnswer(number, 3)).toBe(true);
    expect(validAnswer(number, 11)).toBe(false);
    expect(validAnswer(number, '3')).toBe(false);
    expect(validAnswer(number, Number.NaN)).toBe(false);
    const open: QuestionBlock = { type: 'question', id: 'o', kind: 'open', prompt: 'Why?' };
    expect(validAnswer(open, 'Because')).toBe(true);
    expect(validAnswer(open, ' ')).toBe(false);
    expect(validAnswer(open, 'x'.repeat(2001))).toBe(false);
  });
});

describe('fillText', () => {
  it('fills values in the text of the language, and leaves unknown names', () => {
    const text = { en: 'You watched {count} videos, {unknown}.', nl: 'Je keek {count} video’s.' };
    expect(fillText(text, 'nl', { count: '4.312' })).toBe('Je keek 4.312 video’s.');
    expect(fillText(text, 'en', { count: '4,312' })).toBe('You watched 4,312 videos, {unknown}.');
  });
});

describe('renaming in a story', () => {
  const story: Story = {
    slides: [
      {
        id: 's',
        blocks: [
          { type: 'data', id: 'a', platform: 'yt', table: 'watch_history', view: 'top', column: 'channels/channel' },
          { type: 'data', id: 'b', platform: 'yt', table: 'watch_history', view: 'over-time', date: 'time' },
          { type: 'data', id: 'c', platform: 'tt', table: 'watch_history', view: 'amount' },
        ],
      },
    ],
  };

  it('follows a renamed table, also in the columns of tables nested in another', () => {
    const renamed = renameInStory(story, 'yt', { kind: 'table', from: 'channels', to: 'creators' });
    expect(renamed.slides[0]!.blocks[0]).toMatchObject({ column: 'creators/channel' });
    const table = renameInStory(story, 'yt', { kind: 'table', from: 'watch_history', to: 'videos' });
    expect(table.slides[0]!.blocks.map((b) => (b as DataBlock).table)).toEqual(['videos', 'videos', 'watch_history']);
  });

  it('follows a renamed field of the table or of a nested table, on that platform only', () => {
    const field = renameInStory(story, 'yt', { kind: 'field', table: 'watch_history', from: 'time', to: 'watched_at' });
    expect(field.slides[0]!.blocks[1]).toMatchObject({ date: 'watched_at' });
    const nested = renameInStory(story, 'yt', { kind: 'field', table: 'channels', from: 'channel', to: 'name' });
    expect(nested.slides[0]!.blocks[0]).toMatchObject({ column: 'channels/name' });
    expect(storyReferences(story, 'yt', 'channels', 'channel')).toHaveLength(1);
    expect(storyReferences(story, 'yt', 'watch_history')).toHaveLength(2);
  });
});
