/**
 * What the data blocks of a story show, from the participant's own tables, on their device
 * (docs/plans/2026-11-05-stories-and-exploration.md). Only counts leave this module, and only
 * to the participant's own screen: nothing here is sent.
 */
import type { DataBlock, Row } from '@combray/core';

import type { StoryView, TimeUnit } from './api';
import { localTime, timeline, topItems } from './tables';

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
