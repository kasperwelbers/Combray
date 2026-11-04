/**
 * What a participant donates: the values of the fields the researcher asks for, in long format,
 * one entry per value, with where it was in the file (ADR 0012, decision 9).
 *
 * A donation holds the data as matched, not as tables: the configuration can still change after
 * people donate, and the key page pivots the values into tables when a researcher opens them.
 * Each value says which table and row it belongs to (by the name's id, or the path of the rows),
 * which field it is, the path of real keys it was found at, and its value as read. Where the
 * researcher asked for it (`raw`), the value as it was in the file comes along.
 *
 * Keys that are data (the keys of a `{*}` node, such as usernames) are never part of a path:
 * they are written `{i}`, by position, and are donated only as a key column the researcher asks
 * for. Items of a list are `[i]`.
 */
import { localize, type Localized } from './importer/spec';
import { deriveRows, KEY_COLUMN, leafValue, matchesChild, convertValue, type ColumnDef, type TableDef } from './derive';
import type { ProjectNode } from './decisions';
import { childrenOf, type TreeNode } from './tree';

export type DonatedCell = string | number | boolean | null;

/** One donated value. */
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
}

/** A table in a donation, for people: its name, and its fields' names. */
export interface DonatedTableInfo {
  id: string;
  name: string;
  fields: { id: string; name: string }[];
}

export interface DonationContent {
  tables: DonatedTableInfo[];
  values: DonatedValue[];
}

const cell = (value: unknown): DonatedCell =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value) ? (value as DonatedCell) : value instanceof Date ? value.toISOString() : null;

const text = (name: Localized) => localize(name, 'en');

/** The path of every node of a tree that the project matches, with keys that are data as `{i}`. */
function pathsOf(tree: TreeNode, project: ProjectNode): Map<TreeNode, string[]> {
  const out = new Map<TreeNode, string[]>();
  const visit = (node: TreeNode, at: ProjectNode, path: string[]) => {
    out.set(node, path);
    childrenOf(node).forEach((child, i) => {
      const target = (at.children ?? []).find((c) => matchesChild(at, node, child, c));
      if (!target) return;
      const step = node.kind === 'list' ? `[${i}]` : at.collapsed ? `{${i}}` : child.name;
      visit(child, target, [...path, step]);
    });
  };
  visit(tree, project, []);
  return out;
}

/** Whether a column's values are donated: asked for, and a value (not a nested table's count). */
const donated = (column: ColumnDef) => column.state === 'donate' && column.type !== 'table';

/**
 * The values a participant donates from their tree: the fields the researcher asks for (decision
 * `donate`), from the rows that pass the tables' filters. `tables` are `deriveTables(project)`.
 */
export function donationValues(tree: TreeNode, project: ProjectNode, tables: TableDef[]): DonationContent {
  const rows = deriveRows(tree, project, tables, { sources: true });
  const paths = pathsOf(tree, project);
  const values: DonatedValue[] = [];
  const infos = new Map<string, DonatedTableInfo>();
  // Tables with the same name are one table: their rows are numbered on from each other's.
  const next = new Map<string, number>();
  const offsets = tables.map((table, i) => {
    const offset = next.get(table.id) ?? 0;
    next.set(table.id, offset + rows[i]!.length);
    return offset;
  });

  tables.forEach((table, i) => {
    const columns = table.columns.filter(donated);
    if (columns.length === 0) return;
    const info = infos.get(table.id) ?? { id: table.id, name: text(table.name), fields: [] };
    for (const c of columns) if (!info.fields.some((f) => f.id === c.id)) info.fields.push({ id: c.id, name: text(c.name) || c.id });
    infos.set(table.id, info);
    const parentTable = table.parent === undefined ? undefined : tables[table.parent]!;
    rows[i]!.forEach((row, r) => {
      const place = {
        table: table.id,
        row: offsets[i]! + r,
        ...(parentTable && row.parent !== undefined ? { parent: { table: parentTable.id, row: offsets[table.parent!]! + row.parent } } : {}),
      };
      for (const column of columns) {
        if (column.type === 'key' || column.id === KEY_COLUMN) {
          values.push({ ...place, field: column.id, path: paths.get(row.node!) ?? [], value: cell(convertValue(row.node!.name, column)) });
          continue;
        }
        for (const source of row.sources?.[column.id] ?? []) {
          const raw = cell(leafValue(source));
          const value = cell(convertValue(raw, column));
          values.push({
            ...place,
            field: column.id,
            path: paths.get(source) ?? [],
            value,
            ...(column.raw ? { raw } : {}),
          });
        }
      }
    });
  });
  return { tables: [...infos.values()], values };
}
