/**
 * What changes for donations when a new version of a project is published
 * (docs/decisions/0013-names-labels-versions.md#changes-after-publishing).
 *
 * Every published version is kept, and each donation says which one it was made with, so a new
 * version never changes the values of donations already made. Their names do follow: the key page
 * places every value by its raw path under the newest names (ADR 0015). What a version can change
 * is how donations made from now on compare with the earlier ones:
 *
 * - safe: more is asked (a field or table to donate, a platform, another date format to try), or
 *   the same under another name (earlier donations follow the new name);
 * - narrowing: less is asked (no longer donated, a filter that leaves out more rows);
 * - breaking: the same data read in another way, so earlier and later donations differ for the
 *   same field, or a donated path the new version no longer matches at all (deprecated: earlier
 *   values there are left out of exports unless asked for).
 *
 * Compared are the donated tables and fields of each platform, by their names, over the
 * structures seen by the new version.
 */
import { placements } from '@combray/seal/names';

import { buildTree, getNode, type NodePath, type ProjectNode } from './decisions';
import { deriveTables, type ColumnDef, type TableDef } from './derive';
import { nameMap } from './nameMap';
import type { ProjectConfig } from './config';
import type { Shape } from './shape';

export type ChangeKind = 'safe' | 'narrowing' | 'breaking';

export interface VersionChange {
  kind: ChangeKind;
  platform: string;
  change:
    | 'platform-added'
    | 'platform-removed'
    | 'added'
    | 'no-longer-donated'
    | 'renamed'
    | 'deprecated'
    | 'read-differently'
    | 'more-formats'
    | 'filter-added'
    | 'filter-removed'
    | 'filter-changed';
  /** The table, by its name in the earlier version (the new one for something added). */
  table?: string;
  /** The field, the same way; none for a change to a whole table. */
  field?: string;
  /** For a rename: the new name (`table` or `table/field`). */
  to?: string;
}

/** A platform as published: its configuration and the structures seen. */
export interface PlatformVersion {
  config: ProjectConfig;
  seen?: Shape;
}

interface Donated {
  table: string;
  field?: string;
  /** Where its data is, as keys from the root: the same across versions. */
  keys: string;
  /** The same as a path, for the name map. */
  path: string[];
  column?: ColumnDef;
  filter?: string;
}

const namesOf = (tree: ProjectNode, path: NodePath) => path.map((_, i) => getNode(tree, path.slice(0, i + 1))?.name ?? '');

/** The donated tables and fields of a platform, by `table` and `table/field`. */
function donated(tree: ProjectNode): Map<string, Donated> {
  const tables = deriveTables(tree);
  const out = new Map<string, Donated>();
  const tableName = (t: TableDef): string => {
    const parent = t.parent === undefined ? undefined : tables[t.parent];
    return parent ? `${tableName(parent)}/${t.id}` : t.id;
  };
  for (const table of tables) {
    const columns = table.columns.filter((c) => c.state === 'donate' && c.type !== 'table');
    if (columns.length === 0) continue;
    const name = tableName(table);
    const path = namesOf(tree, table.node);
    out.set(name, {
      table: name,
      keys: path.join('/'),
      path,
      ...(table.filter?.length ? { filter: JSON.stringify(table.filter) } : {}),
    });
    for (const column of columns) {
      const at = namesOf(tree, column.at);
      out.set(`${name}\u0000${column.id}`, { table: name, field: column.id, keys: at.join('/'), path: at, column });
    }
  }
  return out;
}

const formats = (f: string | string[] | undefined) => (f === undefined ? [] : Array.isArray(f) ? f : [f]);

/** How a column is read, apart from its date formats. */
const reading = (c: ColumnDef | undefined) => JSON.stringify([c?.as ?? null, c?.transform ?? null, c?.raw ?? null]);

