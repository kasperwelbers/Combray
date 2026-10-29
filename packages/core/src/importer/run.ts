/** Run an importer spec against a tree, producing a dataset of rows. */
import { findPath, parsePath, type PathMatch } from '../path';
import { isParent, type TreeNode } from '../tree';
import { applyTransform, convert, type FieldValue } from './convert';
import type { CompiledScript, ScriptSandbox } from './sandbox';
import type { FieldSpec, ImporterSpec } from './spec';
import { compileWhere } from './where';

export type Row = Record<string, FieldValue>;

export interface RowError {
  /** Index of the row within its file. */
  row: number;
  field: string;
  message: string;
}

export interface ImporterResult {
  importer: { id: string; version: number };
  /** Locations of the files the importer matched. */
  files: string[][];
  fields: string[];
  rows: Row[];
  /** Rows dropped by `where`. */
  filtered: number;
  /** Script errors, at most `MAX_ERRORS` of them. */
  errors: RowError[];
}

export const MAX_ERRORS = 50;

/** Text content of an element: its text descendants, joined with spaces. */
function textContent(node: TreeNode): string {
  if (node.kind === 'text' || node.kind === 'value') return node.value;
  if (!isParent(node)) return '';
  return node.children.map(textContent).filter(Boolean).join(' ');
}

/** Plain JSON for a subtree: maps become objects, lists arrays, values strings. */
function toJson(node: TreeNode): FieldValue {
  switch (node.kind) {
    case 'value':
      return node.type === 'null' ? null : node.value;
    case 'text':
      return node.value;
    case 'blob':
      return node.name;
    case 'list':
      return node.children.map(toJson);
    case 'element':
      return textContent(node);
    default:
      return Object.fromEntries(node.children.map((c) => [c.name, toJson(c)]));
  }
}

function matchValue(match: PathMatch): FieldValue {
  if (match.type === 'attr') return match.value;
  return toJson(match.node);
}

/**
 * The files an importer applies to. Paths start below the root (the archive or folder); when
 * the import is a single file, the root itself is that file and can match too.
 */
function findFiles(tree: TreeNode, spec: ImporterSpec): PathMatch[] {
  const matches = findPath(tree, spec.match.file);
  if (matches.length > 0 || tree.kind === 'dir') return matches;
  return findPath({ kind: 'dir', name: '', children: [tree] }, spec.match.file).map((m) => ({
    ...m,
    location: [],
  }));
}

/** Something that needs a sandbox, used to fail early with a clear message. */
export function usesScripts(spec: ImporterSpec): boolean {
  return Object.values(spec.select.fields).some((f) => f.script !== undefined);
}

function extract(field: FieldSpec, row: TreeNode, values: Row): FieldValue {
  if (field.from !== undefined) return values[field.from] ?? null;
  const matches = findPath(row, field.path!);
  if (field.join !== undefined) return matches.map(matchValue).filter((v) => v !== null).join(field.join);
  if (field.all) return matches.map(matchValue);
  const match = matches[field.nth ?? 0];
  return match ? matchValue(match) : null;
}

/**
 * Run an importer against a tree (usually a whole imported archive). Every file matching
 * `match.file` contributes rows. Scripts need a sandbox from `createSandbox()`.
 */
export function runImporter(tree: TreeNode, spec: ImporterSpec, sandbox?: ScriptSandbox): ImporterResult {
  if (usesScripts(spec) && !sandbox) throw new Error(`importer ${spec.id} needs a script sandbox`);
  const fileMatches = findFiles(tree, spec);
  const rowsPath = parsePath(spec.select.rows);
  const where = spec.where ? compileWhere(spec.where) : undefined;
  const fields = Object.entries(spec.select.fields);
  const scripts = new Map<string, CompiledScript>();
  for (const [name, field] of fields) {
    if (field.script) scripts.set(name, sandbox!.compile(field.script));
  }

  const result: ImporterResult = {
    importer: { id: spec.id, version: spec.version },
    files: [],
    fields: fields.map(([name]) => name),
    rows: [],
    filtered: 0,
    errors: [],
  };

  for (const file of fileMatches) {
    if (file.type !== 'node') continue;
    result.files.push(file.location);
    const rows = findPath(file.node, rowsPath);
    rows.forEach((rowMatch, rowIndex) => {
      if (rowMatch.type !== 'node') return;
      const values: Row = {};
      for (const [name, field] of fields) {
        let value = extract(field, rowMatch.node, values);
        for (const t of field.transform ?? []) value = applyTransform(value, t);
        const script = scripts.get(name);
        if (script) {
          try {
            value = script(value, values) as FieldValue;
          } catch (error) {
            value = null;
            if (result.errors.length < MAX_ERRORS) {
              result.errors.push({ row: rowIndex, field: name, message: (error as Error).message });
            }
          }
        }
        if (field.as) value = convert(value, field.as, field.format);
        values[name] = value;
      }
      if (where && !where(values)) {
        result.filtered++;
        return;
      }
      result.rows.push(values);
    });
  }
  return result;
}

/** Importers whose `match.file` matches something in the tree. */
export function matchingImporters(tree: TreeNode, specs: ImporterSpec[]): ImporterSpec[] {
  return specs.filter((spec) => findFiles(tree, spec).length > 0);
}
