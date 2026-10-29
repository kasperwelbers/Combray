/** Queries over importer results (tables of rows): memory lane, timeline and top items. */
import type { FieldValue, Row } from '@combray/core';

import type { Page, RowFilter, TimeUnit, Timeline, TopItems } from './api';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A date field in the participant's local time, as `YYYY-MM-DDTHH:mm:ss`. UTC values (`...Z`)
 * are converted; floating values (no zone) are already local.
 */
export function localTime(value: FieldValue | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!value.endsWith('Z')) return value.slice(0, 19);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The start of the period a local day falls in: the day, its ISO week's Monday, or its month. */
export function periodKey(day: string, unit: TimeUnit): string {
  if (unit === 'month') return `${day.slice(0, 7)}-01`;
  if (unit === 'day') return day;
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function nextPeriod(key: string, unit: TimeUnit): string {
  const d = new Date(`${key}T12:00:00Z`);
  if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + (unit === 'week' ? 7 : 1));
  return d.toISOString().slice(0, 10);
}

function values(value: FieldValue | undefined): string[] {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(values);
  if (typeof value === 'object') return [JSON.stringify(value)];
  return [String(value)];
}

export function matches(row: Row, filter: RowFilter, dateField: string | undefined): boolean {
  if (filter.field !== undefined && filter.value !== undefined) {
    if (!values(row[filter.field]).includes(filter.value)) return false;
  }
  if ((filter.from || filter.to) && dateField) {
    const day = localTime(row[dateField])?.slice(0, 10);
    if (!day) return false;
    if (filter.from && day < filter.from) return false;
    if (filter.to && day >= filter.to) return false;
  }
  return true;
}

/** Rows matching a filter, newest first when there is a date field. */
export function rows(all: Row[], dateField: string | undefined, filter: RowFilter, offset: number, limit: number): Page<Row> {
  let selected = all.filter((r) => matches(r, filter, dateField));
  if (dateField) {
    const key = (r: Row) => localTime(r[dateField]) ?? '';
    selected = selected
      .map((r) => [key(r), r] as const)
      .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
      .map(([, r]) => r);
  }
  return { total: selected.length, offset, items: selected.slice(offset, offset + limit) };
}

/** Pick a time unit that gives a readable number of bars. */
export function chooseUnit(first: string, last: string): TimeUnit {
  const days = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000;
  if (days > 730) return 'month';
  if (days > 90) return 'week';
  return 'day';
}

/** Counts per period, with empty periods filled in so gaps are visible. */
export function timeline(all: Row[], dateField: string, filter: RowFilter, unit?: TimeUnit): Timeline {
  const days: string[] = [];
  let undated = 0;
  for (const row of all) {
    if (!matches(row, { ...filter, from: undefined, to: undefined }, dateField)) continue;
    const day = localTime(row[dateField])?.slice(0, 10);
    if (day) days.push(day);
    else undated++;
  }
  if (days.length === 0) return { unit: unit ?? 'day', buckets: [], undated };
  days.sort();
  const chosen = unit ?? chooseUnit(days[0]!, days.at(-1)!);
  const counts = new Map<string, number>();
  for (const day of days) {
    const key = periodKey(day, chosen);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const buckets: Timeline['buckets'] = [];
  const end = periodKey(days.at(-1)!, chosen);
  for (let key = periodKey(days[0]!, chosen); key <= end; key = nextPeriod(key, chosen)) {
    buckets.push({ start: key, end: nextPeriod(key, chosen), count: counts.get(key) ?? 0 });
  }
  return { unit: chosen, buckets, undated };
}

/** The most frequent values of a field. List fields (such as words) count each item. */
export function topItems(
  all: Row[],
  field: string,
  dateField: string | undefined,
  filter: RowFilter,
  limit: number,
  exclude: ReadonlySet<string> = new Set(),
): TopItems {
  const counts = new Map<string, number>();
  for (const row of all) {
    if (!matches(row, filter, dateField)) continue;
    for (const v of new Set(values(row[field]))) {
      if (!exclude.has(v.toLowerCase())) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const items = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
  return { distinct: counts.size, items };
}
