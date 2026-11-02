/**
 * Project tree files: `structure.json` (the union of shapes, kept by the server) and
 * `importer.json` (the researcher's decisions and settings, signed and shareable).
 *
 * See docs/tree-decisions.md#storage. In the browser both are joined into one project tree.
 * Settings are keyed by canonical path plus the node's kind, so the server adding new paths
 * never touches them.
 */
import {
  ROLES,
  STRUCTURE_FIELDS,
  type Alias,
  type NewChildren,
  type NodePath,
  type ProjectNode,
  type Role,
  type RowFilter,
} from './decisions';
import { isFormat, MAX_FORMATS } from './formats';
import { checkTransform, FIELD_TYPES, SpecError, type FieldType, type Localized, type Transform } from './importer/spec';
import { findPatternProblem } from './locate';
import type { Shape } from './shape';
import type { NodeKind, ValueType } from './tree';

export const STRUCTURE_FORMAT = 'combray-structure@1';
export const IMPORTER_FORMAT = 'combray-importer@1';

export interface StructureFile {
  format: typeof STRUCTURE_FORMAT;
  root: Shape;
}

/** The settings of one node. */
export interface ImporterEntry {
  path: NodePath;
  kind: NodeKind;
  decision?: ProjectNode['decision'];
  label?: Localized;
  description?: Localized;
  aliases?: Alias[];
  lifter?: string;
  raw?: true;
  transform?: Transform[];
  as?: FieldType;
  format?: string;
  role?: Role;
  filter?: RowFilter[];
  required?: true;
  newChildren?: NewChildren;
  /** The root's entry only. */
  find?: string[];
}

export interface ImporterFile {
  format: typeof IMPORTER_FORMAT;
  name?: Localized;
  entries: ImporterEntry[];
}

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

const SETTINGS = [
  'decision',
  'label',
  'description',
  'aliases',
  'lifter',
  'raw',
  'transform',
  'as',
  'format',
  'role',
  'filter',
  'required',
  'newChildren',
  'find',
] as const;

function shapeOf(node: ProjectNode): Shape {
  const shape: Shape = { kind: node.kind, name: node.name };
  for (const key of STRUCTURE_FIELDS) {
    if (node[key] !== undefined) (shape as unknown as Record<string, unknown>)[key] = node[key];
  }
  if (node.children) shape.children = node.children.map(shapeOf);
  return shape;
}

/** Split a project tree into its two files. */
export function splitProjectTree(
  tree: ProjectNode,
  name?: Localized,
): { structure: StructureFile; importer: ImporterFile } {
  const entries: ImporterEntry[] = [];
  const visit = (node: ProjectNode, path: NodePath) => {
    const entry: ImporterEntry = { path, kind: node.kind };
    let any = false;
    for (const key of SETTINGS) {
      if (node[key] === undefined) continue;
      (entry as unknown as Record<string, unknown>)[key] = node[key];
      any = true;
    }
    if (any) entries.push(entry);
    for (const child of node.children ?? []) visit(child, [...path, child.name]);
  };
  visit(tree, []);
  const importer: ImporterFile = { format: IMPORTER_FORMAT, ...(name !== undefined ? { name } : {}), entries };
  return { structure: { format: STRUCTURE_FORMAT, root: shapeOf(tree) }, importer };
}

const VALUE_KINDS = new Set<NodeKind>(['value', 'text', 'blob']);

function find(root: ProjectNode, path: NodePath, kind: NodeKind): ProjectNode | undefined {
  let node = root;
  for (let i = 0; i < path.length; i++) {
    const last = i === path.length - 1;
    const next = node.children?.find(
      (c) => c.name === path[i] && (last ? c.kind === kind : !VALUE_KINDS.has(c.kind)),
    );
    if (!next) return undefined;
    node = next;
  }
  return node.kind === kind ? node : undefined;
}

function toNode(shape: Shape): ProjectNode {
  const node: ProjectNode = { kind: shape.kind, name: shape.name };
  for (const key of STRUCTURE_FIELDS) {
    if (shape[key] !== undefined) (node as unknown as Record<string, unknown>)[key] = shape[key];
  }
  if (shape.children) node.children = shape.children.map(toNode);
  return node;
}

