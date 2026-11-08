/**
 * What a participant donates: the values of the fields the researcher asks for, in long format,
 * one entry per value, with its raw path (docs/decisions/0015-raw-paths-and-relational-export.md).
 *
 * A donation holds the data as matched, not as tables: the key page places every value under
 * the newest names by its path. A path is the keys from the upload's root as shapes show them
 * (screened, HTML elements by their shape name), `[i]` for list items and `{i}` for keys that are
 * data, which are never part of a path: they are donated only as a key column the researcher
 * asks for. A single element where the project expects a list of them is the list's item `[0]`.
 *
 * `donationValues` matches; `withoutRows` leaves rows out; `donationPayload` makes what is sent:
 * the paths in a dictionary, and positions numbered again without gaps.
 */
import type { DonatedValue as SentValue, DonationEntry, DonationPayload } from '@combray/seal/payload';
import type { RowGroup } from '@combray/seal/names';

import { localize, type Localized } from './importer/spec';
import { deriveRows, KEY_COLUMN, leafValue, matchesChild, convertValue, type ColumnDef, type TableDef } from './derive';
import { getNode, matchesPosition, type ProjectNode } from './decisions';
import { isItemNode } from './config';
import { listTable } from './nameMap';
import { elementName, screenName } from './shape';
import { childrenOf, type TreeNode } from './tree';

export type DonatedCell = string | number | boolean | null;

/** One donated value, as the participant reviews it. */
export interface DonatedValue {
  /** The table: its name's id, or the path of its rows (`TableDef.id`). */
  table: string;
  /** The row in this donation: values of one row share it. Numbered per table from 0. */
  row: number;
  /** For a row of a nested table: the row it is in. */
  parent?: { table: string; row: number };
  /** The field: its name's id, or its path from the row (`ColumnDef.id`). */
  field: string;
  /** Where the value was: the keys from the upload's root, `[i]` for list items, `{i}` for keys that are data. */
  path: string[];
  /** The value as read (converted as the researcher set). */
  value: DonatedCell;
  /** The value as it was in the file, when it was converted and the researcher asked for both. */
  raw?: DonatedCell;
  /** The value as it was in the file, always: to search and leave rows out by. Never sent unless `raw`. */
  source: DonatedCell;
  /** Its path in `DonationContent.entries`: the general path, with its names and row groups. */
  entry: number;
}

/** A table in a donation, for people: its name, and its fields' names. */
export interface DonatedTableInfo {
  id: string;
  name: string;
  fields: { id: string; name: string }[];
}

/** A row of a donation, for the participant's review: where it is in their files. Not sent. */
export interface DonatedRow {
  table: string;
  row: number;
  parent?: { table: string; row: number };
  /** The path of the row itself, like the values' paths. */
  path: string[];
  /**
   * What the row is, without positions: its platform, the general path of its table, the values
   * in its files (not in the lists in it) and its parent's. The same after a new upload of the same
   * files or a new version of the study, so a row left out stays out.
   */
  hash: string;
}

export interface DonationContent {
  tables: DonatedTableInfo[];
  values: DonatedValue[];
  /** Every row with a donated value, in order: parents before the rows nested in them. */
  rows: DonatedRow[];
  /** The general paths of the values, with the names they are donated as. */
  entries: DonationEntry[];
}

const cell = (value: unknown): DonatedCell =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value) ? (value as DonatedCell) : value instanceof Date ? value.toISOString() : null;

const text = (name: Localized) => localize(name, 'en');

/** A path step of a key, as shapes write it: screened, and HTML elements by their shape name. */
const stepOf = (node: TreeNode) => (node.kind === 'element' ? elementName(node.name, node.attrs) : screenName(node.name));

/** `[*]` and `{*}` for positions: the path without where in the lists it is. */
export const generalPath = (path: readonly string[]) => path.map((s) => (/^\[\d+\]$/.test(s) ? '[*]' : /^\{\d+\}$/.test(s) ? '{*}' : s));

