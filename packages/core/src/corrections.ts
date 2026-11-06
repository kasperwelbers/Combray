/**
 * Parser corrections: what a researcher says the parser got wrong, laid over trees and shapes
 * the same way in the studio and on every participant's device. Two directions
 * (docs/formats/README.md): keys that are data (`collapsed`, set with `setKeysAreData`) and texts
 * that are names (`textNames`). Corrections are settings in the configuration; the structures
 * recorded before stay as they were, and are read through the corrections (`correctedShape`).
 *
 * "Texts are names": HTML where the names of fields are written as text, next to their values,
 * read as names and values (docs/formats/html.md#names-written-as-text). The researcher marks
 * the element that holds them (`textNames` on its config node); nothing is guessed.
 *
 * Inside a marked element, Combray looks for the lists that hold the texts (normalisation makes
 * repeated siblings lists), going through elements but not into the lists themselves. Which of
 * two ways they are read is fixed when the researcher marks the element (`textNamesOf`), from
 * the structure seen, so every row is read the same way:
 *
 * - **Pairs**: one list. Its items alternate name, value (`<span>url</span><span>https://…</span>`),
 *   or each item holds a name followed by its value (`<div><b>url</b><span>https://…</span></div>`).
 * - **Side by side**: two lists with as many items, the first only text. The first holds the
 *   names, the second the values, item by item (`<div><h1>url</h1>…</div><div><span>https://…</span>…</div>`).
 *
 * The lists are replaced by one child of the element per pair, named by the name text. As with
 * table headers and `<dl>` terms, text from a participant's file only becomes a name when the
 * project knows it (`keys`); otherwise the pair keeps a position: the name as a value `#dt[0]`
 * next to its value `#dd[0]`. An element where the texts do not line up (an odd count, lists of
 * different lengths) is left as it is.
 *
 * Runs on the normalised tree, before its shape is taken, wherever a project reads a tree:
 * `prepareTree` on a participant's device, and the studio worker on the researcher's exports.
 */
import type { ConfigNode, ProjectConfig } from './config';
import { buildTree, knownKeys, unifyElementTwins, type ProjectNode } from './decisions';
import { matchesChild } from './derive';
import { inferType } from './infer';
import { normalizeTree } from './normalize';
import { collapseShape, extractShape, mergeAll, type Shape } from './shape';
import type { ElementNode, ListNode, MapNode, TreeNode, ValueNode } from './tree';

/** Name text longer than this is a sentence, not a name (as for table headers). */
const MAX_NAME_TEXT = 60;

/** Normalised children that are not content: attributes such as `@href`. */
const isAttribute = (n: TreeNode) => n.kind === 'value' && n.name.startsWith('@');

