/**
 * Stories: slides that walk participants through their own data and ask about it
 * (docs/plans/2026-11-05-stories-and-exploration.md). A story belongs to a project. Each slide
 * has a few blocks: text, a view of the participant's data, or a question.
 *
 * Data views answer the questions people ask about their own traces, each with the chart that
 * people without a research background read most easily (bars and lines, labelled directly):
 *
 * - **amount**: "How much did I …?" One big number, with a comparison that makes it tangible.
 * - **top**: "Who or what did I … most?" Ranked horizontal bars.
 * - **over-time**: "How did my … change over time?" Columns per month (or week, or day).
 * - **rhythm**: "When do I …?" Columns per hour of the day or day of the week.
 *
 * Everything is computed on the participant's device. A story holds no data, only references
 * to tables and columns by their names (ADR 0013). Renaming a table or field in the studio
 * renames them here too (`renameInStory`).
 *
 * Answers to questions are kept on the device and go into the donation, shown in its review.
 */
import { localize, type Localized } from './importer/spec';

export type DataViewKind = 'amount' | 'top' | 'over-time' | 'rhythm';
export type QuestionKind = 'open' | 'choice' | 'number';

export const DATA_VIEWS: readonly DataViewKind[] = ['amount', 'top', 'over-time', 'rhythm'];
export const QUESTION_KINDS: readonly QuestionKind[] = ['open', 'choice', 'number'];

export interface TextBlock {
  type: 'text';
  id: string;
  text: Localized;
}

/** A view of one table of the participant's data. */
export interface DataBlock {
  type: 'data';
  id: string;
  /** The upload point (platform) the table is from. */
  platform: string;
  /** The table's name. */
  table: string;
  view: DataViewKind;
  /** For `top`: the column to rank the values of, by name (`comments/author` in a nested table). */
  column?: string;
  /** For `over-time` and `rhythm`: the date column, by name; else the table's date. */
  date?: string;
  /** For `top`: how many to show (3 to 10, default 5). */
  top?: number;
  /** For `rhythm`: by hour of the day (default) or day of the week. */
  by?: 'hour' | 'weekday';
  /**
   * The sentence that says what the view shows, with values in braces: `{count}` and
   * `{per_day}` (amount), `{top}` and `{top_count}` (top), `{peak}` and `{peak_count}`
   * (over-time and rhythm). Shown as the slide's message.
   */
  text?: Localized;
  /** Shown instead when the participant has no data for it; without it, the block is skipped. */
  empty?: Localized;
}

export interface QuestionBlock {
  type: 'question';
  /** The answer's key in the donation: stable, so keep it when the wording changes. */
  id: string;
  kind: QuestionKind;
  prompt: Localized;
  /** For `choice`: the buttons. The answer is the option's text in the first language. */
  options?: Localized[];
  /** For `number`. */
  min?: number;
  max?: number;
  /** Participants may move on without answering. Questions are optional unless `required`. */
  required?: boolean;
}

export type StoryBlock = TextBlock | DataBlock | QuestionBlock;

export interface Slide {
  id: string;
  title?: Localized;
  blocks: StoryBlock[];
}

export interface Story {
  slides: Slide[];
}