/** The path of every node of a tree that the project matches (see the top of this file). */
function pathsOf(tree: TreeNode, project: ProjectNode): Map<TreeNode, string[]> {
  const out = new Map<TreeNode, string[]>();
  const visit = (node: TreeNode, at: ProjectNode, path: string[]) => {
    out.set(node, path);
    childrenOf(node).forEach((child, i) => {
      const target = (at.children ?? []).find((c) => matchesChild(at, node, child, c));
      if (target) {
        visit(child, target, [...path, node.kind === 'list' ? `[${i}]` : at.collapsed ? `{${i}}` : stepOf(child)]);
        return;
      }
      // A single element where other files have a list of them: the list's only item (as `resolve`).
      if (child.kind !== 'element') return;
      const name = stepOf(child);
      const list = (at.children ?? []).find((c) => c.kind === 'list' && matchesPosition(at, c, 'list', name));
      const item = list?.children?.find((c) => c.kind === 'element' && isItemNode(c));
      if (item) visit(child, item, [...path, name, '[0]']);
    });
  };
  visit(tree, project, []);
  return out;
}

/** Whether a column's values are donated: asked for, and a value (not a nested table's count). */
const donated = (column: ColumnDef) => column.state === 'donate' && column.type !== 'table';

/** A small, fast hash (cyrb53): for recognising rows on this device, never for security. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The values of a row in its files, not in the lists in it: what a row is, whatever the study asks of it. */
function rowContent(node: TreeNode): string {
  const parts: string[] = [];
  const visit = (n: TreeNode, path: string) => {
    if (n.kind === 'list' && n !== node) return;
    const value = leafValue(n);
    if (n.kind === 'value' || n.kind === 'text') parts.push(`${path}=${JSON.stringify(value)}`);
    childrenOf(n).forEach((c) => visit(c, `${path}/${stepOf(c)}`));
  };
  visit(node, '');
  return parts.sort().join('\n');
}

/**
 * The values a participant donates from their tree: the fields the researcher asks for (decision
 * `donate`), from the rows that pass the tables' filters. `tables` are `deriveTables(project)`;
 * `platform` is the upload point the tree is from.
 */
