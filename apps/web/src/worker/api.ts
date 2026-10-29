import type { DisplayHints, Localized, NodeKind, Row, Shape, ValueType } from '@combray/core';

/** An imported archive, folder or file, stored as its tree. Encrypted; never sent anywhere. */
export interface SourceManifest {
  type: 'source';
  name: string;
  source: 'archive' | 'folder' | 'file';
  /** Day of import, ISO date. */
  importedAt: string;
  nodeCount: number;
  fileCount: number;
  shape: Shape;
}

/** The rows an importer found in a source. Encrypted; never sent anywhere. */
export interface TableManifest {
  type: 'table';
  sourceId: string;
  importer: { id: string; version: number };
  name: Localized;
  description?: Localized;
  importedAt: string;
  rowCount: number;
  fields: string[];
  display: DisplayHints;
  /** Rows left out by the importer's filter. */
  filtered: number;
  /** Rows where a script failed. */
  errorCount: number;
}

/** A file of a source, kept as one encrypted blob of its raw bytes. Never sent anywhere. */
export interface FileManifest {
  type: 'file';
  sourceId: string;
  /** Path inside the picked folder, or the file name. */
  path: string;
  mime: string;
  size: number;
}

export type DatasetManifest = SourceManifest | TableManifest | FileManifest;

export interface TableSummary {
  id: string;
  type: 'table';
  sourceId: string;
  importerId: string;
  name: Localized;
  description?: Localized;
  rowCount: number;
  fields: string[];
  display: DisplayHints;
}

export interface DatasetSummary {
  id: string;
  type: 'source';
  name: string;
  source: SourceManifest['source'];
  importedAt: string;
  nodeCount: number;
  fileCount: number;
  /** What the importers found in this source. */
  tables: TableSummary[];
}

/** Narrow rows down: by a value of a field, and/or by a range of local days [from, to). */
export interface RowFilter {
  field?: string;
  value?: string;
  from?: string;
  to?: string;
}

export type TimeUnit = 'day' | 'week' | 'month';

export interface Timeline {
  unit: TimeUnit;
  /** Consecutive periods, including empty ones. `start` and `end` are local days. */
  buckets: { start: string; end: string; count: number }[];
  /** Rows without a usable date. */
  undated: number;
}

export interface TopItems {
  /** Number of distinct values. */
  distinct: number;
  items: { value: string; count: number }[];
}

/** A node as the tree browser sees it: values are truncated previews. */
export interface NodeSummary {
  index: number;
  kind: NodeKind;
  name: string;
  childCount: number;
  preview?: string;
  type?: ValueType;
  mime?: string;
  size?: number;
  attrs?: Record<string, string>;
}

export interface NodeDetail {
  node: NodeSummary;
  /** From the root down to the node's parent. */
  ancestors: NodeSummary[];
  /** Names from the root (exclusive) to the node. */
  location: string[];
}

export interface Page<T> {
  total: number;
  offset: number;
  items: T[];
}

export interface SearchHit {
  node: NodeSummary;
  location: string[];
}

/** A file to import, with its path inside a picked or dropped folder (or just its name). */
export interface Upload {
  file: File;
  path: string;
}

export type ImportStep = 'reading' | 'parsing' | 'shape' | 'encrypting' | 'importers' | 'done';

export interface ImportProgress {
  step: ImportStep;
  /** Files read so far, during the reading step. */
  files?: number;
}

export interface StoreStatus {
  exists: boolean;
  unlocked: boolean;
  /** The participant id this store was created with, if any. */
  participantId?: string;
}

/** A project as the client sees it: its public config. */
export interface ProjectInfo {
  id: string;
  name?: Localized;
  participants: { mode: 'anonymous' | 'optional' | 'required' };
}

/** A project that has a store on this device. */
export interface LocalProject {
  id: string;
  name?: Localized;
  participantId?: string;
}

/** Why a store could not be created or opened. `retryAfter` is in seconds. */
export type KeyServiceProblem =
  | { status: 'too-many-attempts'; retryAfter: number }
  | { status: 'unreachable' };

export type CreateResult =
  | { status: 'ok' }
  | { status: 'invalid-password' }
  | { status: 'invalid-participant' }
  | { status: 'participant-required' }
  | { status: 'no-such-project' }
  | KeyServiceProblem;

export type ResetResult =
  | { status: 'ok' }
  | { status: 'invalid-password' }
  /** Used, expired, or not for this store. */
  | { status: 'invalid-token' }
  | { status: 'store-gone' }
  | KeyServiceProblem;

export type UnlockResult =
  | { status: 'ok' }
  | { status: 'wrong-password'; retryAfter?: number }
  /** The server no longer has this store's key, so the data cannot be opened again. */
  | { status: 'store-gone' }
  | KeyServiceProblem;

/** The data worker's API. All parsing, encryption and querying happen behind it. */
export interface DataApi {
  /** Projects with a store on this device. Read locally; the server is not asked. */
  localProjects(): Promise<LocalProject[]>;
  /** Switch to a project's store. Every call below works on the open project. */
  openProject(projectId: string): Promise<void>;
  status(): Promise<StoreStatus>;
  create(password: string, project: ProjectInfo, participantId?: string): Promise<CreateResult>;
  unlock(password: string): Promise<UnlockResult>;
  /** Choose a new password with a reset link from the researchers; unlocks on success. */
  resetPassword(token: string, password: string): Promise<ResetResult>;
  lock(): Promise<void>;
  destroy(): Promise<void>;
  importFiles(
    uploads: Upload[],
    onProgress: (progress: ImportProgress) => void,
  ): Promise<DatasetSummary>;
  listDatasets(): Promise<DatasetSummary[]>;
  deleteDataset(id: string): Promise<void>;
  getNode(datasetId: string, index: number): Promise<NodeDetail>;
  getChildren(datasetId: string, index: number, offset: number, limit: number): Promise<Page<NodeSummary>>;
  getShape(datasetId: string): Promise<Shape>;
  search(datasetId: string, query: string, limit: number): Promise<Page<SearchHit>>;
  getRows(tableId: string, filter: RowFilter, offset: number, limit: number): Promise<Page<Row>>;
  getTimeline(tableId: string, filter: RowFilter, unit?: TimeUnit): Promise<Timeline>;
  getTopItems(tableId: string, field: string, filter: RowFilter, limit: number): Promise<TopItems>;
}
