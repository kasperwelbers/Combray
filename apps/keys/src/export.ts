/**
 * The export of opened donations as tables (docs/decisions/0015-raw-paths-and-relational-export.md).
 *
 * Every donated value carries its raw path. Here it is placed under the newest names: the name
 * map of the project's newest published version says, by the path, which table and field it is
 * and which rows it is in. Values are never read again: each keeps the reading of the version
 * its donation was made with, which every row records. A path the newest map no longer matches is
 * deprecated: left out, unless asked for, and then only in the long list under the names it was
 * donated with. Without a name map (a project published before name maps), values keep the names
 * they were donated with.
 *
 * Tables are relational: one per table name and platform, each row with an `.id` (per donation)
 * and the `.id` of the row it is in for every table up (`.tweets_id`), so they join in R or Python.
 */
import { type Cell, type DonationEntry, type NameMap, type Placement, placements, rowKey, valuePath } from '@combray/seal';

import type { Opened } from './decrypt';
import { csvCell } from './decrypt';

export interface ExportOptions {
  /** Put values at paths the newest name map no longer matches in the long list, marked. */
  deprecated?: boolean;
  /** Give, in the long list, the table and field each value was donated as. */
  original?: boolean;
}

/** The name of fields outside any table, for files and columns. */
const RECORD = 'record';
const tableName = (name: string) => name || RECORD;

interface Row {
  donation: string;
  day: string;
  version: number | null;
  id: number;
  /** The id of the row it is in, per table up. */
  parents: Map<string, number>;
  values: Map<string, Cell[]>;
  raw: Map<string, Cell[]>;
}

interface Table {
  platform: string;
  name: string;
  /** The tables up, outermost first, as seen in any row. */
  parents: string[];
  fields: string[];
  withRaw: Set<string>;
  rows: Row[];
}

/** One value placed: in a table's row, or (deprecated) only in the long list. */
interface Placed {
  donation: Opened;
  platform: string;
  path: string[];
  placement: Placement;
  /** The row's `.id` in its table; none for deprecated values. */
  row?: number;
  value: Cell;
  raw?: Cell;
  entry: DonationEntry;
  deprecated: boolean;
}

export interface Exported {
  /** One CSV per platform and table, keyed `{platform}-{table}`. */
  tables: Map<string, { platform: string; name: string; csv: string }>;
  /** Every value, one per line. */
  values: string;
  /** How each field was read, per version. */
  fields: string;
  /** How many values were deprecated, and how many of those were left out. */
  deprecated: { count: number; leftOut: number };
}

const toLine = (cells: Cell[]) => cells.map(csvCell).join(',');
const toFile = (lines: Cell[][]) => lines.map(toLine).join('\r\n') + '\r\n';

/** The cell for a field of a row: its value, or all of them as JSON when a row has more than one. */
const joined = (values: Cell[] | undefined): Cell =>
  values === undefined || values.length === 0 ? null : values.length === 1 ? values[0]! : JSON.stringify(values);

