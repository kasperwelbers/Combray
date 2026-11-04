/**
 * Table derivation: the tables participants see, inferred from the structure.
 *
 * See docs/tree-decisions.md#tables. Every list of objects is a table: its items (`[*]`) are
 * the rows, and the leaves inside an item, however deeply nested in objects, are its columns.
 * A map whose keys are data (`{*}`) is a table too, with the key as a column. Tables inside a
 * table's rows are nested tables, shown in the parent as a count you can open; lists of plain
 * values stay as list cells. Nothing is unnested here: views unnest while they aggregate.
 * Leaves outside any table form a single record.
 */
import { applyTransform, convert, type FieldValue } from './importer/convert';
import type { FieldType, Localized, Transform } from './importer/spec';
import { test, type Cell } from './query';
import { isItemNode, isKeysNode } from './config';
import {
  effectiveStates,
  getNode,
  isLeaf,
  matchesPosition,
  type EffectiveState,
  type ProjectNode,
  type NodePath,
  type Role,
  type RowFilter,
} from './decisions';
import { COLLAPSED_NAME, elementName, ITEM_NAME, screenName } from './shape';
import { childrenOf, type TreeNode, type ValueType } from './tree';

export interface ColumnDef {
  /**
   * Stable id within the table: the id of the leaf's name, so nodes with the same name are one
   * column (ADR 0012); else the ids of the leaf's path from the row, joined with `/`. Nested
   * tables likewise: their name's id, or the path to their rows.
   */
  id: string;
  /**
   * The leaf's label, or the shortest unique suffix of its path from the row. Empty for the
   * key and the value of a `{*}` row, which the UI names.
   */
  name: Localized;
  /** Path from the row to the leaf, or to the nested table's rows for `table` columns. */
  path: NodePath;
  /** The leaf's path from the root (for `table` columns, the nested table's rows). */
  at: NodePath;
  /**
   * `value`: one value per row; `list`: a list of plain values; `table`: the number of nested
   * rows; `key`: the key of a `{*}` row.
   */
  type: 'value' | 'list' | 'table' | 'key';
  /** `table` columns are `show` or `donate` as their table. */
  state: Exclude<EffectiveState, 'ignore'>;
  /** For `table` columns: the index of the nested table. */
  table?: number;
  /** Inferred types and formats of the values (of the keys, for `key` columns). */
  types?: ValueType[];
  formats?: string[];
  /** Conversion, from the leaf: transforms, then `as` with `format`. */
  transform?: Transform[];
  as?: FieldType;
  format?: string;
  /** With a conversion: donate the value as it is in the file too. */
  raw?: true;
  role?: Role;
  /**
   * The name is only structure: no label, and every step is a position (`#cell[0]`,
   * `#text[1]`), an attribute (`@href`) or an HTML element. Such columns have no name worth
   * showing; tables leave their header empty.
   */
  unnamed?: true;
}

export interface TableDef {
  /**
   * Stable id: the id of the name of the node the table is named after, so tables with the same
   * name are one (ADR 0012, `groupTables`); else the ids of its rows' path joined with `/`; `''`
   * for the record of loose fields.
   */
  id: string;
  name: Localized;
  /** Where the table's rows are, as keys from the root: for people. */
  where: string[];
  /** The repeated node (`[*]` or `{*}`) whose entries are rows; the root for the record. */
  node: NodePath;
  /** Same as `node` for tables; `undefined` for the single record of loose fields. */
  rows?: NodePath;
  /** True for a `{*}` table, whose rows have a key. */
  keyed?: true;
  /** Index of the parent table, for nested tables. */
  parent?: number;
  state: Exclude<EffectiveState, 'ignore'>;
  columns: ColumnDef[];
  /** Conditions rows must meet to be imported, from the repeated node. */
  filter?: RowFilter[];
  /** The first row holds the column names (`ProjectNode.headerRow`): see `headerNames`. */
  headerRow?: true;
  /**
   * Columns filters need that the table does not show (an ignored "from ads" field): read to
   * test rows, never kept in them.
   */
  hidden?: ColumnDef[];
}

