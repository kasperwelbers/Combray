/**
 * HTML normalisation, layer 1 of docs/tree-decisions.md#html: turn parsed markup into a tree
 * whose structure is comparable across rows and participants.
 *
 * - Repeated siblings (two or more with the same tag and the same classes) become a list. Cells
 *   in a row usually differ in some class (`mdl-cell--6-col`, `--12-col`), rows do not.
 * - Inside list rows, elements keep only the classes (and id) they have at that position in
 *   every row, so layout classes that vary between rows do not split one position in two.
 * - Text becomes values named by position among text siblings (`#text[0]`, `#text[1]`), with
 *   an inferred type, so "the date-like text" is a leaf researchers can pick.
 * - Data attributes (`href`, `src`, `datetime`, ...) become values named `@href` and so on.
 * - Elements left without children or data attributes (`<br>`, empty cells) are dropped.
 *
 * The input tree is not changed. Directories and other files pass through.
 */
import { inferType } from './infer';
import { elementName } from './shape';
import type { ElementNode, ListNode, TreeNode, ValueNode } from './tree';

/** Repeated siblings needed before they count as a list. */
export const MIN_REPEATS = 2;

/** Attributes whose values are data. Others (class, id, style) are structure or layout. */
const DATA_ATTRIBUTES = ['href', 'src', 'datetime', 'title', 'alt', 'value', 'content'];

type Normalized = ElementNode | ListNode | ValueNode;

const classesOf = (el: ElementNode) => (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
const primaryKey = (el: ElementNode) => `${el.name}.${classesOf(el)[0] ?? ''}`;
const fullKey = (el: ElementNode) => `${el.name}.${[...new Set(classesOf(el))].sort().join('.')}`;

function value(name: string, raw: string): ValueNode {
  return { kind: 'value', name, value: raw, type: inferType(raw) };
}

/** Normalise one element and everything below it. Returns undefined if nothing is left. */
function normalizeElement(el: ElementNode): ElementNode | undefined {
  const children: Normalized[] = [];
  for (const attr of DATA_ATTRIBUTES) {
    const raw = el.attrs[attr];
    if (raw !== undefined && raw.trim() !== '') children.push(value(`@${attr}`, raw));
  }
  let texts = 0;
  const elements: { index: number; el: ElementNode }[] = [];
  for (const child of el.children) {
    if (child.kind === 'text') {
      children.push(value(`#text[${texts++}]`, child.value));
    } else if (child.kind === 'element') {
      const normalized = normalizeElement(child);
      if (normalized) {
        elements.push({ index: children.length, el: normalized });
        children.push(normalized);
      }
    }
  }
  // Group repeated siblings into lists, placed where the first of them was.
  const groups = new Map<string, number[]>();
  elements.forEach(({ el: child }, i) => {
    const key = fullKey(child);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const replaced = new Map<number, ListNode>();
  const removed = new Set<number>();
  for (const members of groups.values()) {
    if (members.length < MIN_REPEATS) continue;
    const items = members.map((i) => elements[i]!.el);
    stabilize(items);
    // Named like its elements, so a single one elsewhere is recognised as the same thing.
    const list: ListNode = { kind: 'list', name: elementName(items[0]!.name, items[0]!.attrs), children: items };
    replaced.set(elements[members[0]!]!.index, list);
    for (const i of members.slice(1)) removed.add(elements[i]!.index);
  }
  const out = children.flatMap((c, i) => (removed.has(i) ? [] : [replaced.get(i) ?? c]));
  if (out.length === 0) return undefined;
  // Attributes are now leaves or names; keep only those that name the element.
  const attrs: Record<string, string> = {};
  if (el.attrs.id !== undefined) attrs.id = el.attrs.id;
  if (el.attrs.class !== undefined) attrs.class = el.attrs.class;
  return { kind: 'element', name: el.name, attrs, children: out };
}

/** The position of an element among its siblings, for aligning rows. */
function positions(children: TreeNode[]): Map<string, TreeNode> {
  const out = new Map<string, TreeNode>();
  const seen = new Map<string, number>();
  for (const child of children) {
    if (child.kind !== 'element' && child.kind !== 'list') continue;
    const base = child.kind === 'element' ? primaryKey(child) : `list:${child.name}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(`${base}#${n}`, child);
  }
  return out;
}

/**
 * Make elements at the same position in different rows look the same: keep only the classes
 * and id that every one of them has, then do the same for their children, position by position.
 */
function stabilize(items: TreeNode[]): void {
  const elements = items.filter((i): i is ElementNode => i.kind === 'element');
  if (elements.length > 1) {
    const sets = elements.map((el) => new Set(classesOf(el)));
    const common = classesOf(elements[0]!).filter((c) => sets.every((s) => s.has(c)));
    const ids = new Set(elements.map((el) => el.attrs.id));
    for (const el of elements) {
      if (common.length > 0) el.attrs.class = common.join(' ');
      else delete el.attrs.class;
      if (ids.size > 1) delete el.attrs.id;
    }
  }
  const lists = items.filter((i): i is ListNode => i.kind === 'list');
  if (lists.length > 0) stabilize(lists.flatMap((l) => l.children));
  const byPosition = new Map<string, TreeNode[]>();
  for (const item of elements) {
    for (const [key, child] of positions(item.children)) {
      byPosition.set(key, [...(byPosition.get(key) ?? []), child]);
    }
  }
  for (const group of byPosition.values()) stabilize(group);
}

/** Normalise every HTML or XML file in a tree. */
export function normalizeTree(node: TreeNode): TreeNode {
  switch (node.kind) {
    case 'element':
      return normalizeElement(node) ?? { ...node, attrs: {}, children: [] };
    case 'dir':
      return { ...node, children: node.children.map(normalizeTree) };
    default:
      return node;
  }
}
