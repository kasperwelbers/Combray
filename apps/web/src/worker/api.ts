import type { NodeKind, Shape, ValueType } from '@combray/core';

/** Encrypted along with each dataset. Never sent anywhere. */
export interface DatasetManifest {
  name: string;
  source: 'archive' | 'folder' | 'file';
  /** Day of import, ISO date. */
  importedAt: string;
  nodeCount: number;
  fileCount: number;
  shape: Shape;
}

export interface DatasetSummary {
  id: string;
  name: string;
  source: DatasetManifest['source'];
  importedAt: string;
  nodeCount: number;
  fileCount: number;
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

export type ImportStep = 'reading' | 'parsing' | 'shape' | 'encrypting' | 'done';

export interface ImportProgress {
  step: ImportStep;
  /** Files read so far, during the reading step. */
  files?: number;
}

export interface StoreStatus {
  exists: boolean;
  unlocked: boolean;
}

export type UnlockResult = 'ok' | 'wrong-passphrase';

/** The data worker's API. All parsing, encryption and querying happen behind it. */
export interface DataApi {
  status(): Promise<StoreStatus>;
  create(passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<UnlockResult>;
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
}
