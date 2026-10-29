/// <reference lib="webworker" />
/**
 * The data worker: parses imports into trees, runs importers, encrypts everything into the local
 * store, and answers the views' queries. The store key lives only here, never on the main
 * thread. Importer scripts run in a QuickJS sandbox inside this worker.
 */
import {
  createSandbox,
  extractShape,
  flatten,
  matchingImporters,
  parseEntries,
  parseFile,
  runImporter,
  type FileEntry,
  type FlatNode,
  type Row,
  type TreeNode,
} from '@combray/core';
import { importers } from '@combray/importers';
import { LocalStore, WrongPassphraseError } from '@combray/store';
import * as Comlink from 'comlink';

import type {
  DataApi,
  DatasetManifest,
  DatasetSummary,
  ImportProgress,
  SourceManifest,
  TableManifest,
  TableSummary,
  Upload,
} from './api';
import { children, countFiles, nodeDetail, search } from './queries';
import { STOPWORDS } from './stopwords';
import { rows, timeline, topItems } from './tables';

let store: LocalStore<DatasetManifest> | undefined;
// Decrypted datasets, kept in memory while unlocked and dropped on lock.
const cache = new Map<string, FlatNode[]>();
const tableCache = new Map<string, { manifest: TableManifest; rows: Row[] }>();

async function getStore(): Promise<LocalStore<DatasetManifest>> {
  store ??= await LocalStore.open<DatasetManifest>();
  return store;
}

async function unlockedStore(): Promise<LocalStore<DatasetManifest>> {
  const s = await getStore();
  if (!s.unlocked) throw new Error('locked');
  return s;
}

async function nodesOf(id: string): Promise<FlatNode[]> {
  const cached = cache.get(id);
  if (cached) return cached;
  const nodes = await (await unlockedStore()).getItems<FlatNode>(id);
  cache.set(id, nodes);
  return nodes;
}

async function tableOf(id: string): Promise<{ manifest: TableManifest; rows: Row[] }> {
  const cached = tableCache.get(id);
  if (cached) return cached;
  const s = await unlockedStore();
  const dataset = (await s.listDatasets()).find((d) => d.id === id);
  if (dataset?.manifest.type !== 'table') throw new Error('no such table');
  const table = { manifest: dataset.manifest, rows: await s.getItems<Row>(id) };
  tableCache.set(id, table);
  return table;
}

function tableSummary(id: string, m: TableManifest): TableSummary {
  const summary: TableSummary = {
    id,
    type: 'table',
    sourceId: m.sourceId,
    importerId: m.importer.id,
    name: m.name,
    rowCount: m.rowCount,
    fields: m.fields,
    display: m.display,
  };
  if (m.description) summary.description = m.description;
  return summary;
}

function sourceSummary(id: string, m: SourceManifest, tables: TableSummary[]): DatasetSummary {
  return {
    id,
    type: 'source',
    name: m.name,
    source: m.source,
    importedAt: m.importedAt,
    nodeCount: m.nodeCount,
    fileCount: m.fileCount,
    tables,
  };
}

/** Run every bundled importer that matches the tree and store the results as tables. */
async function runImporters(
  s: LocalStore<DatasetManifest>,
  sourceId: string,
  tree: TreeNode,
  importedAt: string,
): Promise<TableSummary[]> {
  const matching = matchingImporters(tree, importers);
  if (matching.length === 0) return [];
  const sandbox = await createSandbox();
  const tables: TableSummary[] = [];
  try {
    for (const spec of matching) {
      const result = runImporter(tree, spec, sandbox);
      if (result.rows.length === 0) continue;
      const manifest: TableManifest = {
        type: 'table',
        sourceId,
        importer: result.importer,
        name: spec.name,
        importedAt,
        rowCount: result.rows.length,
        fields: result.fields,
        display: spec.display ?? {},
        filtered: result.filtered,
        errorCount: result.errors.length,
      };
      if (spec.description) manifest.description = spec.description;
      const id = await s.putDataset(manifest, result.rows);
      tableCache.set(id, { manifest, rows: result.rows });
      tables.push(tableSummary(id, manifest));
    }
  } finally {
    sandbox.dispose();
  }
  return tables;
}

