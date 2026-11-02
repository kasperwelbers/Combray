/**
 * Nodes seen together: two nodes that occur in one export are different nodes, so they must
 * never be merged. See docs/structure-versions.md.
 *
 * The evidence is a list of shapes (whole exports). A node of the project tree occurs in a
 * shape when the shape has a path whose every step matches the node's ancestors by canonical
 * name or alias. Absence proves nothing, so only shapes with both nodes count.
 */
import { nameMatches, type NodePath, type ProjectNode } from './decisions';
import { COLLAPSED_NAME } from './shape';
import type { Shape } from './shape';

/** The tree nodes along a canonical path, root excluded, or undefined if one is missing. */
function nodesAlong(root: ProjectNode, path: NodePath): ProjectNode[] | undefined {
  const out: ProjectNode[] = [];
  let node = root;
  for (const name of path) {
    const next = node.children?.find((c) => c.name === name);
    if (!next) return undefined;
    out.push(next);
    node = next;
  }
  return out;
}

/** Whether a shape child is the tree node `node` that sits below `parent`. */
function matches(parent: ProjectNode, node: ProjectNode, child: Shape): boolean {
  if (child.kind !== node.kind) return false;
  // Below a map whose keys are data, every key is the one `{*}` position.
  if (parent.collapsed) return node.name === COLLAPSED_NAME;
  return nameMatches(node, child.name);
}

/** Whether the node at `path` occurs in `shape`. */
export function occursIn(root: ProjectNode, shape: Shape, path: NodePath): boolean {
  const along = nodesAlong(root, path);
  if (!along) return false;
  const visit = (s: Shape, parent: ProjectNode, depth: number): boolean => {
    if (depth === along.length) return true;
    const node = along[depth]!;
    return (s.children ?? []).some((c) => matches(parent, node, c) && visit(c, node, depth + 1));
  };
  return visit(shape, root, 0);
}

/**
 * How many of the shapes contain both nodes. More than zero means they are different nodes,
 * and merging them would be wrong.
 */
export function seenTogether(root: ProjectNode, shapes: readonly Shape[], a: NodePath, b: NodePath): number {
  return shapes.filter((shape) => occursIn(root, shape, a) && occursIn(root, shape, b)).length;
}
