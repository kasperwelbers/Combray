/**
 * Project trees: the union of the shapes a project has seen, with the researcher's decisions.
 *
 * See docs/tree-decisions.md. A project tree holds structure only, like a shape. Show and
 * donate are set on leaves, and on `{*}` nodes for their keys; other inner nodes can only be
 * ignored (which covers everything below them). An inner node's effective state is derived
 * from its leaves. Tables are not marked: they are inferred from the structure (derive.ts).
 */
import type { Localized } from './importer/spec';
import { globMatch } from './path';
import { COLLAPSED_NAME, countBucket, ITEM_NAME, mergeAll, type CountBucket, type Shape } from './shape';
import type { NodeKind, ValueType } from './tree';

export type LeafDecision = 'undecided' | 'ignore' | 'show' | 'donate';
export type EffectiveState = 'ignore' | 'show' | 'donate';

/** Another name for a node: a glob (`*` wildcard, `\*` literal star) or a regular expression. */
export type Alias = string | { regex: string; flags?: string };

export interface ProjectNode {
  kind: NodeKind;
  /** Canonical name, as in shapes: keys, `[*]` for list items, `{*}` for collapsed keys. */
  name: string;
  aliases?: Alias[];
  /**
   * `show` and `donate` on leaves, and on `{*}` nodes for their keys; `ignore` on any node.
   * Absent means undecided.
   */
  decision?: Exclude<LeafDecision, 'undecided'>;
  /**
   * Inner nodes only: a sandboxed function from this node's subtree to a map. The node then
   * counts as a leaf: its children are hidden from decisions and its one decision covers
   * every key the lifter outputs.
   */
  lifter?: string;
  /** Donated leaves only: donate the value as in the file instead of transformed. */
  raw?: true;
  label?: Localized;
  /** One participant-facing sentence, for donated leaves. */
  description?: Localized;
  /** Structure seen so far, as in shapes. */
  types?: ValueType[];
  count?: CountBucket;
  mime?: string;
  collapsed?: true;
  children?: ProjectNode[];
}

/** A position in a project tree: the canonical names from the root's children down. */
export type NodePath = string[];

export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionError';
  }
}

const LEAF_KINDS = new Set<NodeKind>(['value', 'text', 'blob']);

/** A value, text or blob, or an inner node with a lifter. */
export function isLeaf(node: { kind: NodeKind; lifter?: string }): boolean {
  return LEAF_KINDS.has(node.kind) || node.lifter !== undefined;
}

/**
 * Nodes with their own show or donate decision: leaves, and `{*}` nodes, whose keys are data
 * (the people who replied, the dates of a diary).
 */
export function isDecidable(node: { kind: NodeKind; name: string; lifter?: string }): boolean {
  return isLeaf(node) || node.name === COLLAPSED_NAME;
}

/** True if `name` is the node's canonical name or matches one of its aliases. */
export function nameMatches(node: ProjectNode, name: string): boolean {
  if (node.name === name) return true;
  return (node.aliases ?? []).some((alias) =>
    typeof alias === 'string'
      ? globMatch(alias, name)
      : new RegExp(alias.regex, alias.flags).test(name),
  );
}

/** The child of `parent` that a shape or tree node with this kind and name maps to. */
export function matchChild(
  parent: ProjectNode,
  kind: NodeKind,
  name: string,
): ProjectNode | undefined {
  // Below a map whose keys are data, every key is the one `{*}` position.
  if (parent.collapsed) name = COLLAPSED_NAME;
  const children = parent.children ?? [];
  // A canonical name wins over an alias of a sibling.
  return (
    children.find((c) => c.kind === kind && c.name === name) ??
    children.find((c) => c.kind === kind && nameMatches(c, name))
  );
}

/** Find a node by its canonical path. */
export function getNode(root: ProjectNode, path: NodePath): ProjectNode | undefined {
  let node: ProjectNode | undefined = root;
  for (const name of path) {
    node = node.children?.find((c) => c.name === name);
    if (!node) return undefined;
  }
  return node;
}

/** A value that was only ever null: in JSON, usually an empty map or list. */
const isNullOnly = (n: { kind: NodeKind; types?: ValueType[] }) =>
  n.kind === 'value' && n.types?.length === 1 && n.types[0] === 'null';

/**
 * Drop null-only values next to a node with the same name and another kind, so
 * `"subtitles": null` in one record and a list in another stay one node.
 */
function withoutNullTwins<T extends { kind: NodeKind; name: string; types?: ValueType[] }>(children: T[]): T[] {
  return children.filter(
    (c) => !isNullOnly(c) || !children.some((o) => o !== c && o.name === c.name && !isNullOnly(o)),
  );
}

/**
 * An element that is repeated in some places and single in others (one link in a row, or
 * several) is one node: the single element counts as the list's only item. Normalised HTML
 * names a list like its elements, so the two have the same name.
 */
