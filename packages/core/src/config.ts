/**
 * The researcher's configuration of a platform: config nodes with matches, names and settings.
 *
 * See docs/decisions/0012-names-and-matches.md and 0013-names-labels-versions.md. The configuration is kept apart from the
 * structures we have seen (shapes): it says how real nodes map onto the researcher's nodes and
 * what happens to them, and it never records what the data looked like. Real nodes that no config
 * node matches are unmatched; they come back from the seen structures (decisions.ts, `buildTree`).
 */
import type { FieldType, Transform } from './importer/spec';
import type { FilterTest } from './query';
import { COLLAPSED_NAME, ITEM_NAME } from './shape';
import type { NodeKind } from './tree';

export type LeafDecision = 'undecided' | 'ignore' | 'show' | 'donate';

/** What a leaf is for in participant views: the date of a row, its title, its link, or a group. */
export type Role = 'date' | 'title' | 'url' | 'group';
export const ROLES: readonly Role[] = ['date', 'title', 'url', 'group'];

/** A condition rows of a table must meet to be imported: a test on one of its columns. */
export interface RowFilter {
  /** The column's id (`ColumnDef.id`). */
  column: string;
  test: FilterTest;
  /** Keep the rows that do not pass the test instead. */
  not?: true;
}

/** Whether a node reads, shows and asks about parts it has never seen below it. */
export type NewChildren = 'ask' | 'skip';

/**
 * One way a real key is matched: the exact key, or a regular expression tested against it.
 * `[*]` (the items of a list) and `{*}` (the keys of a map whose keys are data) are special keys.
 */
export type Match = string | { regex: string; flags?: string };

/** The settings a config node can have. Settings belong to the node, never to one of its matches. */
export interface NodeSettings {
  /**
   * `show` and `donate` on leaves, and on `{*}` nodes for their keys; `ignore` on any node.
   * Absent means undecided.
   */
  decision?: Exclude<LeafDecision, 'undecided'>;
  /**
   * Inner nodes only: a sandboxed function from this node's subtree to a map. The node then
   * counts as a leaf: its children are hidden from decisions and its one decision covers
   * every key the lifter outputs.
   */
  lifter?: string;
  /** Leaves with a conversion: donate the value as it is in the file too, next to the converted one. */
  raw?: true;
  /** Leaves: built-in transforms, applied in order before `as`. */
  transform?: Transform[];
  /** Leaves: the type to read the value as (a date, a number, a link's domain). */
  as?: FieldType;
  /**
   * Leaves read `as: datetime`: how the date is written (`YYYY-MM-DD HH:mm:ss`, `epoch-ms`), or
   * several ways, tried in order: the first that reads a value wins.
   */
  format?: string | string[];
  /** Leaves: what the value is for in participant views. */
  role?: Role;
  /** Repeated nodes (`[*]`, `{*}`): conditions a row must meet, all of them, to be imported. */
  filter?: RowFilter[];
  /**
   * The rows of a table (`[*]`) only: its first row holds the column names, as in an HTML table
   * whose header is written as an ordinary row. Only how the table is shown changes.
   */
  headerRow?: true;
  /** An upload only fits the tree when this node is there, by any of its matches. */
  required?: true;
  /**
   * Inner nodes: whether parts this node has never seen below it are read, shown and offered
   * for structure sharing (`ask`, the default) or skipped (`skip`). Passed down.
   */
  newChildren?: NewChildren;
  /** The root only: name patterns (globs) for finding the export inside a bigger upload. */
  find?: string[];
  /** The root only: whether participants see the parts the researcher has not decided on. */
  undecided?: 'show';
  /** Maps and folders: their keys are data, and their children are one `{*}` node. */
  collapsed?: true;
  /**
   * HTML elements, or tables of them: names of fields are written as text inside them, next to
   * their values (`corrections.ts`): in one list of pairs, or in a list beside a list of
   * values. Their children are then one per name.
   */
  textNames?: 'pairs' | 'beside';
}

export interface ConfigNode extends NodeSettings {
  /** Stable and generated; unique among its siblings, and random unless it came from a key. */
  id: string;
  kind: NodeKind;
  /** Exact keys and regular expressions; `[]` for the root, which is the upload itself. */
  match: Match[];
  /**
   * Tables and fields: the name stories, filters, exports and donations call it by (`names.ts`).
   * Nodes with the same name are one table or one field. Other nodes have none.
   */
  name?: string;
  children?: ConfigNode[];
}

/** A platform's configuration: what an importer file holds. */
export interface ProjectConfig {
  root: ConfigNode;
}

/** The settings a config node can have, in the order they are written. */
export const SETTINGS = [
  'decision',
  'lifter',
  'raw',
  'transform',
  'as',
  'format',
  'role',
  'filter',
  'headerRow',
  'required',
  'newChildren',
  'find',
  'undecided',
  'collapsed',
  'textNames',
] as const satisfies readonly (keyof NodeSettings)[];

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A new random id: short, and never derived from data. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

export const isRegex = (match: Match): match is { regex: string; flags?: string } => typeof match !== 'string';

/** Regular expressions longer than this are refused: they are names, not programs. */
export const MAX_REGEX = 200;

const compiled = new Map<string, RegExp | null>();

/** A match's regular expression, compiled once; `null` if it is not valid. */
function regexOf(match: { regex: string; flags?: string }): RegExp | null {
  const key = `${match.flags ?? ''}/${match.regex}`;
  let re = compiled.get(key);
  if (re === undefined) {
    try {
      re = match.regex.length <= MAX_REGEX ? new RegExp(match.regex, match.flags) : null;
    } catch {
      re = null;
    }
    compiled.set(key, re);
  }
  return re;
}

/** Why a regular expression cannot be used, or undefined if it can. */
export function regexProblem(regex: string, flags?: string): string | undefined {
  if (regex === '') return 'is empty';
  if (regex.length > MAX_REGEX) return `is longer than ${MAX_REGEX} characters`;
  if (flags !== undefined && !/^[imsu]*$/.test(flags)) return 'has unknown flags';
  try {
    new RegExp(regex, flags);
  } catch {
    return 'is not a valid regular expression';
  }
  return undefined;
}

/** Keys longer than this are not tested against regular expressions (they are not names). */
const MAX_KEY = 1000;

/** Whether one match matches a key: the exact key, or a regular expression that finds it. */
export function matchOne(match: Match, key: string): boolean {
  if (typeof match === 'string') return match === key;
  if (key.length > MAX_KEY) return false;
  return regexOf(match)?.test(key) ?? false;
}

/** Whether any of a node's matches matches a key. */
export function matchesKey(match: readonly Match[], key: string): boolean {
  return match.some((m) => matchOne(m, key));
}

/** How a match is written for people: the key, or `/regex/flags`. */
export function matchText(match: Match): string {
  return typeof match === 'string' ? match : `/${match.regex}/${match.flags ?? ''}`;
}

export const sameMatch = (a: Match, b: Match) => matchText(a) === matchText(b);

/** A node for the items of a list (`[*]`). */
export const isItemNode = (node: { match: readonly Match[] }) => node.match.length === 1 && node.match[0] === ITEM_NAME;
/** A node for the keys of a map whose keys are data (`{*}`). */
export const isKeysNode = (node: { match: readonly Match[] }) => node.match.length === 1 && node.match[0] === COLLAPSED_NAME;
