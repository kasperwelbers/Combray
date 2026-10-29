/**
 * Shape extraction: the structure of a tree with all values removed.
 *
 * See docs/universal-importer.md#structure-metadata. A shape keeps node kinds, names
 * (screened), bucketed list lengths and inferred value types. It never contains values.
 * Dictionary-like maps and directories (keys that are themselves data, such as usernames or
 * dates) are collapsed to `{*}`. The thresholds are first guesses and need tuning on
 * real-world shapes from consenting team members.
 */
import { inferType } from './infer';
import type { NodeKind, TreeNode, ValueType } from './tree';

export interface Shape {
  kind: NodeKind;
  name: string;
  /** Bucketed number of children, for lists and collapsed maps or directories. */
  count?: CountBucket;
  /** Inferred types seen at this position, for values. */
  types?: ValueType[];
  /** MIME type, for blobs. */
  mime?: string;
  /** True if the children's names were collapsed to `{*}`. */
  collapsed?: true;
  children?: Shape[];
}

export const ITEM_NAME = '[*]';
export const COLLAPSED_NAME = '{*}';

const BUCKETS = ['0', '1', '2-10', '11-100', '101-1k', '>1k'] as const;
export type CountBucket = (typeof BUCKETS)[number];

export function countBucket(n: number): CountBucket {
  if (n <= 0) return '0';
  if (n === 1) return '1';
  if (n <= 10) return '2-10';
  if (n <= 100) return '11-100';
  if (n <= 1000) return '101-1k';
  return '>1k';
}

const PHONE = /^\+?\d[\d\s().-]{7,}\d$/;
const DIGIT_RUN = /\d{6,}/;
const USER_ID = /^[A-Za-z0-9._-]*[A-Za-z][A-Za-z0-9._-]*_\d{3,}$/;
const HEX_TOKEN = /^[0-9a-fA-F]{16,}$/;
const B64_TOKEN = /^[A-Za-z0-9+/_=-]{24,}$/;
const EXTENSION = /\.[A-Za-z0-9]{1,5}$/;

function screenTyped(name: string): string | undefined {
  switch (inferType(name)) {
    case 'email-like':
      return '<email>';
    case 'url-like':
      return '<url>';
    case 'date-like':
      return '<date>';
    case 'int':
    case 'float':
      return '<number>';
  }
  return undefined;
}

function screenPattern(name: string): string | undefined {
  if (HEX_TOKEN.test(name) || (B64_TOKEN.test(name) && /\d/.test(name))) return '<token>';
  if (PHONE.test(name) || DIGIT_RUN.test(name)) return '<number>';
  if (USER_ID.test(name)) return '<id>';
  return undefined;
}

/**
 * Replace names that look like data (emails, numbers, dates, ids, tokens) with a type marker.
 * A file extension is kept: `johnsmith_1234.json` becomes `<id>.json`.
 */
export function screenName(name: string): string {
  const typed = screenTyped(name);
  if (typed) return typed;
  const ext = EXTENSION.exec(name);
  if (ext && ext.index > 0) {
    const stem = name.slice(0, ext.index);
    const marker = screenTyped(stem) ?? screenPattern(stem);
    if (marker) return marker + ext[0];
  }
  return screenPattern(name) ?? name;
}

/** The shape name of an element: its tag, id and sorted classes, screened. */
export function elementName(tag: string, attrs: Record<string, string>): string {
  // Tags are already lowercased by the HTML parser; the root of a file is named after the file.
  let name = screenName(tag);
  if (attrs.id !== undefined) name += `#${screenName(attrs.id)}`;
  const classes = [...new Set((attrs.class ?? '').split(/\s+/).filter(Boolean).map(screenName))];
  for (const c of classes.sort()) name += `.${c}`;
  return name;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function merge(a: Shape, b: Shape): Shape {
  const out: Shape = { ...a };
  if (a.types || b.types) {
    out.types = [...new Set([...(a.types ?? []), ...(b.types ?? [])])].sort(compare);
  }
  if (a.count || b.count) {
    const rank = (c?: CountBucket) => (c ? BUCKETS.indexOf(c) : -1);
    out.count = rank(b.count) > rank(a.count) ? b.count : a.count;
  }
  if (!a.mime && b.mime) out.mime = b.mime;
  if (a.collapsed || b.collapsed) out.collapsed = true;
  if (a.children || b.children) {
    out.children = mergeAll([...(a.children ?? []), ...(b.children ?? [])]);
  }
  return out;
}

/** Merge shapes with the same name and kind, and sort by name, then kind. */
export function mergeAll(shapes: Shape[]): Shape[] {
  const byKey = new Map<string, Shape>();
  for (const shape of shapes) {
    const key = `${shape.name}\u0000${shape.kind}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? merge(existing, shape) : shape);
  }
  return [...byKey.values()].sort((a, b) => compare(a.name, b.name) || compare(a.kind, b.kind));
}

/** The top-level structure of a shape, ignoring its own name. */
function signature(shape: Shape): string {
  const parts = (shape.children ?? []).map((c) => `${c.kind}:${c.name}`).sort(compare);
  return `${shape.kind}(${parts.join(',')})`;
}

/** A map or directory is dictionary-like if its keys are data rather than structure. */
function isDictionaryLike(names: string[], children: Shape[]): boolean {
  const n = names.length;
  if (n < 2) return false;
  const screened = names.filter((name) => screenName(name) !== name).length;
  if (screened * 2 >= n) return true;
  if (n < 5) return false;
  if (children.some((c) => c.kind === 'value' || c.kind === 'text' || c.kind === 'blob')) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const c of children) {
    const s = signature(c);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return Math.max(...counts.values()) * 5 >= n * 4;
}

function withChildren(shape: Shape, children: Shape[]): Shape {
  return children.length > 0 ? { ...shape, children } : shape;
}

/** Extract the shape of a tree. Values are never copied into the shape. */
export function extractShape(node: TreeNode): Shape {
  switch (node.kind) {
    case 'value':
      return { kind: 'value', name: screenName(node.name), types: [node.type] };
    case 'text':
      return { kind: 'text', name: '#text' };
    case 'blob':
      return { kind: 'blob', name: screenName(node.name), mime: node.mime };
    case 'list':
      return withChildren(
        { kind: 'list', name: screenName(node.name), count: countBucket(node.children.length) },
        mergeAll(node.children.map((c) => ({ ...extractShape(c), name: ITEM_NAME }))),
      );
    case 'element':
      return withChildren(
        { kind: 'element', name: elementName(node.name, node.attrs) },
        mergeAll(node.children.map(extractShape)),
      );
    case 'map':
    case 'dir': {
      const shapes = node.children.map(extractShape);
      const base: Shape = { kind: node.kind, name: screenName(node.name) };
      if (isDictionaryLike(node.children.map((c) => c.name), shapes)) {
        return withChildren(
          { ...base, collapsed: true, count: countBucket(node.children.length) },
          mergeAll(shapes.map((s) => ({ ...s, name: COLLAPSED_NAME }))),
        );
      }
      return withChildren(base, mergeAll(shapes));
    }
  }
}

/** Number of distinct positions (shape nodes) in a shape, for summaries. */
export function shapeSize(shape: Shape): number {
  return 1 + (shape.children ?? []).reduce((n, c) => n + shapeSize(c), 0);
}