/** Place every value of every donation, and make the tables, the long list and the fields. */
export function exportDonations(opened: Opened[], maps: ReadonlyMap<string, NameMap>, options: ExportOptions = {}): Exported {
  const tables = new Map<string, Table>();
  const placed: Placed[] = [];
  const cache = new Map<string, Placement[]>();
  let deprecatedCount = 0;

  const tableOf = (platform: string, name: string): Table => {
    const key = `${platform}\u0000${name}`;
    let table = tables.get(key);
    if (!table) {
      table = { platform, name, parents: [], fields: [], withRaw: new Set(), rows: [] };
      tables.set(key, table);
    }
    return table;
  };

  for (const d of opened) {
    const version = d.payload.version ?? null;
    // Rows of this donation by table and row key, numbered from 1 per table.
    const rows = new Map<string, Row>();
    const counts = new Map<Table, number>();
    const rowOf = (platform: string, table: string, key: string): Row => {
      const id = `${platform}\u0000${table}\u0000${key}`;
      let row = rows.get(id);
      if (!row) {
        const t = tableOf(platform, table);
        const n = (counts.get(t) ?? 0) + 1;
        counts.set(t, n);
        row = { donation: d.id, day: d.day, version, id: n, parents: new Map(), values: new Map(), raw: new Map() };
        t.rows.push(row);
        rows.set(id, row);
      }
      return row;
    };
    // The values at one path, from every entry that matched it when donated.
    const groups = new Map<string, { entry: DonationEntry; path: string[]; value: Cell; raw?: Cell }[]>();
    for (const [e, positions, value, raw] of d.payload.values) {
      const entry = d.payload.entries[e]!;
      const path = valuePath(entry, positions);
      const key = `${entry.platform}\u0000${path.join('/')}`;
      const list = groups.get(key) ?? [];
      list.push({ entry, path, value, ...(raw !== undefined ? { raw } : {}) });
      groups.set(key, list);
    }
    for (const group of groups.values()) {
      const { entry, path } = group[0]!;
      const map = maps.get(entry.platform);
      const own = (g: (typeof group)[number]): Placement => ({ table: g.entry.table, field: g.entry.field, rows: g.entry.rows });
      let found: Placement[];
      if (!map) found = group.map(own);
      else {
        const key = `${entry.platform}\u0000${entry.path.join('/')}`;
        found = cache.get(key) ?? placements(map, entry.path);
        cache.set(key, found);
      }
      if (map && found.length === 0) {
        deprecatedCount += group.length;
        if (!options.deprecated) continue;
        for (const g of group) placed.push({ donation: d, platform: entry.platform, path, placement: own(g), value: g.value, ...(g.raw !== undefined ? { raw: g.raw } : {}), entry: g.entry, deprecated: true });
        continue;
      }
      for (const placement of found) {
        // One path read in two ways when donated: each field takes the value donated under its name.
        const g =
          group.find((x) => x.entry.field === placement.field && x.entry.table === placement.table) ?? group.find((x) => x.entry.field === placement.field) ?? group[0]!;
        const table = tableOf(entry.platform, tableName(placement.table));
        const row = rowOf(entry.platform, tableName(placement.table), placement.rows.length > 0 ? rowKey(path, placement.rows.at(-1)!) : '');
        placement.rows.slice(0, -1).forEach((up) => {
          const parent = rowOf(entry.platform, up.table, rowKey(path, up));
          row.parents.set(up.table, parent.id);
          if (!table.parents.includes(up.table)) table.parents.push(up.table);
        });
        if (!table.fields.includes(placement.field)) table.fields.push(placement.field);
        row.values.set(placement.field, [...(row.values.get(placement.field) ?? []), g.value]);
        if (g.raw !== undefined) {
          table.withRaw.add(placement.field);
          row.raw.set(placement.field, [...(row.raw.get(placement.field) ?? []), g.raw]);
        }
        placed.push({ donation: d, platform: entry.platform, path, placement, row: row.id, value: g.value, ...(g.raw !== undefined ? { raw: g.raw } : {}), entry: g.entry, deprecated: false });
      }
    }
  }

  const out = new Map<string, { platform: string; name: string; csv: string }>();
  for (const t of tables.values()) {
    // Tables up in order, outermost first: a table's parents come before it in any row's groups.
    const header: Cell[] = ['.donation', '.day', '.version', '.id', ...t.parents.map((p) => `.${p}_id`)];
    for (const f of t.fields) {
      header.push(f);
      if (t.withRaw.has(f)) header.push(`${f} (as in the file)`);
    }
    const lines = t.rows.map((r) => {
      const cells: Cell[] = [r.donation, r.day, r.version, r.id, ...t.parents.map((p) => r.parents.get(p) ?? null)];
      for (const f of t.fields) {
        cells.push(joined(r.values.get(f)));
        if (t.withRaw.has(f)) cells.push(joined(r.raw.get(f)));
      }
      return cells;
    });
    out.set(`${t.platform}-${t.name}`, { platform: t.platform, name: t.name, csv: toFile([header, ...lines]) });
  }

  const longHeader: Cell[] = ['donation', 'day', 'version', 'platform', 'table', 'field', 'row', 'path', 'value', 'as in the file'];
  if (options.deprecated) longHeader.push('deprecated');
  if (options.original) longHeader.push('donated table', 'donated field');
  const long = placed.map((p): Cell[] => {
    const cells: Cell[] = [
      p.donation.id,
      p.donation.day,
      p.donation.payload.version ?? null,
      p.platform,
      tableName(p.placement.table),
      p.placement.field,
      p.row ?? null,
      p.path.join('/'),
      p.value,
      p.raw ?? null,
    ];
    if (options.deprecated) cells.push(p.deprecated);
    if (options.original) cells.push(tableName(p.entry.table), p.entry.field);
    return cells;
  });

  // How each field was read, per version: one column can hold values of several readings.
  const readings = new Map<string, Cell[]>();
  for (const p of placed) {
    if (p.deprecated) continue;
    const version = p.donation.payload.version ?? null;
    const key = JSON.stringify([p.platform, p.placement.table, p.placement.field, version]);
    if (!readings.has(key)) readings.set(key, [p.platform, tableName(p.placement.table), p.placement.field, version, p.entry.as ?? 'as in the file']);
  }

  return {
    tables: out,
    values: toFile([longHeader, ...long]),
    fields: toFile([['platform', 'table', 'field', 'version', 'read as'], ...readings.values()]),
    deprecated: { count: deprecatedCount, leftOut: options.deprecated ? 0 : deprecatedCount },
  };
}