async function parseUpload(
  uploads: Upload[],
  onProgress: (p: ImportProgress) => void,
): Promise<{ tree: TreeNode; source: SourceManifest['source'] }> {
  const first = uploads[0];
  if (!first) throw new Error('no files');
  if (uploads.length === 1 && !first.path.includes('/')) {
    onProgress({ step: 'reading', files: 1 });
    const bytes = new Uint8Array(await first.file.arrayBuffer());
    onProgress({ step: 'parsing' });
    const tree = parseFile(first.file.name, bytes);
    return { tree, source: tree.kind === 'dir' ? 'archive' : 'file' };
  }
  const entries: FileEntry[] = [];
  for (const { file, path } of uploads) {
    entries.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
    onProgress({ step: 'reading', files: entries.length });
  }
  // A picked folder gives paths like `Takeout/YouTube/...`: use the folder as the root.
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  const [top] = tops;
  const nested = tops.size === 1 && top !== undefined && entries.every((e) => e.path.includes('/'));
  const name = nested ? top : `${uploads.length} files`;
  const stripped = nested ? entries.map((e) => ({ ...e, path: e.path.slice(top.length + 1) })) : entries;
  onProgress({ step: 'parsing' });
  return { tree: parseEntries(name, stripped), source: 'folder' };
}

const api: DataApi = {
  async status() {
    const s = await getStore();
    return { exists: s.exists, unlocked: s.unlocked };
  },

  async create(passphrase) {
    await (await getStore()).create(passphrase);
  },

  async unlock(passphrase) {
    try {
      await (await getStore()).unlock(passphrase);
      return 'ok';
    } catch (error) {
      if (error instanceof WrongPassphraseError) return 'wrong-passphrase';
      throw error;
    }
  },

  async lock() {
    cache.clear();
    tableCache.clear();
    (await getStore()).lock();
  },

  async destroy() {
    cache.clear();
    tableCache.clear();
    await (await getStore()).destroy();
    store = undefined;
  },

  async importFiles(uploads, onProgress) {
    const s = await unlockedStore();
    const { tree, source } = await parseUpload(uploads, onProgress);
    onProgress({ step: 'shape' });
    const shape = extractShape(tree);
    const nodes = flatten(tree);
    const importedAt = new Date().toISOString().slice(0, 10);
    const manifest: SourceManifest = {
      type: 'source',
      name: tree.name,
      source,
      importedAt,
      nodeCount: nodes.length,
      fileCount: countFiles(nodes),
      shape,
    };
    onProgress({ step: 'encrypting' });
    const id = await s.putDataset(manifest, nodes);
    cache.set(id, nodes);
    onProgress({ step: 'importers' });
    const tables = await runImporters(s, id, tree, importedAt);
    onProgress({ step: 'done' });
    return sourceSummary(id, manifest, tables);
  },

  async listDatasets() {
    const datasets = await (await unlockedStore()).listDatasets();
    const tables = new Map<string, TableSummary[]>();
    for (const d of datasets) {
      if (d.manifest.type !== 'table') continue;
      const list = tables.get(d.manifest.sourceId) ?? [];
      list.push(tableSummary(d.id, d.manifest));
      tables.set(d.manifest.sourceId, list);
    }
    return datasets
      .flatMap((d) => (d.manifest.type === 'source' ? [sourceSummary(d.id, d.manifest, tables.get(d.id) ?? [])] : []))
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt) || a.name.localeCompare(b.name));
  },

  async deleteDataset(id) {
    const s = await unlockedStore();
    // Deleting a source also deletes the tables found in it.
    for (const d of await s.listDatasets()) {
      if (d.manifest.type === 'table' && d.manifest.sourceId === id) {
        tableCache.delete(d.id);
        await s.deleteDataset(d.id);
      }
    }
    cache.delete(id);
    tableCache.delete(id);
    await s.deleteDataset(id);
  },

  async getNode(datasetId, index) {
    return nodeDetail(await nodesOf(datasetId), index);
  },

  async getChildren(datasetId, index, offset, limit) {
    return children(await nodesOf(datasetId), index, offset, limit);
  },

  async getShape(datasetId) {
    const datasets = await (await unlockedStore()).listDatasets();
    const dataset = datasets.find((d) => d.id === datasetId);
    if (dataset?.manifest.type !== 'source') throw new Error('no such dataset');
    return dataset.manifest.shape;
  },

  async search(datasetId, query, limit) {
    return search(await nodesOf(datasetId), query, limit);
  },

  async getRows(tableId, filter, offset, limit) {
    const { manifest, rows: all } = await tableOf(tableId);
    return rows(all, manifest.display.date, filter, offset, limit);
  },

  async getTimeline(tableId, filter, unit) {
    const { manifest, rows: all } = await tableOf(tableId);
    if (!manifest.display.date) return { unit: unit ?? 'day', buckets: [], undated: all.length };
    return timeline(all, manifest.display.date, filter, unit);
  },

  async getTopItems(tableId, field, filter, limit) {
    const { manifest, rows: all } = await tableOf(tableId);
    // Word lists leave out the most common words.
    const words = all.some((r) => Array.isArray(r[field]));
    return topItems(all, field, manifest.display.date, filter, limit, words ? STOPWORDS : undefined);
  },
};

Comlink.expose(api);
