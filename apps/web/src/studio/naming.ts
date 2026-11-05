/**
 * Names in the tree editor (docs/decisions/0013-names-labels-versions.md). Tables and fields have
 * names: lowercase words joined by underscores, which stories, filters and donations refer to.
 * A table or field without a name of its own is called by the name its key gives (`treeNames`).
 * Other parts (folders, objects, list items) have no name; they are matched for their settings.
 *
 * Matching a part gives it a decision and, for a table or field, its name, in one step. Renaming
 * a name others share renames it for all of them (and the story follows), or splits this part
 * off (the story stays with the old name unless the researcher moves it along).
 */
import {
  combineNodes,
  currentName,
  getNode,
  isDecidable,
  isItemNode,
  isKeysNode,
  materialise,
  matchText,
  nameGroup,
  nameKind,
  pathKey as corePathKey,
  renameNode,
  setDecision,
  setName,
  treeNames,
  type LeafDecision,
  type NameKind,
  type NodePath,
  type ProjectNode,
  type TreeNames,
} from '@combray/core';

import { displayName } from './model';

/** The name a row shows: its own name, else its key (list items and keys that are data in words). */
export function rowName(node: ProjectNode, t: (key: string) => string): string {
  return node.named ?? displayName(node.name, t);
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

/** What a part is called, and who else is called so. */
export interface NameInfo {
  kind: NameKind;
  /** The name it is called by now: its own, or its key's. */
  name: string;
  own: boolean;
  /** The parts with this name (itself included), in the order they give a value. */
  group: NodePath[];
  /** Its place in `group`, from 1. */
  number: number;
}

export function nameInfo(tree: ProjectNode, path: NodePath, names: TreeNames = treeNames(tree)): NameInfo | undefined {
  const kind = nameKind(tree, path, names);
  const name = kind && currentName(tree, path, names);
  if (!kind || name === undefined) return undefined;
  const group = nameGroup(tree, path, names);
  const key = corePathKey(path);
  return { kind, name, own: getNode(tree, path)?.named !== undefined, group, number: group.findIndex((p) => corePathKey(p) === key) + 1 };
}

/** A part that shares its name: its number in the group, and the group's colour (an index). */
export interface SharedName {
  number: number;
  colour: number;
  name: string;
}

/** Groups of parts that share a name (two or more), by each part's path (`/`-joined). */
export function sharedNames(tree: ProjectNode): Map<string, SharedName> {
  const names = treeNames(tree);
  const out = new Map<string, SharedName>();
  let colour = 0;
  const visit = (node: ProjectNode, path: NodePath) => {
    const key = corePathKey(path);
    if (path.length > 0 && !out.has(key) && !node.virtual) {
      const group = nameGroup(tree, path, names);
      if (group.length > 1) {
        const name = currentName(tree, path, names)!;
        group.forEach((p, i) => out.set(corePathKey(p), { number: i + 1, colour, name }));
        colour++;
      }
    }
    for (const child of node.children ?? []) visit(child, [...path, child.id]);
  };
  visit(tree, []);
  return out;
}

/** Who else has a name a part could be given. */
export interface NameTaken {
  /** A node next to this one with that name, of the same kind: the two can be combined into one node. */
  sibling?: NodePath;
  /** The other parts with the name. */
  others: NodePath[];
  count: number;
}

/** Whether `name` is the name of other tables (or fields) this part would share it with. */
export function nameTaken(tree: ProjectNode, path: NodePath, name: string, names: TreeNames = treeNames(tree)): NameTaken | undefined {
  const node = getNode(tree, path);
  const kind = nameKind(tree, path, names);
  if (!node || !kind || name === '') return undefined;
  const key = corePathKey(path);
  let others: string[];
  if (kind === 'field') {
    const own = names.fields.get(key)!;
    others = [...names.fields].filter(([k, f]) => k !== key && f.table === own.table && f.id === name).map(([k]) => k);
  } else {
    const mine = names.tables.filter((t) => t.source && corePathKey(t.source) === key);
    const parent = mine[0]?.parent;
    others = [
      ...new Set(
        names.tables.filter((t) => t.source && corePathKey(t.source) !== key && t.id === name && t.parent === parent).map((t) => corePathKey(t.source!)),
      ),
    ];
  }
  if (others.length === 0) return undefined;
  const parentPath = path.slice(0, -1);
  const sibling = (getNode(tree, parentPath)?.children ?? []).find(
    (c) => c !== node && c.kind === node.kind && others.includes(corePathKey([...parentPath, c.id])),
  );
  return {
    ...(sibling ? { sibling: [...parentPath, sibling.id] } : {}),
    others: others.map((k) => (k === '' ? [] : k.split('/'))),
    count: others.length,
  };
}

/** What the match dialog asks for. */
export interface MatchChoice {
  /** The name, for a table or field. */
  name?: string;
  /** For a name another part next to it has: the same data (combine) or only the same name. */
  join?: 'combine' | 'same-name';
  /** A name this part shares with others: change it for all of them (default), or only this part's. */
  renameAll?: boolean;
  /** When only this part is renamed: move the story's references to it along. */
  moveReferences?: boolean;
  decision?: LeafDecision;
}

/** A name that changed, for updating the story (`renameInStory`). */
export interface Renamed {
  kind: NameKind;
  from: string;
  to: string;
  /** For a field: its table's name (`''` for fields outside any table). */
  table?: string;
  /** Whether the story's references follow. */
  references: boolean;
}

/**
 * Match a part (making it real when nothing matched it), give it the chosen name, and set its
 * decision. Returns the new tree, where the part is now, and the name that changed.
 */
export function saveMatch(tree: ProjectNode, path: NodePath, choice: MatchChoice): { tree: ProjectNode; path: NodePath; renamed?: Renamed } {
  const names = treeNames(tree);
  const info = nameInfo(tree, path, names);
  const wanted = choice.name?.trim();
  let { tree: next, path: at } = materialise(tree, path);
  let renamed: Renamed | undefined;

  if (info && wanted && wanted !== info.name) {
    const taken = nameTaken(tree, path, wanted, names);
    if (taken?.sibling && choice.join === 'combine') {
      // The same data: one node with both matches, the other's settings first.
      const target = getNode(tree, taken.sibling)!;
      const real = materialise(next, [...at.slice(0, -1), target.id]);
      const combined = combineNodes(real.tree, [real.path, [...real.path.slice(0, -1), at.at(-1)!]]);
      next = combined.tree;
      at = combined.path;
      renamed = { kind: info.kind, from: info.name, to: wanted, ...fieldTable(names, path, info.kind), references: info.group.length === 1 };
    } else {
      // A name the others only have by their key becomes theirs, so it stays when this part takes it.
      if (taken) next = setName(next, taken.others.filter((p) => getNode(tree, p)?.named === undefined), wanted);
      const all = choice.renameAll !== false || info.group.length === 1;
      const result = renameNode(next, at, wanted, { all });
      next = result.tree;
      renamed = {
        kind: result.kind,
        from: result.from,
        to: wanted,
        ...(result.table !== undefined ? { table: result.table } : {}),
        references: all || choice.moveReferences === true,
      };
    }
  }

  const node = getNode(next, at);
  if (node && choice.decision !== undefined && (isDecidable(node) || choice.decision === 'ignore' || choice.decision === 'undecided')) {
    if ((node.decision ?? 'undecided') !== choice.decision) next = setDecision(next, at, choice.decision);
  }
  return { tree: next, path: at, ...(renamed ? { renamed } : {}) };
}

function fieldTable(names: TreeNames, path: NodePath, kind: NameKind): { table?: string } {
  if (kind !== 'field') return {};
  const field = names.fields.get(corePathKey(path));
  return field ? { table: names.tables[field.table]!.id } : {};
}

/** Take a part out of the configuration: its settings and name go, and what it matched is not matched again. */
export function unmatch(tree: ProjectNode, path: NodePath): ProjectNode {
  const copy = structuredClone(tree);
  const parent = getNode(copy, path.slice(0, -1));
  if (!parent || path.length === 0) return tree;
  parent.children = (parent.children ?? []).filter((c) => c.id !== path.at(-1));
  return copy;
}
