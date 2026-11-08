/**
 * File groups: which files of an upload are read, and how they become one content tree per group
 * (docs/decisions/0016-file-groups.md).
 *
 * A configuration's root holds file groups. Each group says which files it reads (`files`: exact
 * paths, or a name in any folder) and has the content of those files below it. Before a
 * configuration is laid over a structure or a tree, the upload is turned into its *content*: a
 * root with one folder per group, holding the group's files, each renamed to the group's name.
 * Files of the same kind then share their positions, so `watch-history.html` and
 * `kijkgeschiedenis.html` are configured once. Files no group reads are not in the content.
 *
 * Raw paths do not change (ADR 0015): the root of every file in a content tree keeps where it
 * came from (`origin`), and values below it carry that path. The content is made the same way
 * everywhere: the studio, the participant's device and the name map on the key page agree on
 * which file a group reads.
 *
 * Turning something into content twice changes nothing: a content root is marked by its name.
 */
import { matchOne, type FileMatch, type Match } from './config';
import { elementName, mergeAll, screenName, type Shape } from './shape';
import type { DirNode, TreeNode } from './tree';

/** The name of a content root. No upload has it: roots are nameless, or named after a file. */
export const CONTENT_ROOT = '\u0000content';

/** A group as the content needs it: its name (its key) and the files it reads. */
export interface GroupFiles {
  key: string;
  files: FileMatch[];
}

/** What content is made from: a root whose file groups are its children (a config or project node). */
export interface GroupsHolder {
  children?: readonly { match: readonly Match[]; files?: FileMatch[] }[];
}

/** The file groups of a configuration's root, in order: their key and files. */
export function fileGroups(root: GroupsHolder): GroupFiles[] {
  return (root.children ?? []).flatMap((c) => {
    const key = c.match[0];
    return c.files !== undefined && typeof key === 'string' ? [{ key, files: c.files }] : [];
  });
}

/** A file in an upload: its path steps as shapes write them, and as they are. */
export interface FilePath {
  /** Screened, as shapes and raw paths write them (`<id>.json`, HTML files by their shape name). */
  steps: string[];
  /** The names as they are in the upload. */
  raw: string[];
}

/** Whether one step matches: as written in shapes, or as it is. */
const stepMatches = (match: Match, step: string, raw: string) => matchOne(match, step) || (raw !== step && matchOne(match, raw));

/** Whether a file match matches a file. */
export function fileMatches(match: FileMatch, file: FilePath): boolean {
  if ('path' in match) {
    return match.path.length === file.steps.length && match.path.every((m, i) => stepMatches(m, file.steps[i]!, file.raw[i]!));
  }
  const last = file.steps.length - 1;
  return last >= 0 && stepMatches(match.name, file.steps[last]!, file.raw[last]!);
}

const folderOf = (file: FilePath) => file.steps.slice(0, -1).join('/');

/**
 * Which group reads each file, by index into `groups` (undefined: none). Exact paths first, in
 * the order of the groups, then names in any folder. A name found in more than one folder reads
 * none of them: which one was meant cannot be told (ADR 0016).
 */
export function assignFiles(files: readonly FilePath[], groups: readonly GroupFiles[]): (number | undefined)[] {
  const out: (number | undefined)[] = files.map((file) =>
    groups.findIndex((g) => g.files.some((m) => 'path' in m && fileMatches(m, file))),
  ).map((i) => (i < 0 ? undefined : i));
  groups.forEach((group, g) => {
    for (const match of group.files) {
      if (!('name' in match)) continue;
      const hits = files.flatMap((file, i) => (out[i] === undefined && fileMatches(match, file) ? [i] : []));
      if (new Set(hits.map((i) => folderOf(files[i]!))).size !== 1) continue;
      for (const i of hits) out[i] = g;
    }
  });
  return out;
}

/** Files found by a name in more than one folder, by the group and match that found them: none of them is read. */
export function ambiguousNames(files: readonly FilePath[], groups: readonly GroupFiles[]): { group: string; match: FileMatch; paths: string[][] }[] {
  const exact = assignFiles(files, groups.map((g) => ({ ...g, files: g.files.filter((m) => 'path' in m) })));
  const out: { group: string; match: FileMatch; paths: string[][] }[] = [];
  for (const group of groups) {
    for (const match of group.files) {
      if (!('name' in match)) continue;
      const hits = files.filter((file, i) => exact[i] === undefined && fileMatches(match, file));
      if (new Set(hits.map(folderOf)).size > 1) out.push({ group: group.key, match, paths: hits.map((h) => h.steps) });
    }
  }
  return out;
}

// --- Shapes -----------------------------------------------------------------------------------

/** The files of a shape, with the file shapes: every position that is not a folder, or the root if it is a file. */
export function shapeFiles(shape: Shape): (FilePath & { shape: Shape })[] {
  // An upload that is one file: its name is not part of any path.
  if (shape.kind !== 'dir') return [{ steps: [], raw: [], shape }];
  const out: (FilePath & { shape: Shape })[] = [];
  const visit = (dir: Shape, steps: string[]) => {
    for (const child of dir.children ?? []) {
      const at = [...steps, child.name];
      if (child.kind === 'dir') visit(child, at);
      else out.push({ steps: at, raw: at, shape: child });
    }
  };
  visit(shape, []);
  return out;
}

