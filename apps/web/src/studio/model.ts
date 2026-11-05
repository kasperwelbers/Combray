/**
 * Pure helpers for the researcher workspace: editing project trees and summarising decisions.
 * The core does the decision logic (`@combray/core`); this is what the screens need on top.
 *
 * The workspace keeps a configuration (config nodes and names) and the structures seen so far;
 * the tree on screen is the one laid over the other (`buildTree`). Edits change a copy of that
 * tree, and the configuration is taken back out of it (`toConfig`). See ADR 0012.
 */
import {
  buildTree,
  configOf,
  deriveTables,
  getNode,
  importerFile,
  isDecidable,
  isLeaf,
  structureFile,
  unionShape,
  type Built,
  type ColumnDef,
  type EffectiveState,
  type ImporterFile,
  type NodePath,
  type ProjectConfig,
  type ProjectNode,
  type Shape,
  type StructureFile,
} from '@combray/core';

export const pathKey = (path: NodePath) => JSON.stringify(path);

const undecided = (node: ProjectNode): ProjectNode => {
  const { decision: _decision, ...rest } = node;
  return node.children ? { ...rest, children: node.children.map(undecided) } : rest;
};

/**
 * The columns a filter on the table at `path` can test: every field of its rows, also ignored
 * ones (an "ad" marker the study does not keep), since filters may read columns they do not
 * show. Column ids are paths from the row, so they do not depend on the decisions.
 */
export function filterColumns(tree: ProjectNode, path: NodePath): ColumnDef[] {
  const key = pathKey(path);
  return deriveTables(undecided(tree)).find((table) => pathKey(table.node) === key)?.columns ?? [];
}

export const isRepeatedName = (name: string) => name === '[*]' || name === '{*}';

/** Keys on a row: 1 ignore, 2 show, 3 donate. */
export type Shortcut = '1' | '2' | '3';
export const SHORTCUT_DECISIONS = { '1': 'ignore', '2': 'show', '3': 'donate' } as const;

/** A node name for people: list items and keys that are data get words instead of `[*]`. */
export function displayName(name: string, t: (key: string) => string): string {
  if (name === '[*]') return t('studio.eachItem');
  if (name === '{*}') return t('studio.eachKey');
  return name || t('studio.root');
}

export type IconKind =
  | 'table'
  | 'row'
  | 'list'
  | 'object'
  | 'element'
  | 'folder'
  | 'text'
  | 'number'
  | 'date'
  | 'link'
  | 'email'
  | 'bool'
  | 'empty'
  | 'html-text'
  | 'file';

const GLYPHS: Record<IconKind, string> = {
  table: '▦',
  row: '↳',
  list: '⋮',
  object: '{ }',
  element: '‹›',
  folder: '📁',
  text: 'Aa',
  number: '#',
  date: '◷',
  link: '↗',
  email: '@',
  bool: '◐',
  empty: '∅',
  'html-text': '¶',
  file: '▣',
};

/** What a row's icon shows: tables, lists of values and objects differ, and leaves by type. */
export function nodeIcon(node: ProjectNode): { kind: IconKind; glyph: string } {
  const kind = ((): IconKind => {
    if (formsTable(node)) return 'table';
    if (isRepeatedName(node.name) && !isLeaf(node)) return 'row';
    switch (node.kind) {
      case 'list':
        return 'list';
      case 'map':
        return 'object';
      case 'element':
        return 'element';
      case 'dir':
        return 'folder';
      case 'text':
        return 'html-text';
      case 'blob':
        return 'file';
      case 'value': {
        const types = (node.types ?? []).filter((t) => t !== 'null');
        if (types.includes('date-like') || node.formats?.some((f) => f.startsWith('epoch-'))) return 'date';
        if (types.length === 0) return 'empty';
        if (types.every((t) => t === 'int' || t === 'float')) return 'number';
        if (types.includes('url-like')) return 'link';
        if (types.includes('email-like')) return 'email';
        if (types.every((t) => t === 'bool')) return 'bool';
        return 'text';
      }
    }
  })();
  return { kind, glyph: GLYPHS[kind] };
}

/**
 * Set every decidable field below a node at once (leaves and keys that are data). With
 * `undecidedOnly`, fields that already have a decision keep it.
 */
