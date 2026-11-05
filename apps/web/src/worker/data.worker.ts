/// <reference lib="webworker" />
/**
 * The data worker: parses imports into trees, derives tables through the project's upload
 * points (or runs the YAML importers), encrypts everything into the local store, and answers
 * the views' queries. The store key lives only here, never on the main
 * thread. Importer scripts run in a QuickJS sandbox inside this worker.
 */
import {
  createSandbox,
  defaultRoot,
  extractShape,
  flatten,
  locateRoot,
  matchingImporters,
  readSpot,
  runImporter,
  optionValue,
  storyQuestions,
  validAnswer,
  type Answer,
  UploadProblemError,
  type FlatNode,
  type Located,
  type LocateResult,
  type ReadSpot,
  type Row,
  type TreeNode,
  unflatten,
  type UploadListing,
} from '@combray/core';
import { importers } from '@combray/importers';
import { LocalStore, WrongKeyError } from '@combray/store';
import * as Comlink from 'comlink';

import type {
  AnswersManifest,
  DataApi,
  DatasetManifest,
  DonationManifest,
  DonationReceipt,
  FileManifest,
  DatasetSummary,
  ImportProgress,
  ImportResult,
  LocalProject,
  SourceManifest,
  StoreStatus,
  TableManifest,
  TableSummary,
  UploadPoint,
} from './api';
import { deriveImport, pointProject } from './derived';
import { donatedAnswers, fetchSettings, Review, sendDonation, uploadDonation, withdrawDonation } from './donate';
import { createServerStore, deleteServerStore, fetchKek, resetPassword } from './keyService';
import { children, countFiles, nodeDetail, search } from './queries';
import { STOPWORDS } from './stopwords';
import { addStoryTables, storyViews, type StoryTables } from './story';
import { listUpload } from './upload';
import { rows, timeline, topItems } from './tables';

const DB_PREFIX = 'combray-';
let projectId: string | undefined;
let store: LocalStore<DatasetManifest> | undefined;
// Decrypted datasets, kept in memory while unlocked and dropped on lock.
const cache = new Map<string, FlatNode[]>();
const tableCache = new Map<string, { manifest: TableManifest; rows: Row[] }>();
// An import waiting for the participant to choose where in the upload their export is.
let pending:
  | {
      listing: UploadListing;
      point: UploadPoint;
      choose: (ids: number[]) => Promise<Located>;
    }
  | undefined;
// The donation being reviewed, and the rows left out of it (kept encrypted in the store).
let review: Review | undefined;
let leftOut: { id?: string; keys: Set<string> } | undefined;
// The participant's answers to the story's questions (kept encrypted in the store).
let answers: { id?: string; values: Record<string, Answer> } | undefined;

