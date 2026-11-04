/**
 * Project trees: the researcher's configuration laid over the structures we have seen.
 *
 * See docs/tree-decisions.md and docs/decisions/0012-names-and-matches.md. The configuration
 * (config.ts) holds only nodes someone touched. `buildTree` lays it over a shape: every real
 * position is matched by the config nodes whose matches fit it, and positions no config node
 * matches become *virtual* nodes, undecided. The result, a project tree, is what the studio shows
 * and edits and what tables are derived from; `toConfig` takes the configuration back out of it.
 *
 * Show and donate are set on leaves, and on `{*}` nodes for their keys; other inner nodes can only
 * be ignored (which covers everything below them). An inner node's effective state is derived
 * from its leaves. Tables are not marked: they are inferred from the structure (derive.ts).
 */
import {
  isItemNode,
  isKeysNode,
  matchesKey,
  nameDescription,
  nameLabel,
  newId,
  SETTINGS,
  type ConfigNode,
  type LeafDecision,
  type Match,
  type Name,
  type NodeSettings,
  type ProjectConfig,
} from './config';
import type { Localized } from './importer/spec';
import { COLLAPSED_NAME, ITEM_NAME, mergeAll, repeatOf, type Repeat, type Shape } from './shape';
import type { NodeKind, ValueType } from './tree';

export type { LeafDecision, NewChildren, Role, RowFilter } from './config';
export { ROLES } from './config';

export type EffectiveState = 'ignore' | 'show' | 'donate';

/** What the seen structures say about a position: as in shapes, without names or children. */
export interface StructureInfo {
  types?: ValueType[];
  formats?: string[];
  keyTypes?: ValueType[];
  keyFormats?: string[];
  repeat?: Repeat;
  mime?: string;
}

/** The structure fields of a node, as in shapes. */
export const STRUCTURE_FIELDS = ['types', 'formats', 'keyTypes', 'keyFormats', 'repeat', 'mime'] as const satisfies readonly (keyof StructureInfo)[];

/**
 * A node of a project tree: a config node, or a virtual one for a real position nothing matches,
 * with what the seen structures say about it.
 */
export interface ProjectNode extends NodeSettings, StructureInfo {
  /** The config node's id; for a virtual node `~kind:key`, unique among its siblings. */
  id: string;
  kind: NodeKind;
  /**
   * What the node is called in the tree: its first exact match, else the first key it matched,
   * `[*]` or `{*}`, the real key of a virtual node, or `''` for the root.
   */
  name: string;
  match: Match[];
  /** A real position no config node matches: not part of the configuration until edited. */
  virtual?: true;
  nameId?: string;
  /** From the node's name: the label and description participants see. */
  label?: Localized;
  description?: Localized;
  /** The real keys the node matched in the structures it was laid over. */
  keys?: string[];
  children?: ProjectNode[];
}

/** A position in a project tree: the ids of the nodes from the root's children down. */
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

/** Find a node by its path of ids. */
export function getNode(root: ProjectNode, path: NodePath): ProjectNode | undefined {
  let node: ProjectNode | undefined = root;
  for (const id of path) {
    node = node.children?.find((c) => c.id === id);
    if (!node) return undefined;
  }
  return node;
}

/** The nodes along a path, root first. */
export function nodesAlong(root: ProjectNode, path: NodePath): ProjectNode[] | undefined {
  const out = [root];
  for (const id of path) {
    const next = out.at(-1)!.children?.find((c) => c.id === id);
    if (!next) return undefined;
    out.push(next);
  }
  return out;
}

/** The path of a node in a tree, or undefined if it is not in it. */
export function pathOf(root: ProjectNode, target: ProjectNode): NodePath | undefined {
  const visit = (node: ProjectNode, path: NodePath): NodePath | undefined => {
    if (node === target) return path;
    for (const child of node.children ?? []) {
      const found = visit(child, [...path, child.id]);
      if (found) return found;
    }
    return undefined;
  };
  return visit(root, []);
}

// --- Matching ---------------------------------------------------------------------------------

/**
 * Whether a config node (`child`) matches a real position with this kind and name, below a
 * parent. Below a map whose keys are data, only the `{*}` node matches, and it matches every key.
 */
export function matchesPosition(
  parent: { collapsed?: true },
  child: { kind: NodeKind; match: readonly Match[] },
  kind: NodeKind,
  name: string,
): boolean {
  if (child.kind !== kind) return false;
  if (isKeysNode(child)) return name === COLLAPSED_NAME || parent.collapsed === true;
  if (parent.collapsed) return false;
  if (isItemNode(child)) return name === ITEM_NAME;
  return name !== ITEM_NAME && name !== COLLAPSED_NAME && matchesKey(child.match, name);
}

