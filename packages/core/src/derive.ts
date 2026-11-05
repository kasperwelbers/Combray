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
import { defaultLabel, freeName, toName } from './names';
import { COLLAPSED_NAME, elementName, ITEM_NAME, screenName } from './shape';
import { childrenOf, type TreeNode, type ValueType } from './tree';

export interface ColumnDef {
  /**
   * The field's name, unique within the table (`treeNames`): leaves with the same name are one
   * column. A nested table's column is called by the nested table's name. `{key}` and `{value}`
   * for the key and value of a `{*}` row.
   */
  id: string;
  /**
   * What participants see: its label, else its name with spaces (`defaultLabel`). Empty for the
   * key and the value of a `{*}` row, which the UI names; the path for columns that are only
   * structure (`unnamed`), which the UI leaves out.
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
  format?: string | string[];
  /** With a conversion: donate the value as it is in the file too. */
  raw?: true;
  role?: Role;
  /**
   * The name is only structure: no label, and every step is a position (`#cell[0]`,
   * `#text[1]`), an attribute (`@href`) or an HTML element. Such columns have no name worth
   * showing; tables leave their header empty.
   */
  unnamed?: true;
  /**
   * Other leaves in the row with the same name, in order (`#2`, `#3`): when the first has no
   * value in a row, the next that has one gives it, read with its own conversion.
   */
  alternatives?: ColumnDef[];
}

export interface TableDef {
  /**
   * The table's name (`treeNames`), so tables with the same name are one (`groupTables`); `''`
   * for the record of loose fields.
   */
  id: string;
  /** What participants see: its label, else its name with spaces. */
  name: Localized;
  /** What it is, for participants, from the project's texts. */
  description?: Localized;
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
 * structure (`div.mdl-grid`), so a table in an HTML file is named after the file. A node with a
 * name of its own always is.
 */
function nameSource(chain: ProjectNode[]): ProjectNode | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i]!;
    const parent = chain[i - 1];
    const markup = n.kind === 'element' || (n.kind === 'list' && n.children?.some((c) => c.kind === 'element'));
    if (n.named !== undefined) return n;
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
  if (node.format !== undefined && node.format.length > 0) out.format = node.format;
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

// --- Names of tables and fields ----------------------------------------------------------------

/** File extensions left out of the names keys give (`watch-history.json` is `watch_history`). */
const EXTENSION = /\.(json|html?|csv|txt|js|xml)$/i;

/** The name a key gives by default (`names.ts`); `fallback` when nothing of it is left. */
export function keyName(key: string, fallback: string): string {
  return toName(key.replace(EXTENSION, '')) || fallback;
}

/** A table in `TreeNames`: where its rows are, what names it, and the table it is nested in. */
export interface NamedTable {
  /** The table's name: its own (`ProjectNode.named` of `source`), or the one its key gives. */
  id: string;
  /** The repeated node (`[*]` or `{*}`) whose entries are rows; `[]` for the record of loose fields. */
  rows: NodePath;
  /** The node the table is named after (it carries the name); none for the record. */
  source?: NodePath;
  /** The table it is nested in, by index; none for top-level tables and the record. */
  parent?: number;
  /** Whether the name is its own, rather than given by its key. */
  own: boolean;
}

/** A field in `TreeNames`: its table, and its name. */
export interface NamedField {
  id: string;
  /** Index of its table in `TreeNames.tables`. */
  table: number;
  /** The name its key would give it (shortest path that tells it apart in its table). */
  inferred: string;
  /** That shortest path as keys (`snippet/title`, `div.body/#text[0]`). */
  suffix: string;
  own: boolean;
}

/**
 * The names of every table and field of a project tree, ignored ones included, so ignoring a part
 * never renames another. A table or field with a name of its own (`named`) is called by it; the
 * rest by the name their key gives: for a field the shortest path from its row that tells it
 * apart (`snippet_title`), for a table the key it is named after (`watch_history`). Given names
 * never collide with names of their own: they get `_2` after them instead. Fields with the same
 * name of their own are one field; tables with the same name are one table when they are nested
 * in the same table (see `nameProblem`).
 */
export interface TreeNames {
  tables: NamedTable[];
  /** By the leaf's path, joined with `/`. */
  fields: Map<string, NamedField>;
}

export const pathKey = (path: NodePath) => path.join('/');

