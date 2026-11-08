/**
 * Project files: `structure.json` (the seen tree: the union of the structures seen so far) and
 * `importer.json` (the researcher's configuration: file groups, and config nodes with their
 * matches, names and settings; ADR 0016).
 *
 * See docs/decisions/0012-names-and-matches.md and 0013-names-labels-versions.md. The two are independent: the configuration never
 * records what the data looked like, and the seen structures are never changed by it. In the
 * browser they are laid over each other (`buildTree`).
 */
import { parseNameMap, type NameMap } from '@combray/seal/names';

import { buildTree, UPLOAD_GROUP } from './decisions';
import { keyName } from './derive';
import { isFormat, MAX_FORMATS } from './formats';
import { nameMap, structureOnlyTables } from './nameMap';
import {
  regexProblem,
  ROLES,
  type ConfigNode,
  type FileMatch,
  type Match,
  type ProjectConfig,
  type Role,
} from './config';
import { checkTransform, FIELD_TYPES, SpecError, type FieldType, type Localized } from './importer/spec';
import { findPatternProblem } from './locate';
import { freeName, isName } from './names';
import { COLLAPSED_NAME, ITEM_NAME, type Shape } from './shape';
import type { NodeKind, ValueType } from './tree';

export const STRUCTURE_FORMAT = 'combray-structure@1';
export const IMPORTER_FORMAT = 'combray-importer@3';
/** Configurations without file groups: folders and files in one tree. Read, and upgraded (`upgradeConfig`). */
const IMPORTER_FORMAT_2 = 'combray-importer@2';

/** The seen tree: the union of the structures (shapes) seen so far. Structure only. */
export interface StructureFile {
  format: typeof STRUCTURE_FORMAT;
  root: Shape;
}

/** A platform's configuration, as a file. */
export interface ImporterFile {
  format: typeof IMPORTER_FORMAT;
  name?: Localized;
  root: ConfigNode;
  /**
   * Derived from the configuration over the seen structures when the studio saves it, for the
   * key page (ADR 0015): the name map that places donated paths under this version's names, and
   * the shown tables whose name is only structure (publishing is refused while there are any).
   */
  names?: NameMap;
  unnamed?: string[];
}

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

export function structureFile(root: Shape): StructureFile {
  return { format: STRUCTURE_FORMAT, root };
}

/** The importer file of a configuration; with the seen structures, with its name map too. */
export function importerFile(config: ProjectConfig, name?: Localized, seen?: Shape): ImporterFile {
  const out: ImporterFile = { format: IMPORTER_FORMAT, ...(name !== undefined ? { name } : {}), root: config.root };
  if (seen === undefined) return out;
  const tree = buildTree(config, seen).tree;
  const unnamed = structureOnlyTables(tree);
  return { ...out, names: nameMap(tree), ...(unnamed.length > 0 ? { unnamed } : {}) };
}

export const configOf = (file: ImporterFile): ProjectConfig => ({ root: file.root });

// Validation of files from disk, from the server or from another project. Errors name the first problem.

const KINDS = new Set<NodeKind>(['dir', 'map', 'list', 'value', 'element', 'text', 'blob']);
const TYPES = new Set<ValueType>(['null', 'bool', 'int', 'float', 'string', 'date-like', 'url-like', 'email-like']);
const REPEAT_VALUES = new Set(['once', 'many']);
/** Limits that keep a file a configuration, not a dump. */
const MAX_NODES = 20_000;
const MAX_MATCHES = 50;
const MAX_FILE_MATCHES = 200;
const MAX_FILE_STEPS = 30;
const MAX_KEY = 500;
const MAX_ID = 100;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new ProjectFileError(message);
}

function checkLocalized(v: unknown, what: string): void {
  check(
    typeof v === 'string' || (isObject(v) && Object.values(v).every((s) => typeof s === 'string')),
    `${what} must be a string or a map of languages to strings`,
  );
}

function checkShape(v: unknown, where: string, depth = 0): void {
  check(depth < 200, 'structure is nested too deeply');
  check(isObject(v), `${where}: expected an object`);
  check(typeof v.kind === 'string' && KINDS.has(v.kind as NodeKind), `${where}: unknown kind`);
  check(typeof v.name === 'string', `${where}: name must be a string`);
  if (v.types !== undefined) {
    check(Array.isArray(v.types) && v.types.every((t) => TYPES.has(t as ValueType)), `${where}: unknown type`);
  }
  if (v.keyTypes !== undefined) {
    check(Array.isArray(v.keyTypes) && v.keyTypes.every((t) => TYPES.has(t as ValueType)), `${where}: unknown key type`);
  }
  // Formats are tokens only, so a structure file cannot carry values in them.
  for (const key of ['formats', 'keyFormats'] as const) {
    const formats = v[key];
    if (formats === undefined) continue;
    check(
      Array.isArray(formats) &&
        formats.length <= MAX_FORMATS &&
        formats.every((f) => typeof f === 'string' && isFormat(f)),
      `${where}: ${key} must be formats such as YYYY-MM-DD`,
    );
  }
  if (v.repeat !== undefined) check(REPEAT_VALUES.has(v.repeat as string), `${where}: repeat must be once or many`);
  if (v.mime !== undefined) check(typeof v.mime === 'string', `${where}: mime must be a string`);
  if (v.collapsed !== undefined) check(v.collapsed === true, `${where}: collapsed must be true`);
  if (v.children !== undefined) {
    check(Array.isArray(v.children), `${where}: children must be a list`);
    v.children.forEach((c, i) => checkShape(c, `${where}/${i}`, depth + 1));
  }
}

