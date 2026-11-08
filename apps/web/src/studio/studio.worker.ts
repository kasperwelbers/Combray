/// <reference lib="webworker" />
/**
 * The studio worker: holds the researcher's test packages in memory while they set decisions,
 * shows what is in each field, and derives the participant view from them. Nothing here is stored or sent anywhere; closing
 * the tab drops it.
 */
import {
  applyTextNames,
  chartData,
  chartQuery,
  countNodes,
  deriveRows,
  defaultRoot,
  deriveTables,
  groupTables,
  headerNames,
  extractShape,
  knownKeys,
  normalizeTree,
  readSpot,
  runQuery,
  uploadTree,
  valuesAt,
  type DerivedRow,
  type ProjectNode,
  type TableDef,
  type TreeNode,
} from '@combray/core';
import * as Comlink from 'comlink';

import { deriveImport, pointProject } from '../worker/derived';
import { textMarks } from './model';
import { addStoryTables, storyViews, type StoryTables } from '../worker/story';
import type { Upload } from '../worker/api';
import { listUpload } from '../worker/upload';
import type { PreviewRow, PreviewTable, PreviewValue, StudioApi, StudioExport } from './api';

const MAX_TEXT = 300;
const MAX_ITEMS = 10;
/** Example values on the rows of the tree are cut to this many characters. */
const EXAMPLE_LENGTH = 40;
// Nested rows kept per preview, so a deep tree cannot flood the main thread.
const MAX_NESTED = 2000;

const exports = new Map<number, { info: StudioExport; tree: TreeNode; read?: { marks: string; tree: TreeNode } }>();
/** Test packages for the story preview, by key; kept apart so they never mix into the exports. */
const storyPackages = new Map<string, TreeNode>();
let nextId = 1;

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (typeof value === 'object' && 'mime' in value) return String((value as { mime: unknown }).mime);
  return String(value);
}

function previewValue(value: unknown): PreviewValue {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return { items: value.slice(0, MAX_ITEMS).map(text), total: value.length };
  return text(value);
}

function previewRow(row: DerivedRow, index: number): PreviewRow {
  const values: PreviewRow['values'] = {};
  for (const [id, value] of Object.entries(row.values)) values[id] = previewValue(value);
  return row.parent === undefined ? { index, values } : { index, values, parent: row.parent };
}

/**
 * The trees of the loaded exports as the project reads them: with the names written as text
 * read as names (`applyTextNames`). Any text may be a name here: these are the researcher's own
 * exports, and that is how the names get into the project. Kept until the marks change.
 */
function readExports(projectTree: ProjectNode, only?: number): [number, TreeNode][] {
  const marks = textMarks(projectTree);
  const out: [number, TreeNode][] = [];
  for (const [id, entry] of exports) {
    if (only !== undefined && id !== only) continue;
    if (!marks) {
      out.push([id, entry.tree]);
      continue;
    }
    if (entry.read?.marks !== marks) entry.read = { marks, tree: applyTextNames(entry.tree, projectTree, () => true) };
    out.push([id, entry.read.tree]);
  }
  return out;
}

/**
 * The rows of all exports, one after the other (nested rows' parents shift with each export),
 * or of one export only.
 */
function allRows(projectTree: ProjectNode, tables: TableDef[], only?: number): DerivedRow[][] {
  const all: DerivedRow[][] = tables.map(() => []);
  for (const [, tree] of readExports(projectTree, only)) {
    const offsets = all.map((rows) => rows.length);
    deriveRows(tree, projectTree, tables).forEach((rows, i) => {
      const parent = tables[i]!.parent;
      const offset = parent === undefined ? 0 : offsets[parent]!;
      for (const row of rows) all[i]!.push(row.parent === undefined ? row : { ...row, parent: row.parent + offset });
    });
  }
  return all;
}

/** A package the researcher (or an example) gives, read into a tree. */
async function readUpload(uploads: Upload[]): Promise<{ name: string; tree: TreeNode }> {
  // The researcher's own export defines the root: a file or picked folder as it is, an
  // archive stepped into once (docs/tree-decisions.md#finding-the-export-in-an-upload).
  const listing = await listUpload(uploads);
  const read = await readSpot(listing, await defaultRoot(listing));
  // HTML is normalised so rows and positions compare (docs/tree-decisions.md#html). Header
  // text may name columns here: this is the researcher's own export, and they see it.
  return { name: listing.name, tree: normalizeTree(read.tree, { keys: () => true }) };
}

