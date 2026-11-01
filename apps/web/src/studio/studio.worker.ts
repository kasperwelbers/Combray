/// <reference lib="webworker" />
/**
 * The studio worker: holds the researcher's own exports in memory while they set decisions,
 * and derives the participant view from them. Nothing here is stored or sent anywhere; closing
 * the tab drops it.
 */
import {
  chartData,
  chartQuery,
  countNodes,
  deriveRows,
  deriveTables,
  extractShape,
  normalizeTree,
  runQuery,
  uploadRoot,
  type DerivedRow,
  type ProjectNode,
  type TableDef,
  type TreeNode,
} from '@combray/core';
import * as Comlink from 'comlink';

import { parseUpload } from '../worker/upload';
import type { PreviewRow, PreviewTable, PreviewValue, StudioApi, StudioExport } from './api';

const MAX_TEXT = 300;
const MAX_ITEMS = 10;
// Nested rows kept per preview, so a deep tree cannot flood the main thread.
const MAX_NESTED = 2000;

const exports = new Map<number, { info: StudioExport; tree: TreeNode }>();
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

/** The rows of all exports, one after the other; nested rows' parents shift with each export. */
function allRows(projectTree: ProjectNode, tables: TableDef[]): DerivedRow[][] {
  const all: DerivedRow[][] = tables.map(() => []);
  for (const { tree } of exports.values()) {
    const offsets = all.map((rows) => rows.length);
    deriveRows(tree, projectTree, tables).forEach((rows, i) => {
      const parent = tables[i]!.parent;
      const offset = parent === undefined ? 0 : offsets[parent]!;
      for (const row of rows) all[i]!.push(row.parent === undefined ? row : { ...row, parent: row.parent + offset });
    });
  }
  return all;
}

const api: StudioApi = {
  async addExport(uploads, onProgress) {
    const parsed = await parseUpload(uploads, onProgress);
    onProgress({ step: 'shape' });
    // HTML is normalised so rows and positions compare (docs/tree-decisions.md#html).
    const tree = normalizeTree(uploadRoot(parsed.tree, parsed.source === 'archive'));
    const info: StudioExport = { id: nextId++, name: parsed.tree.name, nodeCount: countNodes(tree) };
    exports.set(info.id, { info, tree });
    onProgress({ step: 'done' });
    return { export: info, shape: extractShape(tree) };
  },

  async removeExport(id) {
    exports.delete(id);
  },

  async preview(projectTree, rowLimit) {
    const tables = deriveTables(projectTree);
    const out: PreviewTable[] = tables.map((t) => ({
      name: t.name,
      keyed: t.keyed === true,
      record: t.rows === undefined,
      ...(t.parent !== undefined ? { parent: t.parent } : {}),
      state: t.state,
      columns: t.columns,
      rowCount: 0,
      rows: [],
    }));
    const all: PreviewRow[][] = allRows(projectTree, tables).map((rows) => rows.map((row, i) => previewRow(row, i)));
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

  async chart(projectTree, spec) {
    const tables = deriveTables(projectTree);
    return chartData(runQuery(tables, allRows(projectTree, tables), chartQuery(tables, spec)), spec);
  },
};

Comlink.expose(api);