/** The changes for donations from one version of a platform to the next. */
export function platformChanges(platform: string, before: PlatformVersion, after: PlatformVersion): VersionChange[] {
  const seen = after.seen ?? before.seen;
  const old = donated(buildTree(before.config, seen).tree);
  const newTree = buildTree(after.config, seen).tree;
  const now = donated(newTree);
  const names = nameMap(newTree);
  const byKeys = new Map([...now.values()].map((d) => [`${d.field === undefined ? 't' : 'f'}:${d.keys}`, d]));
  const out: VersionChange[] = [];
  const at = (d: Donated) => ({ table: d.table, ...(d.field !== undefined ? { field: d.field } : {}) });
  // Tables come before their fields: a field of a renamed table is not renamed itself.
  const tableRenames = new Map<string, string>();
  for (const [key, was] of old) {
    const is = now.get(key);
    if (!is) {
      const moved = byKeys.get(`${was.field === undefined ? 't' : 'f'}:${was.keys}`);
      if (moved && !old.has(moved.field === undefined ? moved.table : `${moved.table}\u0000${moved.field}`)) {
        if (was.field === undefined) tableRenames.set(was.table, moved.table);
        else if (tableRenames.get(was.table) === moved.table && moved.field === was.field) continue;
        out.push({ kind: 'safe', platform, change: 'renamed', ...at(was), to: moved.field === undefined ? moved.table : `${moved.table}/${moved.field}` });
      } else if (was.field !== undefined && placements(names, was.path).length === 0) {
        // Nothing in the new version matches where it was: earlier values there are deprecated.
        out.push({ kind: 'breaking', platform, change: 'deprecated', ...at(was) });
      } else out.push({ kind: 'narrowing', platform, change: 'no-longer-donated', ...at(was) });
      continue;
    }
    if (was.field === undefined) {
      if (was.filter !== is.filter) {
        const change = was.filter === undefined ? 'filter-added' : is.filter === undefined ? 'filter-removed' : 'filter-changed';
        out.push({ kind: change === 'filter-removed' ? 'safe' : 'narrowing', platform, change, ...at(was) });
      }
      continue;
    }
    const [a, b] = [formats(was.column?.format), formats(is.column?.format)];
    if (reading(was.column) !== reading(is.column)) out.push({ kind: 'breaking', platform, change: 'read-differently', ...at(was) });
    else if (JSON.stringify(a) !== JSON.stringify(b)) {
      // Formats tried after the ones before only read values those could not.
      const more = a.length > 0 && a.every((f, i) => b[i] === f);
      out.push({ kind: more ? 'safe' : 'breaking', platform, change: more ? 'more-formats' : 'read-differently', ...at(was) });
    }
  }
  const renamedTo = new Set(out.flatMap((c) => (c.to ? [c.to] : [])));
  const renamedFrom = new Map([...tableRenames].map(([from, to]) => [to, from]));
  for (const [key, is] of now) {
    if (old.has(key)) continue;
    const name = is.field === undefined ? is.table : `${is.table}/${is.field}`;
    if (renamedTo.has(name)) continue;
    // A field that only moved with its table's new name.
    const from = renamedFrom.get(is.table);
    if (is.field !== undefined && from !== undefined && old.has(`${from}\u0000${is.field}`)) continue;
    // A field of a table that is new itself is part of that change.
    if (is.field !== undefined && !old.has(is.table)) continue;
    out.push({ kind: 'safe', platform, change: 'added', ...at(is) });
  }
  return out;
}

/** The changes for donations between two versions of a project, platform by platform (by id). */
export function versionChanges(before: Map<string, PlatformVersion>, after: Map<string, PlatformVersion>): VersionChange[] {
  const out: VersionChange[] = [];
  for (const [id, version] of after) {
    const was = before.get(id);
    out.push(...(was ? platformChanges(id, was, version) : [{ kind: 'safe' as const, platform: id, change: 'platform-added' as const }]));
  }
  for (const id of before.keys()) if (!after.has(id)) out.push({ kind: 'narrowing', platform: id, change: 'platform-removed' });
  const order: Record<ChangeKind, number> = { breaking: 0, narrowing: 1, safe: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}
