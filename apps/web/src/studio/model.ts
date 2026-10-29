/**
 * Pure helpers for the researcher workspace: editing project trees and summarising decisions.
 * The core does the decision logic (`@combray/core`); this is what the screens need on top.
 */
import {
  getNode,
  isDecidable,
  isLeaf,
  joinProjectTree,
  splitProjectTree,
  type EffectiveState,
  type ImporterEntry,
  type ImporterFile,
  type NodePath,
  type ProjectNode,
  type StructureFile,
} from '@combray/core';

export const pathKey = (path: NodePath) => JSON.stringify(path);

export const isRepeatedName = (name: string) => name === '[*]' || name === '{*}';

/** Keys on a selected row: 1 undecided, 2 ignore, 3 show, 4 donate. */
export type Shortcut = '1' | '2' | '3' | '4';
export const SHORTCUT_DECISIONS = { '1': 'undecided', '2': 'ignore', '3': 'show', '4': 'donate' } as const;

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
export type NodePatch = Partial<Pick<ProjectNode, 'label' | 'description' | 'aliases' | 'raw'>>;

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
export function formsTable(node: ProjectNode): boolean {
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
    currentPath = [...currentPath, only.name];
    chain.push({ node: current, path: currentPath });
  }
}

/** The workspace draft as files, with settings for paths not seen yet kept at the end. */
export function toFiles(
  tree: ProjectNode,
  pending: ImporterEntry[],
): { structure: StructureFile; importer: ImporterFile } {
  const { structure, importer } = splitProjectTree(tree);
  return { structure, importer: { ...importer, entries: [...importer.entries, ...pending] } };
}

export function fromFiles(
  structure: StructureFile,
  importer: ImporterFile,
): { tree: ProjectNode; pending: ImporterEntry[] } {
  return joinProjectTree(structure, importer);
}