/** The text of a node that holds only text (a `#text` value, or elements of only text), else undefined. */
function onlyText(node: TreeNode): string | undefined {
  if (node.kind === 'value') return node.name.startsWith('#text') ? node.value : undefined;
  if (node.kind !== 'element' || node.children.length === 0) return undefined;
  const parts = node.children.map(onlyText);
  if (parts.some((p) => p === undefined)) return undefined;
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

/** The lists inside an element, through elements but not into lists, in document order. */
function listsIn(el: ElementNode): ListNode[] {
  return el.children.flatMap((c) => (c.kind === 'list' ? [c] : c.kind === 'element' ? listsIn(c) : []));
}

/** The parts of a list item: the items of its one list, or its own content. */
function partsOf(item: TreeNode): TreeNode[] {
  if (item.kind !== 'element') return [item];
  const content = item.children.filter((c) => !isAttribute(c));
  if (content.length === 1 && content[0]!.kind === 'list') return content[0]!.children;
  return content;
}

interface Pair {
  name: string;
  value: TreeNode[];
}

/** How texts are names in an element (`textNames`): see the top of this file. */
export type TextNames = 'pairs' | 'beside';

/** A shape or project node, as far as finding lists in it goes. */
interface Positions {
  kind: string;
  name: string;
  children?: readonly Positions[];
}

/** The list positions inside an element, through elements but not into lists. */
function listPositions(node: Positions): Positions[] {
  return (node.children ?? []).flatMap((c) => (c.kind === 'list' ? [c] : c.kind === 'element' ? listPositions(c) : []));
}

/**
 * How the texts in an element would be read as names, from its structure: one list holds
 * pairs, two lists are names beside values. Undefined when the element has neither. The studio
 * offers the action only then, and keeps the answer, so every row is read the same way.
 */
export function textNamesOf(node: Positions): TextNames | undefined {
  if (node.kind !== 'element') return undefined;
  const lists = listPositions(node).length;
  return lists === 1 ? 'pairs' : lists === 2 ? 'beside' : undefined;
}

/** The pairs in a marked element, and the lists they came from; undefined if they do not line up. */
function pairsIn(el: ElementNode, how: TextNames): { pairs: Pair[]; lists: ListNode[] } | undefined {
  const lists = listsIn(el);
  if (lists.length !== (how === 'beside' ? 2 : 1)) return undefined;
  if (how === 'beside') {
    const [names, values] = lists as [ListNode, ListNode];
    const texts = names.children.map(onlyText);
    if (names.children.length !== values.children.length || texts.some((t) => t === undefined)) return undefined;
    return { pairs: texts.map((name, i) => ({ name: name!, value: [values.children[i]!] })), lists };
  }
  const items = lists[0]!.children;
  const texts = items.map(onlyText);
  // Items that are each only text: name, value, name, value.
  if (texts.every((t) => t !== undefined)) {
    if (items.length % 2 !== 0) return undefined;
    const pairs: Pair[] = [];
    for (let i = 0; i < items.length; i += 2) pairs.push({ name: texts[i]!, value: [items[i + 1]!] });
    return { pairs, lists };
  }
  // Items that each hold a name and then its value.
  const pairs: Pair[] = [];
  for (const item of items) {
    const [first, ...rest] = partsOf(item);
    const name = first && onlyText(first);
    if (name === undefined || rest.length === 0) return undefined;
    pairs.push({ name, value: rest });
  }
  return { pairs, lists };
}

/** A value under a name: its text when it is only text, else a map of what it holds. */
function valueNode(name: string, parts: TreeNode[]): ValueNode | MapNode {
  const text = parts.length === 1 ? onlyText(parts[0]!) : undefined;
  if (text !== undefined) return { kind: 'value', name, value: text, type: inferType(text) };
  const children = parts.flatMap((p) => (p.kind === 'element' ? p.children : [p]));
  return { kind: 'map', name, children };
}

/** Whether a name text may be a name here (as `keyFor` in normalisation). */
const usable = (text: string, keys: (text: string) => boolean) =>
  text !== '' && text.length <= MAX_NAME_TEXT && !text.includes('/') && !/^[#@]/.test(text) && keys(text);

/** The element without the lists the pairs came from (and elements left empty), with the pairs. */
function withPairs(el: ElementNode, found: { pairs: Pair[]; lists: ListNode[] }, keys: (text: string) => boolean): ElementNode {
  const drop = new Set<TreeNode>(found.lists);
  const without = (node: ElementNode): ElementNode => ({
    ...node,
    children: node.children.flatMap((c): TreeNode[] => {
      if (drop.has(c)) return [];
      if (c.kind !== 'element') return [c];
      const kept = without(c);
      return kept.children.length === 0 ? [] : [kept];
    }),
  });
  const out = without(el);
  const used = new Set(out.children.map((c) => c.name));
  found.pairs.forEach(({ name, value }, i) => {
    if (usable(name, keys) && !used.has(name)) {
      used.add(name);
      out.children.push(valueNode(name, value));
    } else {
      out.children.push({ kind: 'value', name: `#dt[${i}]`, value: name, type: inferType(name) });
      out.children.push(valueNode(`#dd[${i}]`, value));
    }
  });
  return out;
}

/** Project nodes with `textNames`, or with one below them: the only ones worth walking into. */
function marked(root: ProjectNode): Set<ProjectNode> {
  const out = new Set<ProjectNode>();
  const visit = (node: ProjectNode): boolean => {
    const below = (node.children ?? []).map(visit).some(Boolean);
    if (below || node.textNames) out.add(node);
    return below || node.textNames !== undefined;
  };
  visit(root);
  return out;
}

/**
 * Read the names written as text in the elements a project marks (`textNames`), in a normalised
 * tree. `keys` says which text may become a name (`knownKeys` on a participant's device; any text
 * in the studio). The tree is not changed; unmarked parts are returned as they are.
 */
export function applyTextNames(tree: TreeNode, root: ProjectNode, keys: (text: string) => boolean): TreeNode {
  const walk = marked(root);
  if (walk.size === 0) return tree;
  const visit = (node: TreeNode, project: ProjectNode): TreeNode => {
    let out = node;
    if (project.textNames && node.kind === 'element') {
      const found = pairsIn(node, project.textNames);
      if (found) out = withPairs(node, found, keys);
    }
    if (out.kind === 'value' || out.kind === 'text' || out.kind === 'blob') return out;
    const targets = (project.children ?? []).filter((c) => walk.has(c));
    if (targets.length === 0) return out;
    let changed = false;
    const children = out.children.map((child) => {
      const target = targets.find((t) => matchesChild(project, out, child, t));
      if (!target) return child;
      const next = visit(child, target);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? ({ ...out, children } as TreeNode) : out;
  };
  return visit(tree, root);
}

/**
 * A participant's tree, prepared for a project: normalised, with the names written as text read
 * as names, and its shape. Text from the file only becomes a name when the project knows it.
 */
export function prepareTree(raw: TreeNode, root: ProjectNode): { prepared: TreeNode; shape: Shape } {
  const keys = knownKeys(root);
  const prepared = applyTextNames(normalizeTree(raw, { keys }), root, keys);
  return { prepared, shape: extractShape(prepared) };
}

/**
 * A recorded shape with the lists a marked element read as names and values left out, for
 * structures recorded before the element was marked (`correctedShape`). The names themselves
 * come from shapes read after (the studio reads its exports again).
 */
function withoutTextLists(shape: Shape, how: TextNames): Shape {
  const lists = new Set(listPositions(shape));
  if (lists.size !== (how === 'beside' ? 2 : 1)) return shape;
  const without = (s: Shape): Shape => {
    const children = (s.children ?? []).flatMap((c) => {
      if (lists.has(c)) return [];
      if (c.kind !== 'element') return [c];
      const kept = without(c);
      return kept.children && kept.children.length > 0 ? [kept] : [];
    });
    const { children: _children, ...rest } = s;
    return children.length > 0 ? { ...rest, children } : rest;
  };
  return without(shape);
}

const hasCorrections = (node: ConfigNode): boolean =>
  node.collapsed === true || node.textNames !== undefined || (node.children ?? []).some(hasCorrections);

/**
 * Shapes with the configuration's corrections laid over them: maps and folders the researcher
 * says have keys that are data (`collapsed`) keep only `{*}`, so those keys are not passed on,
 * and elements whose texts are names (`textNames`) lose the lists those texts were in.
 * For the structures a platform publishes to participants, and for comparing structures
 * recorded before a correction with ones recorded after. Element twins come out unified, as
 * `buildTree` sees them. Without corrections the shape is returned as it is.
 */
export function correctedShape(config: ProjectConfig, shape: Shape): Shape {
  if (!hasCorrections(config.root)) return shape;
  const unified = unifyElementTwins(shape);
  const { sources } = buildTree(config, unified);
  const collapse = new Set<Shape>();
  const texts = new Map<Shape, TextNames>();
  for (const [node, shapes] of sources) {
    for (const s of shapes) {
      if (node.collapsed && !s.collapsed) collapse.add(s);
      if (node.textNames) texts.set(s, node.textNames);
    }
  }
  if (collapse.size === 0 && texts.size === 0) return unified;
  const visit = (s: Shape): Shape => {
    const children = s.children?.map(visit);
    let out = children && children.some((c, i) => c !== s.children![i]) ? { ...s, children: mergeAll(children) } : s;
    const how = texts.get(s);
    if (how) out = withoutTextLists(out, how);
    return collapse.has(s) ? collapseShape(out) : out;
  };
  return visit(unified);
}