function unifyElementTwins(shape: Shape): Shape {
  if (!shape.children) return shape;
  let children = shape.children.map(unifyElementTwins);
  for (const list of children.filter((c) => c.kind === 'list' && hasElementItems(c))) {
    const twin = children.find((c) => c.kind === 'element' && c.name === list.name);
    if (!twin) continue;
    const merged: Shape = { ...list, children: mergeAll([...(list.children ?? []), { ...twin, name: ITEM_NAME }]) };
    children = children.filter((c) => c !== twin).map((c) => (c === list ? merged : c));
  }
  return { ...shape, children };
}

const hasElementItems = (list: { children?: { kind: NodeKind; name: string }[] }) =>
  (list.children ?? []).some((i) => i.kind === 'element' && i.name === ITEM_NAME);

/** The list a single element belongs to as its only item, if the parent has one. */
function listTwin(parent: ProjectNode, kind: NodeKind, name: string): ProjectNode | undefined {
  if (kind !== 'element') return undefined;
  const list = parent.children?.find((c) => c.kind === 'list' && nameMatches(c, name));
  return list && matchChild(list, 'element', ITEM_NAME);
}

/** The single element a repeated element in a shape belongs to, if the parent has one. */
function elementTwin(parent: ProjectNode, shape: Shape): ProjectNode | undefined {
  if (shape.kind !== 'list' || !hasElementItems(shape)) return undefined;
  return parent.children?.find((c) => c.kind === 'element' && nameMatches(c, shape.name));
}

function fromShape(shape: Shape): ProjectNode {
  const node: ProjectNode = { kind: shape.kind, name: shape.name };
  if (shape.types) node.types = [...shape.types];
  if (shape.count) node.count = shape.count;
  if (shape.mime) node.mime = shape.mime;
  if (shape.collapsed) node.collapsed = true;
  if (shape.children) node.children = withoutNullTwins(shape.children).map(fromShape);
  return node;
}

/** A new project tree from a shape, with every node undecided. The root has no name. */
export function projectTreeFromShape(shape: Shape): ProjectNode {
  return { ...fromShape(unifyElementTwins(shape)), name: '' };
}

function toShape(node: ProjectNode): Shape {
  const shape: Shape = { kind: node.kind, name: node.name };
  if (node.types) shape.types = node.types;
  if (node.count) shape.count = node.count;
  if (node.mime) shape.mime = node.mime;
  if (node.collapsed) shape.collapsed = true;
  if (node.children) shape.children = node.children.map(toShape);
  return shape;
}

/** Fold what a shape says about structure (types, counts) into an existing node. */
function absorb(node: ProjectNode, shape: Shape): void {
  const own = toShape({ ...node, children: undefined });
  const merged = mergeAll([own, { ...shape, name: node.name, children: undefined }])[0]!;
  if (merged.types) node.types = merged.types;
  if (merged.count) node.count = merged.count;
  if (merged.mime) node.mime = merged.mime;
  if (merged.collapsed) node.collapsed = true;
}

/**
 * Add a shape to a project tree. Positions are matched by kind and by canonical name or
 * alias; new positions are added undecided. Returns the new tree and the paths of the added
 * subtrees (top-most only). The input tree is not changed.
 */
export function mergeShape(
  root: ProjectNode,
  shape: Shape,
): { tree: ProjectNode; added: NodePath[] } {
  const tree = structuredClone(root);
  const added: NodePath[] = [];
  const visit = (node: ProjectNode, s: Shape, path: NodePath) => {
    absorb(node, s);
    for (const child of s.children ?? []) {
      const match = matchChild(node, child.kind, child.name);
      if (match) {
        visit(match, child, [...path, match.name]);
        continue;
      }
      const item = listTwin(node, child.kind, child.name);
      if (item) {
        const list = node.children!.find((c) => c.children?.includes(item))!;
        visit(item, { ...child, name: ITEM_NAME }, [...path, list.name, ITEM_NAME]);
        continue;
      }
      const single = elementTwin(node, child);
      if (single) {
        // Seen once before, repeated now: the element becomes the list's item, with its decisions.
        const { aliases, ...rest } = single;
        const list: ProjectNode = {
          kind: 'list',
          name: single.name,
          ...(aliases ? { aliases } : {}),
          children: [{ ...rest, name: ITEM_NAME }],
        };
        node.children = node.children!.map((c) => (c === single ? list : c));
        visit(list, child, [...path, list.name]);
        continue;
      }
      const twins = (node.children ?? []).filter((c) => nameMatches(c, child.name));
      if (isNullOnly(child) && twins.length > 0) continue;
      const nullTwin = twins.find(isNullOnly);
      const others = (node.children ?? []).filter((c) => c !== nullTwin);
      const named = node.collapsed ? { ...child, name: COLLAPSED_NAME } : child;
      node.children = [...others, fromShape(named)];
      added.push([...path, named.name]);
    }
  };
  visit(tree, unifyElementTwins(shape), []);
  return { tree, added };
}

