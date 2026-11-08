/**
 * Name maps: which table and field a raw path belongs to, and how its rows are grouped
 * (docs/decisions/0015-raw-paths-and-relational-export.md).
 *
 * A donated value carries its raw path: the keys from the upload's root, `[3]` for the fourth
 * item of a list and `{3}` for the fourth key of a map whose keys are data. A name map is the
 * structure of a published configuration with the names it gives: keys and regular expressions
 * to match path steps, and the table or field at each node. The studio makes one for every
 * version (`nameMap` in `@combray/core`); participants place their values with their version's
 * map, and the key page places every donation's values with the newest one. Structure only:
 * never a value.
 *
 * No dependencies, so the key page can bundle it as it is.
 */

export const NAME_MAP_FORMAT = 'combray-names/1';

/** A key a node matches: the key itself, or a regular expression that finds it. */
export type NameMatch = string | { regex: string; flags?: string };

export interface NameNode {
  /** The keys this node matches. Not for the items of a list or the keys of a map. */
  m?: NameMatch[];
  /** `[*]`: the items of a list; `{*}`: the keys of a map whose keys are data. */
  k?: '[*]' | '{*}';
  /** The entries of this node are the rows of this table. */
  t?: string;
  /** A field: the value at this node. */
  f?: string;
  /** For the items of a list of plain values: the table they become in the export (`tweets_hashtags`). */
  l?: string;
  /** Side by side: the lists below this node are one table, item `i` of each in row `i`. */
  z?: string;
  /** A list of HTML elements: a single element here (no item step) is its only item. */
  one?: true;
  c?: NameNode[];
}

export interface NameMap {
  format: typeof NAME_MAP_FORMAT;
  root: NameNode;
}

/**
 * How the rows of a table are told apart, from a value's path: by its first `steps` steps, and
 * for a side-by-side table the step `item` (the item's position in each of the lists).
 */
export interface RowGroup {
  table: string;
  steps: number;
  item?: number;
}

/** Where a value goes: its field, its table (`''` for fields outside any table) and the rows it is in, outermost first. */
export interface Placement {
  table: string;
  field: string;
  rows: RowGroup[];
}

const ITEM = /^\[(\d+)\]$/;
const KEY = /^\{(\d+)\}$/;

/** `[*]` for an item step, `{*}` for a key that is data, else the step itself. */
export function generalStep(step: string): string {
  return ITEM.test(step) ? '[*]' : KEY.test(step) ? '{*}' : step;
}

/** Keys longer than this are not tested against regular expressions (they are not names). */
const MAX_KEY = 1000;
const MAX_REGEX = 500;
const compiled = new Map<string, RegExp | null>();

function matchOne(match: NameMatch, key: string): boolean {
  if (typeof match === 'string') return match === key;
  if (key.length > MAX_KEY) return false;
  const id = `${match.flags ?? ''}/${match.regex}`;
  let re = compiled.get(id);
  if (re === undefined) {
    try {
      re = match.regex.length <= MAX_REGEX ? new RegExp(match.regex, match.flags) : null;
    } catch {
      re = null;
    }
    compiled.set(id, re);
  }
  return re?.test(key) ?? false;
}

/**
 * Every place a path goes in a name map: none when the map does not match it (the path is
 * deprecated), more than one when matches overlap. Works on general paths (`[*]`, `{*}`) and on
 * paths with positions alike: the row groups only count steps.
 */
export function placements(map: NameMap | NameNode, path: readonly string[]): Placement[] {
  const root = 'root' in map ? map.root : map;
  const out: Placement[] = [];
  const visit = (node: NameNode, i: number, rows: RowGroup[], zip: RowGroup | undefined) => {
    if (node.t !== undefined) rows = [...rows, { table: node.t, steps: i }];
    if (node.l !== undefined) rows = [...rows, { table: node.l, steps: i }];
    if (node.z !== undefined) zip = { table: node.z, steps: i };
    if (i === path.length) {
      const field = node.f ?? (node.k === '{*}' ? '{key}' : undefined);
      if (field !== undefined) out.push({ table: rows.at(-1)?.table ?? '', field, rows });
      // The key of a `{*}` row of plain values sits at the same path as its value.
      if (node.k === '{*}' && node.f !== undefined && node.f !== '{key}') out.push({ table: rows.at(-1)?.table ?? '', field: '{key}', rows });
      return;
    }
    const step = path[i]!;
    const general = generalStep(step);
    for (const child of node.c ?? []) {
      if (child.k !== undefined) {
        if (child.k !== general) continue;
        // The first item step below a side-by-side node tells its rows apart.
        if (zip && child.k === '[*]' && !rows.some((r) => r.table === zip!.table)) {
          visit(child, i + 1, [...rows, { ...zip, item: i }], undefined);
        } else visit(child, i + 1, rows, zip);
        continue;
      }
      if (general !== step || !(child.m ?? []).some((m) => matchOne(m, step))) continue;
      const next = path[i + 1];
      const item = child.one ? child.c?.find((c) => c.k === '[*]') : undefined;
      // A single element where other files have a list of them: the list's only item.
      if (item && (next === undefined || generalStep(next) !== '[*]')) visit(item, i + 1, rows, zip);
      else visit(child, i + 1, rows, zip);
    }
  };
  visit(root, 0, [], undefined);
  return out;
}

/** The key of the row a value is in, for one row group: steps of its path, joined. */
export function rowKey(path: readonly string[], group: RowGroup): string {
  const head = path.slice(0, group.steps).join('/');
  return group.item === undefined ? head : `${head}//${path[group.item] ?? ''}`;
}

// --- Checking maps from the server ------------------------------------------------------------

const MAX_NODES = 50_000;
const MAX_DEPTH = 200;
const NAME = /^[a-z][a-z0-9_]*$|^\{key\}$|^\{value\}$|^$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Check a name map from the server or a file. Anything unexpected is refused rather than guessed at. */
export function parseNameMap(json: unknown): NameMap {
  if (!isObject(json) || json.format !== NAME_MAP_FORMAT) throw new Error('not a name map');
  let nodes = 0;
  const check = (v: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('name map too large');
    if (!isObject(v)) throw new Error('invalid name map node');
    if (v.m !== undefined) {
      const ok =
        Array.isArray(v.m) &&
        v.m.every((m) => typeof m === 'string' || (isObject(m) && typeof m.regex === 'string' && (m.flags === undefined || (typeof m.flags === 'string' && /^[imsu]*$/.test(m.flags)))));
      if (!ok) throw new Error('invalid match in name map');
    }
    if (v.k !== undefined && v.k !== '[*]' && v.k !== '{*}') throw new Error('invalid name map node');
    for (const key of ['t', 'f', 'l', 'z'] as const) {
      if (v[key] !== undefined && !(typeof v[key] === 'string' && NAME.test(v[key]))) throw new Error('invalid name in name map');
    }
    if (v.one !== undefined && v.one !== true) throw new Error('invalid name map node');
    if (v.c !== undefined) {
      if (!Array.isArray(v.c)) throw new Error('invalid name map node');
      for (const c of v.c) check(c, depth + 1);
    }
  };
  check(json.root, 0);
  return json as unknown as NameMap;
}
