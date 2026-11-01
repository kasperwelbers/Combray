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
 * - Semantic HTML: a `<table>` becomes a list of rows, each a map from column to cell, and a
 *   `<dl>` becomes a map from term to description. Header and term text is only used as a key
 *   when `keys` allows it (the client allows names the project tree knows, so text from a
 *   participant's file never becomes a name in a shape); otherwise cells are named by position
 *   (`#cell[0]`, `#dd[0]`) and terms stay values (`#dt[0]`).
 *
 * The input tree is not changed. Directories and other files pass through.
 */
import { inferType } from './infer';
import { uploadRoot } from './parse';
import { elementName } from './shape';
import type { ElementNode, ListNode, MapNode, TreeNode, ValueNode } from './tree';

/** Repeated siblings needed before they count as a list. */
export const MIN_REPEATS = 2;

/** Attributes whose values are data. Others (class, id, style) are structure or layout. */
const DATA_ATTRIBUTES = ['href', 'src', 'datetime', 'title', 'alt', 'value', 'content'];

type Normalized = ElementNode | ListNode | ValueNode | MapNode;

export interface NormalizeOptions {
  /**
   * Whether text from a table header or a `<dl>` term may become a key. Defaults to never.
   * Participants' clients allow the names and aliases of the project tree; the researcher
   * workspace allows any, since it shows the researcher's own export.
   */
  keys?: (text: string) => boolean;
}

const NO_KEYS = () => false;

const classesOf = (el: ElementNode) => (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
const primaryKey = (el: ElementNode) => `${el.name}.${classesOf(el)[0] ?? ''}`;
const fullKey = (el: ElementNode) => `${el.name}.${[...new Set(classesOf(el))].sort().join('.')}`;

function value(name: string, raw: string): ValueNode {
  return { kind: 'value', name, value: raw, type: inferType(raw) };
}

/** Elements that sit inside running text. */
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'span', 'small', 'mark', 'code', 'u', 's', 'sub', 'sup', 'abbr', 'time', 'img', 'font', 'label']);
/** Elements that are list items by their nature, whatever their content. */
const ITEM_TAGS = new Set(['li', 'tr', 'option', 'article']);

/** The children an element has, by name, and whether it has text: for telling items apart. */
const signature = (el: ElementNode) =>
  [...new Set(el.children.map((c) => (c.kind === 'value' ? c.name.replace(/\[\d+\]$/, '') : `<${c.name}>`)))].sort().join(',');

/**
 * Whether siblings with the same tag and classes are items of a list. Classes are a strong
 * hint, and so are three or more of them; two bare elements (no classes) only count when they
 * hold the same kinds of things.
 */
function looksRepeated(items: ElementNode[]): boolean {
  if (items.length >= 3 || ITEM_TAGS.has(items[0]!.name) || classesOf(items[0]!).length > 0) return true;
  return new Set(items.map(signature)).size === 1;
}

/**
 * A link around a single element (`<a href><div>date</div></a>`, present in some rows and not
 * in others) gives its link to that element instead, so the element keeps one position.
 */
function unwrapLink(link: ElementNode): ElementNode {
  const [only, ...rest] = link.children.filter((c) => c.kind !== 'value' || !c.name.startsWith('@'));
  if (!only || rest.length > 0 || only.kind !== 'element') return link;
  const attributes = link.children.filter((c) => c.kind === 'value' && c.name.startsWith('@'));
  return { ...only, children: [...attributes, ...only.children.filter((c) => !attributes.some((a) => a.name === c.name))] };
}

/** Normalise one element and everything below it. Returns undefined if nothing is left. */
function normalizeElement(el: ElementNode, options: Required<NormalizeOptions>): Normalized | undefined {
  if (el.name === 'table') return normalizeTable(el, options);
  if (el.name === 'dl') return normalizeDl(el, options);
  if (el.name === 'a') {
    const normalized = normalizeGeneric(el, options);
    return normalized?.kind === 'element' ? unwrapLink(normalized) : normalized;
  }
  return normalizeGeneric(el, options);
}