/**
 * Effective states of every node, keyed by node. Ignore covers everything below it. A leaf is
 * otherwise its own decision, with undecided shown. An inner node is donate if any leaf below
 * it is donate, else show if any leaf below it is shown, else ignore.
 */
export function effectiveStates(root: ProjectNode): Map<ProjectNode, EffectiveState> {
  const states = new Map<ProjectNode, EffectiveState>();
  const visit = (node: ProjectNode, ignored: boolean): EffectiveState => {
    let state: EffectiveState;
    if (ignored || node.decision === 'ignore') {
      state = 'ignore';
      for (const child of node.children ?? []) visit(child, true);
    } else if (isLeaf(node)) {
      state = node.decision ?? 'show';
      // Below a lifter, nodes are input to the lifter, not imported themselves.
      for (const child of node.children ?? []) visit(child, true);
    } else {
      // The keys of a `{*}` node are a field of their own, shown unless decided otherwise.
      state = node.name === COLLAPSED_NAME ? (node.decision ?? 'show') : 'ignore';
      for (const child of node.children ?? []) {
        const s = visit(child, false);
        if (s === 'donate') state = 'donate';
        else if (s === 'show' && state === 'ignore') state = 'show';
      }
    }
    states.set(node, state);
    return state;
  };
  visit(root, false);
  return states;
}

/** Paths of the leaves below `node` (inclusive) with an explicit show or donate decision. */
function decidedLeaves(node: ProjectNode, path: NodePath, out: NodePath[] = []): NodePath[] {
  if (isDecidable(node) && (node.decision === 'show' || node.decision === 'donate')) out.push(path);
  if (node.lifter !== undefined) return out;
  for (const child of node.children ?? []) decidedLeaves(child, [...path, child.name], out);
  return out;
}

/**
 * The show and donate decisions that ignoring this node would override, so the UI can warn
 * before it does.
 */
export function ignoreOverrides(root: ProjectNode, path: NodePath): NodePath[] {
  const node = getNode(root, path);
  if (!node) throw new DecisionError(`no node at ${path.join('/')}`);
  return decidedLeaves(node, path).filter((p) => p.length > path.length);
}

/**
 * Set a decision. `show` and `donate` are only allowed on leaves and `{*}` nodes. Decisions below an ignored
 * node are kept, so un-ignoring restores them; they have no effect while it is ignored.
 */
export function setDecision(root: ProjectNode, path: NodePath, decision: LeafDecision): ProjectNode {
  const tree = structuredClone(root);
  const node = getNode(tree, path);
  if (!node) throw new DecisionError(`no node at ${path.join('/')}`);
  if ((decision === 'show' || decision === 'donate') && !isDecidable(node)) {
    throw new DecisionError(`${decision} is only possible on leaves, not on ${node.kind} nodes`);
  }
  if (decision === 'undecided') delete node.decision;
  else node.decision = decision;
  return tree;
}

export interface MergeConflict {
  /** Path of the merged node, under the target. */
  path: NodePath;
  field: 'decision' | 'label' | 'description';
}

/**
 * Merge the node at `from` into the node at `into` (same kind, same parent not required):
 * `from`'s name and aliases become aliases of `into`, children merge recursively, and
 * `from` is removed. Where both sides set a property differently, `into` wins and the
 * conflict is listed for the researcher.
 */
export function mergeNodes(
  root: ProjectNode,
  from: NodePath,
  into: NodePath,
): { tree: ProjectNode; conflicts: MergeConflict[] } {
  if (from.length === 0 || into.length === 0) throw new DecisionError('cannot merge the root');
  if (into.length > from.length && from.every((name, i) => into[i] === name)) {
    throw new DecisionError('cannot merge a node into its own descendant');
  }
  const tree = structuredClone(root);
  const parent = getNode(tree, from.slice(0, -1));
  const source = getNode(tree, from);
  const target = getNode(tree, into);
  if (!parent || !source || !target) throw new DecisionError('no node at one of the paths');
  if (source === target) throw new DecisionError('cannot merge a node into itself');
  if (source.kind !== target.kind) {
    throw new DecisionError(`cannot merge a ${source.kind} node into a ${target.kind} node`);
  }
  const conflicts: MergeConflict[] = [];
  const combine = (src: ProjectNode, dst: ProjectNode, path: NodePath) => {
    if (src.name !== dst.name && !nameMatches(dst, src.name)) {
      dst.aliases = [...(dst.aliases ?? []), src.name];
    }
    for (const alias of src.aliases ?? []) {
      if (!(dst.aliases ?? []).some((a) => JSON.stringify(a) === JSON.stringify(alias))) {
        dst.aliases = [...(dst.aliases ?? []), alias];
      }
    }
    absorb(dst, toShape({ ...src, children: undefined }));
    for (const field of ['decision', 'label', 'description'] as const) {
      if (src[field] === undefined) continue;
      if (dst[field] === undefined) (dst as unknown as Record<string, unknown>)[field] = src[field];
      else if (JSON.stringify(dst[field]) !== JSON.stringify(src[field])) {
        conflicts.push({ path, field });
      }
    }
    for (const child of src.children ?? []) {
      const match = matchChild(dst, child.kind, child.name);
      if (match) combine(child, match, [...path, match.name]);
      else dst.children = [...(dst.children ?? []), child];
    }
  };
  combine(source, target, into);
  parent.children = parent.children!.filter((c) => c !== source);
  return { tree, conflicts };
}

