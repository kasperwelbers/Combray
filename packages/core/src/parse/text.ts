import { inferType } from '../infer';
import type { ListNode, TreeNode, ValueNode } from '../tree';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const LATIN = new TextDecoder('windows-1252');

/**
 * Decode bytes as UTF-8, falling back to Windows-1252 for exports that are not valid UTF-8
 * (the successor of `reparseAsUTF8` in data-donation-importers).
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return LATIN.decode(bytes);
  }
}

export function valueNode(name: string, raw: string): ValueNode {
  return { kind: 'value', name, value: raw, type: inferType(raw) };
}

/** A plain text file becomes a list of lines. */
export function parseText(name: string, text: string): ListNode {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return { kind: 'list', name, children: lines.map((line, i) => valueNode(String(i), line)) };
}

/** Build a list node from items, naming each child by its index. */
export function listOf(name: string, items: TreeNode[]): ListNode {
  return { kind: 'list', name, children: items };
}