export function treeNames(root: ProjectNode): TreeNames {
  const found: { rows: NodePath; source?: NodePath; parent?: number; node?: ProjectNode }[] = [{ rows: [] }];
  const leaves = new Map<number, NodePath[]>();
  const visit = (node: ProjectNode, path: NodePath, chain: ProjectNode[], current: number) => {
    let table = current;
    if (node.name === COLLAPSED_NAME || (node.name === ITEM_NAME && !isLeaf(node))) {
      const source = nameSource([...chain, node]);
      const at = source === undefined ? -1 : chain.indexOf(source);
      found.push({
        rows: path,
        ...(source ? { source: at < 0 ? path : path.slice(0, at), node: source } : {}),
        ...(current !== 0 ? { parent: current } : {}),
      });
      table = found.length - 1;
    }
    if (isLeaf(node)) {
      leaves.set(table, [...(leaves.get(table) ?? []), path]);
      return;
    }
    for (const child of node.children ?? []) visit(child, [...path, child.id], [...chain, node], table);
  };
  visit(root, [], [], 0);

  // Tables: their own names first, so names given by keys stay clear of them.
  const taken = new Set(found.flatMap((t) => (t.node?.named !== undefined ? [t.node.named] : [])));
  const tables: NamedTable[] = found.map((t, i) => {
    const own = t.node?.named;
    const id = i === 0 ? '' : (own ?? freeName(keyName(t.node?.name ?? '', 'table'), taken));
    if (i > 0) taken.add(id);
    return { id, rows: t.rows, ...(t.source ? { source: t.source } : {}), ...(t.parent !== undefined ? { parent: t.parent } : {}), own: own !== undefined };
  });

  const fields = new Map<string, NamedField>();
  tables.forEach((table, index) => {
    const paths = leaves.get(index) ?? [];
    const relative = paths.map((p) => namesOf(root, p).slice(table.rows.length));
    const suffixes = suffixNames(relative.filter((r) => r.length > 0));
    const nodes = paths.map((p) => getNode(root, p)!);
    const used = new Set<string>([
      ...nodes.flatMap((n) => (n.named !== undefined ? [n.named] : [])),
      ...tables.filter((t) => t.parent === index).map((t) => t.id),
    ]);
    let s = 0;
    paths.forEach((path, i) => {
      if (relative[i]!.length === 0) {
        // The value of a `{*}` row whose entries are plain values.
        fields.set(pathKey(path), { id: VALUE_COLUMN, table: index, inferred: VALUE_COLUMN, suffix: '', own: false });
        return;
      }
      const suffix = suffixes[s++]!;
      const inferred = keyName(suffix.replaceAll('/', ' '), 'field');
      const own = nodes[i]!.named;
      const id = own ?? freeName(inferred, used);
      used.add(id);
      fields.set(pathKey(path), { id, table: index, inferred, suffix, own: own !== undefined });
    });
  });
  return { tables, fields };
}

/** How participants see tables and fields: labels from the project's texts (`texts.ts`). */
export interface Labels {
  /** A table's label, by its name; a field's, by its table's name and its own. */
  label(table: string, field?: string): Localized | undefined;
  /** One sentence about a table (or field), the same way. */
  description?(table: string, field?: string): Localized | undefined;
}

/**
 * Derive the tables of a project tree. Ignored leaves are left out. Tables come in tree order,
 * parents before their nested tables. Tables and columns of nodes that share a name are not
 * joined here: see `groupTables`. Without a label, a table or column is shown by its name
 * (`defaultLabel`).
 */
