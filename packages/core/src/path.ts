/**
 * The path language: one way to address nodes in any tree, whatever the source format.
 * See docs/universal-importer.md#paths.
 *
 * Not yet supported: embedded CSS selectors (`css(...)`).
 */
import { childrenOf, type TreeNode } from './tree';

export interface ElementSelector {
  tag?: string;
  id?: string;
  classes: string[];
}

export interface NamePattern {
  /** Matched against node names, with `*` as a wildcard and `\*` as a literal star. */
  glob: string;
  /** The same pattern read as `tag#id.class`, matched against element nodes. */
  selector?: ElementSelector;
}

export type Segment =
  | { type: 'anyDepth' }
  | { type: 'anyChild' }
  | { type: 'anyIndex' }
  | { type: 'index'; index: number }
  | { type: 'filter'; key: 'kind' | 'type'; value: string }
  | { type: 'names'; names: NamePattern[] }
  | { type: 'attr'; name: string };

export interface Path {
  segments: Segment[];
}

export type PathMatch =
  | { type: 'node'; node: TreeNode; location: string[] }
  | { type: 'attr'; node: TreeNode; location: string[]; value: string };

export class PathError extends Error {
  constructor(message: string) {
    super(`invalid path: ${message}`);
    this.name = 'PathError';
  }
}