export function parseStructureFile(json: unknown): StructureFile {
  check(isObject(json) && json.format === STRUCTURE_FORMAT, `not a ${STRUCTURE_FORMAT} file`);
  checkShape(json.root, 'root');
  return json as unknown as StructureFile;
}

const FILTER_TESTS = ['empty', 'equals', 'in', 'contains', 'matches', 'min', 'max'];
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function checkFilter(f: unknown, at: string): void {
  check(isObject(f) && typeof f.column === 'string' && isObject(f.test), `${at}: a filter has a column and a test`);
  if (f.not !== undefined) check(f.not === true, `${at}: not must be true`);
  const test = f.test as Record<string, unknown>;
  const keys = Object.keys(test);
  check(keys.length > 0 && keys.every((k) => FILTER_TESTS.includes(k) || k === 'flags'), `${at}: unknown filter test`);
  if ('empty' in test) check(typeof test.empty === 'boolean', `${at}: empty must be true or false`);
  if ('equals' in test) check(isScalar(test.equals), `${at}: equals must be a plain value`);
  if ('in' in test) check(Array.isArray(test.in) && test.in.every(isScalar), `${at}: in must be a list of plain values`);
  if ('contains' in test) check(typeof test.contains === 'string', `${at}: contains must be text`);
  if ('matches' in test) {
    check(typeof test.matches === 'string', `${at}: matches must be a regular expression`);
    check(test.flags === undefined || test.flags === 'i', `${at}: flags may only be i`);
    try {
      new RegExp(test.matches as string);
    } catch {
      throw new ProjectFileError(`${at}: invalid regular expression`);
    }
  }
}

function checkMatch(m: unknown, at: string): void {
  if (typeof m === 'string') {
    check(m.length > 0 && m.length <= MAX_KEY, `${at}: a key must be 1 to ${MAX_KEY} characters`);
    return;
  }
  check(isObject(m) && typeof m.regex === 'string', `${at}: a match is a key or { regex }`);
  check(m.flags === undefined || typeof m.flags === 'string', `${at}: flags must be text`);
  const problem = regexProblem(m.regex as string, m.flags as string | undefined);
  check(problem === undefined, `${at}: regular expression ${problem}`);
}

function checkFileMatch(m: unknown, at: string): void {
  check(isObject(m), `${at}: a file match is { path } or { name }`);
  if (m.path !== undefined) {
    check(m.name === undefined && Array.isArray(m.path) && m.path.length <= MAX_FILE_STEPS, `${at}: a file match is { path } or { name }`);
    m.path.forEach((step, i) => checkMatch(step, `${at}: step ${i}`));
  } else {
    check(m.name !== undefined, `${at}: a file match is { path } or { name }`);
    checkMatch(m.name, `${at}: name`);
  }
}

