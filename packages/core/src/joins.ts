/**
 * Joining and splitting real nodes (docs/decisions/0012-names-and-matches.md).
 *
 * - **Combine into one node:** siblings of the same kind become one config node with all their
 *   matches, for variants that need the same settings. Their children are one subtree.
 * - **Give the same name:** nodes keep their own settings and subtrees, and share a name, so
 *   participants see one table or column.
 *
 * Splitting is the reverse: take a match off a node (the real node it matched is unmatched again),
 * or give a node its own name. Every function returns a new tree; the input is not changed.
 */
import { isItemNode, isKeysNode, newId, sameMatch, SETTINGS, type ConfigNode, type Match, type Name } from './config';
import {
  buildTree,
  DecisionError,
  getNode,
  materialise,
  nodesAlong,
  toConfig,
  type NodePath,
  type ProjectNode,
} from './decisions';
import type { Shape } from './shape';

/** A setting both nodes have, set differently: the node combined into keeps its own. */
export interface JoinConflict {
  path: NodePath;
  field: string;
}

const siblingsOf = (paths: NodePath[]) => {
  const parents = new Set(paths.map((p) => JSON.stringify(p.slice(0, -1))));
  return parents.size === 1 && paths.every((p) => p.length > 0);
};

/**
 * Why these nodes cannot be combined into one, or undefined if they can: they must be two or
 * more siblings of the same kind, and not list items or keys that are data.
 */
export function combineProblem(tree: ProjectNode, paths: NodePath[]): string | undefined {
  if (paths.length < 2) return 'choose two or more rows';
  if (!siblingsOf(paths)) return 'only rows next to each other (with the same parent) can be combined';
  const nodes = paths.map((p) => getNode(tree, p));
  if (nodes.some((n) => !n)) return 'a row is gone';
  if (new Set(nodes.map((n) => n!.kind)).size > 1) return 'rows of different kinds cannot be one node; give them the same name instead';
  if (nodes.some((n) => isItemNode(n!) || isKeysNode(n!))) return 'list items and keys that are data are already one node';
  return undefined;
}

/** Fold `from` into `into`: matches, settings `into` lacks, and children, recursively. */
function fold(into: ConfigNode, from: ConfigNode, path: NodePath, conflicts: JoinConflict[]): void {
  for (const m of from.match) if (!into.match.some((x) => sameMatch(x, m))) into.match.push(m);
  for (const key of [...SETTINGS, 'nameId'] as const) {
    const value = from[key];
    if (value === undefined) continue;
    if (into[key] === undefined) (into as unknown as Record<string, unknown>)[key] = value;
    else if (JSON.stringify(into[key]) !== JSON.stringify(value)) conflicts.push({ path, field: key });
  }
  for (const child of from.children ?? []) {
    const twin = (into.children ?? []).find(
      (c) => c.kind === child.kind && c.match.some((m) => typeof m === 'string' && child.match.some((n) => sameMatch(m, n))),
    );
    if (twin) fold(twin, child, [...path, twin.id], conflicts);
    else into.children = [...(into.children ?? []), child];
  }
}

/**
 * Combine sibling nodes into one config node with all their matches (the first real one is
 * kept, with its id). Children with a key in common are combined the same way; where both set a
 * setting differently, the kept node's setting wins and the conflict is listed.
 */
export function combineNodes(tree: ProjectNode, paths: NodePath[]): { tree: ProjectNode; path: NodePath; conflicts: JoinConflict[] } {
  const problem = combineProblem(tree, paths);
  if (problem) throw new DecisionError(problem);
  const keep = paths.find((p) => !getNode(tree, p)!.virtual) ?? paths[0]!;
  const real = materialise(tree, keep);
  // Making the kept node real may have made its parents real too, with new ids.
  const parent = getNode(real.tree, real.path.slice(0, -1))!;
  const target = getNode(real.tree, real.path)!;
  // Work on the configuration: virtual nodes below come back from the structures.
  const targetConfig = toConfig(target);
  const conflicts: JoinConflict[] = [];
  const others = paths.filter((p) => p !== keep).map((p) => getNode(tree, p)!);
  for (const other of others) fold(targetConfig, toConfig(other), real.path, conflicts);
  const ids = new Set(others.map((o) => o.id));
  const combined = fromConfigDeep(targetConfig);
  parent.children = (parent.children ?? []).filter((c) => !ids.has(c.id)).map((c) => (c.id === target.id ? combined : c));
  return { tree: real.tree, path: real.path, conflicts };
}

