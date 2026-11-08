// Helpers for tests on project trees: build one from a shape, and find nodes by their names.
import {
  buildTree,
  getNode,
  includeAll,
  toConfig,
  type NodePath,
  type ProjectConfig,
  type ProjectNode,
  type Shape,
} from '../src';

/**
 * The project tree of a shape with nothing configured (or with `config`): every file read by a
 * group of its own (`includeAll`), and every node in them virtual.
 */
export function treeOf(shape: Shape, config?: ProjectConfig): ProjectNode {
  return buildTree(config ?? includeAll(shape), shape).tree;
}

/**
 * The child of the root reached by a name: a group, or the content of the group that reads a file
 * with that name (or the upload itself), so tests can name files as they are in the upload.
 */
function fromRoot(tree: ProjectNode, name: string): { node: ProjectNode; path: NodePath } | undefined {
  const own = tree.children?.find((c) => c.name === name);
  if (own) return { node: own, path: [own.id] };
  const groups = (tree.children ?? []).filter((c) => c.files !== undefined);
  const byFile = groups.find((g) => g.files!.some((m) => ('path' in m ? m.path.at(-1) : m.name) === name));
  if (byFile?.children?.[0]) return { node: byFile.children[0], path: [byFile.id, byFile.children[0].id] };
  // The upload is one file: its content.
  const upload = groups.find((g) => g.files!.some((m) => 'path' in m && m.path.length === 0));
  const file = upload?.children?.find((c) => c.children?.some((k) => k.name === name));
  const next = file?.children?.find((k) => k.name === name);
  return next ? { node: next, path: [upload!.id, file!.id, next.id] } : undefined;
}

/** The path (of ids) of the node reached by these names, each a node's `name`. */
export function at(tree: ProjectNode, ...names: string[]): NodePath {
  const path: NodePath = [];
  let node = tree;
  for (const name of names) {
    if (node === tree && tree.children?.some((c) => c.files !== undefined)) {
      const found = fromRoot(tree, name);
      if (found) {
        path.push(...found.path);
        node = found.node;
        continue;
      }
    }
    const next = node.children?.find((c) => c.name === name);
    if (!next) throw new Error(`no ${name} below ${node.name || 'the root'} (${node.children?.map((c) => c.name).join(', ')})`);
    path.push(next.id);
    node = next;
  }
  return path;
}

/** The node reached by these names. */
export function nodeAt(tree: ProjectNode, ...names: string[]): ProjectNode {
  return getNode(tree, at(tree, ...names))!;
}

/** The configuration of a tree, laid over a shape again: what the studio does after an edit. */
export function rebuild(tree: ProjectNode, shape?: Shape): ProjectNode {
  return buildTree({ root: toConfig(tree) }, shape).tree;
}

/**
 * A project tree of a shape where every node is configured, with its key as its id: column ids
 * read like paths (`stats/likes`), for tests about what is done with the tables.
 */
export function keyedTree(shape: Shape): ProjectNode {
  const visit = (node: ProjectNode): ProjectNode => {
    const { virtual: _virtual, ...rest } = node;
    return { ...rest, id: node.name || node.id, ...(node.children ? { children: node.children.map(visit) } : {}) };
  };
  return visit(treeOf(shape));
}

/** The path of the content of the one file a tree reads: its group, and the file below it. */
export function filePath(tree: ProjectNode): NodePath {
  const group = tree.children!.find((c) => c.files !== undefined)!;
  return [group.id, group.children![0]!.id];
}

/** The content of the one file a tree reads (the root of a configuration from before file groups). */
export const fileOf = (tree: ProjectNode): ProjectNode => getNode(tree, filePath(tree))!;
