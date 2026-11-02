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
  matchChild,
  mergeShape,
  normalizeTree,
  uploadRoot,
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

const trees = new Map<string, ProjectNode>();

/**
 * The tree of an upload point: its pack, for now. Projects get their own trees in Phase 2.
 * Kept once joined; matching an upload works on a copy (`mergeShape`).
 */
function pointTree(point: UploadPoint): ProjectNode | undefined {
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

/** The folders (canonical paths) in which a project tree knows a file of this name and kind. */
function placesFor(projectTree: ProjectNode, file: TreeNode): NodePath[] {
  const out: NodePath[] = [];
  const visit = (node: ProjectNode, path: NodePath) => {
    if (matchChild(node, file.kind, file.name)) out.push(path);
    for (const child of node.children ?? []) if (child.kind === 'dir') visit(child, [...path, child.name]);
  };
  visit(projectTree, []);
  return out;
}

const dir = (name: string, children: TreeNode[]): TreeNode => ({ kind: 'dir', name, children });

/** How many single folders below the root are also tried as the root (`takeout-…/Takeout/`). */
const MAX_UNWRAP = 3;

/**
 * The ways an upload may sit in a project tree, as nameless roots:
 * - as uploaded (an archive unwrapped from its one top folder);
 * - a folder holding just one folder, such as an unzipped Takeout (`takeout-…/Takeout/`), from
 *   that inner folder;
 * - a single file in each folder where the project knows a file by that name or an alias
 *   (`watch-history.json` in `YouTube and YouTube Music/history`).
 * File names are only compared here, in the worker; roots have no name.
 */
function roots(tree: TreeNode, archive: boolean, projectTree: ProjectNode): TreeNode[] {
  const root = uploadRoot(tree, archive);
  if (tree.kind !== 'dir') {
    const placed = placesFor(projectTree, tree).map((path) =>
      dir('', [path.reduceRight<TreeNode>((child, name) => dir(name, [child]), tree)]),
    );
    return [root, ...placed];
  }
  const out = [root];
  let node = root;
  for (let i = 0; i < MAX_UNWRAP && node.kind === 'dir' && node.children.length === 1; i++) {
    const only = node.children[0]!;
    if (only.kind !== 'dir') break;
    out.push({ ...only, name: '' });
    node = only;
  }
  return out;
}

/** Match a root against one upload point. The score is the number of rows in tables it knows. */
function tryPoint(root: TreeNode, projectTree: ProjectNode, point: UploadPoint): { result: DerivedImport; score: number } {
  // Header text from the participant's file only becomes a name when the project knows it.
  const prepared = normalizeTree(root, { keys: knownKeys(projectTree) });
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
    for (const root of roots(tree, archive, projectTree)) {
      const attempt = tryPoint(root, projectTree, point);
      if (attempt.score > (best?.score ?? 0)) best = attempt;
    }
  }
  return best?.result;
}