export const KEY_COLUMN = '{key}';
export const VALUE_COLUMN = '{value}';

const isRepeated = (name: string) => name === ITEM_NAME || name === COLLAPSED_NAME;

/** Shortest unique suffixes, over the names in each path without `[*]` and `{*}`. */
function suffixNames(paths: NodePath[]): string[] {
  const parts = paths.map((p) => {
    const named = p.filter((name) => !isRepeated(name));
    return named.length > 0 ? named : p;
  });
  const lengths = parts.map(() => 1);
  for (;;) {
    const names = parts.map((p, i) => p.slice(-lengths[i]!).join('/'));
    let changed = false;
    for (let i = 0; i < names.length; i++) {
      const clash = names.some((n, j) => j !== i && n === names[i]);
      if (clash && lengths[i]! < parts[i]!.length) {
        lengths[i]!++;
        changed = true;
      }
    }
    if (!changed) return shortened(names);
  }
}

/**
 * Element names in column names shortened to their tag and as few classes as keep the names
 * unique: `div.content-cell.mdl-cell.mdl-cell--6-col` becomes `div.content-cell`, or, next to
 * a `div.content-cell.mdl-cell.mdl-cell--12-col`, `div.mdl-cell--6-col`: the classes they do
 * not share.
 */
function shortened(names: string[]): string[] {
  const element = /^[a-z][a-z0-9]*(#[^./]+)?(\.[^./]+){2,}$/;
  const split = (segment: string) => {
    const [head, ...classes] = segment.split('.');
    return { head: head!, classes };
  };
  const short = names.map((name) =>
    name
      .split('/')
      .map((segment) => (element.test(segment) ? segment.split('.').slice(0, 2).join('.') : segment))
      .join('/'),
  );
  // Names that still collide keep, per element, the classes that tell them apart.
  const groups = new Map<string, number[]>();
  short.forEach((s, i) => groups.set(s, [...(groups.get(s) ?? []), i]));
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const parts = members.map((i) => names[i]!.split('/'));
    members.forEach((i, m) => {
      const own = parts[m]!;
      const distinct = own.map((segment, k) => {
        if (!element.test(segment)) return segment;
        const { head, classes } = split(segment);
        const others = parts.filter((_, o) => o !== m).map((p) => (p[k] ? split(p[k]!).classes : []));
        const kept = classes.filter((c) => others.some((o) => !o.includes(c)));
        return kept.length > 0 && kept.length < classes.length ? [head, ...kept].join('.') : short[i]!.split('/')[k]!;
      });
      short[i] = distinct.join('/');
    });
  }
  // Anything still the same is left in full.
  return short.map((s, i) => (short.some((o, j) => j !== i && o === s) ? names[i]! : s));
}

/** The path of a table's rows; a table without repeated rows is one record at its node. */
function rowsOf(table: TableDef): NodePath {
  return table.rows ?? table.node;
}

/**
 * The node a table is named after: the nearest one that is not a repeated item and not HTML
 * structure (`div.mdl-grid`), so a table in an HTML file is named after the file.
 */
function nameSource(chain: ProjectNode[]): ProjectNode | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i]!;
    const parent = chain[i - 1];
    const markup = n.kind === 'element' || (n.kind === 'list' && n.children?.some((c) => c.kind === 'element'));
    if (n.label !== undefined) return n;
    // HTML structure names a table only inside another table's rows (`a` links in a cell).
    const nested = chain.slice(0, i).some((c) => isRepeated(c.name));
    if (isRepeated(n.name) || (markup && parent !== undefined && parent.kind !== 'dir' && !nested)) continue;
    return n;
  }
  return undefined;
}

function valueInfo(types?: ValueType[], formats?: string[]): Pick<ColumnDef, 'types' | 'formats'> {
  return { ...(types ? { types } : {}), ...(formats ? { formats } : {}) };
}

/** The conversion settings of a leaf, for its column. */
function conversion(node: ProjectNode): Pick<ColumnDef, 'transform' | 'as' | 'format' | 'raw' | 'role'> {
  const out: Pick<ColumnDef, 'transform' | 'as' | 'format' | 'raw' | 'role'> = {};
  if (node.transform?.length) out.transform = node.transform;
  if (node.as) out.as = node.as;
  if (node.format) out.format = node.format;
  if (node.raw && (out.transform || out.as)) out.raw = true;
  if (node.role) out.role = node.role;
  return out;
}

