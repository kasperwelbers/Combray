import type { ListNode, TreeNode } from '../tree';
import { valueNode } from './text';

/** Convert a parsed JSON value into a tree. `name` is the name of the root (usually the filename). */
export function jsonToTree(name: string, json: unknown): TreeNode {
  if (json === null || json === undefined) return { kind: 'value', name, value: '', type: 'null' };
  if (Array.isArray(json)) {
    return { kind: 'list', name, children: json.map((v, i) => jsonToTree(String(i), v)) };
  }
  switch (typeof json) {
    case 'object':
      return {
        kind: 'map',
        name,
        children: Object.entries(json as Record<string, unknown>).map(([k, v]) => jsonToTree(k, v)),
      };
    case 'boolean':
      return { kind: 'value', name, value: String(json), type: 'bool' };
    case 'number':
      return valueNode(name, String(json));
    default:
      return valueNode(name, String(json));
  }
}

// Some exports wrap JSON in a script assignment, e.g. `window.YTD.tweets.part0 = [...]`.
const SCRIPT_PREFIX = /^\s*(?:window|var|let|const)[\w.$\s]*=\s*/;

/** Parse JSON text, also accepting a leading `window.x = ` assignment. Throws on invalid JSON. */
export function parseJson(name: string, text: string): TreeNode {
  const body = text.replace(/^﻿/, '');
  try {
    return jsonToTree(name, JSON.parse(body));
  } catch (error) {
    const stripped = body.replace(SCRIPT_PREFIX, '').replace(/;\s*$/, '');
    if (stripped === body) throw error;
    return jsonToTree(name, JSON.parse(stripped));
  }
}

/** JSON Lines / NDJSON: one JSON value per line. Blank lines are skipped. */
export function parseJsonLines(name: string, text: string): ListNode {
  const children: TreeNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    children.push(jsonToTree(String(children.length), JSON.parse(line)));
  }
  return { kind: 'list', name, children };
}
