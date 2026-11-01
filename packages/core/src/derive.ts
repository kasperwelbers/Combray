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
import type { Localized } from './importer/spec';
import {
  effectiveStates,
  getNode,
  isLeaf,
  matchChild,
  type EffectiveState,
  type ProjectNode,
  type NodePath,
} from './decisions';
import { COLLAPSED_NAME, elementName, ITEM_NAME, screenName } from './shape';
import { childrenOf, type TreeNode, type ValueType } from './tree';

export interface ColumnDef {
  /** Stable id within the table: the leaf's path from the row, joined with `/`. */
  id: string;
  /**
   * The leaf's label, or the shortest unique suffix of its path from the row. Empty for the
   * key and the value of a `{*}` row, which the UI names.
   */
  name: Localized;
  /** Path from the row to the leaf, or to the nested table's rows for `table` columns. */
  path: NodePath;
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
}

export interface TableDef {
  name: Localized;
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

function labelOr(node: ProjectNode, fallback: string): Localized {
  return node.label ?? fallback;
}

/**
 * Derive the tables of a project tree. Ignored leaves are left out. Tables come in tree order,
 * parents before their nested tables.
 */
export function deriveTables(root: ProjectNode): TableDef[] {
  const states = effectiveStates(root);
  // Table 0 is the record of leaves outside any table; it is dropped below if it stays empty.
  const tables: TableDef[] = [{ name: labelOr(root, ''), node: [], state: 'show', columns: [] }];
  const leafPaths = new Map<number, NodePath[]>();
  const visit = (node: ProjectNode, path: NodePath, ancestors: ProjectNode[], current: number) => {
    const state = states.get(node)!;
    if (state === 'ignore') return;
    let table = current;
    const keyed = node.name === COLLAPSED_NAME;
    if (keyed || (node.name === ITEM_NAME && !isLeaf(node))) {
      const named = nameSource([...ancestors, node]);
      tables.push({
        name: labelOr(named ?? node, named?.name ?? ''),
        node: path,
        rows: path,
        ...(keyed ? { keyed: true as const } : {}),
        ...(current !== 0 ? { parent: current } : {}),
        state,
        columns: [],
      });
      table = tables.length - 1;
    }
    if (isLeaf(node)) {
      leafPaths.set(table, [...(leafPaths.get(table) ?? []), path]);
      return;
    }
    for (const child of node.children ?? []) {
      visit(child, [...path, child.name], [...ancestors, node], table);
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

  tables.forEach((table, index) => {
    const base = rowsOf(table);
    const nodeAt = (path: NodePath) => getNode(root, path)!;
    const leaves = leafPaths.get(index) ?? [];
    const relative = leaves.map((p) => p.slice(base.length));
    const names = suffixNames(relative.filter((r) => r.length > 0));
    let named = 0;
    table.columns = leaves.map((leaf, i) => {
      const rel = relative[i]!;
      const node = nodeAt(leaf);
      const state = states.get(node) as ColumnDef['state'];
      const info = valueInfo(node.types, node.formats);
      // The value of a `{*}` row whose entries are plain values.
      if (rel.length === 0) {
        return { id: VALUE_COLUMN, name: node.label ?? '', path: rel, type: 'value', state, ...info };
      }
      return {
        id: rel.join('/'),
        name: labelOr(node, names[named++]!),
        path: rel,
        // A list of plain values below the row (`tags/[*]`) is a list cell.
        type: rel.includes(ITEM_NAME) ? 'list' : 'value',
        state,
        ...info,
      };
    });
    if (table.keyed) {
      const entry = nodeAt(base);
      const state: ColumnDef['state'] = entry.decision === 'donate' ? 'donate' : 'show';
      const keys = valueInfo(nodeAt(base.slice(0, -1)).keyTypes, nodeAt(base.slice(0, -1)).keyFormats);
      table.columns.unshift({ id: KEY_COLUMN, name: '', path: [], type: 'key', state, ...keys });
    }
    if (table.parent !== undefined) {
      const parent = tables[table.parent]!;
      const rel = rowsOf(table).slice(rowsOf(parent).length);
      parent.columns.push({
        id: rel.join('/'),
        name: table.name,
        path: rel,
        type: 'table',
        state: table.state,
        table: index,
      });
    }
  });
  return tables;
}

/** A row: values by column id. `parent` is the index of the parent row, for nested tables. */
export interface DerivedRow {
  values: Record<string, unknown>;
  parent?: number;
}

/** The project node a tree child maps to, or undefined if the project tree does not know it. */
function projectChild(parent: ProjectNode, treeParent: TreeNode, child: TreeNode): ProjectNode | undefined {
  if (treeParent.kind === 'list') return matchChild(parent, child.kind, ITEM_NAME);
  if (parent.collapsed) return matchChild(parent, child.kind, COLLAPSED_NAME);
  const name = child.kind === 'element' ? elementName(child.name, child.attrs) : screenName(child.name);
  return matchChild(parent, child.kind, name) ?? matchChild(parent, child.kind, child.name);
}

/** All tree nodes under `node` that map to the project path `path`, relative to `projectNode`. */
function resolve(node: TreeNode, projectNode: ProjectNode, path: NodePath): TreeNode[] {
  if (path.length === 0) return [node];
  const [head, ...rest] = path;
  const target = projectNode.children?.find((c) => c.name === head);
  if (!target) return [];
  return childrenOf(node).flatMap((child) => {
    if (projectChild(projectNode, node, child) === target) return resolve(child, target, rest);
    // A single element where other files have a list of them: the list's only item.
    if (target.kind === 'list' && child.kind === 'element' && rest[0] === ITEM_NAME) {
      const item = target.children?.find((c) => c.name === ITEM_NAME && c.kind === 'element');
      if (item && elementName(child.name, child.attrs) === target.name) return resolve(child, item, rest.slice(1));
    }
    return [];
  });
}

function leafValue(node: TreeNode): unknown {
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
 * The rows of every derived table for one participant's tree, matched through the project
 * tree (canonical names, aliases, `[*]` and `{*}`). The tree's root name is ignored. Values
 * are as in the file; conversions are applied later.
 */
export function deriveRows(tree: TreeNode, root: ProjectNode, tables: TableDef[]): DerivedRow[][] {
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
    for (const { node, parent } of candidates) {
      const values: Record<string, unknown> = {};
      for (const column of table.columns) {
        if (column.type === 'table') continue;
        if (column.type === 'key') {
          values[column.id] = node.name;
          continue;
        }
        const matches = resolve(node, rowProject, column.path);
        values[column.id] =
          column.type === 'list' ? matches.map(leafValue) : matches.length > 0 ? leafValue(matches[0]!) : null;
      }
      rowNodes[index]!.push(node);
      out[index]!.push(parent === undefined ? { values } : { values, parent });
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
  const top: OutlineGroup = { path: [], name: labelOr(root, ''), fields: [], groups: [] };
  const leaves = new Map<OutlineGroup, NodePath[]>();
  const visit = (node: ProjectNode, path: NodePath, ancestors: ProjectNode[], group: OutlineGroup) => {
    let current = group;
    if (node.name === COLLAPSED_NAME || (node.name === ITEM_NAME && !isLeaf(node))) {
      const named = nameSource([...ancestors, node]);
      current = {
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
    for (const child of node.children ?? []) visit(child, [...path, child.name], [...ancestors, node], current);
  };
  visit(root, [], [], top);
  const name = (group: OutlineGroup) => {
    const paths = leaves.get(group) ?? [];
    const relative = paths.map((p) => p.slice(group.path.length));
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