function checkNode(e: unknown, at: string, count: { nodes: number }, depth: number, root: boolean, parentKind?: string, inGroup = false): void {
  check(depth < 200, 'configuration is nested too deeply');
  check(++count.nodes <= MAX_NODES, 'configuration has too many nodes');
  check(isObject(e), `${at}: expected an object`);
  check(typeof e.id === 'string' && e.id.length > 0 && e.id.length <= MAX_ID, `${at}: id must be text`);
  check(typeof e.kind === 'string' && KINDS.has(e.kind as NodeKind), `${at}: unknown kind`);
  check(Array.isArray(e.match) && e.match.length <= MAX_MATCHES, `${at}: match must be a list`);
  e.match.forEach((m, i) => checkMatch(m, `${at}: match ${i}`));
  const group = depth === 1;
  if (root) {
    check(e.match.length === 0, `${at}: the root matches the upload itself and has no match`);
    check(e.kind === 'dir', `${at}: the root holds file groups`);
  } else if (group) {
    check(e.kind === 'dir' && Array.isArray(e.files), `${at}: the root holds file groups only`);
    check(e.match.length === 1 && typeof e.match[0] === 'string' && isName(e.match[0]), `${at}: a file group has one name, of lowercase letters, digits and underscores`);
  } else if (inGroup) {
    check(e.match.length === 0, `${at}: the files of a group are matched by their kind, without a match`);
    check(e.kind !== 'dir', `${at}: the files of a group are files, not folders`);
  } else check(e.match.length > 0, `${at}: a node needs at least one match`);
  if (e.files !== undefined) {
    check(group, `${at}: only file groups have files`);
    check(Array.isArray(e.files) && e.files.length <= MAX_FILE_MATCHES, `${at}: files must be a list`);
    e.files.forEach((m, i) => checkFileMatch(m, `${at}: file ${i}`));
  }
  const special = e.match.filter((m) => m === ITEM_NAME || m === COLLAPSED_NAME);
  check(special.length === 0 || e.match.length === 1, `${at}: [*] and {*} are matches of their own`);
  if (e.match[0] === ITEM_NAME) check(parentKind === 'list', `${at}: [*] is only below a list`);
  if (e.name !== undefined) check(typeof e.name === 'string' && isName(e.name), `${at}: a name has lowercase letters, digits and underscores`);
  if (e.decision !== undefined) check(['ignore', 'show', 'donate'].includes(e.decision as string), `${at}: unknown decision`);
  if (e.raw !== undefined) check(e.raw === true, `${at}: raw must be true`);
  if (e.required !== undefined) check(e.required === true, `${at}: required must be true`);
  if (e.collapsed !== undefined) {
    check(e.collapsed === true, `${at}: collapsed must be true`);
    check(e.kind === 'map' || e.kind === 'dir', `${at}: only maps and folders have keys that are data`);
  }
  if (e.textNames !== undefined) {
    check(e.textNames === 'pairs' || e.textNames === 'beside', `${at}: textNames must be pairs or beside`);
    check(e.kind === 'element' || e.kind === 'list', `${at}: only HTML elements and their tables have texts that are names`);
  }
  if (e.sideBySide !== undefined) {
    check(e.sideBySide === true, `${at}: sideBySide must be true`);
    check(e.kind === 'map' || e.kind === 'element', `${at}: only objects have lists side by side`);
  }
  if (e.newChildren !== undefined) {
    check(e.newChildren === 'ask' || e.newChildren === 'skip', `${at}: newChildren must be ask or skip`);
  }
  if (e.find !== undefined) {
    check(root, `${at}: only the root has find patterns`);
    check(Array.isArray(e.find) && e.find.length > 0, `${at}: find must be a list of name patterns`);
    for (const pattern of e.find) {
      const problem = typeof pattern === 'string' ? findPatternProblem(pattern) : 'not text';
      check(problem === undefined, `${at}: find pattern ${JSON.stringify(pattern)}: ${problem}`);
    }
  }
  if (e.headerRow !== undefined) {
    check(e.headerRow === true, `${at}: headerRow must be true`);
    check(e.match[0] === ITEM_NAME, `${at}: only the rows of a table ([*]) have a header row`);
  }
  if (e.undecided !== undefined) {
    check(root, `${at}: only the root has the undecided setting`);
    check(e.undecided === 'show', `${at}: undecided must be show`);
  }
  if (e.lifter !== undefined) check(typeof e.lifter === 'string', `${at}: lifter must be a string`);
  if (e.as !== undefined) check(FIELD_TYPES.has(e.as as FieldType), `${at}: unknown type in as`);
  if (e.format !== undefined) {
    const formats = Array.isArray(e.format) ? e.format : [e.format];
    check(
      formats.length > 0 && formats.length <= MAX_FORMATS && formats.every((f) => typeof f === 'string' && isFormat(f)),
      `${at}: format must be like YYYY-MM-DD, or a list of such formats`,
    );
  }
  if (e.role !== undefined) check(ROLES.includes(e.role as Role), `${at}: unknown role`);
  if (e.transform !== undefined) {
    check(Array.isArray(e.transform), `${at}: transform must be a list`);
    for (const t of e.transform) {
      try {
        checkTransform('importer', at, t);
      } catch (error) {
        throw new ProjectFileError(error instanceof SpecError ? error.message.replace(/^importer importer: /, '') : `${at}: invalid transform`);
      }
    }
  }
  if (e.filter !== undefined) {
    check(Array.isArray(e.filter), `${at}: filter must be a list`);
    for (const f of e.filter) checkFilter(f, at);
  }
  if (e.children !== undefined) {
    check(Array.isArray(e.children), `${at}: children must be a list`);
    const ids = new Set<string>();
    e.children.forEach((c, i) => {
      const where = `${at}/${i}`;
      checkNode(c, where, count, depth + 1, false, e.kind as string, group);
      const id = (c as { id: string }).id;
      check(!ids.has(id), `${where}: id ${id} is used twice among siblings`);
      ids.add(id);
    });
  }
}

