/**
 * The name map of a project tree: its configuration as keys to match path steps, with the names
 * of its tables and fields (docs/decisions/0015-raw-paths-and-relational-export.md).
 *
 * Published with every version (in the importer file), so the key page can place each donated
 * value, by its raw path, under the newest names (`placements` in `@combray/seal`). Only
 * configured nodes are in it: a path that only a part nobody configured would match is not
 * donated, and a donated path that no configured node matches any more is deprecated.
 * Structure only: keys, regular expressions and names.
 */
import { NAME_MAP_FORMAT, type NameMap, type NameNode } from '@combray/seal/names';

import { isItemNode, isKeysNode } from './config';
import { getNode, isLeaf, type NodePath, type ProjectNode } from './decisions';
import { deriveTables, pathKey, treeNames, type TreeNames } from './derive';
import { COLLAPSED_NAME, ITEM_NAME } from './shape';

/** The table a list of plain values becomes in the export: `tweets_hashtags`, `record_tags` for loose ones. */
export const listTable = (table: string, field: string) => `${table || 'record'}_${field}`;

/** Whether a node is the rows of a table in `names` (its entries are rows), and which. */
function tableAt(names: TreeNames, path: NodePath) {
  if (path.length === 0) return undefined;
  const key = pathKey(path);
  return names.tables.find((t) => t.rows.length > 0 && pathKey(t.rows) === key);
}

/** The name map of a project tree (`buildTree` of a configuration over the seen structures). */
export function nameMap(root: ProjectNode): NameMap {
  const names = treeNames(root);
  const visit = (node: ProjectNode, path: NodePath): NameNode | undefined => {
    if (node.virtual) return undefined;
    const out: NameNode = {};
    if (path.length > 0) {
      if (isItemNode(node)) out.k = ITEM_NAME;
      else if (isKeysNode(node)) out.k = COLLAPSED_NAME;
      else out.m = node.match.map((m) => (typeof m === 'string' ? m : { regex: m.regex, ...(m.flags ? { flags: m.flags } : {}) }));
    }
    const table = tableAt(names, path);
    if (table) {
      if (node.name === ITEM_NAME || node.name === COLLAPSED_NAME) out.t = table.id;
      else out.z = table.id;
    }
    if (isLeaf(node)) {
      const field = names.fields.get(pathKey(path));
      if (field) {
        out.f = field.id;
        // A list of plain values outside a side-by-side table: a table of its own in the export.
        const own = names.tables[field.table];
        const rows = own && own.rows.length > 0 ? getNode(root, own.rows)?.name : undefined;
        const sideBySide = rows !== undefined && rows !== ITEM_NAME && rows !== COLLAPSED_NAME;
        if (node.name === ITEM_NAME && !sideBySide) out.l = listTable(own?.id ?? '', field.id);
      }
    } else {
      const children = (node.children ?? []).flatMap((c) => visit(c, [...path, c.id]) ?? []);
      if (children.length > 0) out.c = children;
      if (node.kind === 'list' && node.children?.some((c) => c.name === ITEM_NAME && c.kind === 'element')) out.one = true;
    }
    return out;
  };
  return { format: NAME_MAP_FORMAT, root: visit(root, []) ?? {} };
}

/**
 * Tables participants are asked to donate whose name says nothing but structure: given by an
 * HTML element (`div_mdl_cell`), a position or an attribute, not by a key, a file or the
 * researcher. Publishing is refused while there are any (ADR 0015): exports are read by name.
 */
export function structureOnlyTables(root: ProjectNode): string[] {
  const names = treeNames(root);
  const shown = new Set(deriveTables(root).flatMap((t) => (t.state === 'donate' ? [t.id] : [])));
  const out = new Set<string>();
  for (const table of names.tables) {
    if (table.own || table.rows.length === 0 || !shown.has(table.id)) continue;
    const source = table.source ? getNode(root, table.source) : undefined;
    const parent = table.source ? getNode(root, table.source.slice(0, -1)) : undefined;
    const name = source?.name ?? '';
    // An HTML file names its tables; the elements inside it do not.
    const inMarkup = parent !== undefined && parent.kind === 'element';
    const markup = (source?.kind === 'element' || source?.kind === 'list') && inMarkup;
    if (!source || table.source!.length === 0 || markup || /^[#@]/.test(name)) out.add(table.id);
  }
  return [...out];
}
