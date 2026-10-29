/**
 * Table derivation: the tables participants see, derived from a project tree's decisions.
 *
 * See docs/tree-decisions.md#tables. Leaves go into their nearest table: a node marked as a
 * table, or, below no marked node, the nearest repeated node (an implicit table). A table's
 * rows are its repeated node: list items (`[*]`) or the entries of a collapsed map (`{*}`).
 * Lists between a row and a leaf become list cells; tables inside tables become nested tables,
 * shown in their parent as a count.
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
import { childrenOf, type TreeNode } from './tree';

export interface ColumnDef {
  /** Stable id within the table: the leaf's path from the row, joined with `/`. */
  id: string;
  /** The leaf's label, or the shortest unique suffix of its path from the row. */
  name: Localized;
  /** Path from the row to the leaf, or to the nested table's row for `table` columns. */
  path: NodePath;
  /** `value`: one value per row; `list`: a list cell; `table`: the number of nested rows. */
  type: 'value' | 'list' | 'table';
  /** For `donate` and `show` leaves; `table` columns are `show` or `donate` as their table. */
  state: Exclude<EffectiveState, 'ignore'>;
  /** For `list` columns: the default from the nearest repeated node's `unnest`. */
  unnest?: 'count' | 'longer' | 'wider';
  /** For `table` columns: the index of the nested table. */
  table?: number;
}

export interface TableDef {
  name: Localized;
  /** The node marked as a table, or the repeated node of an implicit table. */
  node: NodePath;
  /** The repeated node whose entries are rows. `undefined` for a single record at `node`. */
  rows?: NodePath;
  /** True if no node is marked as a table here. */
  implicit: boolean;
  /** Index of the parent table, for nested tables. */
  parent?: number;
  state: Exclude<EffectiveState, 'ignore'>;
  columns: ColumnDef[];
}

const isRepeated = (name: string) => name === ITEM_NAME || name === COLLAPSED_NAME;
const startsWith = (path: NodePath, prefix: NodePath) =>
  prefix.length <= path.length && prefix.every((name, i) => path[i] === name);

/** The shallowest repeated node below `node`, inclusive; ties go to the first child. */
function rowsBelow(node: ProjectNode, path: NodePath): NodePath | undefined {
  let level: { node: ProjectNode; path: NodePath }[] = [{ node, path }];
  while (level.length > 0) {
    const found = level.find((n) => isRepeated(n.node.name) && n.path.length > 0);
    if (found) return found.path;
    level = level.flatMap((n) =>
      isLeaf(n.node) ? [] : (n.node.children ?? []).map((c) => ({ node: c, path: [...n.path, c.name] })),
    );
  }
  return undefined;
}

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
    if (!changed) return names;
  }
}

/** The path of a table's rows; a table without repeated rows is one record at its node. */
function rowsOf(table: TableDef): NodePath {
  return table.rows ?? table.node;
}

/**
 * The node an implicit table is named after: the nearest one that is not a repeated item and
 * not HTML structure (`div.mdl-grid`), so a table in an HTML file is named after the file.
 */
function nameSource(chain: ProjectNode[]): ProjectNode | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i]!;
    const parent = chain[i - 1];
    const markup = n.kind === 'element' || (n.kind === 'list' && n.children?.some((c) => c.kind === 'element'));
    if (n.label !== undefined) return n;
    if (isRepeated(n.name) || (markup && parent !== undefined && parent.kind !== 'dir')) continue;
    return n;
  }
  return undefined;
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
  const tables: TableDef[] = [
    { name: labelOr(root, ''), node: [], implicit: true, state: 'show', columns: [] },
  ];
  const leafPaths = new Map<number, NodePath[]>();
  const visit = (node: ProjectNode, path: NodePath, ancestors: ProjectNode[], current: number) => {
    const state = states.get(node)!;
    if (state === 'ignore') return;
    let table = current;
    const explicit = node.table === true;
    // Implicit tables only where no marked table is above.
    const insideMarked = !tables[current]!.implicit;
    const implicit = !explicit && !insideMarked && isRepeated(node.name) && !isLeaf(node);
    if (explicit || implicit) {
      // Nested only in a table whose rows it is below.
      let parent = current;
      while (parent !== 0 && !startsWith(path, rowsOf(tables[parent]!))) {
        parent = tables[parent]!.parent ?? 0;
      }
      const rows = explicit ? rowsBelow(node, path) : path;
      const named = nameSource([...ancestors, node]);
      tables.push({
        name: explicit ? labelOr(node, node.name) : labelOr(named ?? node, named?.name ?? ''),
        node: path,
        ...(rows ? { rows } : {}),
        implicit,
        ...(parent !== 0 ? { parent } : {}),
        state,
        columns: [],
      });
      table = tables.length - 1;
    }
    if (isLeaf(node)) {
      // A leaf above its table's rows (a table's own metadata) belongs to the table above.
      while (table !== 0 && !startsWith(path, rowsOf(tables[table]!))) {
        table = tables[table]!.parent ?? 0;
      }
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
    const names = suffixNames(relative);
    table.columns = leaves.map((leaf, i) => {
      const rel = relative[i]!;
      const node = nodeAt(leaf);
      // Repeated nodes between the row and the leaf make it a list cell.
      const lists: ProjectNode[] = [];
      for (let k = base.length; k < leaf.length; k++) {
        if (isRepeated(leaf[k]!)) lists.push(nodeAt(leaf.slice(0, k + 1)));
      }
      const column: ColumnDef = {
        id: rel.join('/'),
        name: labelOr(node, names[i]!),
        path: rel,
        type: lists.length > 0 ? 'list' : 'value',
        state: states.get(node) as ColumnDef['state'],
      };
      if (column.type === 'list') column.unnest = lists.at(-1)?.unnest ?? 'count';
      return column;
    });
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
        const matches = resolve(node, rowProject, column.path);
        if (column.type === 'table') continue;
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
