/// <reference lib="webworker" />
/**
 * The data worker: parses imports into trees, encrypts them into the local store, and answers
 * the tree browser's queries. The store key lives only here, never on the main thread.
 */
import {
  extractShape,
  flatten,
  parseEntries,
  parseFile,
  type FileEntry,
  type FlatNode,
  type TreeNode,
} from '@combray/core';
import { LocalStore, WrongPassphraseError } from '@combray/store';
import * as Comlink from 'comlink';

import type { DataApi, DatasetManifest, DatasetSummary, ImportProgress, Upload } from './api';
import { children, countFiles, nodeDetail, search } from './queries';

let store: LocalStore<DatasetManifest> | undefined;
// Decrypted datasets, kept in memory while unlocked and dropped on lock.
const cache = new Map<string, FlatNode[]>();

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

function toSummary(id: string, m: DatasetManifest): DatasetSummary {
  return {
    id,
    name: m.name,
    source: m.source,
    importedAt: m.importedAt,
    nodeCount: m.nodeCount,
    fileCount: m.fileCount,
  };
}

async function parseUpload(
  uploads: Upload[],
  onProgress: (p: ImportProgress) => void,
): Promise<{ tree: TreeNode; source: DatasetManifest['source'] }> {
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
    (await getStore()).lock();
  },

  async destroy() {
    cache.clear();
    await (await getStore()).destroy();
    store = undefined;
  },

  async importFiles(uploads, onProgress) {
    const s = await unlockedStore();
    const { tree, source } = await parseUpload(uploads, onProgress);
    onProgress({ step: 'shape' });
    const shape = extractShape(tree);
    const nodes = flatten(tree);
    const manifest: DatasetManifest = {
      name: tree.name,
      source,
      importedAt: new Date().toISOString().slice(0, 10),
      nodeCount: nodes.length,
      fileCount: countFiles(nodes),
      shape,
    };
    onProgress({ step: 'encrypting' });
    const id = await s.putDataset(manifest, nodes);
    cache.set(id, nodes);
    onProgress({ step: 'done' });
    return toSummary(id, manifest);
  },

  async listDatasets() {
    const datasets = await (await unlockedStore()).listDatasets();
    return datasets
      .map((d) => toSummary(d.id, d.manifest))
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt) || a.name.localeCompare(b.name));
  },

  async deleteDataset(id) {
    cache.delete(id);
    await (await unlockedStore()).deleteDataset(id);
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
    if (!dataset) throw new Error('no such dataset');
    return dataset.manifest.shape;
  },

  async search(datasetId, query, limit) {
    return search(await nodesOf(datasetId), query, limit);
  },
};

Comlink.expose(api);