/**
 * Join the two files into a project tree. Entries for paths the structure does not have yet
 * (from a shared importer, before any data was seen) are returned as `pending`, so they can be
 * kept and applied once the structure has them.
 */
export function joinProjectTree(
  structure: StructureFile,
  importer: ImporterFile,
): { tree: ProjectNode; pending: ImporterEntry[] } {
  const tree = toNode(structure.root);
  const pending: ImporterEntry[] = [];
  for (const entry of importer.entries) {
    const node = find(tree, entry.path, entry.kind);
    if (!node) {
      pending.push(entry);
      continue;
    }
    for (const key of SETTINGS) {
      if (entry[key] !== undefined) (node as unknown as Record<string, unknown>)[key] = entry[key];
    }
  }
  return { tree, pending };
}

// Validation of files from disk or from another project. Errors name the first problem.

const KINDS = new Set<NodeKind>(['dir', 'map', 'list', 'value', 'element', 'text', 'blob']);
const TYPES = new Set<ValueType>(['null', 'bool', 'int', 'float', 'string', 'date-like', 'url-like', 'email-like']);
const BUCKETS = new Set(['0', '1', '2-10', '11-100', '101-1k', '>1k']);

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
  if (v.count !== undefined) check(BUCKETS.has(v.count as string), `${where}: unknown count`);
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

export function parseImporterFile(json: unknown): ImporterFile {
  check(isObject(json) && json.format === IMPORTER_FORMAT, `not a ${IMPORTER_FORMAT} file`);
  if (json.name !== undefined) checkLocalized(json.name, 'name');
  check(Array.isArray(json.entries), 'entries must be a list');
  json.entries.forEach((e, i) => {
    const at = `entry ${i}`;
    check(isObject(e), `${at}: expected an object`);
    check(Array.isArray(e.path) && e.path.every((p) => typeof p === 'string'), `${at}: path must be a list of names`);
    check(typeof e.kind === 'string' && KINDS.has(e.kind as NodeKind), `${at}: unknown kind`);
    if (e.decision !== undefined) check(['ignore', 'show', 'donate'].includes(e.decision as string), `${at}: unknown decision`);
    if (e.raw !== undefined) check(e.raw === true, `${at}: raw must be true`);
    if (e.required !== undefined) check(e.required === true, `${at}: required must be true`);
    if (e.newChildren !== undefined) {
      check(e.newChildren === 'ask' || e.newChildren === 'skip', `${at}: newChildren must be ask or skip`);
    }
    if (e.find !== undefined) {
      check((e.path as unknown[]).length === 0, `${at}: only the root has find patterns`);
      check(Array.isArray(e.find) && e.find.length > 0, `${at}: find must be a list of name patterns`);
      for (const pattern of e.find) {
        const problem = typeof pattern === 'string' ? findPatternProblem(pattern) : 'not text';
        check(problem === undefined, `${at}: find pattern ${JSON.stringify(pattern)}: ${problem}`);
      }
    }
    if (e.lifter !== undefined) check(typeof e.lifter === 'string', `${at}: lifter must be a string`);
    if (e.label !== undefined) checkLocalized(e.label, `${at}: label`);
    if (e.as !== undefined) check(FIELD_TYPES.has(e.as as FieldType), `${at}: unknown type in as`);
    if (e.format !== undefined) check(typeof e.format === 'string' && isFormat(e.format), `${at}: format must be like YYYY-MM-DD`);
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
    if (e.description !== undefined) checkLocalized(e.description, `${at}: description`);
    if (e.aliases !== undefined) {
      check(Array.isArray(e.aliases), `${at}: aliases must be a list`);
      for (const a of e.aliases) {
        if (typeof a === 'string') continue;
        check(isObject(a) && typeof a.regex === 'string', `${at}: an alias is a string or { regex }`);
        try {
          new RegExp(a.regex as string, typeof a.flags === 'string' ? a.flags : undefined);
        } catch {
          throw new ProjectFileError(`${at}: invalid regular expression`);
        }
      }
    }
  });
  return json as unknown as ImporterFile;
}
