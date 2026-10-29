/**
 * A compact, flat representation of a tree: an array of nodes in breadth-first order, so the
 * children of a node are contiguous. Used to store trees in chunks and to browse them lazily.
 */
import type { NodeKind, TreeNode, ValueType } from './tree';

export interface FlatNode {
  kind: NodeKind;
  name: string;
  /** Index of the parent, -1 for the root. */
  parent: number;
  /** Index of the first child, if the node has children. */
  first?: number;
  /** Number of children. */
  count?: number;
  value?: string;
  type?: ValueType;
  attrs?: Record<string, string>;
  mime?: string;
  size?: number;
}

export function flatten(root: TreeNode): FlatNode[] {
  const out: FlatNode[] = [];
  const queue: { node: TreeNode; parent: number }[] = [{ node: root, parent: -1 }];
  for (let head = 0; head < queue.length; head++) {
    const { node, parent } = queue[head]!;
    const flat: FlatNode = { kind: node.kind, name: node.name, parent };
    switch (node.kind) {
      case 'value':
        flat.value = node.value;
        flat.type = node.type;
        break;
      case 'text':
        flat.value = node.value;
        break;
      case 'blob':
        flat.mime = node.mime;
        flat.size = node.size;
        break;
      case 'element':
        if (Object.keys(node.attrs).length > 0) flat.attrs = node.attrs;
        break;
    }
    if ('children' in node && node.children.length > 0) {
      flat.first = queue.length;
      flat.count = node.children.length;
      for (const child of node.children) queue.push({ node: child, parent: head });
    }
    out.push(flat);
    // Let the queue entry be collected; the flat array is all we keep.
    queue[head] = undefined as never;
  }
  return out;
}

export function unflatten(nodes: FlatNode[], index = 0): TreeNode {
  const flat = nodes[index];
  if (!flat) throw new Error(`no node at ${index}`);
  const children: TreeNode[] = [];
  for (let i = 0; i < (flat.count ?? 0); i++) children.push(unflatten(nodes, flat.first! + i));
  switch (flat.kind) {
    case 'value':
      return { kind: 'value', name: flat.name, value: flat.value ?? '', type: flat.type ?? 'string' };
    case 'text':
      return { kind: 'text', name: '#text', value: flat.value ?? '' };
    case 'blob':
      return { kind: 'blob', name: flat.name, mime: flat.mime ?? '', size: flat.size ?? 0 };
    case 'element':
      return { kind: 'element', name: flat.name, attrs: flat.attrs ?? {}, children };
    default:
      return { kind: flat.kind, name: flat.name, children };
  }
}

/** Names from the root (exclusive) down to the node: the node's location for paths. */
export function locationOf(nodes: FlatNode[], index: number): string[] {
  const names: string[] = [];
  for (let i = index; i > 0; i = nodes[i]!.parent) names.push(nodes[i]!.name);
  return names.reverse();
}