/** The file shape each renamed copy in a content shape was made from (several when merged). */
const originals = new WeakMap<Shape, Shape[]>();

/** The shapes in an upload's structure that a position of its content was made from. */
export const originalShapes = (shape: Shape): Shape[] => originals.get(shape) ?? [shape];

/**
 * The content of a structure: one folder per group with a file in it, holding its files under the
 * group's name. With `merge` (the default), files of one kind are merged into one position; without
 * it they stay side by side, each the same object below its root as in `shape`.
 */
export function contentShape(shape: Shape, root: GroupsHolder, options: { merge?: boolean } = {}): Shape {
  if (shape.name === CONTENT_ROOT) return shape;
  const groups = fileGroups(root);
  const files = shapeFiles(shape);
  const assigned = assignFiles(files, groups);
  const children: Shape[] = [];
  groups.forEach((group, g) => {
    const own = files.filter((_, i) => assigned[i] === g).map((f) => f.shape);
    if (own.length === 0) return;
    const parts: Shape[] = [];
    for (const kind of [...new Set(own.map((s) => s.kind))]) {
      const ofKind = own.filter((s) => s.kind === kind);
      if (options.merge === false) {
        for (const s of ofKind) {
          const copy = { ...s, name: group.key };
          originals.set(copy, [s]);
          parts.push(copy);
        }
        continue;
      }
      const merged = ofKind.length === 1 ? { ...ofKind[0]!, name: group.key } : mergeFiles(ofKind, group.key);
      originals.set(merged, ofKind);
      parts.push(merged);
    }
    children.push({ kind: 'dir', name: group.key, children: parts });
  });
  return { kind: 'dir', name: CONTENT_ROOT, ...(children.length > 0 ? { children } : {}) };
}

function mergeFiles(shapes: Shape[], name: string): Shape {
  return mergeAll(shapes.map((s) => ({ ...s, name })))[0]!;
}

// --- Trees ------------------------------------------------------------------------------------

/** A path step of a key, as shapes write it: screened, and HTML elements by their shape name. */
export const stepOf = (node: TreeNode): string => (node.kind === 'element' ? elementName(node.name, node.attrs) : screenName(node.name));

/** The files of a tree: every node that is not a folder, or the root if it is a file (whose name is not part of any path). */
export function treeFiles(tree: TreeNode): (FilePath & { node: TreeNode })[] {
  if (tree.kind !== 'dir') return [{ steps: [], raw: [], node: tree }];
  const out: (FilePath & { node: TreeNode })[] = [];
  const visit = (dir: DirNode, steps: string[], raw: string[]) => {
    for (const child of dir.children) {
      if (child.kind === 'dir') visit(child, [...steps, screenName(child.name)], [...raw, child.name]);
      else out.push({ steps: [...steps, stepOf(child)], raw: [...raw, child.name], node: child });
    }
  };
  visit(tree, [], []);
  return out;
}

/**
 * The content of a tree: one folder per group, holding the files it reads, each renamed to the
 * group's name and keeping its raw path in `origin`.
 */
export function contentTree(tree: TreeNode, root: GroupsHolder): TreeNode {
  if (tree.name === CONTENT_ROOT) return tree;
  const groups = fileGroups(root);
  const files = treeFiles(tree);
  const assigned = assignFiles(files, groups);
  const children: TreeNode[] = [];
  groups.forEach((group, g) => {
    const own = files.filter((_, i) => assigned[i] === g);
    if (own.length === 0) return;
    children.push({
      kind: 'dir',
      name: group.key,
      children: own.map((f) => ({ ...f.node, name: group.key, origin: f.steps }) as TreeNode),
    });
  });
  return { kind: 'dir', name: CONTENT_ROOT, children };
}

/** The files of a content tree, with where each came from. */
export function contentFiles(content: TreeNode): { origin: string[]; node: TreeNode }[] {
  if (content.kind !== 'dir' || content.name !== CONTENT_ROOT) return [];
  return content.children.flatMap((group) =>
    group.kind === 'dir' ? group.children.flatMap((file) => (file.kind !== 'dir' && file.origin ? [{ origin: file.origin, node: file }] : [])) : [],
  );
}

/**
 * An upload from the content of a tree: every file back at the place it came from (`origin`), with
 * its own name. Files no group read are not in it. For adding what the studio reads through its
 * corrections to the structures seen, which are kept as uploads are.
 */
export function uploadTree(content: TreeNode): TreeNode {
  if (content.name !== CONTENT_ROOT) return content;
  const files = contentFiles(content);
  const atRoot = files.find((f) => f.origin.length === 0);
  if (atRoot) return withoutOrigin(atRoot.node, '');
  const root: DirNode = { kind: 'dir', name: '', children: [] };
  for (const file of files) {
    let dir = root;
    for (const name of file.origin.slice(0, -1)) {
      let next = dir.children.find((c): c is DirNode => c.kind === 'dir' && c.name === name);
      if (!next) dir.children.push((next = { kind: 'dir', name, children: [] }));
      dir = next;
    }
    dir.children.push(withoutOrigin(file.node, file.origin.at(-1)!));
  }
  return root;
}

function withoutOrigin(node: TreeNode, name: string): TreeNode {
  if (node.kind === 'dir') return node;
  const { origin: _origin, ...rest } = node;
  return { ...rest, name } as TreeNode;
}
