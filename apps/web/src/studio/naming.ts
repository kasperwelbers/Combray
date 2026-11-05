/**
 * Names in the tree editor (docs/plans/2026-11-05-researcher-experience.md): every matched part
 * has a name. It is its own name (a `Name`, which participants see and donations are exported
 * with) or, until it gets one, its key. Parts nothing matches are "not matched". Matching a part
 * gives it a name and a decision in one step; giving it a name another part already has asks
 * whether it is the same data (merge into that node) or only the same name (a node of its own).
 */
import {
  combineNodes,
  createName,
  getNode,
  isDecidable,
  isItemNode,
  isKeysNode,
  materialise,
  matchText,
  nodesNamed,
  setDecision,
  setName,
  type LeafDecision,
  type Name,
  type NodePath,
  type ProjectNode,
} from '@combray/core';

import { displayName } from './model';

/** The name a row shows: its own name, else its key (list items and keys that are data in words). */
export function rowName(node: ProjectNode, names: readonly Name[], t: (key: string) => string): string {
  const own = node.nameId === undefined ? undefined : names.find((n) => n.id === node.nameId);
  return own?.text || displayName(node.name, t);
}

/**
 * The keys a row matched, when they say more than its name: other keys, or several. A config node
 * nothing matched yet shows what it would match.
 */
export function keysBehind(node: ProjectNode, shown: string): string[] {
  const keys = node.keys?.length ? node.keys : node.match.map(matchText);
  return keys.length === 1 && keys[0] === shown ? [] : keys;
}

/** List items and keys that are data are named by their list or map, not on their own. */
export const isPositional = (node: ProjectNode) => isItemNode(node) || isKeysNode(node);

/** What giving a part a name that exists already would join it to. */
export interface NameTaken {
  /** A node next to this one with that name, of the same kind: the two can be merged into one node. */
  sibling?: NodePath;
  /** The name to share, if it exists as a name of its own (rather than a key). */
  nameId?: string;
  /** How many parts have the name. */
  count: number;
}

/**
 * Whether `text` is already the name of another part, and what this one could be joined to.
 * Names are compared as written, ignoring case and the space around them.
 */
export function nameTaken(tree: ProjectNode, path: NodePath, names: readonly Name[], text: string, t: (key: string) => string): NameTaken | undefined {
  const wanted = text.trim().toLowerCase();
  const node = getNode(tree, path);
  if (!node || wanted === '') return undefined;
  const same = (n: ProjectNode) => n !== node && !n.virtual && !isPositional(n) && rowName(n, names, t).trim().toLowerCase() === wanted;
  const parent = getNode(tree, path.slice(0, -1));
  const sibling = (parent?.children ?? []).find((c) => same(c) && c.kind === node.kind);
  const named = names.find((n) => n.id !== node.nameId && n.text.trim().toLowerCase() === wanted);
  const count = named ? nodesNamed(tree, named.id).length : sibling ? 1 : 0;
  if (!sibling && !named) return undefined;
  return {
    ...(sibling ? { sibling: [...path.slice(0, -1), sibling.id] } : {}),
    ...(named ? { nameId: named.id } : sibling?.nameId ? { nameId: sibling.nameId } : {}),
    count: Math.max(count, 1),
  };
}

/** What the match dialog asks for. */
export interface MatchChoice {
  text: string;
  /** For a name another part has: the same data (merge) or only the same name (own node). */
  join?: 'merge' | 'same-name';
  /** A name this part shares with others: change it for all of them (default), or give this part its own. */
  renameAll?: boolean;
  decision?: LeafDecision;
}

/**
 * Match a part (making it real when nothing matched it), give it the chosen name, and set its
 * decision. Returns the new tree and names, and where the part is now.
 */
export function saveMatch(
  tree: ProjectNode,
  names: readonly Name[],
  path: NodePath,
  choice: MatchChoice,
  t: (key: string) => string,
): { tree: ProjectNode; names: Name[]; path: NodePath } {
  let nextNames = [...names];
  const text = choice.text.trim();
  const taken = nameTaken(tree, path, names, text, t);
  let { tree: next, path: at } = materialise(tree, path);

  if (taken && choice.join === 'merge' && taken.sibling) {
    // The same data: one node with both matches, the other's settings first.
    const target = getNode(tree, taken.sibling)!;
    const real = materialise(next, [...at.slice(0, -1), target.id]);
    const combined = combineNodes(real.tree, [real.path, [...real.path.slice(0, -1), at.at(-1)!]]);
    next = combined.tree;
    at = combined.path;
  } else if (taken) {
    // The same name, a node of its own: share the name, made one if it was only a key.
    let nameId = taken.nameId;
    if (nameId === undefined) {
      const name = createName(text);
      nextNames = [...nextNames, name];
      nameId = name.id;
      if (taken.sibling) next = setName(next, [[...at.slice(0, -1), getNode(tree, taken.sibling)!.id]], nameId);
    }
    next = setName(next, [at], nameId);
  } else if (text !== '') {
    const node = getNode(next, at)!;
    const own = node.nameId === undefined ? undefined : nextNames.find((n) => n.id === node.nameId);
    const shared = own ? nodesNamed(next, own.id).length > 1 : false;
    if (own && (!shared || choice.renameAll !== false)) {
      if (own.text !== text) nextNames = nextNames.map((n) => (n.id === own.id ? { ...n, text } : n));
    } else if (own || text !== displayName(node.name, t)) {
      // A name of its own; the key needs none.
      const name = createName(text);
      nextNames = [...nextNames, name];
      next = setName(next, [at], name.id);
    }
  }

  const node = getNode(next, at);
  if (node && choice.decision !== undefined && (isDecidable(node) || choice.decision === 'ignore' || choice.decision === 'undecided')) {
    if ((node.decision ?? 'undecided') !== choice.decision) next = setDecision(next, at, choice.decision);
  }
  // A name nothing has any more is gone.
  return { tree: next, names: nextNames.filter((n) => nodesNamed(next, n.id).length > 0), path: at };
}

/**
 * Take a part out of the configuration: its settings and name go, and what it matched is not
 * matched again. Names nothing has any more are dropped.
 */
export function unmatch(tree: ProjectNode, names: readonly Name[], path: NodePath): { tree: ProjectNode; names: Name[] } {
  const copy = structuredClone(tree);
  const parent = getNode(copy, path.slice(0, -1));
  if (!parent || path.length === 0) return { tree, names: [...names] };
  parent.children = (parent.children ?? []).filter((c) => c.id !== path.at(-1));
  return { tree: copy, names: names.filter((n) => nodesNamed(copy, n.id).length > 0) };
}