/**
 * Whether a text is a key the project knows: one a config node matches, or one in the seen
 * structures. For `NormalizeOptions.keys`: header text in a participant's HTML only becomes a key
 * when the project knows it, so text from the file never becomes a new name.
 */
export function knownKeys(root: ProjectNode): (text: string) => boolean {
  const names = new Set<string>();
  const matches: Match[] = [];
  const visit = (node: ProjectNode) => {
    names.add(node.name);
    for (const key of node.keys ?? []) names.add(key);
    for (const m of node.match) if (typeof m === 'string') names.add(m);
    else matches.push(m);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return (text) => names.has(text) || matchesKey(matches, text);
}

// --- Shapes -----------------------------------------------------------------------------------

/** A value that was only ever null: in JSON, usually an empty map or list. */
const isNullOnly = (n: { kind: NodeKind; types?: ValueType[] }) =>
  n.kind === 'value' && n.types?.length === 1 && n.types[0] === 'null';

const hasElementItems = (list: { children?: { kind: NodeKind; name: string }[] }) =>
  (list.children ?? []).some((i) => i.kind === 'element' && i.name === ITEM_NAME);

/**
 * An element that is repeated in some places and single in others (one link in a row, or
 * several) is one position: the single element counts as the list's only item. Normalised HTML
 * names a list like its elements, so the two have the same name.
 */
export function unifyElementTwins(shape: Shape): Shape {
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

function structureOf(shapes: Shape[]): StructureInfo {
  if (shapes.length === 0) return {};
  const merged = mergeAll(shapes.map((s) => ({ ...s, name: '', children: undefined })))[0]!;
  const out: StructureInfo = {};
  for (const key of STRUCTURE_FIELDS) {
    if (merged[key] !== undefined) (out as Record<string, unknown>)[key] = merged[key];
  }
  return out;
}

/** The union of shapes: one structure with every position any of them has. */
export function unionShape(shapes: readonly Shape[]): Shape | undefined {
  const [first, ...rest] = shapes;
  if (!first) return undefined;
  const merged = mergeAll([first, ...rest].map((s) => ({ ...s, name: '' })));
  // Shapes of different kinds (a file and a folder) cannot be one root: the first one wins.
  return unifyElementTwins(merged.find((s) => s.kind === first.kind)!);
}

// --- Laying the configuration over a shape ----------------------------------------------------

/** Whether a node skips new children: its own `newChildren`, or else its parent's. */
const closedHere = (node: { newChildren?: string }, parentClosed: boolean) =>
  node.newChildren === undefined ? parentClosed : node.newChildren === 'skip';

export interface BuildOptions {
  /**
   * Leave out real positions no config node matches below nodes that skip new children
   * (`newChildren: 'skip'`), as a participant's client does. The studio keeps everything.
   */
  skipClosed?: boolean;
}

/** A shape position a node matched, with the shape position it sits in. */
interface Source {
  shape: Shape;
  parent?: Shape;
}

export interface Built {
  tree: ProjectNode;
  /** The shape positions each node matched. */
  sources: Map<ProjectNode, Shape[]>;
  /**
   * Nodes that match two different keys side by side in one shape position: which value would
   * go in the column? (ADR 0012, rule 5.)
   */
  conflicts: Set<ProjectNode>;
  /** Nodes that match a real position another sibling matches too: the data is in both. */
  shared: Map<ProjectNode, ProjectNode[]>;
  /** Paths of the virtual nodes, top-most only: real positions no config node matches. */
  unmatched: NodePath[];
}

/** The working node of a config node, without children. */
function fromConfig(config: ConfigNode, names: Map<string, Name>): ProjectNode {
  const node: ProjectNode = { id: config.id, kind: config.kind, name: '', match: [...config.match] };
  for (const key of SETTINGS) {
    const value = config[key];
    if (value !== undefined) (node as unknown as Record<string, unknown>)[key] = structuredClone(value);
  }
  if (config.nameId !== undefined) {
    node.nameId = config.nameId;
    const name = names.get(config.nameId);
    if (name) {
      node.label = nameLabel(name);
      const description = nameDescription(name);
      if (description !== undefined) node.description = description;
    }
  }
  return node;
}

/** The id of a virtual node: its kind and key, unique among its siblings. */
export const virtualId = (kind: NodeKind, name: string) => `~${kind}:${name}`;

/**
 * Lay a configuration over a shape. Every config node is kept, also the ones the shape does not
 * have; real positions no config node matches are added as virtual nodes. Every config node that
 * matches a position gets it, so overlapping matches see the same data (ADR 0012).
 */
export function buildTree(config: ProjectConfig, shape?: Shape, options: BuildOptions = {}): Built {
  const names = new Map(config.names.map((n) => [n.id, n]));
  const sources = new Map<ProjectNode, Shape[]>();
  const conflicts = new Set<ProjectNode>();
  const shared = new Map<ProjectNode, ProjectNode[]>();
  const unmatched: NodePath[] = [];

  const visit = (
    node: ProjectNode,
    configChildren: ConfigNode[],
    from: Source[],
    path: NodePath,
    parentClosed: boolean,
    insideVirtual: boolean,
  ) => {
    const shapes = from.map((s) => s.shape);
    sources.set(node, shapes);
    Object.assign(node, structureOf(shapes));
    // A map the structures show as one whose keys are data is one, configured or not.
    if (shapes.some((s) => s.collapsed)) node.collapsed = true;
    const keys = [...new Set(shapes.map((s) => s.name))];
    if (path.length > 0 && keys.length > 0) node.keys = keys;
    const closed = closedHere(node, parentClosed);

    const real = from.flatMap((s) => (s.shape.children ?? []).map((child): Source => ({ shape: child, parent: s.shape })));
    const used = new Map<Shape, ProjectNode[]>();
    const children: ProjectNode[] = [];
    for (const config of configChildren) {
      const child = fromConfig(config, names);
      const matched: Source[] = [];
      for (const r of real) {
        if (matchesPosition(node, child, r.shape.kind, r.shape.name)) matched.push(r);
        // A single element where the config has a list of them: the list's only item.
        else if (child.kind === 'list' && r.shape.kind === 'element' && matchesKey(child.match, r.shape.name) && hasConfigElementItems(config)) {
          matched.push({ ...r, shape: { kind: 'list', name: r.shape.name, children: [{ ...r.shape, name: ITEM_NAME }] } });
        }
        // A repeated element where the config has a single one: each item is that element.
        else if (child.kind === 'element' && r.shape.kind === 'list' && hasElementItems(r.shape) && matchesKey(child.match, r.shape.name)) {
          for (const item of r.shape.children ?? []) {
            if (item.kind === 'element') matched.push({ shape: { ...item, name: r.shape.name }, parent: r.parent });
          }
        } else continue;
        used.set(r.shape, [...(used.get(r.shape) ?? []), child]);
      }
      // Two different keys side by side in one position, both matched by this node.
      const byParent = new Map<Shape | undefined, Set<string>>();
      for (const m of matched) byParent.set(m.parent, (byParent.get(m.parent) ?? new Set()).add(m.shape.name));
      if ([...byParent.values()].some((names) => names.size > 1)) conflicts.add(child);
      child.name = displayName(child, matched);
      children.push(child);
      visit(child, config.children ?? [], matched, [...path, child.id], closed, false);
    }
    for (const [, nodes] of used) {
      if (nodes.length < 2) continue;
      for (const n of nodes) shared.set(n, [...new Set([...(shared.get(n) ?? []), ...nodes.filter((o) => o !== n)])]);
    }

    // Real positions nothing matches: virtual nodes, one per kind and key.
    if (!(closed && options.skipClosed)) {
      const rest = real.filter((r) => !used.has(r.shape));
      const groups = new Map<string, Source[]>();
      for (const r of rest) {
        const name = node.collapsed ? COLLAPSED_NAME : r.shape.name;
        // `"subtitles": null` next to a list of subtitles is the same position, empty.
        if (isNullOnly(r.shape) && (real.some((o) => o.shape.name === r.shape.name && !isNullOnly(o.shape)) || children.some((c) => matchesKey(c.match, r.shape.name)))) {
          continue;
        }
        const key = `${r.shape.kind}\u0000${name}`;
        groups.set(key, [...(groups.get(key) ?? []), { ...r, shape: { ...r.shape, name } }]);
      }
      for (const group of groups.values()) {
        const { kind, name } = group[0]!.shape;
        let id = virtualId(kind, name);
        while (children.some((c) => c.id === id)) id += "'";
        const child: ProjectNode = { id, kind, name, match: [name], virtual: true };
        children.push(child);
        if (!insideVirtual) unmatched.push([...path, id]);
        visit(child, [], group, [...path, id], closed, true);
      }
    }
    if (children.length > 0) node.children = children;
    else delete node.children;
  };

  const root = fromConfig(config.root, names);
  const start = shape ? [{ shape: unifyElementTwins(shape) }] : [];
  visit(root, config.root.children ?? [], start, [], false, false);
  root.name = '';
  return { tree: root, sources, conflicts, shared, unmatched };
}

const hasConfigElementItems = (config: ConfigNode) =>
  (config.children ?? []).some((c) => c.kind === 'element' && isItemNode(c));

/** What a node is called: its first exact key, else the first key it matched, else its first match. */
function displayName(node: ProjectNode, matched: Source[]): string {
  const exact = node.match.find((m): m is string => typeof m === 'string');
  if (exact !== undefined) return exact;
  const seen = matched.find((m) => m.shape.name !== ITEM_NAME && m.shape.name !== COLLAPSED_NAME);
  if (seen) return seen.shape.name;
  const first = node.match[0];
  return first === undefined ? '' : typeof first === 'string' ? first : `/${first.regex}/`;
}

/** The project tree of a configuration alone: its nodes, without any structure. */
export function configTree(config: ProjectConfig): ProjectNode {
  return buildTree(config).tree;
}

/** A configuration with only a root, for a structure nobody has configured yet. */
export function emptyConfig(kind: NodeKind): ProjectConfig {
  return { root: { id: 'root', kind, match: [] }, names: [] };
}

/** The configuration in a project tree: its config nodes, without virtual ones or structure. */
export function toConfig(tree: ProjectNode): ConfigNode {
  const visit = (node: ProjectNode): ConfigNode => {
    const out: ConfigNode = { id: node.id, kind: node.kind, match: [...node.match] };
    if (node.nameId !== undefined) out.nameId = node.nameId;
    for (const key of SETTINGS) {
      const value = node[key];
      if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = structuredClone(value);
    }
    const children = (node.children ?? []).filter((c) => !c.virtual).map(visit);
    if (children.length > 0) out.children = children;
    return out;
  };
  return visit(tree);
}

// --- Editing ----------------------------------------------------------------------------------

/**
 * Make the virtual nodes along a path real: each becomes a config node with a new id and one
 * exact match, its key. Returns the new tree and the node's new path. Doing anything with a
 * virtual node (deciding, naming, a conversion) starts here.
 */
export function materialise(tree: ProjectNode, path: NodePath): { tree: ProjectNode; path: NodePath } {
  const copy = structuredClone(tree);
  const along = nodesAlong(copy, path);
  if (!along) throw new DecisionError(`no node at ${path.join('/')}`);
  const out: NodePath = [];
  for (const node of along.slice(1)) {
    if (node.virtual) {
      delete node.virtual;
      node.id = newId();
    }
    out.push(node.id);
  }
  return { tree: copy, path: out };
}

/**
 * Where a path went after an edit: the same ids, or, for a node that was virtual, the config
 * node that now matches its key. For keeping a selection or open rows across edits.
 */
export function remapPath(before: ProjectNode, after: ProjectNode, path: NodePath): NodePath | undefined {
  let old: ProjectNode = before;
  let now: ProjectNode = after;
  const out: NodePath = [];
  for (const id of path) {
    const prev = old.children?.find((c) => c.id === id);
    if (!prev) return undefined;
    const next =
      now.children?.find((c) => c.id === id) ??
      now.children?.find((c) => c.kind === prev.kind && !c.virtual && c.match.some((m) => m === prev.name));
    if (!next) return undefined;
    out.push(next.id);
    old = prev;
    now = next;
  }
  return out;
}

/** Whether a node skips new children; see `closedHere`. Nodes with `newChildren: 'skip'` above them too. */
export function closedNodes(root: ProjectNode): Set<ProjectNode> {
  const out = new Set<ProjectNode>();
  const visit = (node: ProjectNode, parentClosed: boolean) => {
    const closed = closedHere(node, parentClosed);
    if (closed) out.add(node);
    for (const child of node.children ?? []) visit(child, closed);
  };
  visit(root, false);
  return out;
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
  for (const child of node.children ?? []) decidedLeaves(child, [...path, child.id], out);
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
 * Set a decision. `show` and `donate` are only allowed on leaves and `{*}` nodes. Decisions below
 * an ignored node are kept, so un-ignoring restores them. A virtual node is made real first.
 */
export function setDecision(
  root: ProjectNode,
  path: NodePath,
  decision: LeafDecision,
): ProjectNode {
  const found = getNode(root, path);
  if (!found) throw new DecisionError(`no node at ${path.join('/')}`);
  if ((decision === 'show' || decision === 'donate') && !isDecidable(found)) {
    throw new DecisionError(`${decision} is only possible on leaves, not on ${found.kind} nodes`);
  }
  if (decision === 'undecided' && found.decision === undefined) return root;
  const real = materialise(root, path);
  const node = getNode(real.tree, real.path)!;
  if (decision === 'undecided') delete node.decision;
  else node.decision = decision;
  return real.tree;
}

// --- Comparing a participant's shape --------------------------------------------------------

export interface ShapeComparison {
  /** Donated leaves in the project tree that this shape does not have. */
  missing: NodePath[];
  /** Required nodes (`required`) that this shape does not have, by any of their matches. */
  missingRequired: NodePath[];
}

/** The nodes of a tree that a shape has, by any of their matches. */
export function matchShape(root: ProjectNode, shape: Shape): Set<ProjectNode> {
  const built = buildTree({ root: toConfig(root), names: [] }, shape);
  const seen = new Set<ProjectNode>();
  const visit = (node: ProjectNode, own: ProjectNode | undefined) => {
    if (!own) return;
    if ((built.sources.get(node)?.length ?? 0) > 0) seen.add(own);
    for (const child of node.children ?? []) visit(child, own.children?.find((c) => c.id === child.id && !c.virtual));
  };
  visit(built.tree, root);
  return seen;
}

/** Paths of the required nodes (`required`) in a project tree, top first. */
export function requiredPaths(root: ProjectNode): NodePath[] {
  const out: NodePath[] = [];
  const visit = (node: ProjectNode, path: NodePath) => {
    if (node.required) out.push(path);
    for (const child of node.children ?? []) visit(child, [...path, child.id]);
  };
  visit(root, []);
  return out;
}

/** Compare a participant's shape with the project tree, locally: what it lacks. */
export function compareShape(root: ProjectNode, shape: Shape): ShapeComparison {
  const seen = matchShape(root, shape);
  const states = effectiveStates(root);
  const missing: NodePath[] = [];
  const missingRequired: NodePath[] = [];
  const visit = (node: ProjectNode, path: NodePath) => {
    if (node.virtual) return;
    const donated = isLeaf(node)
      ? states.get(node) === 'donate'
      : node.name === COLLAPSED_NAME && node.decision === 'donate' && states.get(node) !== 'ignore';
    if (donated && !seen.has(node)) missing.push(path);
    if (node.required && !seen.has(node)) missingRequired.push(path);
    for (const child of node.children ?? []) visit(child, [...path, child.id]);
  };
  visit(root, []);
  return { missing, missingRequired };
}

/**
 * The top-most positions of a shape that the seen structure does not have: parts of a
 * participant's export nobody has seen before. Matched by kind and key, as shapes merge.
 */
export function newPositions(seen: Shape | undefined, shape: Shape): Set<Shape> {
  const out = new Set<Shape>();
  const visit = (known: Shape | undefined, s: Shape) => {
    for (const child of s.children ?? []) {
      const match = known?.children?.find((k) => k.kind === child.kind && k.name === child.name);
      if (match) visit(match, child);
      else out.add(child);
    }
  };
  visit(seen && unifyElementTwins(seen), unifyElementTwins(shape));
  return out;
}

// --- Keys that are data ----------------------------------------------------------------------

/**
 * Treat the keys of a map or folder as data: its children become one `{*}` node per kind, as the
 * shape extractor does for maps it recognises as dictionaries (usernames, dates). The settings of
 * the first child of each kind are kept; the keys are not kept as matches, because they are data.
 */
export function setKeysAreData(root: ProjectNode, path: NodePath): ProjectNode {
  const node = getNode(root, path);
  if (!node) throw new DecisionError(`no node at ${path.join('/')}`);
  if (node.kind !== 'map' && node.kind !== 'dir') throw new DecisionError('only maps and folders have keys');
  if (node.collapsed) return root;
  const real = materialise(root, path);
  const target = getNode(real.tree, real.path)!;
  const children = target.children ?? [];
  const kinds = [...new Set(children.map((c) => c.kind))];
  target.children = kinds.map((kind) => {
    const of = children.filter((c) => c.kind === kind);
    const first = of.find((c) => !c.virtual) ?? of[0]!;
    // Their children all sit below the one `{*}` node now; settings of the first one win.
    const merged = of.flatMap((c) => c.children ?? []);
    const seen = new Set<string>();
    const unique = merged.filter((c) => {
      const key = `${c.kind}\u0000${c.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const { virtual: _virtual, keys: _keys, ...rest } = first;
    return { ...rest, id: newId(), name: COLLAPSED_NAME, match: [COLLAPSED_NAME], ...(unique.length > 0 ? { children: unique } : {}) };
  });
  target.collapsed = true;
  target.repeat = repeatOf(children.length);
  return real.tree;
}