/**
 * Whether the path from `base` to a leaf says nothing but structure: positions, attributes and
 * HTML elements (lists of repeated elements included), so a name made of it means nothing to
 * people. Keys from JSON or CSV, and header text that became a key, are names.
 */
function structuralPath(root: ProjectNode, base: NodePath, leaf: NodePath): boolean {
  for (let i = base.length; i < leaf.length; i++) {
    const node = getNode(root, leaf.slice(0, i + 1));
    const name = node?.name ?? '';
    if (name === ITEM_NAME || name === COLLAPSED_NAME || /^[#@]/.test(name)) continue;
    const parent = getNode(root, leaf.slice(0, i));
    if (node?.kind === 'element' || (node?.kind === 'list' && parent?.kind === 'element')) continue;
    return false;
  }
  return true;
}

function labelOr(node: ProjectNode, fallback: string): Localized {
  return node.label ?? fallback;
}

/** The names (keys) along a path of ids. */
function namesOf(root: ProjectNode, path: NodePath): string[] {
  const out: string[] = [];
  let node: ProjectNode | undefined = root;
  for (const id of path) {
    node = node?.children?.find((c) => c.id === id);
    out.push(node?.name ?? id);
  }
  return out;
}

/** The id of a table: its name's, or the path of its rows (`[]` for the record of loose fields). */
function tableId(named: ProjectNode | undefined, rows: NodePath | undefined): string {
  if (named?.nameId !== undefined) return named.nameId;
  return rows === undefined ? '' : rows.join('/');
}

/** All leaves below a table's rows (ignored ones too), not those of the tables nested in them. */
function leavesOfRows(rows: ProjectNode, path: NodePath): NodePath[] {
  const out: NodePath[] = [];
  const visit = (node: ProjectNode, p: NodePath) => {
    if (node !== rows && (isRepeated(node.name) && !isLeaf(node))) return;
    if (isLeaf(node)) {
      out.push(p);
      return;
    }
    for (const child of node.children ?? []) visit(child, [...p, child.id]);
  };
  visit(rows, path);
  return out;
}

/** The repeated nodes directly below a table's rows (ignored ones too): its nested tables. */
function nestedRowsOf(rows: ProjectNode, path: NodePath): NodePath[] {
  const out: NodePath[] = [];
  const visit = (node: ProjectNode, p: NodePath) => {
    if (node !== rows && isRepeated(node.name) && !isLeaf(node)) {
      out.push(p);
      return;
    }
    if (isLeaf(node)) return;
    for (const child of node.children ?? []) visit(child, [...p, child.id]);
  };
  visit(rows, path);
  return out;
}

/**
 * Derive the tables of a project tree. Ignored leaves are left out. Tables come in tree order,
 * parents before their nested tables. Tables and columns of nodes that share a name are not
 * joined here: see `groupTables`.
 */
export function deriveTables(root: ProjectNode): TableDef[] {
  const states = effectiveStates(root);
  // Table 0 is the record of leaves outside any table; it is dropped below if it stays empty.
  const tables: TableDef[] = [{ id: '', name: labelOr(root, ''), where: [], node: [], state: 'show', columns: [] }];
  const leafPaths = new Map<number, NodePath[]>();
  const visit = (node: ProjectNode, path: NodePath, ancestors: ProjectNode[], current: number) => {
    const state = states.get(node)!;
    if (state === 'ignore') return;
    let table = current;
    const keyed = node.name === COLLAPSED_NAME;
    if (keyed || (node.name === ITEM_NAME && !isLeaf(node))) {
      const named = nameSource([...ancestors, node]);
      tables.push({
        id: tableId(named, path),
        name: labelOr(named ?? node, named?.name ?? ''),
        where: namesOf(root, path),
        node: path,
        rows: path,
        ...(keyed ? { keyed: true as const } : {}),
        ...(current !== 0 ? { parent: current } : {}),
        state,
        columns: [],
        ...(node.filter?.length ? { filter: node.filter } : {}),
        ...(node.headerRow && node.name === ITEM_NAME ? { headerRow: true as const } : {}),
      });
      table = tables.length - 1;
    }
    if (isLeaf(node)) {
      leafPaths.set(table, [...(leafPaths.get(table) ?? []), path]);
      return;
    }
    for (const child of node.children ?? []) {
      visit(child, [...path, child.id], [...ancestors, node], table);
    }
  };
  visit(root, [], [], 0);
  if (!leafPaths.has(0)) {
    tables.shift();
    for (const t of tables) if (t.parent !== undefined) t.parent--;
    const shifted = [...leafPaths].map(([k, v]) => [k - 1, v] as const);
    leafPaths.clear();
    for (const [k, v] of shifted) leafPaths.set(k, v);
  } else {
    tables[0]!.state = (leafPaths.get(0) ?? []).some((p) => states.get(getNode(root, p)!) === 'donate')
      ? 'donate'
      : 'show';
  }

  const columnOf = (table: TableDef, leaf: NodePath, name: Localized, state: ColumnDef['state']): ColumnDef => {
    const base = rowsOf(table);
    const node = getNode(root, leaf)!;
    const rel = leaf.slice(base.length);
    const info = { ...valueInfo(node.types, node.formats), ...conversion(node) };
    // The value of a `{*}` row whose entries are plain values.
    if (rel.length === 0) return { id: VALUE_COLUMN, name: node.label ?? '', path: rel, at: leaf, type: 'value', state, ...info };
    return {
      id: node.nameId ?? rel.join('/'),
      name,
      path: rel,
      at: leaf,
      // A list of plain values below the row (`tags/[*]`) is a list cell.
      type: namesOf(root, leaf).slice(base.length).includes(ITEM_NAME) ? 'list' : 'value',
      state,
      ...info,
      ...(node.label === undefined && structuralPath(root, base, leaf) ? { unnamed: true as const } : {}),
    };
  };

  tables.forEach((table, index) => {
    const base = rowsOf(table);
    const nodeAt = (path: NodePath) => getNode(root, path)!;
    const leaves = leafPaths.get(index) ?? [];
    const relative = leaves.map((p) => namesOf(root, p).slice(base.length));
    const names = suffixNames(relative.filter((r) => r.length > 0));
    let named = 0;
    table.columns = leaves.map((leaf, i) => {
      const node = nodeAt(leaf);
      const name = relative[i]!.length === 0 ? '' : labelOr(node, names[named++]!);
      return columnOf(table, leaf, name, states.get(node) as ColumnDef['state']);
    });
    if (table.keyed) {
      const entry = nodeAt(base);
      const state: ColumnDef['state'] = entry.decision === 'donate' ? 'donate' : 'show';
      const map = nodeAt(base.slice(0, -1));
      const keys = { ...valueInfo(map.keyTypes, map.keyFormats), ...conversion(entry) };
      table.columns.unshift({ id: KEY_COLUMN, name: '', path: [], at: base, type: 'key', state, ...keys });
    }
    if (table.parent !== undefined) {
      const parent = tables[table.parent]!;
      const rel = rowsOf(table).slice(rowsOf(parent).length);
      parent.columns.push({
        // The nested table's name, or its path from the parent's rows.
        id: table.id === rowsOf(table).join('/') ? rel.join('/') : table.id,
        name: table.name,
        path: rel,
        at: rowsOf(table),
        type: 'table',
        state: table.state,
        table: index,
      });
    }
  });
  // Columns that filters need but the table does not show (an ignored "from ads" field).
  for (const table of tables) {
    if (!table.filter?.length || table.rows === undefined) continue;
    const rows = getNode(root, table.rows)!;
    const hidden: ColumnDef[] = [];
    for (const f of table.filter) {
      if (table.columns.some((c) => c.id === f.column)) continue;
      const leaf = leavesOfRows(rows, table.rows).find((p) => {
        const node = getNode(root, p)!;
        return (node.nameId ?? p.slice(table.rows!.length).join('/')) === f.column;
      });
      if (leaf) {
        hidden.push({ ...columnOf(table, leaf, '', 'show'), name: '' });
        continue;
      }
      // An ignored nested table: the filter tests how many rows it has (none: "not from ads").
      const nested = nestedRowsOf(rows, table.rows).find((p) => p.slice(table.rows!.length).join('/') === f.column);
      if (nested) hidden.push({ id: f.column, name: '', path: nested.slice(table.rows.length), at: nested, type: 'table', state: 'show' });
    }
    if (hidden.length > 0) table.hidden = hidden;
  }
  return tables;
}

/**
 * Join the tables of nodes that share a name into one (ADR 0012), with their rows one after the
 * other. Columns join by id: leaves with the same name are one column. Nested tables join when
 * their parents did. A column is requested when it is requested in any of the joined tables.
 */
export function groupTables(
  tables: TableDef[],
  rows: DerivedRow[][] = tables.map(() => []),
): { tables: TableDef[]; rows: DerivedRow[][] } {
  const out: TableDef[] = [];
  const outRows: DerivedRow[][] = [];
  const target: number[] = [];
  const offset: number[] = [];
  tables.forEach((table, i) => {
    const parent = table.parent === undefined ? undefined : target[table.parent];
    const g = table.id === '' ? -1 : out.findIndex((o) => o.id === table.id && o.parent === parent && o.keyed === table.keyed);
    if (g < 0) {
      out.push({ ...table, ...(parent !== undefined ? { parent } : {}), columns: table.columns.map((c) => ({ ...c })) });
      outRows.push([]);
      target[i] = out.length - 1;
    } else {
      const group = out[g]!;
      for (const column of table.columns) {
        const existing = group.columns.find((c) => c.id === column.id);
        if (!existing) group.columns.push({ ...column });
        else if (column.state === 'donate') existing.state = 'donate';
      }
      if (table.state === 'donate') group.state = 'donate';
      target[i] = g;
    }
    const into = target[i]!;
    offset[i] = outRows[into]!.length;
    for (const row of rows[i] ?? []) {
      outRows[into]!.push(
        row.parent === undefined ? { values: row.values } : { values: row.values, parent: offset[table.parent!]! + row.parent },
      );
    }
  });
  for (const table of out) {
    for (const column of table.columns) if (column.table !== undefined) column.table = target[column.table]!;
    // Two joined tables nested in the same parent are one column.
    const seen = new Set<number>();
    table.columns = table.columns.filter((c) => c.table === undefined || (!seen.has(c.table) && Boolean(seen.add(c.table))));
  }
  return { tables: out, rows: outRows };
}

/** A row: values by column id. `parent` is the index of the parent row, for nested tables. */
export interface DerivedRow {
  values: Record<string, unknown>;
  parent?: number;
  /** With `sources`: the row's own node in the tree, and the nodes each column's values are from. */
  node?: TreeNode;
  sources?: Record<string, TreeNode[]>;
}

/** Whether a tree child is the real position the project node `target` (below `parent`) matches. */
export function matchesChild(parent: ProjectNode, treeParent: TreeNode, child: TreeNode, target: ProjectNode): boolean {
  if (child.kind !== target.kind) return false;
  if (treeParent.kind === 'list') return isItemNode(target);
  if (parent.collapsed) return isKeysNode(target);
  const name = child.kind === 'element' ? elementName(child.name, child.attrs) : screenName(child.name);
  return matchesPosition(parent, target, child.kind, name) || (name !== child.name && matchesPosition(parent, target, child.kind, child.name));
}

/** All tree nodes under `node` that map to the project path `path`, relative to `projectNode`. */
function resolve(node: TreeNode, projectNode: ProjectNode, path: NodePath): TreeNode[] {
  if (path.length === 0) return [node];
  const [head, ...rest] = path;
  const target = projectNode.children?.find((c) => c.id === head);
  if (!target) return [];
  return childrenOf(node).flatMap((child) => {
    if (matchesChild(projectNode, node, child, target)) return resolve(child, target, rest);
    // A single element where other files have a list of them: the list's only item.
    if (target.kind === 'list' && child.kind === 'element') {
      const item = target.children?.find((c) => c.id === rest[0] && c.kind === 'element' && isItemNode(c));
      if (item && matchesPosition(projectNode, target, 'list', elementName(child.name, child.attrs))) return resolve(child, item, rest.slice(1));
    }
    return [];
  });
}

export function leafValue(node: TreeNode): unknown {
  switch (node.kind) {
    case 'value':
      return node.type === 'null' ? null : node.value;
    case 'text':
      return node.value;
    case 'blob':
      return { mime: node.mime, size: node.size };
    default:
      // A lifter's input; lifters run in the sandbox, not here.
      return null;
  }
}

/**
 * The values in a tree at a project path, as they are in the file (before any conversion), for the
 * studio's look at a field in the researcher's test packages. For a node whose keys are data
 * (`{*}`), the keys are its values.
 */
export function valuesAt(tree: TreeNode, root: ProjectNode, path: NodePath): unknown[] {
  return resolve(tree, root, path).map((node) => (isLeaf({ kind: node.kind }) ? leafValue(node) : node.name));
}

/** A value converted as its column says: transforms, then `as`. Unconverted columns pass through. */
export function convertValue(value: unknown, column: Pick<ColumnDef, 'transform' | 'as' | 'format'>): unknown {
  if (!column.transform && !column.as) return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  let out = value as FieldValue;
  for (const t of column.transform ?? []) out = applyTransform(out, t);
  return column.as ? convert(out, column.as, column.format) : out;
}

/**
 * Whether a row meets every filter of its table. A filter on a column the table lacks fails,
 * so a filter that no longer fits the structure imports nothing rather than everything.
 */
function keeps(table: TableDef, values: Record<string, unknown>): boolean {
  return (table.filter ?? []).every((f) => {
    if (!(f.column in values)) return false;
    return test((values[f.column] ?? null) as Cell, f.test) !== (f.not === true);
  });
}

export interface DeriveOptions {
  /** Keep values as in the file: no conversions, no row filters. */
  raw?: boolean;
  /** Keep where each value is from (`DerivedRow.node` and `sources`), for donations. */
  sources?: boolean;
}

/**
 * The rows of every derived table for one participant's tree, matched through the project
 * tree (matches, `[*]` and `{*}`). The tree's root name is ignored. Values
 * are converted as their columns say, and rows that do not meet their table's filters are
 * left out, with the rows nested in them.
 */
export function deriveRows(
  tree: TreeNode,
  root: ProjectNode,
  tables: TableDef[],
  options: DeriveOptions = {},
): DerivedRow[][] {
  const out: DerivedRow[][] = tables.map(() => []);
  // Tree nodes of each table's rows, so nested tables can find their parent row.
  const rowNodes: TreeNode[][] = tables.map(() => []);
  tables.forEach((table, index) => {
    const rowPath = rowsOf(table);
    let candidates: { node: TreeNode; parent?: number }[];
    if (table.parent === undefined) {
      candidates = resolve(tree, root, rowPath).map((node) => ({ node }));
    } else {
      const parentTable = tables[table.parent]!;
      const parentPath = rowsOf(parentTable);
      const parentNode = getNode(root, parentPath)!;
      candidates = rowNodes[table.parent]!.flatMap((node, parent) =>
        resolve(node, parentNode, rowPath.slice(parentPath.length)).map((n) => ({ node: n, parent })),
      );
    }
    const rowProject = getNode(root, rowPath)!;
    const filtered = new Set(options.raw ? [] : (table.filter ?? []).map((f) => f.column));
    const columns = [...table.columns, ...(options.raw ? [] : (table.hidden ?? []))];
    for (const { node, parent } of candidates) {
      const values: Record<string, unknown> = {};
      const sources: Record<string, TreeNode[]> = {};
      for (const column of columns) {
        let value: unknown;
        if (column.type === 'table') {
          // Nested counts are filled in below; a filter on one needs it now.
          if (!filtered.has(column.id)) continue;
          value = resolve(node, rowProject, column.path).length;
        } else if (column.type === 'key') value = node.name;
        else {
          const matches = resolve(node, rowProject, column.path);
          value = column.type === 'list' ? matches.map(leafValue) : matches.length > 0 ? leafValue(matches[0]!) : null;
          if (options.sources) sources[column.id] = column.type === 'list' ? matches : matches.slice(0, 1);
        }
        values[column.id] = options.raw ? value : convertValue(value, column);
      }
      if (!options.raw && !keeps(table, values)) continue;
      for (const column of table.hidden ?? []) delete values[column.id];
      rowNodes[index]!.push(node);
      const row: DerivedRow = parent === undefined ? { values } : { values, parent };
      if (options.sources) Object.assign(row, { node, sources });
      out[index]!.push(row);
    }
  });
  // Counts of nested rows per parent row.
  tables.forEach((table, index) => {
    if (table.parent === undefined) return;
    const column = tables[table.parent]!.columns.find((c) => c.table === index)!;
    const counts = new Map<number, number>();
    for (const row of out[index]!) counts.set(row.parent!, (counts.get(row.parent!) ?? 0) + 1);
    out[table.parent]!.forEach((row, i) => (row.values[column.id] = counts.get(i) ?? 0));
  });
  return out;
}

/** A table in the researcher's outline: its fields, and the tables nested in its rows. */
export interface OutlineGroup {
  /** The table's id (`TableDef.id`): groups with the same id are one table for participants. */
  id: string;
  /** The repeated node whose entries are rows; `[]` for the fields outside any table. */
  path: NodePath;
  name: Localized;
  keyed?: true;
  fields: { path: NodePath; name: Localized }[];
  groups: OutlineGroup[];
}

/**
 * The project tree as tables and fields only, ignored ones included: what a researcher needs
 * to pick data, without the objects and HTML structure in between. Fields are named as their
 * columns would be (labels, or the shortest unique suffix of their path).
 */
export function outline(root: ProjectNode): OutlineGroup {
  const top: OutlineGroup = { id: '', path: [], name: labelOr(root, ''), fields: [], groups: [] };
  const leaves = new Map<OutlineGroup, NodePath[]>();
  const visit = (node: ProjectNode, path: NodePath, ancestors: ProjectNode[], group: OutlineGroup) => {
    let current = group;
    if (node.name === COLLAPSED_NAME || (node.name === ITEM_NAME && !isLeaf(node))) {
      const named = nameSource([...ancestors, node]);
      current = {
        id: tableId(named, path),
        path,
        name: labelOr(named ?? node, named?.name ?? ''),
        ...(node.name === COLLAPSED_NAME ? { keyed: true as const } : {}),
        fields: [],
        groups: [],
      };
      group.groups.push(current);
    }
    if (isLeaf(node)) {
      leaves.set(current, [...(leaves.get(current) ?? []), path]);
      return;
    }
    for (const child of node.children ?? []) visit(child, [...path, child.id], [...ancestors, node], current);
  };
  visit(root, [], [], top);
  const name = (group: OutlineGroup) => {
    const paths = leaves.get(group) ?? [];
    const relative = paths.map((p) => namesOf(root, p).slice(group.path.length));
    const names = suffixNames(relative.filter((r) => r.length > 0));
    let named = 0;
    group.fields = paths.map((path, i) => {
      const node = getNode(root, path)!;
      return { path, name: relative[i]!.length === 0 ? (node.label ?? '') : labelOr(node, names[named++]!) };
    });
    group.groups.forEach(name);
  };
  name(top);
  return top;
}

/** Header text longer than this is cut: a column name, not a paragraph. */
const MAX_HEADER_NAME = 80;

/**
 * Column names read from the first row of a table whose rows say so (`headerRow`): the text of
 * each value column, for columns without a label (a label is the researcher's own name and
 * wins). Empty and non-text cells give no name. Only for showing the table: the row itself
 * stays in the data.
 */
export function headerNames(root: ProjectNode, table: TableDef, first: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  for (const column of table.columns) {
    if (column.type !== 'value' || getNode(root, column.at)?.label !== undefined) continue;
    const value = first[column.id];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_HEADER_NAME);
    if (text) names.set(column.id, text);
  }
  return names;
}
