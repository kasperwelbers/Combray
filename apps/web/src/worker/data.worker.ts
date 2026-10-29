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
  runImporter,
  type FlatNode,
  type Row,
  type TreeNode,
} from '@combray/core';
import { importers } from '@combray/importers';
import { LocalStore, WrongKeyError } from '@combray/store';
import * as Comlink from 'comlink';

import type {
  DataApi,
  DatasetManifest,
  FileManifest,
  DatasetSummary,
  ImportProgress,
  LocalProject,
  SourceManifest,
  StoreStatus,
  TableManifest,
  TableSummary,
  Upload,
} from './api';
import { createServerStore, deleteServerStore, fetchKek, resetPassword } from './keyService';
import { children, countFiles, nodeDetail, search } from './queries';
import { STOPWORDS } from './stopwords';
import { parseUpload } from './upload';
import { rows, timeline, topItems } from './tables';

const DB_PREFIX = 'combray-';
let projectId: string | undefined;
let store: LocalStore<DatasetManifest> | undefined;
// Decrypted datasets, kept in memory while unlocked and dropped on lock.
const cache = new Map<string, FlatNode[]>();
const tableCache = new Map<string, { manifest: TableManifest; rows: Row[] }>();

async function getStore(): Promise<LocalStore<DatasetManifest>> {
  if (!projectId) throw new Error('no project open');
  store ??= await LocalStore.open<DatasetManifest>(DB_PREFIX + projectId);
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

const api: DataApi = {
  async localProjects() {
    const projects: LocalProject[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith(DB_PREFIX)) continue;
      const s = await LocalStore.open(name);
      const project = s.project;
      if (project) {
        const entry: LocalProject = { id: project.id };
        if (project.name) entry.name = project.name as NonNullable<LocalProject['name']>;
        if (s.participantId) entry.participantId = s.participantId;
        projects.push(entry);
      }
      s.close();
    }
    return projects.sort((a, b) => a.id.localeCompare(b.id));
  },

  async openProject(id) {
    if (id === projectId) return;
    cache.clear();
    tableCache.clear();
    store?.close();
    store = undefined;
    projectId = id;
  },

  async status() {
    const s = await getStore();
    const status: StoreStatus = { exists: s.exists, unlocked: s.unlocked };
    if (s.participantId) status.participantId = s.participantId;
    return status;
  },

  async create(password, project, participantId) {
    const s = await getStore();
    if (project.id !== projectId) throw new Error('another project is open');
    const id = project.participants.mode === 'anonymous' ? undefined : participantId;
    const created = await createServerStore(project.id, id, password);
    if (!created.ok) return created.result;
    await s.create(created.store, { project: { id: project.id, name: project.name }, participantId: id });
    return { status: 'ok' };
  },

  async resetPassword(token, password) {
    const s = await getStore();
    if (!s.storeId) throw new Error('no store on this device yet');
    const reset = await resetPassword(s.storeId, token, password);
    if (!reset.ok) return reset.result;
    try {
      await s.unlock(reset.kek);
      return { status: 'ok' };
    } catch (error) {
      if (error instanceof WrongKeyError) return { status: 'store-gone' };
      throw error;
    }
  },

  async unlock(password) {
    const s = await getStore();
    if (!s.storeId) throw new Error('no store on this device yet');
    const fetched = await fetchKek(s.storeId, password);
    if (!fetched.ok) return fetched.result;
    try {
      await s.unlock(fetched.kek);
      return { status: 'ok' };
    } catch (error) {
      // The server gave a key, but not this store's: its master key must have changed.
      if (error instanceof WrongKeyError) return { status: 'store-gone' };
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
    const s = await getStore();
    // Crypto-shred first: once the server forgets the KEK, even a copy of this disk is useless.
    if (s.storeId && s.deleteToken) await deleteServerStore(s.storeId, s.deleteToken);
    await s.destroy();
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
    // Keep the raw files too, one encrypted blob each, so better importers can read them later.
    for (const { file, path } of uploads) {
      const fileManifest: FileManifest = { type: 'file', sourceId: id, path, mime: file.type, size: file.size };
      await s.putFile(fileManifest, file);
    }
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
    // Deleting a source also deletes its files and the tables found in it.
    for (const d of await s.listDatasets()) {
      if (d.manifest.type !== 'source' && d.manifest.sourceId === id) {
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
