/**
 * Naming tables and fields in a project tree (docs/decisions/0013-names-labels-versions.md).
 *
 * Only tables and fields have names. A table is named on the node it is named after (the list or
 * file above its rows, `treeNames`), a field on its leaf. Within a table, fields with the same
 * name are one field; tables with the same name are one table, and may only share it when they
 * are nested in the same table (or both at the top). A name is unique otherwise, so a story or an
 * analysis can refer to a table by its name alone.
 */
import { isLeaf, getNode, materialise, DecisionError, type NodePath, type ProjectNode } from './decisions';
import { keyName, pathKey, treeNames, type TreeNames } from './derive';
import { isName, MAX_NAME } from './names';

export type NameKind = 'table' | 'field';

/** Whether a node is named as a table, as a field, or not at all (folders, objects, list items). */
export function nameKind(tree: ProjectNode, path: NodePath, names: TreeNames = treeNames(tree)): NameKind | undefined {
  const key = pathKey(path);
  if (names.fields.has(key) && path.length > 0) {
    const node = getNode(tree, path);
    // The value of a `{*}` row is named by its table.
    if (node && isLeaf(node) && names.fields.get(key)!.id !== '{value}') return 'field';
  }
  if (names.tables.some((t, i) => i > 0 && t.source !== undefined && pathKey(t.source) === key)) return 'table';
  return undefined;
}

/** The name a node is called by now: its own, or the one its key gives. */
export function currentName(tree: ProjectNode, path: NodePath, names: TreeNames = treeNames(tree)): string | undefined {
  const key = pathKey(path);
  const field = names.fields.get(key);
  if (field && nameKind(tree, path, names) === 'field') return field.id;
  return names.tables.find((t, i) => i > 0 && t.source !== undefined && pathKey(t.source) === key)?.id;
}

/** The tables named after a node (usually one). */
function tablesOf(names: TreeNames, path: NodePath): number[] {
  const key = pathKey(path);
  return names.tables.flatMap((t, i) => (i > 0 && t.source !== undefined && pathKey(t.source) === key ? [i] : []));
}

/**
 * The nodes that share a node's name, itself first: the fields with that name in its table, or
 * the nodes of the tables with that name in the same table. In the order of the tree, which is
 * the order in which they give a value (`#1` first).
 */
export function nameGroup(tree: ProjectNode, path: NodePath, names: TreeNames = treeNames(tree)): NodePath[] {
  const kind = nameKind(tree, path, names);
  if (kind === 'field') {
    const own = names.fields.get(pathKey(path))!;
    const out = [...names.fields].filter(([, f]) => f.table === own.table && f.id === own.id).map(([key]) => key.split('/'));
    return out;
  }
  if (kind === 'table') {
    const [first] = tablesOf(names, path);
    const table = names.tables[first!]!;
    const sources = names.tables
      .filter((t, i) => i > 0 && t.id === table.id && t.parent === table.parent && t.source !== undefined)
      .map((t) => pathKey(t.source!));
    return [...new Set(sources)].map((key) => (key === '' ? [] : key.split('/')));
  }
  return [];
}

/** Where a table is, for people: the name of the table it is nested in, or none at the top. */
function parentName(names: TreeNames, index: number): string | undefined {
  const parent = names.tables[index]!.parent;
  return parent === undefined ? undefined : names.tables[parent]!.id;
}

/**
 * Why a node cannot have this name, or undefined if it can. Names are lowercase letters, digits
 * and underscores. A field cannot be called like a table nested in its table; a table cannot have
 * the name of a table elsewhere (nested in another table), nor of a field next to it.
 */
export function nameProblem(tree: ProjectNode, path: NodePath, name: string, names: TreeNames = treeNames(tree)): string | undefined {
  if (name === '') return 'a name cannot be empty';
  if (name.length > MAX_NAME) return `a name has at most ${MAX_NAME} characters`;
  if (!isName(name)) return 'a name has lowercase letters, digits and underscores, and starts with a letter';
  const kind = nameKind(tree, path, names);
  if (kind === undefined) return 'only tables and fields have names';
  if (kind === 'field') {
    const own = names.fields.get(pathKey(path))!;
    if (names.tables.some((t) => t.parent === own.table && t.id === name)) return `a table in this table is called ${name}`;
    return undefined;
  }
  const mine = tablesOf(names, path);
  const parent = names.tables[mine[0]!]!.parent;
  const elsewhere = names.tables.findIndex((t, i) => i > 0 && !mine.includes(i) && t.id === name && t.parent !== parent);
  if (elsewhere > 0) {
    const where = parentName(names, elsewhere);
    return where === undefined ? `${name} is already the name of a table at the top` : `${name} is already used in the ${where} table`;
  }
  if (parent !== undefined && [...names.fields.values()].some((f) => f.table === parent && f.id === name)) {
    return `${parent === 0 ? 'a field' : `the ${names.tables[parent]!.id} table`} already has a field called ${name}`;
  }
  return undefined;
}