const api: StudioApi = {
  async readPackage(files) {
    const { tree } = await readUpload(files.map((f) => ({ file: new File([f.text], f.path.split('/').pop() ?? f.path), path: f.path })));
    return { tree, shape: extractShape(tree) };
  },

  async loadStoryPackage(key, tree) {
    storyPackages.set(key, tree);
  },

  async storyViews(story, sources) {
    // As on a participant's device: the package read through the platform's tree, its tables
    // derived, and the views computed from their rows.
    const tables: StoryTables = new Map();
    for (const source of sources) {
      const tree = storyPackages.get(source.package);
      const point = { id: source.platform, ...(source.pack ? { pack: source.pack } : {}), structure: source.structure, importer: source.importer };
      const project = tree && pointProject(point);
      if (!tree || !project) continue;
      // Names written as text are read as the project says.
      const prepared = applyTextNames(tree, project.tree, knownKeys(project.tree));
      const derived = deriveImport({ prepared, shape: extractShape(prepared) }, project, point);
      addStoryTables(
        tables,
        source.platform,
        derived.tables.map((t) => ({ key: t.table.key, date: t.table.display.date, rows: t.rows })),
      );
    }
    return storyViews(story, tables);
  },

  async addExport(uploads, onProgress) {
    onProgress({ step: 'looking' });
    const { name, tree } = await readUpload(uploads);
    const info: StudioExport = { id: nextId++, name, nodeCount: countNodes(tree) };
    exports.set(info.id, { info, tree });
    onProgress({ step: 'done' });
    return { export: info, shape: extractShape(tree) };
  },

  async addTree(name, tree) {
    const info: StudioExport = { id: nextId++, name, nodeCount: countNodes(tree) };
    exports.set(info.id, { info, tree });
    return { export: info, shape: extractShape(tree) };
  },

  async exportTree(id) {
    const found = exports.get(id);
    if (!found) throw new Error('not-loaded');
    return found.tree;
  },

  async readShapes(projectTree) {
    // As uploads, as the structures seen are kept: read texts move to where their files came from.
    return readExports(projectTree).map(([, tree]) => extractShape(uploadTree(tree)));
  },

  async removeExport(id) {
    exports.delete(id);
  },

  async preview(projectTree, rowLimit, source) {
    // Tables of nodes that share a name are one table, as participants see them. Without a
    // source, the structure only: tables and columns without rows.
    const ungrouped = deriveTables(projectTree);
    const rowsOf = source === undefined || !exports.has(source) ? ungrouped.map(() => []) : allRows(projectTree, ungrouped, source);
    const { tables, rows: derived } = groupTables(ungrouped, rowsOf);
    const out: PreviewTable[] = tables.map((t) => ({
      name: t.name,
      keyed: t.keyed === true,
      record: t.rows === undefined,
      ...(t.headerRow ? { headerRow: true as const } : {}),
      ...(t.parent !== undefined ? { parent: t.parent } : {}),
      state: t.state,
      columns: t.columns,
      rowCount: 0,
      rows: [],
    }));
    // A first row that holds the column names names them and is not shown as a row (top-level
    // tables, as in the participant client); its nested rows go with it.
    tables.forEach((table, i) => {
      if (!table.headerRow || table.parent !== undefined || derived[i]!.length === 0) return;
      const names = headerNames(projectTree, table, derived[i]![0]!.values);
      out[i]!.columns = table.columns.map((c) => {
        const name = names.get(c.id);
        if (name === undefined) return c;
        const { unnamed: _unnamed, ...named } = c;
        return { ...named, name };
      });
    });
    const all: PreviewRow[][] = derived.map((rows, i) => {
      const shown = rows.map((row, index) => previewRow(row, index));
      return tables[i]!.headerRow && tables[i]!.parent === undefined ? shown.slice(1) : shown;
    });
    // Tables come parents first, so nested rows can be kept only under parent rows that are.
    const kept: Set<number>[] = [];
    out.forEach((table, i) => {
      const rows = all[i]!;
      table.rowCount = rows.length;
      table.rows =
        table.parent === undefined
          ? rows.slice(0, rowLimit)
          : rows.filter((r) => kept[table.parent!]!.has(r.parent!)).slice(0, MAX_NESTED);
      kept[i] = new Set(table.rows.map((r) => r.index));
    });
    return out;
  },

  async fieldValues(projectTree, path, limit) {
    const counts = new Map<string, number>();
    let total = 0;
    let empty = 0;
    for (const [, tree] of readExports(projectTree)) {
      for (const value of valuesAt(tree, projectTree, path)) {
        total++;
        const shown = text(value);
        if (shown === null || shown === '') {
          empty++;
          continue;
        }
        counts.set(shown, (counts.get(shown) ?? 0) + 1);
      }
    }
    const top = [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }));
    return { total, empty, distinct: counts.size, top };
  },

  async examples(projectTree, paths, perField) {
    const out: Record<string, string[]> = {};
    for (const path of paths) {
      const counts = new Map<string, number>();
      for (const [, tree] of readExports(projectTree)) {
        for (const value of valuesAt(tree, projectTree, path)) {
          const shown = text(value);
          if (shown) counts.set(shown, (counts.get(shown) ?? 0) + 1);
        }
      }
      if (counts.size === 0) continue;
      out[JSON.stringify(path)] = [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, perField)
        .map(([value]) => (value.length > EXAMPLE_LENGTH ? `${value.slice(0, EXAMPLE_LENGTH)}…` : value));
    }
    return out;
  },

  async chart(projectTree, spec) {
    const tables = deriveTables(projectTree);
    return chartData(runQuery(tables, allRows(projectTree, tables), chartQuery(tables, spec)), spec);
  },
};

Comlink.expose(api);