export function donationValues(tree: TreeNode, project: ProjectNode, tables: TableDef[], platform = ''): DonationContent {
  const rows = deriveRows(tree, project, tables, { sources: true });
  const paths = pathsOf(tree, project);
  const values: DonatedValue[] = [];
  const donatedRows: DonatedRow[] = [];
  const infos = new Map<string, DonatedTableInfo>();
  const entries: DonationEntry[] = [];
  const entryIds = new Map<string, number>();
  const entryOf = (path: string[], table: string, field: string, groups: RowGroup[], as?: string): number => {
    const general = generalPath(path);
    const key = JSON.stringify([general, table, field, groups]);
    let id = entryIds.get(key);
    if (id === undefined) {
      id = entries.push({ platform, path: general, table, field, rows: groups, ...(as ? { as } : {}) }) - 1;
      entryIds.set(key, id);
    }
    return id;
  };
  // How the rows of each table are told apart: by the steps of its rows' path, and its parents'.
  const groupsOf = (index: number): RowGroup[] => {
    const table = tables[index]!;
    if (table.rows === undefined) return [];
    const own = { table: table.id, steps: table.rows.length };
    return table.parent === undefined ? [own] : [...groupsOf(table.parent), own];
  };
  // Tables with the same name are one table: their rows are numbered on from each other's.
  const next = new Map<string, number>();
  const offsets = tables.map((table, i) => {
    const offset = next.get(table.id) ?? 0;
    next.set(table.id, offset + rows[i]!.length);
    return offset;
  });
  const rowHashes: string[][] = tables.map(() => []);
  const seenHashes = new Map<string, number>();

  tables.forEach((table, i) => {
    const groups = groupsOf(i);
    const columns = table.columns.filter(donated);
    const parentTable = table.parent === undefined ? undefined : tables[table.parent]!;
    const general = table.rows ? generalPath(getNodeNames(project, table.rows)).join('/') : '';
    rows[i]!.forEach((row, r) => {
      // Every row gets its hash, also rows with nothing asked: rows nested in them need it.
      const parentHash = parentTable && row.parent !== undefined ? rowHashes[table.parent!]![row.parent] : '';
      const base = hash53([platform, general, parentHash, row.node ? rowContent(row.node) : ''].join('\u0000'));
      const n = seenHashes.get(base) ?? 0;
      seenHashes.set(base, n + 1);
      const rowHash = n === 0 ? base : `${base}.${n}`;
      rowHashes[i]![r] = rowHash;
      if (columns.length === 0) return;
      const place = {
        table: table.id,
        row: offsets[i]! + r,
        ...(parentTable && row.parent !== undefined ? { parent: { table: parentTable.id, row: offsets[table.parent!]! + row.parent } } : {}),
      };
      const rowPath = row.node ? (paths.get(row.node) ?? []) : [];
      donatedRows.push({ ...place, path: rowPath, hash: rowHash });
      const info = infos.get(table.id) ?? { id: table.id, name: text(table.name), fields: [] };
      for (const c of columns) if (!info.fields.some((f) => f.id === c.id)) info.fields.push({ id: c.id, name: text(c.name) || c.id });
      infos.set(table.id, info);
      for (const column of columns) {
        if (column.type === 'key' || column.id === KEY_COLUMN) {
          const key = cell(row.node!.name);
          values.push({ ...place, field: column.id, path: rowPath, value: cell(convertValue(row.node!.name, column)), source: key, entry: entryOf(rowPath, table.id, column.id, groups, column.as) });
          continue;
        }
        for (const source of row.sources?.[column.id] ?? []) {
          const raw = cell(leafValue(source));
          const value = cell(convertValue(raw, column));
          const path = paths.get(source) ?? [];
          // A list of plain values is a table of its own in the export, its rows told apart by the item.
          const item = column.type === 'list' ? path.findIndex((s, k) => k >= (table.rows?.length ?? 0) && /^\[\d+\]$/.test(s)) : -1;
          const own = item >= 0 ? [...groups, { table: listTable(table.id, column.id), steps: item + 1 }] : groups;
          values.push({
            ...place,
            field: column.id,
            path,
            value,
            ...(column.raw ? { raw } : {}),
            source: raw,
            entry: entryOf(path, own.at(-1)?.table ?? table.id, column.id, own, column.as),
          });
        }
      }
    });
  });
  return { tables: [...infos.values()], values, rows: donatedRows, entries };
}

/** The names (keys) along a path of ids, as shapes write them. */
function getNodeNames(root: ProjectNode, path: string[]): string[] {
  return path.map((_, i) => getNode(root, path.slice(0, i + 1))?.name ?? '');
}

const rowKey = (table: string, row: number) => `${table}\u0000${row}`;

/**
 * Leave rows out of a donation: the rows `drop` says, and every row nested in one of them, with
 * their values. Row numbers are kept, so they may have gaps.
 */
export function withoutRows(content: DonationContent, drop: (row: DonatedRow) => boolean): DonationContent {
  const dropped = new Set<string>();
  // Parents come before the rows nested in them.
  for (const row of content.rows) {
    if (drop(row) || (row.parent && dropped.has(rowKey(row.parent.table, row.parent.row)))) dropped.add(rowKey(row.table, row.row));
  }
  const kept = (table: string, row: number) => !dropped.has(rowKey(table, row));
  const rows = content.rows.filter((r) => kept(r.table, r.row));
  const tables = content.tables.filter((t) => rows.some((r) => r.table === t.id));
  return { tables, values: content.values.filter((v) => kept(v.table, v.row)), rows, entries: content.entries };
}

