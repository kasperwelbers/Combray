/**
 * Importing through a project tree (docs/tree-decisions.md): the upload is matched against the
 * tree of one of the project's upload points, and the tables inferred from it are what the
 * participant sees. Nested tables stay nested: their rows are kept inside the parent row.
 *
 * Everything here runs in the data worker, on the participant's own data. Nothing is sent.
 */
import {
  deriveRows,
  deriveTables,
  extractShape,
  getNode,
  knownKeys,
  mergeShape,
  prepareUpload,
  type ColumnDef,
  type DerivedRow,
  type FieldValue,
  type NodePath,
  type ProjectNode,
  type Row,
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

/** The tree of an upload point: its pack, for now. Projects get their own trees in Phase 2. */
function pointTree(point: UploadPoint): ProjectNode | undefined {
  const pack = packs.find((p) => p.id === point.pack);
  return pack && packTree(pack);
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

/** Match an upload against one upload point. The score is the number of rows in tables it knows. */
function tryPoint(
  tree: TreeNode,
  archive: boolean,
  projectTree: ProjectNode,
  point: UploadPoint,
): { result: DerivedImport; score: number } {
  // Header text from the participant's file only becomes a name when the project knows it.
  const prepared = prepareUpload(tree, archive, { keys: knownKeys(projectTree) });
  // Parts the project does not know yet are added undecided, so participants still see them.
  const merged = mergeShape(projectTree, extractShape(prepared));
  const added = new Set(merged.added.map(pathKey));
  const defs = deriveTables(merged.tree);
  const nested = nest(defs, deriveRows(prepared, merged.tree, defs));
  let score = 0;
  const tables: DerivedImport['tables'] = [];
  defs.forEach((def, i) => {
    if (def.parent !== undefined || nested[i]!.length === 0) return;
    const rowsPath = def.rows ?? [];
    const columns = def.columns.map((c) => columnInfo(c, defs, rowsPath, merged.tree, added));
    const collection = anyColumn(columns, (c) => c.type !== 'table' && !c.undecided);
    if (collection) score += nested[i]!.length;
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
  return { result: { point, tables }, score };
}

/**
 * Derive the tables of an upload through the upload point it fits best. Undefined when it
 * fits none, so the caller can fall back to the YAML importers.
 */
export function deriveImport(tree: TreeNode, archive: boolean, points: UploadPoint[]): DerivedImport | undefined {
  let best: { result: DerivedImport; score: number } | undefined;
  for (const point of points) {
    const projectTree = pointTree(point);
    if (!projectTree) continue;
    const attempts = [tryPoint(tree, archive, projectTree, point)];
    // A single file is its own root; a pack may know it as a file in a folder
    // (`user_data.json` from a TikTok zip), so try it that way too, matched by name and aliases.
    if (tree.kind !== 'dir') attempts.push(tryPoint({ kind: 'dir', name: '', children: [tree] }, false, projectTree, point));
    for (const attempt of attempts) if (attempt.score > (best?.score ?? 0)) best = attempt;
  }
  return best?.result;
}