/** Forget everything kept in memory: on lock, and when switching projects. */
function forget(): void {
  cache.clear();
  tableCache.clear();
  review = undefined;
  leftOut = undefined;
  answers = undefined;
}

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
  if (m.derived) summary.derived = m.derived;
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
async function runImporters(s: LocalStore<DatasetManifest>, sourceId: string, tree: TreeNode, importedAt: string): Promise<TableSummary[]> {
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

/** Store a root that was read: its tree, its raw files, and the tables found in it. */
async function storeSource(
  listing: UploadListing,
  read: ReadSpot,
  onProgress: (p: ImportProgress) => void,
  findTables: (s: LocalStore<DatasetManifest>, sourceId: string, importedAt: string) => Promise<TableSummary[]>,
  point?: UploadPoint,
): Promise<ImportResult> {
  const s = await unlockedStore();
  const nodes = flatten(read.tree);
  const importedAt = new Date().toISOString().slice(0, 10);
  const manifest: SourceManifest = {
    type: 'source',
    // The name of the picked file or folder: shown on this device only.
    name: listing.name,
    source: listing.source === 'files' ? 'folder' : listing.source,
    importedAt,
    nodeCount: nodes.length,
    fileCount: countFiles(nodes),
    shape: extractShape(read.tree),
    ...(point ? { point: point.id } : {}),
  };
  onProgress({ step: 'encrypting' });
  const id = await s.putDataset(manifest, nodes);
  cache.set(id, nodes);
  review = undefined;
  // Keep the raw files that were read too, one encrypted blob each, so better importers can
  // read them later. Files outside the root, or skipped in it, are never kept.
  for (const { path, bytes } of read.files) {
    const fileManifest: FileManifest = {
      type: 'file',
      sourceId: id,
      path,
      mime: '',
      size: bytes.byteLength,
    };
    await s.putFile(fileManifest, new Blob([bytes as Uint8Array<ArrayBuffer>]));
  }
  onProgress({ step: 'importers' });
  const tables = await findTables(s, id, importedAt);
  onProgress({ step: 'done' });
  return { status: 'done', dataset: sourceSummary(id, manifest, tables) };
}

/** Store the tables derived through an upload point's project tree. */
async function storeDerived(
  s: LocalStore<DatasetManifest>,
  sourceId: string,
  importedAt: string,
  derived: ReturnType<typeof deriveImport>,
): Promise<TableSummary[]> {
  const summaries: TableSummary[] = [];
  for (const { table, rows } of derived.tables) {
    const { name, display, description, ...rest } = table;
    const manifest: TableManifest = {
      type: 'table',
      sourceId,
      importer: {
        id: `${derived.point.id}:${derived.point.pack ?? 'project'}`,
        version: 1,
      },
      name,
      importedAt,
      rowCount: rows.length,
      fields: table.columns.map((c) => c.id),
      display,
      filtered: 0,
      errorCount: 0,
      derived: rest,
      ...(description !== undefined ? { description } : {}),
    };
    const id = await s.putDataset(manifest, rows);
    tableCache.set(id, { manifest, rows });
    summaries.push(tableSummary(id, manifest));
  }
  return summaries;
}

/** What to do with the result of looking for the root: store it, ask, or report a problem. */
async function finish(listing: UploadListing, point: UploadPoint, located: LocateResult, onProgress: (p: ImportProgress) => void): Promise<ImportResult> {
  if (located.status === 'choose') {
    pending = { listing, point, choose: located.choose };
    return {
      status: 'choose',
      choices: located.choices,
      multiple: located.multiple,
    };
  }
  pending = undefined;
  if (located.status !== 'found') return { status: located.status };
  const { root } = located;
  const derived = deriveImport(root, pointProject(point)!, point);
  return storeSource(listing, root, onProgress, (s, id, importedAt) => storeDerived(s, id, importedAt, derived), point);
}

/** The upload point a source was imported through: in its manifest, or (older) its tables'. */
function pointOf(id: string, manifest: SourceManifest, datasets: { id: string; manifest: DatasetManifest }[]): string | undefined {
  if (manifest.point) return manifest.point;
  const table = datasets.find((d) => d.manifest.type === 'table' && d.manifest.sourceId === id)?.manifest as TableManifest | undefined;
  const importer = table?.importer.id;
  return importer?.includes(':') ? importer.slice(0, importer.lastIndexOf(':')) : undefined;
}

/** The donation of every upload made through the study's upload points, with its settings now. */
async function buildReview(): Promise<Review | 'unreachable'> {
  const study = await fetchSettings(projectId!);
  if (!study) return 'unreachable';
  if (review?.settings === study.settings) return review;
  const datasets = await (await unlockedStore()).listDatasets();
  const parts = [];
  for (const d of datasets) {
    if (d.manifest.type !== 'source') continue;
    const pointId = pointOf(d.id, d.manifest, datasets);
    const point = study.points.find((p) => p.id === pointId);
    const project = point && pointProject(point);
    if (project) parts.push(uploadDonation(d.id, unflatten(await nodesOf(d.id)), project));
  }
  review = new Review(parts, study.settings, study.consent);
  return review;
}

function reviewing(): Review {
  if (!review) throw new Error('no donation is being reviewed');
  return review;
}

async function leftOutKeys(): Promise<Set<string>> {
  if (leftOut) return leftOut.keys;
  const s = await unlockedStore();
  const stored = (await s.listDatasets()).find((d) => d.manifest.type === 'left-out');
  leftOut = {
    ...(stored ? { id: stored.id } : {}),
    keys: new Set(stored ? await s.getItems<string>(stored.id) : []),
  };
  return leftOut.keys;
}

async function saveLeftOut(keys: Set<string>): Promise<void> {
  const s = await unlockedStore();
  const old = leftOut?.id;
  const id = await s.putDataset({ type: 'left-out' }, [...keys]);
  if (old) await s.deleteDataset(old);
  leftOut = { id, keys };
}

async function storedAnswers(): Promise<Record<string, Answer>> {
  if (answers) return answers.values;
  const s = await unlockedStore();
  const stored = (await s.listDatasets()).find((d) => d.manifest.type === 'answers');
  const values = Object.fromEntries(stored ? await s.getItems<[string, Answer]>(stored.id) : []);
  answers = { ...(stored ? { id: stored.id } : {}), values };
  return values;
}

async function saveAnswers(values: Record<string, Answer>): Promise<void> {
  const s = await unlockedStore();
  const old = answers?.id;
  const manifest: AnswersManifest = { type: 'answers' };
  const id = await s.putDataset(manifest, Object.entries(values));
  if (old) await s.deleteDataset(old);
  answers = { id, values };
}

/** The rows of each table the story can refer to, from every upload made through an upload point. */
async function storyTables(): Promise<StoryTables> {
  const datasets = await (await unlockedStore()).listDatasets();
  const points = new Map<string, string | undefined>();
  for (const d of datasets) if (d.manifest.type === 'source') points.set(d.id, pointOf(d.id, d.manifest, datasets));
  const out: StoryTables = new Map();
  for (const d of datasets) {
    if (d.manifest.type !== 'table' || d.manifest.derived?.key === undefined) continue;
    const point = points.get(d.manifest.sourceId);
    if (!point) continue;
    addStoryTables(out, point, [{ key: d.manifest.derived.key, date: d.manifest.display.date, rows: (await tableOf(d.id)).rows }]);
  }
  return out;
}

function receiptOf(id: string, m: DonationManifest): DonationReceipt {
  return {
    id,
    donation: m.donation,
    code: `${m.donation}.${m.token}`,
    sent: m.sent,
    rows: m.rows,
    tables: m.tables,
    ...(m.withdrawn ? { withdrawn: m.withdrawn } : {}),
  };
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
    forget();
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
    await s.create(created.store, {
      project: { id: project.id, name: project.name },
      participantId: id,
    });
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
    forget();
    (await getStore()).lock();
  },

  async destroy() {
    forget();
    const s = await getStore();
    // Crypto-shred first: once the server forgets the KEK, even a copy of this disk is useless.
    if (s.storeId && s.deleteToken) await deleteServerStore(s.storeId, s.deleteToken);
    await s.destroy();
    store = undefined;
  },

  async importFiles(uploads, onProgress, point) {
    await unlockedStore();
    pending = undefined;
    onProgress({ step: 'looking' });
    try {
      const listing = await listUpload(uploads);
      const projectTree = point && pointProject(point)?.tree;
      if (point && projectTree) return await finish(listing, point, await locateRoot(listing, projectTree), onProgress);
      // Without a project tree: everything, named as before, for the YAML importers.
      const read = await readSpot(listing, await defaultRoot(listing), {
        name: listing.name,
      });
      return await storeSource(listing, read, onProgress, (s, id, importedAt) => runImporters(s, id, read.tree, importedAt));
    } catch (error) {
      if (error instanceof UploadProblemError) return { status: error.problem };
      throw error;
    }
  },

  async chooseRoots(ids, onProgress) {
    if (!pending) throw new Error('no import is waiting for a choice');
    const { listing, point, choose } = pending;
    onProgress({ step: 'looking' });
    return finish(listing, point, await choose(ids), onProgress);
  },

  async cancelImport() {
    pending = undefined;
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
      if ((d.manifest.type === 'table' || d.manifest.type === 'file') && d.manifest.sourceId === id) {
        tableCache.delete(d.id);
        await s.deleteDataset(d.id);
      }
    }
    cache.delete(id);
    tableCache.delete(id);
    review = undefined;
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

  async story() {
    const study = await fetchSettings(projectId!);
    if (!study) return 'unreachable';
    if (!study.story) return 'none';
    const views = storyViews(study.story, await storyTables());
    return { story: study.story, views, answers: await storedAnswers() };
  },

  async answer(questionId, answer) {
    const next = { ...(await storedAnswers()) };
    if (answer === null) delete next[questionId];
    else next[questionId] = answer;
    await saveAnswers(next);
  },

  async donationAnswers() {
    const study = await fetchSettings(projectId!);
    if (!study) return 'unreachable';
    const stored = await storedAnswers();
    return storyQuestions(study.story).flatMap((q) => {
      const answer = stored[q.id];
      if (answer === undefined || !validAnswer(q, answer)) return [];
      const option = q.options?.find((o) => optionValue(o) === answer);
      return [{ id: q.id, prompt: q.prompt, answer, ...(option ? { option } : {}) }];
    });
  },

  async donationOverview() {
    const r = await buildReview();
    if (r === 'unreachable') return r;
    return r.overview(await leftOutKeys());
  },

  async donationRows(tableId, query, offset, limit) {
    return reviewing().rows(tableId, query, offset, limit, await leftOutKeys());
  },

  async leaveOut(keys, out) {
    const next = new Set(await leftOutKeys());
    for (const key of keys) {
      if (out) next.add(key);
      else next.delete(key);
    }
    await saveLeftOut(next);
    return reviewing().overview(next);
  },

  async leaveOutMatching(tableId, query) {
    const r = reviewing();
    const next = new Set(await leftOutKeys());
    const keys = r.matching(tableId, query).filter((k) => !next.has(k));
    for (const key of keys) next.add(key);
    if (keys.length > 0) await saveLeftOut(next);
    return { count: keys.length, overview: r.overview(next) };
  },

  async putBackAll() {
    await saveLeftOut(new Set());
    return reviewing().overview(new Set());
  },

  async donate(pin, consent) {
    const study = await fetchSettings(projectId!);
    if (!study) return { status: 'unreachable' };
    // What is sent must be what the participant reviewed.
    if (!review || review.settings !== study.settings) {
      review = undefined;
      return { status: 'changed' };
    }
    const keys = await leftOutKeys();
    const content = review.donated(keys);
    const asked = donatedAnswers(study.story, await storedAnswers(), consent.language);
    if (content.values.length === 0 && asked.questions.length === 0) return { status: 'nothing' };
    const sent = await sendDonation(projectId!, study, content, pin, consent, asked);
    if (sent.status !== 'sent') return sent;
    const manifest: DonationManifest = {
      type: 'donation',
      donation: sent.donation,
      token: sent.token,
      sent: new Date().toISOString(),
      rows: content.rows.length,
      tables: review
        .overview(keys)
        .tables.filter((t) => t.rowCount > t.leftOut)
        .map((t) => t.name),
    };
    const id = await (await unlockedStore()).putDataset(manifest, []);
    return { status: 'done', receipt: receiptOf(id, manifest) };
  },

  async donations() {
    const datasets = await (await unlockedStore()).listDatasets();
    return datasets.flatMap((d) => (d.manifest.type === 'donation' ? [receiptOf(d.id, d.manifest)] : [])).sort((a, b) => b.sent.localeCompare(a.sent));
  },

  async withdraw(id) {
    const s = await unlockedStore();
    const found = (await s.listDatasets()).find((d) => d.id === id);
    if (found?.manifest.type !== 'donation') throw new Error('no such donation');
    const result = await withdrawDonation(found.manifest.donation, found.manifest.token);
    if (result === 'done') {
      await s.putDataset({ ...found.manifest, withdrawn: new Date().toISOString() }, []);
      await s.deleteDataset(id);
    }
    return result;
  },
};

Comlink.expose(api);