/** Split on `/`, ignoring slashes inside `{}`, `[]`, `()` and double quotes. */
function splitSegments(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (const c of input) {
    if (c === '"') {
      quoted = !quoted;
      current += c;
    } else if (!quoted && '{[('.includes(c)) {
      depth++;
      current += c;
    } else if (!quoted && '}])'.includes(c)) {
      depth--;
      if (depth < 0) throw new PathError(`unbalanced '${c}'`);
      current += c;
    } else if (c === '/' && !quoted && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (quoted || depth !== 0) throw new PathError('unclosed quote or bracket');
  parts.push(current);
  return parts;
}

function parseSelector(pattern: string): ElementSelector | undefined {
  if (pattern === '' || pattern.includes('*')) return undefined;
  const selector: ElementSelector = { classes: [] };
  const match = /^([^.#]*)((?:[.#][^.#]+)*)$/.exec(pattern);
  if (!match) return undefined;
  if (match[1]) selector.tag = match[1].toLowerCase();
  for (const part of match[2]?.match(/[.#][^.#]+/g) ?? []) {
    if (part.startsWith('#')) selector.id = part.slice(1);
    else selector.classes.push(part.slice(1));
  }
  return selector;
}

function parseName(raw: string): NamePattern {
  const name = raw.trim();
  if (name === '') throw new PathError('empty name');
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    // Quoted names match literally: no globs, no selectors.
    return { glob: name.slice(1, -1).replaceAll('*', '\\*') };
  }
  const selector = parseSelector(name);
  return selector ? { glob: name, selector } : { glob: name };
}

function parseSegment(raw: string): Segment {
  if (raw === '') throw new PathError('empty segment');
  if (raw === '**') return { type: 'anyDepth' };
  if (raw === '*') return { type: 'anyChild' };
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1);
    if (inner === '*') return { type: 'anyIndex' };
    if (inner.startsWith('?')) {
      const eq = inner.indexOf('=');
      if (eq < 0) throw new PathError(`filter needs key=value: ${raw}`);
      const key = inner.slice(1, eq).trim();
      if (key !== 'kind' && key !== 'type') throw new PathError(`unknown filter key '${key}'`);
      return { type: 'filter', key, value: inner.slice(eq + 1).trim() };
    }
    if (!/^\d+$/.test(inner)) throw new PathError(`bad index: ${raw}`);
    return { type: 'index', index: Number(inner) };
  }
  if (raw.startsWith('@')) {
    if (raw.length === 1) throw new PathError('empty attribute name');
    return { type: 'attr', name: raw.slice(1) };
  }
  if (raw.startsWith('css(')) throw new PathError('css() segments are not supported yet');
  if (raw.startsWith('{') && raw.endsWith('}')) {
    return { type: 'names', names: raw.slice(1, -1).split(',').map(parseName) };
  }
  return { type: 'names', names: [parseName(raw)] };
}

export function parsePath(input: string): Path {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return { segments: [] };
  const segments: Segment[] = [];
  for (const raw of splitSegments(trimmed)) {
    const segment = parseSegment(raw);
    const last = segments.at(-1);
    if (segment.type === 'anyDepth' && last?.type === 'anyDepth') continue;
    if (last?.type === 'attr') throw new PathError('an attribute must be the last segment');
    segments.push(segment);
  }
  return { segments };
}

/** Glob match with `*` as "any run of characters" and `\*` as a literal star. */
export function globMatch(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const chunks: string[] = [''];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && pattern[i + 1] === '*') {
      chunks[chunks.length - 1] += '*';
      i++;
    } else if (c === '*') {
      chunks.push('');
    } else {
      chunks[chunks.length - 1] += c;
    }
  }
  if (chunks.length === 1) return chunks[0] === name;
  const first = chunks[0]!;
  const last = chunks[chunks.length - 1]!;
  if (!name.startsWith(first) || name.length < first.length + last.length) return false;
  let rest = name.slice(first.length);
  for (const chunk of chunks.slice(1, -1)) {
    const i = rest.indexOf(chunk);
    if (i < 0) return false;
    rest = rest.slice(i + chunk.length);
  }
  return rest.endsWith(last);
}

function selectorMatches(selector: ElementSelector, node: TreeNode): boolean {
  if (node.kind !== 'element') return false;
  if (selector.tag !== undefined && selector.tag !== node.name.toLowerCase()) return false;
  if (selector.id !== undefined && node.attrs.id !== selector.id) return false;
  const classes = (node.attrs.class ?? '').split(/\s+/).filter(Boolean);
  return selector.classes.every((c) => classes.includes(c));
}

function segmentMatches(segment: Segment, parent: TreeNode, child: TreeNode): boolean {
  switch (segment.type) {
    case 'anyChild':
      return true;
    case 'anyIndex':
      return parent.kind === 'list';
    case 'index':
      return parent.kind === 'list' && child.name === String(segment.index);
    case 'filter':
      if (segment.key === 'kind') return child.kind === segment.value;
      return (
        child.kind === 'value' &&
        (child.type === segment.value || child.type === `${segment.value}-like`)
      );
    case 'names':
      return segment.names.some(
        (p) =>
          globMatch(p.glob, child.name) ||
          (p.selector !== undefined && selectorMatches(p.selector, child)),
      );
    default:
      return false;
  }
}

function walk(node: TreeNode, segments: Segment[], location: string[], out: PathMatch[]): void {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    out.push({ type: 'node', node, location: [...location] });
    return;
  }
  if (segment.type === 'anyDepth') {
    walk(node, rest, location, out);
    for (const child of childrenOf(node)) {
      location.push(child.name);
      walk(child, segments, location, out);
      location.pop();
    }
    return;
  }
  if (segment.type === 'attr') {
    if (node.kind === 'element' && segment.name in node.attrs) {
      out.push({
        type: 'attr',
        node,
        location: [...location, `@${segment.name}`],
        value: node.attrs[segment.name]!,
      });
    }
    return;
  }
  for (const child of childrenOf(node)) {
    if (segmentMatches(segment, node, child)) {
      location.push(child.name);
      walk(child, rest, location, out);
      location.pop();
    }
  }
}

/** All matches of a path, starting from the children of `root`, in document order. */
export function findPath(root: TreeNode, path: Path | string): PathMatch[] {
  const parsed = typeof path === 'string' ? parsePath(path) : path;
  const out: PathMatch[] = [];
  walk(root, parsed.segments, [], out);
  return out;
}