/**
 * Several uploads in one donation: tables with the same id are one table, and the rows of each
 * upload are numbered on from the ones before.
 */
export function combineDonations(parts: DonationContent[]): DonationContent {
  const tables = new Map<string, DonatedTableInfo>();
  const next = new Map<string, number>();
  const out: DonationContent = { tables: [], values: [], rows: [], entries: [] };
  const entryIds = new Map<string, number>();
  for (const part of parts) {
    const entry = part.entries.map((e) => {
      const key = JSON.stringify(e);
      let id = entryIds.get(key);
      if (id === undefined) {
        id = out.entries.push(e) - 1;
        entryIds.set(key, id);
      }
      return id;
    });
    for (const t of part.tables) {
      const known = tables.get(t.id);
      if (!known) tables.set(t.id, { ...t, fields: [...t.fields] });
      else for (const f of t.fields) if (!known.fields.some((k) => k.id === f.id)) known.fields.push(f);
    }
    const offsets = new Map<string, number>();
    const offset = (table: string) => {
      if (!offsets.has(table)) offsets.set(table, next.get(table) ?? 0);
      return offsets.get(table)!;
    };
    const shift = <T extends { table: string; row: number; parent?: { table: string; row: number } }>(x: T): T => ({
      ...x,
      row: x.row + offset(x.table),
      ...(x.parent ? { parent: { table: x.parent.table, row: x.parent.row + offset(x.parent.table) } } : {}),
    });
    out.rows.push(...part.rows.map(shift));
    out.values.push(...part.values.map((v) => ({ ...shift(v), entry: entry[v.entry]! })));
    for (const r of part.rows) next.set(r.table, Math.max(next.get(r.table) ?? 0, r.row + offset(r.table) + 1));
  }
  out.tables = [...tables.values()];
  return out;
}

/**
 * What is sent of a donation (`combray-donation/2`): the entries that are used, and every value
 * as a reference to its entry with its positions. Positions are numbered again without gaps,
 * keeping their order, per list (and per map whose keys are data): a gap would show that rows
 * were left out, and where. The study's `version` is the one the donation was made with.
 */
export function donationPayload(
  content: DonationContent,
  extra: Omit<DonationPayload, 'format' | 'entries' | 'values'>,
): DonationPayload {
  // For every list in the donation (by platform and the path up to it), its positions in use.
  const used = new Map<string, Set<number>>();
  const listsOf = (v: DonatedValue) => {
    const platform = content.entries[v.entry]!.platform;
    const out: { list: string; at: number }[] = [];
    v.path.forEach((step, i) => {
      const m = /^[[{](\d+)[\]}]$/.exec(step);
      if (m) out.push({ list: `${platform}\u0000${v.path.slice(0, i).join('/')}`, at: Number(m[1]) });
    });
    return out;
  };
  for (const v of content.values) {
    for (const { list, at } of listsOf(v)) {
      const set = used.get(list) ?? new Set<number>();
      set.add(at);
      used.set(list, set);
    }
  }
  const rank = new Map<string, Map<number, number>>();
  for (const [list, set] of used) rank.set(list, new Map([...set].sort((a, b) => a - b).map((at, i) => [at, i])));
  const entryIds = new Map<number, number>();
  const entries: DonationEntry[] = [];
  const values: SentValue[] = content.values.map((v) => {
    let entry = entryIds.get(v.entry);
    if (entry === undefined) {
      entry = entries.push(content.entries[v.entry]!) - 1;
      entryIds.set(v.entry, entry);
    }
    const positions = listsOf(v).map(({ list, at }) => rank.get(list)!.get(at)!);
    return v.raw === undefined ? [entry, positions, v.value] : [entry, positions, v.value, v.raw];
  });
  return { format: 'combray-donation/2', ...extra, entries, values };
}