export const STORY_LIMITS = Object.freeze({ slides: 40, blocks: 6, options: 10, text: 2000, id: 64 });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function isLocalized(v: unknown, required = true): v is Localized {
  if (v === undefined) return !required;
  if (typeof v === 'string') return v.length <= STORY_LIMITS.text && (!required || v.trim() !== '');
  if (!isObject(v)) return false;
  const values = Object.entries(v);
  return (
    values.length > 0 &&
    values.length <= 20 &&
    values.every(([k, s]) => /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(k) && typeof s === 'string' && s.length <= STORY_LIMITS.text) &&
    (!required || values.some(([, s]) => (s as string).trim() !== ''))
  );
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseBlock(raw: unknown): StoryBlock | undefined {
  if (!isObject(raw) || typeof raw.id !== 'string' || !ID.test(raw.id)) return undefined;
  const id = raw.id;
  if (raw.type === 'text') return isLocalized(raw.text) ? { type: 'text', id, text: raw.text } : undefined;
  if (raw.type === 'data') {
    if (typeof raw.platform !== 'string' || !ID.test(raw.platform) || typeof raw.table !== 'string' || raw.table.length > 500) return undefined;
    if (!DATA_VIEWS.includes(raw.view as DataViewKind)) return undefined;
    const view = raw.view as DataViewKind;
    const column = typeof raw.column === 'string' && raw.column.length <= 500 ? raw.column : undefined;
    if (view === 'top' && !column) return undefined;
    const block: DataBlock = { type: 'data', id, platform: raw.platform, table: raw.table, view };
    if (column && view === 'top') block.column = column;
    if (typeof raw.date === 'string' && raw.date.length <= 500 && (view === 'over-time' || view === 'rhythm')) block.date = raw.date;
    if (view === 'top' && isNumber(raw.top)) block.top = Math.min(10, Math.max(3, Math.round(raw.top)));
    if (view === 'rhythm' && (raw.by === 'hour' || raw.by === 'weekday')) block.by = raw.by;
    if (raw.text !== undefined && isLocalized(raw.text)) block.text = raw.text;
    if (raw.empty !== undefined && isLocalized(raw.empty)) block.empty = raw.empty;
    return block;
  }
  if (raw.type === 'question') {
    if (!QUESTION_KINDS.includes(raw.kind as QuestionKind) || !isLocalized(raw.prompt)) return undefined;
    const block: QuestionBlock = { type: 'question', id, kind: raw.kind as QuestionKind, prompt: raw.prompt };
    if (block.kind === 'choice') {
      const options = Array.isArray(raw.options) ? raw.options.filter((o): o is Localized => isLocalized(o)).slice(0, STORY_LIMITS.options) : [];
      if (options.length < 2) return undefined;
      block.options = options;
    }
    if (block.kind === 'number') {
      if (isNumber(raw.min)) block.min = raw.min;
      if (isNumber(raw.max)) block.max = raw.max;
      if (block.min !== undefined && block.max !== undefined && block.min > block.max) return undefined;
    }
    if (raw.required === true) block.required = true;
    return block;
  }
  return undefined;
}

/**
 * A story from a project config, without trusting its shape: blocks that are not right are left
 * out, slides without blocks too, and question ids are kept unique (the first one wins).
 */
export function parseStory(raw: unknown): Story | undefined {
  if (!isObject(raw) || !Array.isArray(raw.slides)) return undefined;
  const questions = new Set<string>();
  const slides: Slide[] = [];
  for (const s of raw.slides.slice(0, STORY_LIMITS.slides)) {
    if (!isObject(s) || typeof s.id !== 'string' || !ID.test(s.id) || !Array.isArray(s.blocks)) continue;
    const blocks = s.blocks.slice(0, STORY_LIMITS.blocks).flatMap((b) => {
      const block = parseBlock(b);
      if (!block) return [];
      if (block.type === 'question') {
        if (questions.has(block.id)) return [];
        questions.add(block.id);
      }
      return [block];
    });
    if (blocks.length === 0) continue;
    slides.push({ id: s.id, ...(isLocalized(s.title) ? { title: s.title } : {}), blocks });
  }
  return slides.length > 0 ? { slides } : undefined;
}

/** The questions of a story, in order. */
export function storyQuestions(story: Story | undefined): QuestionBlock[] {
  return (story?.slides ?? []).flatMap((s) => s.blocks.filter((b): b is QuestionBlock => b.type === 'question'));
}

export type Answer = string | number;

/**
 * Whether an answer fits its question: text of at most 2000 characters, one of the options (by
 * their text in any language), or a number within the bounds.
 */
export function validAnswer(question: QuestionBlock, answer: unknown): answer is Answer {
  if (question.kind === 'open') return typeof answer === 'string' && answer.trim() !== '' && answer.length <= STORY_LIMITS.text;
  if (question.kind === 'number') {
    return isNumber(answer) && (question.min === undefined || answer >= question.min) && (question.max === undefined || answer <= question.max);
  }
  return typeof answer === 'string' && (question.options ?? []).some((o) => optionValue(o) === answer);
}

/** The stored value of a choice option: its text in English, else its first language. */
export function optionValue(option: Localized): string {
  if (typeof option === 'string') return option;
  return option.en ?? Object.values(option)[0] ?? '';
}

/** The values a sentence of a data block can use. */
export type StoryValues = Record<string, string>;

/** Fill `{name}` in a text with values; unknown names are left as they are. */
export function fillText(text: Localized, language: string, values: StoryValues): string {
  return localize(text, language).replace(/\{([a-z_]+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** Templates: the questions people ask about their data, as a slide to start from. */
export type SlideTemplate = DataViewKind | 'question';

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

/** A new slide for a template, on a table (and a column, for `top`). */
export function slideFromTemplate(template: SlideTemplate, data?: { platform: string; table: string; column?: string }): Slide {
  const question = (prompt: Localized, options?: Localized[]): QuestionBlock => ({
    type: 'question',
    id: nextId('q'),
    kind: options ? 'choice' : 'open',
    prompt,
    ...(options ? { options } : {}),
  });
  const block = (view: DataViewKind, extra: Partial<DataBlock>): DataBlock => ({
    type: 'data',
    id: nextId('d'),
    platform: data?.platform ?? '',
    table: data?.table ?? '',
    view,
    ...extra,
  });
  if (template === 'amount') {
    return {
      id: nextId('s'),
      blocks: [
        block('amount', { text: { en: 'You did this {count} times: about {per_day} a day.', nl: 'Je deed dit {count} keer: ongeveer {per_day} per dag.' } }),
        question({ en: 'Is that more or less than you expected?', nl: 'Is dat meer of minder dan je had verwacht?' }, [
          { en: 'Less', nl: 'Minder' },
          { en: 'About what I expected', nl: 'Ongeveer wat ik verwachtte' },
          { en: 'More', nl: 'Meer' },
        ]),
      ],
    };
  }
  if (template === 'top') {
    return {
      id: nextId('s'),
      blocks: [
        block('top', { ...(data?.column ? { column: data.column } : {}), top: 5, text: { en: 'Your number one: {top}.', nl: 'Jouw nummer één: {top}.' } }),
        question({ en: 'Why do you think this one is at the top?', nl: 'Waarom denk je dat deze bovenaan staat?' }),
      ],
    };
  }
  if (template === 'over-time') {
    return {
      id: nextId('s'),
      blocks: [
        block('over-time', { text: { en: 'Your busiest time was {peak}.', nl: 'Je drukste periode was {peak}.' } }),
        question({ en: 'What was going on in your life around then?', nl: 'Wat speelde er in die tijd in je leven?' }),
      ],
    };
  }
  if (template === 'rhythm') {
    return {
      id: nextId('s'),
      blocks: [
        block('rhythm', { by: 'hour', text: { en: 'You are most active around {peak}.', nl: 'Je bent het actiefst rond {peak}.' } }),
        question({ en: 'Does that match your days?', nl: 'Past dat bij hoe je dagen eruitzien?' }),
      ],
    };
  }
  return { id: nextId('s'), blocks: [question({ en: 'What would you like to tell us?', nl: 'Wat wil je ons vertellen?' })] };
}

/** A data block, with the slide it is on. */
export interface StoryReference {
  slide: number;
  block: DataBlock;
}

/** The data blocks that use a table of a platform (and, with `field`, that field of it). */
export function storyReferences(story: Story, platform: string, table?: string, field?: string): StoryReference[] {
  const out: StoryReference[] = [];
  story.slides.forEach((slide, i) => {
    for (const block of slide.blocks) {
      if (block.type !== 'data' || block.platform !== platform) continue;
      const columns = [block.column, block.date].filter((c): c is string => c !== undefined);
      const usesTable = table === undefined || block.table === table || columns.some((c) => c.split('/').slice(0, -1).includes(table));
      if (!usesTable) continue;
      if (field !== undefined && !columns.some((c) => endsIn(c, table, field) || (block.table === table && c === field))) continue;
      out.push({ slide: i, block });
    }
  });
  return out;
}

/** Whether a column reference (`comments/author`) is a field of a nested table. */
const endsIn = (column: string, table: string | undefined, field: string) => {
  const parts = column.split('/');
  return parts.length > 1 && parts.at(-1) === field && parts.at(-2) === table;
};

/**
 * The story with a table or field of a platform renamed: data blocks on the table, and columns
 * of nested tables (`comments/author`) follow. A field is given with the name of its table.
 */
export function renameInStory(
  story: Story,
  platform: string,
  change: { kind: 'table'; from: string; to: string } | { kind: 'field'; table: string; from: string; to: string },
): Story {
  const column = (c: string | undefined, block: DataBlock): string | undefined => {
    if (c === undefined) return c;
    const parts = c.split('/');
    if (change.kind === 'table') return parts.map((p, i) => (i < parts.length - 1 && p === change.from ? change.to : p)).join('/');
    if (parts.length === 1) return block.table === change.table && c === change.from ? change.to : c;
    return endsIn(c, change.table, change.from) ? [...parts.slice(0, -1), change.to].join('/') : c;
  };
  return {
    ...story,
    slides: story.slides.map((slide) => ({
      ...slide,
      blocks: slide.blocks.map((block) => {
        if (block.type !== 'data' || block.platform !== platform) return block;
        const out: DataBlock = { ...block };
        if (change.kind === 'table' && block.table === change.from) out.table = change.to;
        if (block.column !== undefined) out.column = column(block.column, block)!;
        if (block.date !== undefined) out.date = column(block.date, block)!;
        return out;
      }),
    })),
  };
}