export interface ShapeComparison {
  /** Top-most positions in the shape that the project tree does not know, with their shape. */
  unknown: { path: string[]; shape: Shape }[];
  /** Donated leaves in the project tree that this shape does not have. */
  missing: NodePath[];
}

/**
 * Compare a participant's shape with the project tree, locally. Unknown positions are the
 * candidates for the structure-metadata consent request; they are never donated. Ignored
 * subtrees are skipped: what is below an ignored node is never imported, so it is not asked
 * for either.
 */
export function compareShape(root: ProjectNode, shape: Shape): ShapeComparison {
  const unknown: ShapeComparison['unknown'] = [];
  const seen = new Set<ProjectNode>();
  const visit = (node: ProjectNode, s: Shape, path: string[]) => {
    seen.add(node);
    if (node.decision === 'ignore') return;
    for (const child of s.children ?? []) {
      const match = matchChild(node, child.kind, child.name);
      const item = match ? undefined : listTwin(node, child.kind, child.name);
      const single = match || item ? undefined : elementTwin(node, child);
      if (match) visit(match, child, [...path, child.name]);
      else if (item) visit(item, { ...child, name: ITEM_NAME }, [...path, child.name, ITEM_NAME]);
      else if (single) for (const i of child.children ?? []) visit(single, i, [...path, child.name]);
      else if (node.collapsed) {
        unknown.push({ path: [...path, COLLAPSED_NAME], shape: { ...child, name: COLLAPSED_NAME } });
      } else unknown.push({ path: [...path, child.name], shape: child });
    }
  };
  visit(root, unifyElementTwins(shape), []);
  const states = effectiveStates(root);
  const missing: NodePath[] = [];
  const findMissing = (node: ProjectNode, path: NodePath) => {
    const donated = isLeaf(node)
      ? states.get(node) === 'donate'
      : node.name === COLLAPSED_NAME && node.decision === 'donate' && states.get(node) !== 'ignore';
    if (donated && !seen.has(node)) missing.push(path);
    for (const child of node.children ?? []) findMissing(child, [...path, child.name]);
  };
  findMissing(root, []);
  return { unknown, missing };
}

/**
 * Treat the keys of a map or directory as data: its children become one `{*}` position, as
 * the shape extractor does for maps it recognises as dictionaries (usernames, dates). Children
 * merge per kind; their names are dropped, not kept as aliases, because they are data.
 */
export function setKeysAreData(
  root: ProjectNode,
  path: NodePath,
): { tree: ProjectNode; conflicts: MergeConflict[] } {
  const node = getNode(root, path);
  if (!node) throw new DecisionError(`no node at ${path.join('/')}`);
  if (node.kind !== 'map' && node.kind !== 'dir') throw new DecisionError('only maps and folders have keys');
  if (node.collapsed) return { tree: root, conflicts: [] };
  const tree = structuredClone(root);
  const target = getNode(tree, path)!;
  const conflicts: MergeConflict[] = [];
  const children = target.children ?? [];
  const kinds = [...new Set(children.map((c) => c.kind))];
  const merged: ProjectNode[] = [];
  for (const kind of kinds) {
    const [first, ...rest] = children.filter((c) => c.kind === kind);
    // Merge into a temporary parent so names that repeat across kinds do not clash.
    const scratch: ProjectNode = { kind: 'map', name: '', children: [{ ...first!, name: COLLAPSED_NAME }, ...rest] };
    let scratchTree = scratch;
    for (const other of rest) {
      const result = mergeNodes(scratchTree, [other.name], [COLLAPSED_NAME]);
      scratchTree = result.tree;
      conflicts.push(...result.conflicts.map((c) => ({ ...c, path: [...path, ...c.path] })));
    }
    const entry = scratchTree.children![0]!;
    delete entry.aliases;
    merged.push(entry);
  }
  const count = countBucket(children.length);
  Object.assign(target, { collapsed: true, count, children: merged });
  return { tree, conflicts };
}