export function decideBelow(
  tree: ProjectNode,
  path: NodePath,
  decision: 'show' | 'donate' | 'undecided',
  undecidedOnly: boolean,
): ProjectNode {
  const copy = structuredClone(tree);
  const start = getNode(copy, path);
  if (!start) return tree;
  const visit = (node: ProjectNode) => {
    if (isDecidable(node) && node !== start && !(undecidedOnly && node.decision !== undefined)) {
      if (decision === 'undecided') delete node.decision;
      else node.decision = decision;
    }
    if (!isLeaf(node)) for (const child of node.children ?? []) visit(child);
  };
  visit(start);
  return copy;
}

/** Settings a researcher edits in the side panel. */
export type NodePatch = Partial<
  Pick<
    ProjectNode,
    | 'raw'
    | 'transform'
    | 'as'
    | 'format'
    | 'role'
    | 'filter'
    | 'required'
    | 'newChildren'
    | 'find'
    | 'undecided'
    | 'headerRow'
  >
>;

/** A copy of the tree with `patch` applied to one node; `undefined` values remove a setting. */
export function patchNode(tree: ProjectNode, path: NodePath, patch: NodePatch): ProjectNode {
  const copy = structuredClone(tree);
  const node = getNode(copy, path);
  if (!node) return tree;
  for (const [key, value] of Object.entries(patch)) {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (empty) delete (node as unknown as Record<string, unknown>)[key];
    else (node as unknown as Record<string, unknown>)[key] = value;
  }
  return copy;
}

/** Fields whose researcher decision is still open (and that no ignore above covers). */
export function isUndecided(node: ProjectNode, states: Map<ProjectNode, EffectiveState>): boolean {
  return isDecidable(node) && node.decision === undefined && states.get(node) !== 'ignore';
}

/** A list of objects or a map whose keys are data: its entries are the rows of a table. */
function formsTable(node: ProjectNode): boolean {
  return (node.children ?? []).some((c) => (c.name === '[*]' && !isLeaf(c)) || c.name === '{*}');
}

export interface Counts {
  leaves: number;
  undecided: number;
  show: number;
  donate: number;
  ignore: number;
}