/** A project node for a config subtree (no structure; the next `buildTree` adds it). */
function fromConfigDeep(config: ConfigNode): ProjectNode {
  const { children, ...rest } = config;
  const exact = config.match.find((m): m is string => typeof m === 'string');
  return {
    ...structuredClone(rest),
    name: exact ?? '',
    ...(children ? { children: children.map(fromConfigDeep) } : {}),
  };
}

/**
 * How many of the structures would have the combined node match two keys side by side, which
 * makes combining them wrong (ADR 0012, rule 5). Absence is no evidence: structures that have only
 * one of them do not count.
 */
export function combineConflicts(tree: ProjectNode, structures: readonly Shape[], paths: NodePath[]): number {
  if (combineProblem(tree, paths)) return 0;
  const { tree: combined, path } = combineNodes(tree, paths);
  const config = { root: toConfig(combined), names: [] };
  return structures.filter((shape) => {
    const built = buildTree(config, shape);
    const node = getNode(built.tree, path);
    return node !== undefined && built.conflicts.has(node);
  }).length;
}

/** Give nodes a name (an existing one's id), so participants see them as one; undefined takes it off. */
export function setName(tree: ProjectNode, paths: NodePath[], nameId: string | undefined): ProjectNode {
  let current = tree;
  for (const path of paths) {
    const real = materialise(current, remapAfter(current, path));
    const node = getNode(real.tree, real.path)!;
    if (nameId === undefined) delete node.nameId;
    else node.nameId = nameId;
    current = real.tree;
  }
  return current;
}

/** A path in a tree that may have had other virtual nodes made real since: by ids, then by key. */
function remapAfter(tree: ProjectNode, path: NodePath): NodePath {
  const out: NodePath = [];
  let node = tree;
  for (const id of path) {
    const next = node.children?.find((c) => c.id === id);
    if (!next) {
      // `~kind:key` became a config node matching that key.
      const [, kind, key] = /^~([a-z]+):(.*?)'*$/.exec(id) ?? [];
      const real = node.children?.find((c) => c.kind === kind && c.match.some((m) => m === key));
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

/** Add a match to a node (making it real first). Returns the tree and the node's path. */
export function addMatch(tree: ProjectNode, path: NodePath, match: Match): { tree: ProjectNode; path: NodePath } {
  const real = materialise(tree, path);
  const node = getNode(real.tree, real.path)!;
  if (isItemNode(node) || isKeysNode(node)) throw new DecisionError('list items and keys that are data have no other matches');
  if (!node.match.some((m) => sameMatch(m, match))) node.match = [...node.match, match];
  return real;
}

/**
 * Take a match off a node: the real node it matched is unmatched again. Taking off the last
 * match removes the node and its settings.
 */
export function removeMatch(tree: ProjectNode, path: NodePath, match: Match): ProjectNode {
  const copy = structuredClone(tree);
  const along = nodesAlong(copy, path);
  if (!along || path.length === 0) throw new DecisionError(`no node at ${path.join('/')}`);
  const node = along.at(-1)!;
  const parent = along.at(-2)!;
  node.match = node.match.filter((m) => !sameMatch(m, match));
  if (node.match.length === 0) parent.children = (parent.children ?? []).filter((c) => c !== node);
  return copy;
}

/** Copy a config subtree with new ids. */
function withNewIds(node: ProjectNode): ProjectNode {
  const { children, ...rest } = structuredClone(node);
  return { ...rest, ...(rest.virtual ? {} : { id: newId() }), ...(children ? { children: children.map(withNewIds) } : {}) };
}

/**
 * Split a node that matches several keys (a regular expression, or several matches) into one
 * node per key it matched, each with a copy of its settings and an exact match.
 */
export function splitByKey(tree: ProjectNode, path: NodePath): ProjectNode {
  const copy = structuredClone(tree);
  const along = nodesAlong(copy, path);
  if (!along || path.length === 0) throw new DecisionError(`no node at ${path.join('/')}`);
  const node = along.at(-1)!;
  const parent = along.at(-2)!;
  const keys = node.keys ?? [];
  if (keys.length < 2) return tree;
  const copies = keys.map((key) => ({ ...withNewIds(node), name: key, match: [key], keys: [key] }));
  parent.children = (parent.children ?? []).flatMap((c) => (c === node ? copies : [c]));
  return copy;
}

/** A new name with this text. */
export function createName(text: string): Name {
  return { id: newId(), text: text.trim() };
}

/** Paths of the nodes that have a name. */
export function nodesNamed(tree: ProjectNode, nameId: string): NodePath[] {
  const out: NodePath[] = [];
  const visit = (node: ProjectNode, path: NodePath) => {
    if (node.nameId === nameId) out.push(path);
    for (const child of node.children ?? []) visit(child, [...path, child.id]);
  };
  visit(tree, []);
  return out;
}
