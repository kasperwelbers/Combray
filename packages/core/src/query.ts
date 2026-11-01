/**
 * Queries over derived tables: a small pipeline of tidyverse-like verbs that runs locally on
 * a participant's rows. See docs/exploration.md#queries.
 *
 * A query starts at one table and can `unnest` its nested tables (one row per nested row, with
 * the parent row's columns alongside), then filter, mutate, group, summarise, arrange and
 * limit. Queries are plain JSON, so researchers can ship them in a project and the AI helper
 * can write them from the structure alone; they only ever run in the browser.
 */
import type { Localized } from './importer/spec';
import { parseDate, toDomain, tokenize } from './importer/convert';
import type { ColumnDef, DerivedRow, TableDef } from './derive';

export type Scalar = string | number | boolean | null;
export type Cell = Scalar | Scalar[];

export type FilterTest =
  | { empty: boolean }
  | { equals: Scalar }
  | { in: Scalar[] }
  | { contains: string }
  /** Inclusive; numbers compare as numbers, anything else as text (ISO dates sort). */
  | { min?: Scalar; max?: Scalar };

export type DatePart = 'year' | 'month' | 'week' | 'day' | 'weekday' | 'hour';

export type MutateFn =
  | { date: { format?: string } }
  | { datePart: DatePart }
  | 'number'
  | 'lowercase'
  | 'domain'
  | 'words'
  | 'length';

export type SummaryFn = 'count' | 'distinct' | 'sum' | 'mean' | 'min' | 'max';

export interface Summary {
  name: string;
  fn: SummaryFn;
  /** Not needed for `count`. */
  column?: string;
}

export type Step =
  /** One row per row of a nested table of a table already in the query. */
  | { unnest: number; keepEmpty?: boolean }
  /** One row per item of a list cell (tidyr's `unnest_longer`). */
  | { unnestList: string }
  | { filter: string; test: FilterTest; not?: boolean }
  | { mutate: string; from: string; fn: MutateFn }
  | { select: string[] }
  | { group: string[] }
  /** Summarises the groups (or all rows, without a group step); ends the grouping. */
  | { summarise: Summary[] }
  | { arrange: string; desc?: boolean }
  | { limit: number };

export interface Query {
  from: number;
  steps: Step[];
}

/** A column of a query's frame: from a table, or made by a step. */
export interface FrameColumn {
  id: string;
  name: Localized;
  /** The table it comes from, for table columns. */
  table?: number;
  def?: ColumnDef;
}

export interface QueryResult {
  columns: FrameColumn[];
  rows: Record<string, Cell>[];
}

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

interface FrameRow {
  values: Record<string, Cell>;
  /** The row index in each table the row comes from. */
  at: Map<number, number>;
}

/** Column ids of a nested table, prefixed with the path from the query's first table. */
function prefixOf(tables: TableDef[], from: number, table: number): string {
  const parts: string[] = [];
  let t = table;
  while (t !== from) {
    const parent = tables[t]!.parent;
    if (parent === undefined) throw new QueryError(`table ${table} is not nested in table ${from}`);
    parts.unshift(tables[parent]!.columns.find((c) => c.table === t)!.id);
    t = parent;
  }
  return parts.map((p) => `${p}/`).join('');
}

function tableColumns(tables: TableDef[], from: number, table: number): FrameColumn[] {
  const prefix = prefixOf(tables, from, table);
  return tables[table]!.columns.map((c) => ({ id: prefix + c.id, name: c.name, table, def: c }));
}

/**
 * The tables a query can unnest, in order: each must be nested in the first table or in one
 * unnested before it.
 */
export function unnestPath(tables: TableDef[], from: number, to: number): number[] {
  const path: number[] = [];
  let t: number | undefined = to;
  while (t !== undefined && t !== from) {
    path.unshift(t);
    t = tables[t]!.parent;
  }
  if (t !== from) throw new QueryError(`table ${to} is not nested in table ${from}`);
  return path;
}

/** The table at the top of a table's chain of parents. */
export function rootTable(tables: TableDef[], table: number): number {
  let t = table;
  while (tables[t]!.parent !== undefined) t = tables[t]!.parent!;
  return t;
}

const toNumber = (v: Cell): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean' || v === null || Array.isArray(v)) return null;
  const n = Number(v.trim());
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
};

