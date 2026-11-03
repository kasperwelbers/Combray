/**
 * Importing through a project tree (docs/tree-decisions.md): the root found in an upload
 * (`locateRoot`) is matched against the tree of its upload point, and the tables inferred from
 * it are what the participant sees. Nested tables stay nested: their rows are kept inside the
 * parent row.
 *
 * Everything here runs in the data worker, on the participant's own data. Nothing is sent.
 */
import {
  deriveRows,
  deriveTables,
  getNode,
  joinProjectTree,
  mergeShape,
  parseImporterFile,
  parseStructureFile,
  type ColumnDef,
  type DerivedRow,
  type FieldValue,
  type NodePath,
  type ProjectNode,
  type Row,
  type Shape,
  type TableDef,
  type TreeNode,
} from '@combray/core';
import { packs, packTree } from '@combray/importers';

import type { ColumnInfo, DerivedTable, UploadPoint } from './api';

/** One table of an upload, with its rows (nested rows inside them). */
export interface DerivedImport {
  point: UploadPoint;
  tables: { table: DerivedTable; rows: Row[] }[];
}

const pathKey = (path: NodePath) => path.join('\u0000');

const trees = new Map<string, ProjectNode>();

/**
 * The tree of an upload point: the project's own, as published from the studio, or else the
 * bundled pack it names. Kept once joined; matching an upload works on a copy (`mergeShape`).
 */
export function pointTree(point: UploadPoint): ProjectNode | undefined {
  if (point.structure !== undefined && point.importer !== undefined) {
    const key = `project:${point.id}`;
    if (!trees.has(key)) {
      try {
        trees.set(key, joinProjectTree(parseStructureFile(point.structure), parseImporterFile(point.importer)).tree);
      } catch {
        // A tree the client cannot read: fall back to the pack, if there is one.
      }
    }
    const own = trees.get(key);
    if (own) return own;
  }
  const pack = packs.find((p) => p.id === point.pack);
  if (!pack) return undefined;
  if (!trees.has(pack.id)) trees.set(pack.id, packTree(pack));
  return trees.get(pack.id);
}

/** Whether a node has, or something below it has, a researcher's show or donate decision. */
function decided(node: ProjectNode | undefined): boolean {
  if (!node) return false;
  if (node.decision === 'show' || node.decision === 'donate') return true;
  return (node.children ?? []).some(decided);
}

/** The rows of each table, with nested tables' rows inside their parent rows. */
function nest(tables: TableDef[], rows: DerivedRow[][]): Row[][] {
  const out: Row[][] = rows.map((table) => table.map((r) => ({ ...(r.values as Row) })));
  // Children before parents, so nested rows are complete when they move into their parent.
  for (let i = tables.length - 1; i >= 0; i--) {
    const parent = tables[i]!.parent;
    if (parent === undefined) continue;
    const column = tables[parent]!.columns.find((c) => c.table === i)!;
    for (const row of out[parent]!) row[column.id] = [];
    rows[i]!.forEach((r, j) => (out[parent]![r.parent!]![column.id] as FieldValue[]).push(out[i]![j]!));
  }
  return out;
}

function columnInfo(
  column: ColumnDef,
  tables: TableDef[],
  rowsPath: NodePath,
  tree: ProjectNode,
  added: Set<string>,
): ColumnInfo {
  const full = [...rowsPath, ...column.path];
  const isNew = full.some((_, i) => added.has(pathKey(full.slice(0, i + 1))));
  const info: ColumnInfo = { id: column.id, name: column.name, type: column.type, state: column.state };
  if (isNew) info.new = true;
  if (column.role) info.role = column.role;
  if (column.as === 'datetime' || column.as === 'url') info.as = column.as;
  if (column.type === 'table') {
    const nested = tables[column.table!]!;
    info.columns = nested.columns.map((c) => columnInfo(c, tables, nested.rows!, tree, added));
  } else if (!decided(getNode(tree, full))) {
    info.undecided = true;
  }
  return info;
}

/** Display hints from roles: the first date, title and link, and every group, nested ones too. */
function displayOf(columns: ColumnInfo[]): DerivedTable['display'] {
  const display: DerivedTable['display'] = {};
  const groups: string[] = [];
  const visit = (cols: ColumnInfo[], prefix: string) => {
    for (const c of cols) {
      const id = prefix + c.id;
      if (c.type === 'table') visit(c.columns ?? [], `${id}/`);
      else if (c.role === 'group') groups.push(id);
      else if (c.role && !prefix && display[c.role] === undefined) display[c.role] = id;
    }
  };
  visit(columns, '');
  if (groups.length > 0) display.group_by = groups;
  return display;
}

function anyColumn(columns: ColumnInfo[], test: (c: ColumnInfo) => boolean): boolean {
  return columns.some((c) => test(c) || anyColumn(c.columns ?? [], test));
}

/**
 * The tables of a root found for an upload point, `prepared` (normalised) as `locateRoot`
 * returns it.
 */
export function deriveImport(
  root: { prepared: TreeNode; shape: Shape },
  projectTree: ProjectNode,
  point: UploadPoint,
): DerivedImport {
  // Parts the project does not know yet are added undecided, so participants still see them,
  // except below nodes that skip new children.
  const merged = mergeShape(projectTree, root.shape, { skipClosed: true });
  const added = new Set(merged.added.map(pathKey));
  const defs = deriveTables(merged.tree);
  const nested = nest(defs, deriveRows(root.prepared, merged.tree, defs));
  const tables: DerivedImport['tables'] = [];
  defs.forEach((def, i) => {
    if (def.parent !== undefined || nested[i]!.length === 0) return;
    const rowsPath = def.rows ?? [];
    const columns = def.columns.map((c) => columnInfo(c, defs, rowsPath, merged.tree, added));
    const collection = anyColumn(columns, (c) => c.type !== 'table' && !c.undecided);
    const table: DerivedTable = {
      name: def.name,
      path: rowsPath,
      record: def.rows === undefined,
      collection,
      requested: def.state === 'donate',
      columns,
      display: displayOf(columns),
    };
    if (anyColumn(columns, (c) => c.new === true)) table.new = true;
    tables.push({ table, rows: nested[i]! });
  });
  return { point, tables };
}