export function countDecisions(tree: ProjectNode, states: Map<ProjectNode, EffectiveState>): Counts {
  const counts: Counts = { leaves: 0, undecided: 0, show: 0, donate: 0, ignore: 0 };
  const visit = (node: ProjectNode) => {
    if (isDecidable(node)) {
      counts.leaves++;
      if (isUndecided(node, states)) counts.undecided++;
      // The keys of a `{*}` node count with their own decision, not the state of what is inside.
      else if (isLeaf(node)) counts[states.get(node) ?? 'show']++;
      else counts[states.get(node) === 'ignore' ? 'ignore' : (node.decision ?? 'show')]++;
      if (isLeaf(node)) return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return counts;
}

/** Undecided leaves below each node, for the "only undecided" filter. */
export function undecidedBelow(
  tree: ProjectNode,
  states: Map<ProjectNode, EffectiveState>,
): Map<ProjectNode, number> {
  const out = new Map<ProjectNode, number>();
  const visit = (node: ProjectNode): number => {
    let n = isUndecided(node, states) ? 1 : 0;
    if (!isLeaf(node)) for (const child of node.children ?? []) n += visit(child);
    out.set(node, n);
    return n;
  };
  visit(tree);
  return out;
}

/**
 * A run of inner nodes shown as one row: each has exactly one child, which is again an inner
 * node, and none of them has a label, is a repeated node, or holds one (those are tables).
 * Returns the nodes of the run with their paths, top first.
 */
export function foldChain(node: ProjectNode, path: NodePath): { node: ProjectNode; path: NodePath }[] {
  const chain = [{ node, path }];
  let current = node;
  let currentPath = path;
  for (;;) {
    const children = current.children ?? [];
    const only = children[0];
    if (
      children.length !== 1 ||
      !only ||
      isLeaf(current) ||
      isLeaf(only) ||
      current.collapsed ||
      current.label !== undefined ||
      isRepeatedName(current.name) ||
      isRepeatedName(only.name)
    ) {
      return chain;
    }
    current = only;
    currentPath = [...currentPath, only.id];
    chain.push({ node: current, path: currentPath });
  }
}

/** What the workspace edits: a configuration, and the structures seen so far (their union). */
export interface StudioDraft {
  config: ProjectConfig;
  seen?: Shape;
}

/** The workspace draft as files: the seen structures, and the configuration. */
export function toFiles(draft: StudioDraft): { structure: StructureFile; importer: ImporterFile } {
  return {
    structure: structureFile(draft.seen ?? { kind: draft.config.root.kind, name: '' }),
    importer: importerFile(draft.config),
  };
}

export function fromFiles(structure: StructureFile, importer: ImporterFile): StudioDraft {
  return { config: configOf(importer), seen: structure.root };
}

/** The seen structures with one more added (they only grow). */
export function addSeen(seen: Shape | undefined, ...shapes: Shape[]): Shape | undefined {
  return unionShape(seen ? [seen, ...shapes] : shapes);
}

/**
 * Siblings in the order rows show them: as in the tree, but nodes with the same name next to
 * each other, after the first of them.
 */
export function withSameNamesTogether(children: ProjectNode[]): ProjectNode[] {
  const out: ProjectNode[] = [];
  const done = new Set<ProjectNode>();
  for (const child of children) {
    if (done.has(child)) continue;
    const same = child.nameId === undefined ? [child] : children.filter((c) => c.nameId === child.nameId);
    for (const c of same) {
      out.push(c);
      done.add(c);
    }
  }
  return out;
}

/** A name shortened for the tree: the shortest form that no other node in the list could have. */
export interface ShortName {
  short: string;
  full: string;
  /** Whether `short` leaves out part of the path, so the full path is worth showing. */
  shortened: boolean;
}

/** Combinations tried per name before falling back to the full form of each step. */
const MAX_FORMS = 64;
const ELEMENT = /^([a-z][a-z0-9-]*)(#[^./]+)?((?:\.[^./]+)*)$/;

/** Ways to write one step, shortest first: an element by its tag, its id or one class. */
function stepForms(name: string, kind: ProjectNode['kind']): string[] {
  const match = kind === 'element' ? ELEMENT.exec(name) : null;
  if (!match || (!match[2] && !match[3])) return [name];
  const [, tag, id, classes] = match;
  const forms = [tag!, ...(id ? [`${tag}${id}`] : []), ...classes!.split('.').filter(Boolean).map((c) => `${tag}.${c}`), name];
  return [...new Set(forms)];
}

/** Every way to write the last `k` steps, shortest first. */
function suffixForms(steps: { name: string; kind: ProjectNode['kind'] }[], k: number): string[] {
  let out = [''];
  for (const step of steps.slice(-k)) {
    const forms = stepForms(step.name, step.kind);
    const next = out.length * forms.length > MAX_FORMS ? [step.name] : forms;
    out = out.flatMap((head) => next.map((form) => (head ? `${head}/${form}` : form)));
  }
  return out.sort((a, b) => a.length - b.length);
}

/**
 * Names for `paths` (each below `base`) as short as they can be while telling them apart,
 * read from the end: `div.mdl-cell--12-col.mdl-typography--caption/#text[0]` becomes
 * `div.mdl-typography--caption`, or `div` when no other field has a div. The text of an
 * element (a last `#text[0]`) is named by its element. A name is used only when it could not
 * be the name of another path in the list.
 */
export function shortNames(tree: ProjectNode, paths: NodePath[], base: NodePath = []): ShortName[] {
  const namesOf = (path: NodePath) => path.map((id, i) => getNode(tree, path.slice(0, i + 1))?.name ?? id);
  const steps = paths.map((path) => {
    const names = namesOf(path);
    const out = path.slice(base.length).flatMap((_, i) => {
      const name = names[base.length + i]!;
      const node = getNode(tree, path.slice(0, base.length + i + 1));
      const parent = getNode(tree, path.slice(0, base.length + i));
      // Repeated elements are a list named after the element.
      const kind = node?.kind === 'list' && parent?.kind === 'element' ? 'element' : (node?.kind ?? 'map');
      return isRepeatedName(name) ? [] : [{ name, kind }];
    });
    // The text of an element is what the element says.
    if (out.length > 1 && out.at(-1)!.name === '#text[0]' && out.at(-2)!.kind === 'element') out.pop();
    return out;
  });
  const candidates = steps.map((s) => {
    const all: string[] = [];
    for (let k = 1; k <= s.length; k++) all.push(...suffixForms(s, k));
    return all;
  });
  const owners = new Map<string, Set<number>>();
  candidates.forEach((list, i) => list.forEach((c) => owners.set(c, (owners.get(c) ?? new Set()).add(i))));
  return paths.map((path, i) => {
    const names = namesOf(path);
    const full = names.slice(base.length).filter((n) => !isRepeatedName(n)).join(' / ') || names.join(' / ');
    const short = candidates[i]!.find((c) => owners.get(c)!.size === 1) ?? steps[i]!.map((s) => s.name).join('/');
    const shown = short.split('/').join(' / ');
    return { short: shown || full, full, shortened: shown !== full };
  });
}

/** Whether a node, or anything below it, has a show or donate decision. */
const hasDecided = (node: ProjectNode): boolean =>
  node.decision === 'show' || node.decision === 'donate' || (node.children ?? []).some(hasDecided);

/**
 * The tree as participants' processed view uses it: unless the platform lets participants see
 * undecided parts (`undecided: show` on the root), undecided fields count as ignored, as in
 * the participant client (`worker/derived.ts`). Keys that are data (`{*}`) stay when something
 * below them is decided, since their key column belongs to those rows.
 */
export function asParticipantsSee(tree: ProjectNode): ProjectNode {
  if (tree.undecided === 'show') return tree;
  const visit = (node: ProjectNode): ProjectNode => {
    if (node.decision !== undefined) return node.decision === 'ignore' ? node : withChildren(node);
    if (isLeaf(node)) return { ...node, decision: 'ignore' };
    if (isDecidable(node) && !hasDecided(node)) return { ...node, decision: 'ignore' };
    return withChildren(node);
  };
  const withChildren = (node: ProjectNode): ProjectNode =>
    node.children && !isLeaf(node) ? { ...node, children: node.children.map(visit) } : node;
  return visit(tree);
}

/** What a row of the tree says beyond its decision: how the configuration meets the structures. */
export interface RowInfo {
  /** A config node that matches nothing in the structures seen so far. */
  notSeen?: true;
  /** In how many packages this node matches two keys side by side: which value is meant? */
  conflicts?: number;
  /** Other rows that match the same keys: the data is in each of them. */
  alsoMatchedBy?: string[];
  /** Rows with this row's name have different decisions: allowed, but unusual. */
  nameMismatch?: true;
}

function walk(tree: ProjectNode, visit: (node: ProjectNode, path: NodePath) => void) {
  const go = (node: ProjectNode, path: NodePath) => {
    visit(node, path);
    for (const child of node.children ?? []) go(child, [...path, child.id]);
  };
  go(tree, []);
}

/** Config nodes that match nothing seen so far: settings for parts no package has shown. */
export function notSeen(tree: ProjectNode): NodePath[] {
  const out: NodePath[] = [];
  walk(tree, (node, path) => {
    if (path.length > 0 && !node.virtual && !node.keys?.length) out.push(path);
  });
  return out;
}

/**
 * The notes on each row: config nodes nothing matches, rows that share their data, and nodes
 * that match two keys side by side. Conflicts are checked per structure (each package on its
 * own), since the union has keys side by side that no package has together.
 */
export function rowInfo(built: Built, config: ProjectConfig, structures: readonly Shape[]): Map<ProjectNode, RowInfo> {
  const out = new Map<ProjectNode, RowInfo>();
  const add = (node: ProjectNode, info: RowInfo) => out.set(node, { ...out.get(node), ...info });
  const conflicts = new Map<string, number>();
  for (const shape of structures) {
    const own = buildTree(config, shape);
    if (own.conflicts.size === 0) continue;
    walk(own.tree, (node, path) => {
      if (own.conflicts.has(node)) conflicts.set(pathKey(path), (conflicts.get(pathKey(path)) ?? 0) + 1);
    });
  }
  const byName = new Map<string, ProjectNode[]>();
  walk(built.tree, (node, path) => {
    if (path.length > 0 && !node.virtual && !node.keys?.length) add(node, { notSeen: true });
    const count = conflicts.get(pathKey(path));
    if (count) add(node, { conflicts: count });
    const shared = built.shared.get(node);
    if (shared?.length) add(node, { alsoMatchedBy: shared.map((n) => n.name) });
    if (node.nameId !== undefined && isDecidable(node)) byName.set(node.nameId, [...(byName.get(node.nameId) ?? []), node]);
  });
  for (const nodes of byName.values()) {
    if (new Set(nodes.map((n) => n.decision ?? 'undecided')).size > 1) for (const n of nodes) add(n, { nameMismatch: true });
  }
  return out;
}
