/**
 * Importing through a project tree (docs/tree-decisions.md): the root found in an upload
 * (`locateRoot`) is matched against the configuration of its upload point, and the tables
 * inferred from it are what the participant sees. Nested tables stay nested: their rows are
 * kept inside the parent row. Tables of nodes that share a name are one table (ADR 0012).
 *
 * Everything here runs in the data worker, on the participant's own data. Nothing is sent.
 */
import {
  buildTree,
  configOf,
  deriveRows,
  deriveTables,
  getNode,
  groupTables,
  headerNames,
  parseImporterFile,
  parseStructureFile,
  type ColumnDef,
  type DerivedRow,
  type FieldValue,
  type NodePath,
  type ProjectConfig,
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

/**
 * What an upload point imports through: the researcher's configuration, and the structures
 * the project has seen, which tell new parts (never seen) from parts nobody configured.
 */
export interface PointProject {
  config: ProjectConfig;
  seen: Shape;
  /** The configuration laid over the seen structures: for finding the root of an upload. */
  tree: ProjectNode;
}

const projects = new Map<string, PointProject>();
/** The study's own configurations, by upload point, with the files they were read from. */
const own = new Map<string, { files: string; project: PointProject }>();

function project(config: ProjectConfig, seen: Shape): PointProject {
  return { config, seen, tree: buildTree(config, seen).tree };
}

/**
 * The project of an upload point: the project's own, as published from the studio, or else the
 * bundled pack it names. Kept once built.
 */
export function pointProject(point: UploadPoint): PointProject | undefined {
  if (point.structure !== undefined && point.importer !== undefined) {
    // Read again when the study's settings changed since (they are fetched fresh to donate).
    const files = JSON.stringify([point.structure, point.importer]);
    if (own.get(point.id)?.files !== files) {
      try {
        const importer = parseImporterFile(point.importer);
        own.set(point.id, { files, project: project(configOf(importer), parseStructureFile(point.structure).root) });
      } catch {
        // A configuration the client cannot read: fall back to the pack, if there is one.
        own.delete(point.id);
      }
    }
    const found = own.get(point.id);
    if (found) return found.project;
  }
  const pack = packs.find((p) => p.id === point.pack);
  if (!pack) return undefined;
  if (!projects.has(pack.id)) projects.set(pack.id, { config: configOf(pack.importer), seen: pack.structure.root, tree: packTree(pack) });
  return projects.get(pack.id);
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

function columnInfo(column: ColumnDef, tables: TableDef[], tree: ProjectNode, added: Set<string>): ColumnInfo {
  const full = column.at;
  const isNew = full.some((_, i) => added.has(pathKey(full.slice(0, i + 1))));
  const info: ColumnInfo = { id: column.id, name: column.name, type: column.type, state: column.state };
  if (isNew) info.new = true;
  if (column.role) info.role = column.role;
  if (column.unnamed) info.unnamed = true;
  if (column.as === 'datetime' || column.as === 'url') info.as = column.as;
  if (column.type === 'table') {
    const nested = tables[column.table!]!;
    info.columns = nested.columns.map((c) => columnInfo(c, tables, tree, added));
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

/**
 * Drop the columns the researcher has not decided on (new parts included), in nested tables too,
 * and their values from the rows; a nested table left without columns goes as well. Returns the
 * columns that are left.
 */
function withoutUndecided(columns: ColumnInfo[], rows: Row[]): ColumnInfo[] {
  const kept: ColumnInfo[] = [];
  for (const column of columns) {
    if (column.type === 'table') {
      const nested = rows.flatMap((row) => (Array.isArray(row[column.id]) ? (row[column.id] as Row[]) : []));
      const inner = withoutUndecided(column.columns ?? [], nested);
      if (inner.length > 0) {
        kept.push({ ...column, columns: inner });
        continue;
      }
    } else if (!column.undecided) {
      kept.push(column);
      continue;
    }
    for (const row of rows) delete row[column.id];
  }
  return kept;
}

function anyColumn(columns: ColumnInfo[], test: (c: ColumnInfo) => boolean): boolean {
  return columns.some((c) => test(c) || anyColumn(c.columns ?? [], test));
}

/**
 * The tables of a root found for an upload point, `prepared` (normalised) as `locateRoot`
 * returns it. Parts the researcher has not decided on are left out, columns and values, unless
 * the tree's root says participants see them (`undecided: 'show'`); the raw data still has them.
 */
export function deriveImport(root: { prepared: TreeNode; shape: Shape }, project: PointProject, point: UploadPoint): DerivedImport {
  // The configuration over this participant's own structure. Parts nobody has configured are
  // there undecided, so participants can still see them; new parts too, except below nodes
  // that skip new children.
  const built = buildTree(project.config, root.shape, { seen: project.seen });
  const tree = built.tree;
  const added = new Set(freshPaths(tree, built.fresh).map(pathKey));
  // Tables of nodes that share a name are one table, with the rows of each.
  const ungrouped = deriveTables(tree);
  const { tables: defs, rows } = groupTables(ungrouped, deriveRows(root.prepared, tree, ungrouped));
  // Undecided parts are hidden unless the researcher lets participants see them.
  const hideUndecided = tree.undecided !== 'show';
  const nested = nest(defs, rows);
  const tables: DerivedImport['tables'] = [];
  defs.forEach((def, i) => {
    if (def.parent !== undefined || nested[i]!.length === 0) return;
    let columns = def.columns.map((c) => columnInfo(c, defs, tree, added));
    if (hideUndecided) {
      columns = withoutUndecided(columns, nested[i]!);
      if (columns.length === 0) return;
    }
    // The researcher says the first row holds the column names: shown as names, kept as data.
    let headerRow: Row | undefined;
    if (def.headerRow && nested[i]!.length > 0) {
      headerRow = nested[i]!.shift()!;
      const names = headerNames(tree, def, headerRow);
      columns = columns.map((c) => {
        const name = names.get(c.id);
        if (name === undefined) return c;
        const { unnamed: _unnamed, ...named } = c;
        return { ...named, name };
      });
    }
    const collection = anyColumn(columns, (c) => c.type !== 'table' && !c.undecided);
    const table: DerivedTable = {
      name: def.name,
      path: def.where,
      record: def.rows === undefined,
      collection,
      requested: def.state === 'donate',
      columns,
      display: displayOf(columns),
    };
    if (anyColumn(columns, (c) => c.new === true)) table.new = true;
    if (headerRow) table.headerRow = headerRow;
    tables.push({ table, rows: nested[i]! });
  });
  return { point, tables };
}

/** The paths of the fresh nodes in a tree. */
function freshPaths(tree: ProjectNode, fresh: Set<ProjectNode>): NodePath[] {
  const out: NodePath[] = [];
  const visit = (node: ProjectNode, path: NodePath) => {
    if (fresh.has(node)) out.push(path);
    for (const child of node.children ?? []) visit(child, [...path, child.id]);
  };
  visit(tree, []);
  return out;
}
