/**
 * What the data blocks of a story show, from the participant's own tables, on their device
 * (docs/plans/2026-11-05-stories-and-exploration.md). Only counts leave this module, and only
 * to the participant's own screen: nothing here is sent.
 */
import type { DataBlock, Row, Story } from '@combray/core';

import type { StoryView, TimeUnit } from './api';
import { STOPWORDS } from './stopwords';
import { localTime, timeline, topItems } from './tables';

/** The rows of the tables a story can refer to, by `storyTableKey`, with each table's date. */
export type StoryTables = Map<string, { rows: Row[]; date?: string }>;

/** A table of one platform (upload point), by its id. */
export const storyTableKey = (platform: string, table: string) => JSON.stringify([platform, table]);

/**
 * Add the tables of one upload to the story's tables: rows of uploads of the same platform
 * count together. `tables` are as `deriveImport` gives them (with `key`, the table's id).
 */
export function addStoryTables(
  out: StoryTables,
  platform: string,
  tables: { key?: string | undefined; date?: string | undefined; rows: Row[] }[],
): void {
  for (const table of tables) {
    if (table.key === undefined) continue;
    const id = storyTableKey(platform, table.key);
    const entry = out.get(id) ?? { rows: [], ...(table.date ? { date: table.date } : {}) };
    entry.rows.push(...table.rows);
    out.set(id, entry);
  }
}

/** What each data block of a story shows, by block id; blocks without data are left out. */
export function storyViews(story: Story, tables: StoryTables): Record<string, StoryView> {
  const views: Record<string, StoryView> = {};
  for (const slide of story.slides) {
    for (const block of slide.blocks) {
      if (block.type !== 'data') continue;
      const table = tables.get(storyTableKey(block.platform, block.table));
      if (!table) continue;
      // Word lists leave out the most common words.
      const words = block.column !== undefined && table.rows.some((r) => Array.isArray(r[block.column!]));
      const view = storyView(block, table.rows, block.date ?? table.date, words ? STOPWORDS : undefined);
      if (view) views[block.id] = view;
    }
  }
  return views;
}

const DAY = 86_400_000;

const days = (first: string, last: string) => Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY) + 1;

/** Columns per month, week or day: a dozen or a few dozen, which people can take in at a glance. */
function storyUnit(first: string, last: string): TimeUnit {
  const span = days(first, last);
  if (span > 180) return 'month';
  if (span > 42) return 'week';
  return 'day';
}

/** The local days of a date column, sorted. */
function localDays(rows: Row[], date: string | undefined): string[] {
  if (!date) return [];
  return rows
    .map((r) => localTime(r[date])?.slice(0, 10))
    .filter((d): d is string => d !== undefined)
    .sort();
}

/**
 * The view of one data block over the rows of its table (from every upload of its platform), or
 * `undefined` when there is nothing to show. `date` is the column the block uses for time: its
 * own, or the table's date. `exclude` are words left out of word lists.
 */
export function storyView(block: DataBlock, rows: Row[], date: string | undefined, exclude?: ReadonlySet<string>): StoryView | undefined {
  if (rows.length === 0) return undefined;
  if (block.view === 'amount') {
    const dated = localDays(rows, date);
    if (dated.length === 0) return { view: 'amount', count: rows.length };
    const first = dated[0]!;
    const last = dated.at(-1)!;
    return {
      view: 'amount',
      count: rows.length,
      first,
      last,
      days: days(first, last),
    };
  }
  if (block.view === 'top') {
    if (!block.column) return undefined;
    const top = topItems(rows, block.column, undefined, {}, block.top ?? 5, exclude);
    return top.items.length > 0 ? { view: 'top', items: top.items, distinct: top.distinct } : undefined;
  }
  if (!date) return undefined;
  if (block.view === 'over-time') {
    const dated = localDays(rows, date);
    if (dated.length === 0) return undefined;
    const t = timeline(rows, date, {}, storyUnit(dated[0]!, dated.at(-1)!));
    return {
      view: 'over-time',
      unit: t.unit,
      buckets: t.buckets.map((b) => ({ start: b.start, count: b.count })),
    };
  }
  const by = block.by ?? 'hour';
  const counts = new Array<number>(by === 'hour' ? 24 : 7).fill(0);
  let any = false;
  for (const row of rows) {
    const local = localTime(row[date]);
    if (!local) continue;
    // A date without a time says nothing about the hour.
    if (by === 'hour') {
      if (local.length < 13) continue;
      counts[Number(local.slice(11, 13))]!++;
    } else {
      counts[(new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay() + 6) % 7]!++;
    }
    any = true;
  }
  return any ? { view: 'rhythm', by, counts } : undefined;
}
