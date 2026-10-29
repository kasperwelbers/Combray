import { locationOf, type FlatNode } from '@combray/core';

import type { NodeDetail, NodeSummary, Page, SearchHit } from './api';

const PREVIEW_LENGTH = 200;

export function summarize(nodes: FlatNode[], index: number): NodeSummary {
  const node = nodes[index];
  if (!node) throw new Error(`no node ${index}`);
  const summary: NodeSummary = { index, kind: node.kind, name: node.name, childCount: node.count ?? 0 };
  if (node.value !== undefined) {
    summary.preview =
      node.value.length > PREVIEW_LENGTH ? `${node.value.slice(0, PREVIEW_LENGTH)}…` : node.value;
  }
  if (node.type) summary.type = node.type;
  if (node.mime) summary.mime = node.mime;
  if (node.size !== undefined) summary.size = node.size;
  if (node.attrs) summary.attrs = node.attrs;
  return summary;
}

export function nodeDetail(nodes: FlatNode[], index: number): NodeDetail {
  const ancestors: NodeSummary[] = [];
  for (let i = nodes[index]?.parent ?? -1; i >= 0; i = nodes[i]!.parent) {
    ancestors.unshift(summarize(nodes, i));
  }
  return { node: summarize(nodes, index), ancestors, location: locationOf(nodes, index) };
}

export function children(nodes: FlatNode[], index: number, offset: number, limit: number): Page<NodeSummary> {
  const node = nodes[index];
  if (!node) throw new Error(`no node ${index}`);
  const total = node.count ?? 0;
  const items: NodeSummary[] = [];
  const end = Math.min(total, offset + limit);
  for (let i = offset; i < end; i++) items.push(summarize(nodes, node.first! + i));
  return { total, offset, items };
}

/** Case-insensitive search over names, values and attribute values. */
export function search(nodes: FlatNode[], query: string, limit: number): Page<SearchHit> {
  const q = query.trim().toLowerCase();
  if (q === '') return { total: 0, offset: 0, items: [] };
  const items: SearchHit[] = [];
  let total = 0;
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]!;
    const hit =
      node.name.toLowerCase().includes(q) ||
      (node.value !== undefined && node.value.toLowerCase().includes(q)) ||
      (node.attrs !== undefined && Object.values(node.attrs).some((v) => v.toLowerCase().includes(q)));
    if (!hit) continue;
    total++;
    if (items.length < limit) items.push({ node: summarize(nodes, i), location: locationOf(nodes, i) });
  }
  return { total, offset: 0, items };
}

/** Files in the tree: every non-directory node whose parent is a directory (or the root file). */
export function countFiles(nodes: FlatNode[]): number {
  if (nodes[0]?.kind !== 'dir') return 1;
  let n = 0;
  for (const node of nodes) {
    if (node.kind !== 'dir' && node.parent >= 0 && nodes[node.parent]!.kind === 'dir') n++;
  }
  return n;
}
