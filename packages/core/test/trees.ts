// Helpers for tests on project trees: build one from a shape, and find nodes by their names.
import {
  buildTree,
  emptyConfig,
  getNode,
  toConfig,
  type NodePath,
  type ProjectConfig,
  type ProjectNode,
  type Shape,
} from '../src';

/** The project tree of a shape with nothing configured (or with `config`): every node virtual. */
export function treeOf(shape: Shape, config?: ProjectConfig): ProjectNode {
  return buildTree(config ?? emptyConfig(shape.kind), shape).tree;
}

/** The path (of ids) of the node reached by these names, each a node's `name`. */
export function at(tree: ProjectNode, ...names: string[]): NodePath {
  const path: NodePath = [];
  let node = tree;
  for (const name of names) {
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