export function parseImporterFile(json: unknown): ImporterFile {
  check(isObject(json) && (json.format === IMPORTER_FORMAT || json.format === IMPORTER_FORMAT_2), `not a ${IMPORTER_FORMAT} file`);
  if (json.name !== undefined) checkLocalized(json.name, 'name');
  if (json.format === IMPORTER_FORMAT_2) {
    // The old tree is checked as it was (by the rules it was made with), then upgraded.
    checkOldNode(json.root);
    json = { ...json, format: IMPORTER_FORMAT, root: upgradeConfig(json.root as ConfigNode).root };
    if (!isObject(json)) throw new ProjectFileError('invalid importer file');
  }
  checkNode(json.root, 'root', { nodes: 0 }, 0, true);
  if (json.names !== undefined) {
    try {
      parseNameMap(json.names);
    } catch (e) {
      throw new ProjectFileError(`names: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (json.unnamed !== undefined) check(Array.isArray(json.unnamed) && json.unnamed.every((n) => typeof n === 'string'), 'unnamed must be a list of names');
  return json as unknown as ImporterFile;
}

// --- Upgrading configurations without file groups ----------------------------------------------

/** A version 2 tree: any node may be a folder or a file, so only its basic shape is checked here. */
function checkOldNode(e: unknown, depth = 0): void {
  check(depth < 200 && isObject(e) && typeof e.kind === 'string' && KINDS.has(e.kind as NodeKind) && Array.isArray(e.match), 'root: invalid configuration');
  if (e.children !== undefined) {
    check(Array.isArray(e.children), 'root: invalid configuration');
    for (const c of e.children) checkOldNode(c, depth + 1);
  }
}

/** File matches for every combination of a path's alternatives, at most this many per file. */
const MAX_UPGRADE_PATHS = 64;

function paths(steps: Match[][]): FileMatch[] {
  let out: Match[][] = [[]];
  for (const alternatives of steps) {
    out = out.flatMap((head) => alternatives.map((m) => [...head, m])).slice(0, MAX_UPGRADE_PATHS);
  }
  return out.map((path) => ({ path }));
}

/**
 * A configuration from before file groups (`combray-importer@2`), with them (ADR 0016). Every file
 * the old tree configured becomes a group that reads it at every path the old folders matched;
 * files with the same table name and different kinds (a JSON and an HTML history) share one
 * group. The upload itself, when it was one file, is the group `export`. Settings of folders
 * are left out: a group reads only its files, so `newChildren`, `ignore` and `required` on folders
 * no longer say anything. A required file makes its group required.
 */
export function upgradeConfig(old: ConfigNode): ProjectConfig {
  const root: ConfigNode = { id: old.id, kind: 'dir', match: [] };
  for (const key of ['find', 'undecided'] as const) if (old[key] !== undefined) (root as unknown as Record<string, unknown>)[key] = old[key];
  const files: { node: ConfigNode; steps: Match[][] }[] = [];
  if (old.kind !== 'dir') files.push({ node: old, steps: [] });
  else {
    const visit = (dir: ConfigNode, steps: Match[][]) => {
      for (const child of dir.children ?? []) {
        if (child.decision === 'ignore') continue;
        if (child.kind === 'dir') visit(child, [...steps, child.match]);
        else files.push({ node: child, steps: [...steps, child.match] });
      }
    };
    visit(old, []);
  }
  const groups: ConfigNode[] = [];
  const taken = new Set<string>();
  for (const { node, steps } of files) {
    const first = node.match.find((m): m is string => typeof m === 'string');
    const name = old.kind !== 'dir' ? UPLOAD_GROUP : (node.name ?? keyName(first ?? '', 'file'));
    const { find: _find, undecided: _undecided, required, ...settings } = node;
    const file: ConfigNode = { ...settings, match: [] };
    const fileMatches = old.kind !== 'dir' ? [{ path: [] }] : paths(steps);
    // A file of another kind with the same table name: the same content, another format.
    const same = groups.find((g) => g.match[0] === name && !g.children!.some((c) => c.kind === node.kind));
    if (same) {
      if (!same.children!.some((c) => c.id === file.id)) same.children!.push(file);
      else same.children!.push({ ...file, id: `${file.id}-${same.children!.length}` });
      same.files = [...same.files!, ...fileMatches];
      if (required) same.required = true;
      continue;
    }
    const key = freeName(name, taken);
    taken.add(key);
    groups.push({ id: `g-${key}`, kind: 'dir', match: [key], files: fileMatches, ...(required ? { required } : {}), children: [file] });
  }
  if (groups.length > 0) root.children = groups;
  return { root };
}