export function deriveTables(root: ProjectNode, labels?: Labels): TableDef[] {
  const states = effectiveStates(root);
  const names = treeNames(root);
  const tableIndex = new Map(names.tables.map((t, i) => [pathKey(t.rows), i]));
  const tableLabel = (id: string): Localized => (id === '' ? '' : (labels?.label(id) ?? defaultLabel(id)));
  // Table 0 is the record of leaves outside any table; it is dropped below if it stays empty.
  const tables: TableDef[] = [{ id: '', name: '', where: [], node: [], state: 'show', columns: [] }];
  const leafPaths = new Map<number, NodePath[]>();
  const visit = (node: ProjectNode, path: NodePath, current: number) => {
    const state = states.get(node)!;
    if (state === 'ignore') return;
    let table = current;
    const keyed = node.name === COLLAPSED_NAME;
    if (keyed || (node.name === ITEM_NAME && !isLeaf(node))) {
      const id = names.tables[tableIndex.get(pathKey(path))!]!.id;
      const description = labels?.description?.(id);
      tables.push({
        id,
        name: tableLabel(id),
        ...(description !== undefined ? { description } : {}),
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
    for (const child of node.children ?? []) visit(child, [...path, child.id], table);
  };
  visit(root, [], 0);
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

  const columnOf = (table: TableDef, leaf: NodePath, state: ColumnDef['state']): ColumnDef => {
    const base = rowsOf(table);
    const node = getNode(root, leaf)!;
    const rel = leaf.slice(base.length);
    const info = { ...valueInfo(node.types, node.formats), ...conversion(node) };
    const field = names.fields.get(pathKey(leaf))!;
    // The value of a `{*}` row whose entries are plain values.
    if (rel.length === 0) return { id: VALUE_COLUMN, name: '', path: rel, at: leaf, type: 'value', state, ...info };
    // Only structure (`#cell[0]`), and called by the name it gives: nothing worth showing.
    const unnamed = field.id === field.inferred && structuralPath(root, base, leaf);
    return {
      id: field.id,
      name: labels?.label(table.id, field.id) ?? (unnamed ? field.suffix : defaultLabel(field.id)),
      path: rel,
      at: leaf,
      // A list of plain values below the row (`tags/[*]`) is a list cell.
      type: namesOf(root, leaf).slice(base.length).includes(ITEM_NAME) ? 'list' : 'value',
      state,
      ...info,
      ...(unnamed ? { unnamed: true as const } : {}),
    };
  };

  tables.forEach((table, index) => {
    const columns: ColumnDef[] = [];
    for (const leaf of leafPaths.get(index) ?? []) {
      const column = columnOf(table, leaf, states.get(getNode(root, leaf)!) as ColumnDef['state']);
      // Fields with the same name in one row are one column: the first that has a value wins.
      const first = columns.find((c) => c.id === column.id);
      if (first) {
        first.alternatives = [...(first.alternatives ?? []), column];
        if (column.state === 'donate') first.state = 'donate';
      } else columns.push(column);
    }
    table.columns = columns;
    if (table.keyed) {
      const base = rowsOf(table);
      const entry = getNode(root, base)!;
      const state: ColumnDef['state'] = entry.decision === 'donate' ? 'donate' : 'show';
      const map = getNode(root, base.slice(0, -1))!;
      const keys = { ...valueInfo(map.keyTypes, map.keyFormats), ...conversion(entry) };
      table.columns.unshift({ id: KEY_COLUMN, name: '', path: [], at: base, type: 'key', state, ...keys });
    }
    if (table.parent !== undefined) {
      const parent = tables[table.parent]!;
      parent.columns.push({
        id: table.id,
        name: table.name,
        path: rowsOf(table).slice(rowsOf(parent).length),
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
      const leaf = leavesOfRows(rows, table.rows).find((p) => names.fields.get(pathKey(p))?.id === f.column);
      if (leaf) {
        hidden.push({ ...columnOf(table, leaf, 'show'), name: '' });
        continue;
      }
      // An ignored nested table: the filter tests how many rows it has (none: "not from ads").
      const nested = nestedRowsOf(rows, table.rows).find((p) => names.tables[tableIndex.get(pathKey(p)) ?? -1]?.id === f.column);
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
          // The first of the leaves with this name that is in the row (`alternatives`).
          let used = column;
          let matches = resolve(node, rowProject, column.path);
          for (const other of column.alternatives ?? []) {
            if (matches.length > 0) break;
            const found = resolve(node, rowProject, other.path);
            if (found.length > 0) [used, matches] = [other, found];
          }
          value = used.type === 'list' ? matches.map(leafValue) : matches.length > 0 ? leafValue(matches[0]!) : null;
          if (options.sources) sources[column.id] = used.type === 'list' ? matches : matches.slice(0, 1);
          values[column.id] = options.raw ? value : convertValue(value, used);
          continue;
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
  /** The table's name (`TableDef.id`): groups with the same name are one table for participants. */
  id: string;
  /** Whether the name is its own (else its key gives it). */
  own: boolean;
  /** The repeated node whose entries are rows; `[]` for the fields outside any table. */
  path: NodePath;
  /** The node the table is named after; none for the fields outside any table. */
  source?: NodePath;
  keyed?: true;
  fields: { path: NodePath; id: string; own: boolean }[];
  groups: OutlineGroup[];
}

/**
 * The project tree as tables and fields only, ignored ones included: what a researcher needs
 * to pick data, without the objects and HTML structure in between, by their names.
 */
export function outline(root: ProjectNode): OutlineGroup {
  const names = treeNames(root);
  const groups: OutlineGroup[] = names.tables.map((t) => ({
    id: t.id,
    own: t.own,
    path: t.rows,
    ...(t.source ? { source: t.source } : {}),
    ...(getNode(root, t.rows)?.name === COLLAPSED_NAME ? { keyed: true as const } : {}),
    fields: [],
    groups: [],
  }));
  names.tables.forEach((t, i) => {
    if (i > 0) groups[t.parent ?? 0]!.groups.push(groups[i]!);
  });
  for (const [key, field] of names.fields) {
    groups[field.table]!.fields.push({ path: key === '' ? [] : key.split('/'), id: field.id, own: field.own });
  }
  return groups[0]!;
}

/** Header text longer than this is cut: a column name, not a paragraph. */
const MAX_HEADER_NAME = 80;

/**
 * Column names read from the first row of a table whose rows say so (`headerRow`): the text of
 * each value column, unless it has a label or a name of its own other than the one its key
 * gives (the researcher's own words win). Empty and non-text cells give no name. Only for
 * showing the table: the row itself stays in the data.
 */
export function headerNames(root: ProjectNode, table: TableDef, first: Record<string, unknown>, labels?: Labels): Map<string, string> {
  const names = new Map<string, string>();
  const fields = treeNames(root).fields;
  for (const column of table.columns) {
    if (column.type !== 'value' || labels?.label(table.id, column.id) !== undefined) continue;
    const field = fields.get(pathKey(column.at));
    if (field && field.own && field.id !== field.inferred) continue;
    const value = first[column.id];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_HEADER_NAME);
    if (text) names.set(column.id, text);
  }
  return names;
}
