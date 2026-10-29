import { parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';

import type { ElementNode, TreeNode } from '../tree';

// Not data: skipped entirely, including their contents.
const SKIPPED_TAGS = new Set(['script', 'style', 'noscript', 'template']);

function convert(node: ChildNode, xml: boolean): TreeNode | undefined {
  if (node.type === 'text') {
    const value = node.data.replace(/\s+/g, ' ').trim();
    return value === '' ? undefined : { kind: 'text', name: '#text', value };
  }
  if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
    const tag = xml ? node.name : node.name.toLowerCase();
    if (!xml && SKIPPED_TAGS.has(tag)) return undefined;
    return {
      kind: 'element',
      name: tag,
      attrs: { ...node.attribs },
      children: convertAll(node.children, xml),
    };
  }
  if (node.type === 'cdata') return convertAll(node.children, xml)[0];
  return undefined;
}

function convertAll(nodes: ChildNode[], xml: boolean): TreeNode[] {
  const out: TreeNode[] = [];
  for (const child of nodes) {
    const converted = convert(child, xml);
    if (converted) out.push(converted);
  }
  return out;
}

/**
 * HTML and XML become element nodes. The file itself is an element named after the file, so
 * a path reads `MyActivity.html/html/body/div.outer-cell`. Uses htmlparser2 because
 * `DOMParser` is not available in web workers.
 */
export function parseMarkup(name: string, text: string, xml = false): ElementNode {
  const doc = parseDocument(text, { xmlMode: xml, decodeEntities: true });
  return { kind: 'element', name, attrs: {}, children: convertAll(doc.children, xml) };
}
