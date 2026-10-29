/**
 * Simple charts as queries: what a researcher or participant picks in the chart builder
 * (count the rows of a table over time, or per category) becomes a `Query`, and its result
 * becomes points to draw. See docs/exploration.md#charts.
 */
import type { TableDef } from './derive';
import {
  queryColumns,
  rootTable,
  unnestPath,
  type Cell,
  type DatePart,
  type Query,
  type QueryResult,
  type Scalar,
  type Step,
  type SummaryFn,
} from './query';

export interface ChartSpec {
  /** The table whose rows are counted (or summarised); nested tables are unnested to it. */
  table: number;
  /** A column of the table or of a table it is nested in. With `time`, a timeline. */
  x: { column: string; time?: DatePart; format?: string };
  /** What is drawn per bar or point; the number of rows if left out. */
  y?: { fn: Exclude<SummaryFn, 'count'>; column: string };
  /** A column whose values become separate series (lines, or stacked bars). */
  split?: string;
}

export interface ChartPoint {
  x: Scalar;
  series: Scalar;
  y: number;
}

export interface ChartData {
  kind: 'time' | 'category';
  points: ChartPoint[];
  /** In order: x values on the axis, and series by size. */
  xs: Scalar[];
  series: Scalar[];
  /** Categories or series left out because there were more than fit. */
  more: { xs: number; series: number };
}

const X = '{x}';
const Y = '{y}';

/** Timelines group by the date part they compute; categories by the column itself. */
const xColumn = (spec: ChartSpec) => (spec.x.time ? X : spec.x.column);

/** The query that computes a chart. */
export function chartQuery(tables: TableDef[], spec: ChartSpec): Query {
  const from = rootTable(tables, spec.table);
  const columns = queryColumns(tables, from, spec.table);
  const column = (id: string) => {
    const c = columns.find((c) => c.id === id);
    if (!c) throw new Error(`no column ${id}`);
    return c;
  };
  const steps: Step[] = unnestPath(tables, from, spec.table).map((t) => ({ unnest: t }));
  for (const id of [spec.x.column, spec.split].filter((c): c is string => c !== undefined)) {
    if (column(id).def?.type === 'list') steps.push({ unnestList: id });
  }
  const x = xColumn(spec);
  if (spec.x.time) {
    steps.push({ mutate: X, from: spec.x.column, fn: { date: spec.x.format ? { format: spec.x.format } : {} } });
    steps.push({ mutate: X, from: X, fn: { datePart: spec.x.time } });
  }
  steps.push({ filter: x, test: { empty: false } });
  steps.push({ group: spec.split ? [x, spec.split] : [x] });
  steps.push({
    summarise: [spec.y ? { name: Y, fn: spec.y.fn, column: spec.y.column } : { name: Y, fn: 'count' }],
  });
  return { from, steps };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Every bucket between the first and the last, so empty periods show as zero. */
function timeAxis(part: DatePart, seen: Scalar[], limit: number): Scalar[] {
  if (part === 'hour') return Array.from({ length: 24 }, (_, i) => i);
  if (part === 'weekday') return [1, 2, 3, 4, 5, 6, 7];
  const sorted = [...seen].map(String).sort();
  if (sorted.length === 0) return [];
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  const out: string[] = [];
  const date = new Date(`${part === 'year' ? `${first}-01-01` : part === 'month' ? `${first}-01` : first}T00:00:00Z`);
  for (let i = 0; i < limit; i++) {
    const s =
      part === 'year'
        ? String(date.getUTCFullYear())
        : part === 'month'
          ? `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`
          : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    if (s > last) return out;
    out.push(s);
    if (part === 'year') date.setUTCFullYear(date.getUTCFullYear() + 1);
    else if (part === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
    else date.setUTCDate(date.getUTCDate() + (part === 'week' ? 7 : 1));
  }
  // Too many buckets to fill: show the ones seen.
  return sorted;
}

const asNumber = (v: Cell | undefined) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** Points to draw from a chart query's result: the biggest categories and series only. */
export function chartData(
  result: QueryResult,
  spec: ChartSpec,
  limits: { categories?: number; series?: number; buckets?: number } = {},
): ChartData {
  const { categories = 15, series: maxSeries = 5, buckets = 400 } = limits;
  const split = spec.split;
  const x = xColumn(spec);
  const all = result.rows.map((r) => ({
    x: (Array.isArray(r[x]) ? null : (r[x] ?? null)) as Scalar,
    series: split ? ((Array.isArray(r[split]) ? null : (r[split] ?? null)) as Scalar) : null,
    y: asNumber(r[Y]),
  }));
  const totals = (key: 'x' | 'series') => {
    const m = new Map<Scalar, number>();
    for (const p of all) m.set(p[key], (m.get(p[key]) ?? 0) + p.y);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  const seriesAll = totals('series');
  const series = seriesAll.slice(0, maxSeries);
  const time = spec.x.time !== undefined;
  const xsAll = time ? timeAxis(spec.x.time!, [...new Set(all.map((p) => p.x))], buckets) : totals('x');
  const xs = time ? xsAll : xsAll.slice(0, categories);
  const keepX = new Set(xs);
  const keepSeries = new Set(series);
  return {
    kind: time ? 'time' : 'category',
    points: all.filter((p) => keepX.has(p.x) && keepSeries.has(p.series)),
    xs,
    series,
    more: { xs: xsAll.length - xs.length, series: seriesAll.length - series.length },
  };
}