function normalizeGeneric(el: ElementNode, options: Required<NormalizeOptions>): Normalized | undefined {
  const children: Normalized[] = [];
  for (const attr of DATA_ATTRIBUTES) {
    const raw = el.attrs[attr];
    if (raw !== undefined && raw.trim() !== '') children.push(value(`@${attr}`, raw));
  }
  let texts = 0;
  const elements: { index: number; el: ElementNode }[] = [];
  // In running text (`Watched <a>title</a><br><a>channel</a>`), inline elements are positions
  // like the text around them: `a[0]`, `a[1]`, whether a row has one link or two.
  const mixed = el.children.some((c) => c.kind === 'text');
  const inline = new Map<string, number>();
  for (const child of el.children) {
    if (child.kind === 'text') {
      children.push(value(`#text[${texts++}]`, child.value));
    } else if (child.kind === 'element') {
      let normalized = normalizeElement(child, options);
      if (normalized?.kind === 'element' && normalized.name === child.name && mixed && INLINE_TAGS.has(child.name)) {
        const n = inline.get(child.name) ?? 0;
        inline.set(child.name, n + 1);
        normalized = { ...normalized, name: `${child.name}[${n}]` };
      }
      if (normalized?.kind === 'element') elements.push({ index: children.length, el: normalized });
      if (normalized) children.push(normalized);
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
    if (!looksRepeated(items)) {
      // Two different things that share a bare tag (`<div>link</div><div>emoji</div>`).
      items.forEach((item, n) => (item.name = `${item.name}[${n}]`));
      continue;
    }
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

/** All text below a node, whitespace collapsed. */
function textOf(node: TreeNode): string {
  if (node.kind === 'text') return node.value;
  if (node.kind !== 'element') return '';
  return node.children.map(textOf).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

const elementChildren = (el: ElementNode, ...tags: string[]) =>
  el.children.filter((c): c is ElementNode => c.kind === 'element' && tags.includes(c.name));

/**
 * The content of a table cell or `<dd>` under a name: a value when it is only text, else a map
 * of its normalised content (links, positional text). Undefined when it is empty.
 */
function cell(el: ElementNode, name: string, options: Required<NormalizeOptions>): ValueNode | MapNode | undefined {
  const normalized = normalizeElement({ ...el, attrs: {} }, options);
  if (!normalized) return undefined;
  const children = normalized.kind === 'element' ? normalized.children : [normalized];
  if (children.every((c) => c.kind === 'value' && c.name.startsWith('#text['))) {
    return value(name, (children as ValueNode[]).map((c) => c.value).join(' '));
  }
  return { kind: 'map', name, children };
}

/** A key from header or term text, if allowed and usable as a name. */
function keyFor(text: string, options: Required<NormalizeOptions>): string | undefined {
  const key = text.trim();
  return key !== '' && !key.includes('/') && options.keys(key) ? key : undefined;
}

/**
 * A `<table>`: a list of rows, each a map from column to cell. The header is the `<thead>` row,
 * or else a first row of only `<th>` cells. Columns are keyed by their header text where that
 * is allowed, else by position. Spanning cells are not expanded.
 */
function normalizeTable(table: ElementNode, options: Required<NormalizeOptions>): ListNode | undefined {
  const sections = elementChildren(table, 'thead', 'tbody', 'tfoot');
  const head = sections.filter((s) => s.name === 'thead').flatMap((s) => elementChildren(s, 'tr'));
  let rows = [
    ...elementChildren(table, 'tr'),
    ...sections.filter((s) => s.name !== 'thead').flatMap((s) => elementChildren(s, 'tr')),
  ];
  let header = head[0];
  if (!header && rows[0] && elementChildren(rows[0], 'td').length === 0 && elementChildren(rows[0], 'th').length > 0) {
    header = rows[0];
    rows = rows.slice(1);
  }
  const titles = header ? elementChildren(header, 'th', 'td').map(textOf) : [];
  const items: MapNode[] = [];
  for (const row of rows) {
    const used = new Set<string>();
    const cells = elementChildren(row, 'th', 'td').flatMap((td, i) => {
      let name = titles[i] !== undefined ? keyFor(titles[i]!, options) : undefined;
      if (name === undefined || used.has(name)) name = `#cell[${i}]`;
      used.add(name);
      const out = cell(td, name, options);
      return out ? [out] : [];
    });
    if (cells.length > 0) items.push({ kind: 'map', name: String(items.length), children: cells });
  }
  if (items.length === 0) return undefined;
  return { kind: 'list', name: elementName('table', table.attrs), children: items };
}

/**
 * A `<dl>`: a map from term to description. A term is the key where that is allowed; else the
 * pair is kept by position, the term as a value (`#dt[0]`) next to its description (`#dd[0]`).
 * Several descriptions for one term become a list.
 */
function normalizeDl(dl: ElementNode, options: Required<NormalizeOptions>): MapNode | undefined {
  // Terms and descriptions may be wrapped in a `<div>` per pair, as HTML allows.
  const parts = dl.children.flatMap((c) =>
    c.kind === 'element' && c.name === 'div' ? elementChildren(c, 'dt', 'dd') : c.kind === 'element' && (c.name === 'dt' || c.name === 'dd') ? [c] : [],
  );
  const pairs: { term: string; descriptions: ElementNode[] }[] = [];
  for (const part of parts) {
    if (part.name === 'dt') pairs.push({ term: textOf(part), descriptions: [] });
    else if (pairs.length > 0) pairs.at(-1)!.descriptions.push(part);
    else pairs.push({ term: '', descriptions: [part] });
  }
  const children: Normalized[] = [];
  const used = new Set<string>();
  pairs.forEach(({ term, descriptions }, i) => {
    let name = keyFor(term, options);
    if (name === undefined || used.has(name)) {
      name = `#dd[${i}]`;
      if (term !== '') children.push(value(`#dt[${i}]`, term));
    }
    used.add(name);
    const cells = descriptions.flatMap((d, j) => {
      const out = cell(d, String(j), options);
      return out ? [out] : [];
    });
    if (cells.length === 1) children.push({ ...cells[0]!, name });
    else if (cells.length > 1) children.push({ kind: 'list', name, children: cells });
  });
  if (children.length === 0) return undefined;
  return { kind: 'map', name: elementName('dl', dl.attrs), children };
}

/**
 * Normalise every HTML or XML file in a tree. `keys` says which header and term text may
 * become keys (see `NormalizeOptions`).
 */
export function normalizeTree(node: TreeNode, options: NormalizeOptions = {}): TreeNode {
  const opts: Required<NormalizeOptions> = { keys: options.keys ?? NO_KEYS };
  switch (node.kind) {
    case 'element': {
      const normalized = normalizeElement(node, opts);
      // A file is always an element, so paths into it keep their first step.
      if (normalized?.kind === 'element') return normalized;
      return { kind: 'element', name: node.name, attrs: {}, children: normalized ? [normalized] : [] };
    }
    case 'dir':
      return { ...node, children: node.children.map((c) => normalizeTree(c, options)) };
    default:
      return node;
  }
}

/**
 * An upload as it is matched against a project tree: without its own name, unwrapped from a
 * single top folder (for archives), and normalised.
 */
export function prepareUpload(tree: TreeNode, archive: boolean, options: NormalizeOptions = {}): TreeNode {
  return normalizeTree(uploadRoot(tree, archive), options);
}