const isEmpty = (v: Cell) => v === null || v === '' || (Array.isArray(v) && v.length === 0);

function compare(a: Cell, b: Cell): number {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) ? (isEmpty(b) ? 0 : 1) : -1;
  const x = toNumber(a);
  const y = toNumber(b);
  if (x !== null && y !== null) return x - y;
  const s = String(a);
  const t = String(b);
  return s < t ? -1 : s > t ? 1 : 0;
}

function test(value: Cell, t: FilterTest): boolean {
  if ('empty' in t) return isEmpty(value) === t.empty;
  if (Array.isArray(value)) return value.some((v) => test(v, t));
  if ('equals' in t) return value === t.equals || (value !== null && String(value) === String(t.equals));
  if ('in' in t) return t.in.some((x) => test(value, { equals: x }));
  if ('contains' in t) return value !== null && String(value).toLowerCase().includes(t.contains.toLowerCase());
  if (isEmpty(value)) return false;
  if (t.min !== undefined && t.min !== null && compare(value, t.min) < 0) return false;
  if (t.max !== undefined && t.max !== null && compare(value, t.max) > 0) return false;
  return true;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A part of an ISO date (as `parseDate` returns), as text that sorts in time order. */
export function datePart(iso: string, part: DatePart): Scalar {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?/.exec(iso);
  if (!m) return null;
  const [, y, mo, d, h = '00'] = m;
  switch (part) {
    case 'year':
      return y!;
    case 'month':
      return `${y}-${mo}`;
    case 'day':
      return `${y}-${mo}-${d}`;
    case 'hour':
      return Number(h);
    case 'weekday':
    case 'week': {
      const date = new Date(Date.UTC(+y!, +mo! - 1, +d!));
      const weekday = ((date.getUTCDay() + 6) % 7) + 1; // Monday is 1
      if (part === 'weekday') return weekday;
      // The Monday the week starts on.
      date.setUTCDate(date.getUTCDate() - weekday + 1);
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    }
  }
}

function mutate(value: Cell, fn: MutateFn): Cell {
  if (Array.isArray(value)) {
    if (fn === 'length') return value.length;
    return value.map((v) => mutate(v, fn) as Scalar);
  }
  if (fn === 'length') return value === null ? null : String(value).length;
  if (value === null) return null;
  const s = String(value);
  if (typeof fn === 'object') {
    if ('date' in fn) return parseDate(s, fn.date.format);
    const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s : parseDate(s);
    return iso === null ? null : datePart(iso, fn.datePart);
  }
  switch (fn) {
    case 'number':
      return toNumber(value);
    case 'lowercase':
      return s.toLowerCase();
    case 'domain':
      return toDomain(s);
    case 'words':
      return tokenize(s);
  }
}

function summarise(rows: FrameRow[], s: Summary): Cell {
  if (s.fn === 'count') return rows.length;
  if (!s.column) throw new QueryError(`${s.fn} needs a column`);
  const values = rows.map((r) => r.values[s.column!] ?? null).filter((v) => !isEmpty(v));
  if (s.fn === 'distinct') return new Set(values.map((v) => JSON.stringify(v))).size;
  if (s.fn === 'min' || s.fn === 'max') {
    if (values.length === 0) return null;
    const sorted = [...values].sort(compare);
    const v = s.fn === 'min' ? sorted[0]! : sorted.at(-1)!;
    return Array.isArray(v) ? null : v;
  }
  const numbers = values.map(toNumber).filter((n): n is number => n !== null);
  const sum = numbers.reduce((a, b) => a + b, 0);
  if (s.fn === 'sum') return sum;
  return numbers.length > 0 ? sum / numbers.length : null;
}

/** Run a query on the rows of derived tables (as `deriveRows` returns them). */
export function runQuery(tables: TableDef[], rows: DerivedRow[][], query: Query): QueryResult {
  if (!tables[query.from]) throw new QueryError(`no table ${query.from}`);
  let columns: FrameColumn[] = tableColumns(tables, query.from, query.from);
  let frame: FrameRow[] = rows[query.from]!.map((r, i) => ({
    values: r.values as Record<string, Cell>,
    at: new Map([[query.from, i]]),
  }));
  let groups: string[] | undefined;
  const has = (id: string) => {
    if (!columns.some((c) => c.id === id)) throw new QueryError(`no column ${id}`);
  };

  for (const step of query.steps) {
    if ('unnest' in step) {
      const table = tables[step.unnest];
      const parent = table?.parent;
      if (!table || parent === undefined) throw new QueryError(`table ${step.unnest} is not a nested table`);
      if (!frame.every((r) => r.at.has(parent)) && frame.length > 0) {
        throw new QueryError(`unnest table ${parent} before table ${step.unnest}`);
      }
      const prefix = prefixOf(tables, query.from, step.unnest);
      const byParent = new Map<number, number[]>();
      rows[step.unnest]!.forEach((r, i) => {
        const list = byParent.get(r.parent!) ?? [];
        list.push(i);
        byParent.set(r.parent!, list);
      });
      const added = tableColumns(tables, query.from, step.unnest);
      frame = frame.flatMap((r) => {
        const children = byParent.get(r.at.get(parent)!) ?? [];
        if (children.length === 0) {
          if (!step.keepEmpty) return [];
          const values = { ...r.values };
          for (const c of added) values[c.id] = null;
          return [{ values, at: r.at }];
        }
        return children.map((i) => {
          const values = { ...r.values };
          for (const [id, v] of Object.entries(rows[step.unnest]![i]!.values)) values[prefix + id] = v as Cell;
          return { values, at: new Map([...r.at, [step.unnest, i]]) };
        });
      });
      columns = [...columns, ...added];
    } else if ('unnestList' in step) {
      has(step.unnestList);
      frame = frame.flatMap((r) => {
        const v = r.values[step.unnestList] ?? null;
        if (!Array.isArray(v)) return [r];
        return v.map((item) => ({ values: { ...r.values, [step.unnestList]: item }, at: r.at }));
      });
    } else if ('filter' in step) {
      has(step.filter);
      frame = frame.filter((r) => test(r.values[step.filter] ?? null, step.test) !== (step.not === true));
    } else if ('mutate' in step) {
      has(step.from);
      for (const r of frame) r.values = { ...r.values, [step.mutate]: mutate(r.values[step.from] ?? null, step.fn) };
      if (!columns.some((c) => c.id === step.mutate)) columns = [...columns, { id: step.mutate, name: step.mutate }];
    } else if ('select' in step) {
      step.select.forEach(has);
      columns = step.select.map((id) => columns.find((c) => c.id === id)!);
    } else if ('group' in step) {
      step.group.forEach(has);
      groups = step.group;
    } else if ('summarise' in step) {
      const by = groups ?? [];
      const buckets = new Map<string, FrameRow[]>();
      for (const r of frame) {
        const key = JSON.stringify(by.map((id) => r.values[id] ?? null));
        const bucket = buckets.get(key) ?? [];
        bucket.push(r);
        buckets.set(key, bucket);
      }
      if (by.length === 0 && buckets.size === 0) buckets.set('[]', []);
      frame = [...buckets.values()].map((bucket) => {
        const values: Record<string, Cell> = {};
        for (const id of by) values[id] = bucket[0]!.values[id] ?? null;
        for (const s of step.summarise) values[s.name] = summarise(bucket, s);
        return { values, at: new Map() };
      });
      columns = [
        ...by.map((id) => columns.find((c) => c.id === id)!),
        ...step.summarise.map((s) => ({ id: s.name, name: s.name })),
      ];
      groups = undefined;
    } else if ('arrange' in step) {
      has(step.arrange);
      const sign = step.desc ? -1 : 1;
      frame = [...frame].sort((a, b) => sign * compare(a.values[step.arrange] ?? null, b.values[step.arrange] ?? null));
    } else if ('limit' in step) {
      frame = frame.slice(0, Math.max(0, step.limit));
    }
  }
  const ids = new Set(columns.map((c) => c.id));
  return {
    columns,
    rows: frame.map((r) => Object.fromEntries(Object.entries(r.values).filter(([id]) => ids.has(id)))),
  };
}

/** The columns a query starting at `from` can use after unnesting down to `to`. */
export function queryColumns(tables: TableDef[], from: number, to: number): FrameColumn[] {
  const path = unnestPath(tables, from, to);
  return [from, ...path].flatMap((t) => tableColumns(tables, from, t));
}
