import type { ColumnDef, DisplayHints, Localized, NodeKind, NodePath, Role, Row, Shape, ValueType } from '@combray/core';

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

/**
 * Where participants add data for one platform, from the project config: matched against the
 * tree of a platform pack (docs/tree-decisions.md#upload-points-and-the-nameless-root).
 */
export interface UploadPoint {
  id: string;
  /** A bundled platform pack (`google-takeout`, `tiktok`). */
  pack: string;
  name?: Localized;
}

/** A column of a table derived through a project tree. */
export interface ColumnInfo {
  id: string;
  /** The researcher's label; empty for the key and value of a key/value table. */
  name: Localized;
  type: ColumnDef['type'];
  state: ColumnDef['state'];
  role?: Role;
  /** Read as a date and time, or as a link: shown as such. */
  as?: 'datetime' | 'url';
  /** The researcher has not decided on it: shown, never requested. */
  undecided?: true;
  /** Not in the project's structure yet: new to the researchers too. */
  new?: true;
  /** For nested tables: their columns. Their rows are inside each row, under the column id. */
  columns?: ColumnInfo[];
}

/** What a table derived through a project tree adds to its manifest. */
export interface DerivedTable {
  name: Localized;
  /** Where its rows are in the project tree, for breadcrumbs. */
  path: NodePath;
  /** A single record of fields outside any list. */
  record: boolean;
  /** Has fields the researchers chose to show or ask for; else it is "other data". */
  collection: boolean;
  /** Has fields the researchers ask participants to donate. */
  requested: boolean;
  new?: true;
  columns: ColumnInfo[];
  display: DisplayHints;
}

/** The rows an importer found in a source. Encrypted; never sent anywhere. */
export interface TableManifest {
  type: 'table';
  sourceId: string;
  /** The YAML importer, or the upload point and pack a derived table came from. */
  importer: { id: string; version: number };
  /** For tables derived through a project tree. */
  derived?: Omit<DerivedTable, 'name' | 'display'>;
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
  derived?: Omit<DerivedTable, 'name' | 'display'>;
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
  /** Without upload points, uploads go through the YAML importers. */
  uploads?: UploadPoint[];
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
    points?: UploadPoint[],
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
