/**
 * The tree model: every input (archive, JSON, CSV, HTML, ...) becomes a tree of nodes.
 * See docs/universal-importer.md#the-tree-model.
 */

export type ValueType =
  | 'null'
  | 'bool'
  | 'int'
  | 'float'
  | 'string'
  | 'date-like'
  | 'url-like'
  | 'email-like';

/** A directory or archive; children are its entries. */
export interface DirNode {
  kind: 'dir';
  name: string;
  children: TreeNode[];
}

/** A JSON object or CSV row; children are keyed by name. */
export interface MapNode {
  kind: 'map';
  name: string;
  children: TreeNode[];
}

/** A JSON array, CSV file, JSON Lines file or text file; children are named by index. */
export interface ListNode {
  kind: 'list';
  name: string;
  children: TreeNode[];
}

/** A primitive value: the raw string plus an inferred type. */
export interface ValueNode {
  kind: 'value';
  name: string;
  value: string;
  type: ValueType;
}

/**
 * An HTML or XML element; `name` is the tag. The root of a parsed HTML file is an element
 * named after the file, so paths read `MyActivity.html/html/body/...`.
 */
export interface ElementNode {
  kind: 'element';
  name: string;
  attrs: Record<string, string>;
  children: TreeNode[];
}

/** Text content of an element. `name` is always `#text`. */
export interface TextNode {
  kind: 'text';
  name: '#text';
  value: string;
}

/** A binary file: type and size only, contents are not parsed. */
export interface BlobNode {
  kind: 'blob';
  name: string;
  mime: string;
  size: number;
}

export type TreeNode = DirNode | MapNode | ListNode | ValueNode | ElementNode | TextNode | BlobNode;
export type NodeKind = TreeNode['kind'];
export type ParentNode = DirNode | MapNode | ListNode | ElementNode;

export function isParent(node: TreeNode): node is ParentNode {
  return 'children' in node;
}

export function childrenOf(node: TreeNode): TreeNode[] {
  return isParent(node) ? node.children : [];
}

/** Count all nodes in a tree, including the root. */
export function countNodes(root: TreeNode): number {
  let n = 0;
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    n++;
    if (isParent(node)) stack.push(...node.children);
  }
  return n;
}