/** Give nodes a name, making them real first; `undefined` takes their own name off. */
export function setName(tree: ProjectNode, paths: NodePath[], name: string | undefined): ProjectNode {
  let current = tree;
  for (const path of paths) {
    const real = materialise(current, remapAfter(current, path));
    const node = getNode(real.tree, real.path)!;
    if (name === undefined) delete node.named;
    else node.named = name;
    current = real.tree;
  }
  return current;
}

/** A path in a tree that may have had other virtual nodes made real since: by ids, then by key. */
export function remapAfter(tree: ProjectNode, path: NodePath): NodePath {
  const out: NodePath = [];
  let node = tree;
  for (const id of path) {
    const next = node.children?.find((c) => c.id === id);
    if (!next) {
      // `~kind:key` became a config node matching that key.
      const [, kind, key] = /^~([a-z]+):(.*?)'*$/.exec(id) ?? [];
      // Below a group, files are matched by their kind.
      const real = node.children?.find((c) => c.kind === kind && (node.files !== undefined || c.match.some((m) => m === key)));
      if (!real) throw new DecisionError(`no node at ${path.join('/')}`);
      out.push(real.id);
      node = real;
    } else {
      out.push(next.id);
      node = next;
    }
  }
  return out;
}

/**
 * Rename a table or field. With `all` (the default) every node that shares its name gets the new
 * name, and the table's filters on a renamed field follow; without, only this node does (it is
 * split off from the others, who keep the name). Returns the new tree and what changed, for
 * updating the story (`renameInStory`).
 */
export function renameNode(
  tree: ProjectNode,
  path: NodePath,
  name: string,
  options: { all?: boolean } = {},
): { tree: ProjectNode; kind: NameKind; from: string; table?: string } {
  const names = treeNames(tree);
  const kind = nameKind(tree, path, names);
  const from = currentName(tree, path, names);
  if (kind === undefined || from === undefined) throw new DecisionError('only tables and fields have names');
  const problem = nameProblem(tree, path, name, names);
  if (problem) throw new DecisionError(problem);
  const all = options.all !== false;
  const group = all ? nameGroup(tree, path, names) : [path];
  let next = setName(tree, group, name);
  if (kind === 'field') {
    const own = names.fields.get(pathKey(path))!;
    const table = names.tables[own.table]!;
    // Filters on the field, on the rows of its table, follow it (when it still has the old name there).
    if (all && table.rows.length > 0) next = renameFilters(next, remapAfter(next, table.rows), from, name);
    return { tree: next, kind, from, ...(own.table > 0 ? { table: table.id } : { table: '' }) };
  }
  // A nested table's count is a column of its parent: filters on it follow too.
  const index = tablesOf(names, path)[0]!;
  const parent = names.tables[index]!.parent;
  if (all && parent !== undefined && parent > 0) next = renameFilters(next, remapAfter(next, names.tables[parent]!.rows), from, name);
  return { tree: next, kind, from };
}

function renameFilters(tree: ProjectNode, rows: NodePath, from: string, to: string): ProjectNode {
  const node = getNode(tree, rows);
  if (!node?.filter?.some((f) => f.column === from)) return tree;
  node.filter = node.filter.map((f) => (f.column === from ? { ...f, column: to } : f));
  return tree;
}

/**
 * Keep the names tables and fields are called by now: every table with a field that is shown or
 * donated or that a filter tests, and those fields, get the name their key gives them as a name
 * of their own (only real nodes; nothing is made real here). A name given by a key can change
 * when the structure does (a second `title` makes the first `snippet_title`); a name of its own
 * does not, so references in stories and filters keep working.
 */
export function keepNames(tree: ProjectNode): ProjectNode {
  const names = treeNames(tree);
  const copy = structuredClone(tree);
  const keep = new Set<number>();
  const fix = (path: NodePath, name: string) => {
    const node = getNode(copy, path);
    if (node && !node.virtual && node.named === undefined) node.named = name;
  };
  for (const [key, field] of names.fields) {
    if (field.own || field.id === '{value}') continue;
    const path = key.split('/');
    const node = getNode(tree, path);
    const table = names.tables[field.table]!;
    const filtered = getNode(tree, table.rows)?.filter?.some((f) => f.column === field.id) ?? false;
    if (!node || node.virtual || !(node.decision === 'show' || node.decision === 'donate' || filtered)) continue;
    fix(path, field.id);
    keep.add(field.table);
  }
  for (const [, field] of names.fields) if (field.own) keep.add(field.table);
  // The keys of a `{*}` table, shown or donated.
  names.tables.forEach((table, i) => {
    const rows = getNode(tree, table.rows);
    if (i > 0 && (rows?.decision === 'show' || rows?.decision === 'donate')) keep.add(i);
  });
  for (const index of keep) {
    for (let i: number | undefined = index; i !== undefined && i > 0; i = names.tables[i]!.parent) {
      const table = names.tables[i]!;
      if (!table.own && table.source) fix(table.source, table.id);
    }
  }
  return copy;
}

/** The name a node's key gives it, for a node that has none yet. */
export function nameOfKey(node: ProjectNode): string {
  return keyName(node.name, 'field');
}
