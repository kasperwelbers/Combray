import type { ChartData, ChartSpec, ColumnDef, Localized, ProjectNode, Shape, TableDef } from '@combray/core';

import type { ImportProgress, Upload } from '../worker/api';

/** An export the researcher loaded into the workspace. Kept in the worker's memory only. */
export interface StudioExport {
  id: number;
  /** Shown to the researcher only; never part of the project tree. */
  name: string;
  nodeCount: number;
}

export type PreviewValue = string | number | null | { items: (string | null)[]; total: number };

export interface PreviewRow {
  /** Index among all rows of the table, which nested rows' `parent` refers to. */
  index: number;
  values: Record<string, PreviewValue>;
  parent?: number;
}

export interface PreviewTable {
  name: Localized;
  /** True for a table of key and value rows (a map whose keys are data). */
  keyed: boolean;
  /** True for a single record: fields outside any repeated node. */
  record: boolean;
  parent?: number;
  state: TableDef['state'];
  columns: ColumnDef[];
  rowCount: number;
  rows: PreviewRow[];
}

export interface StudioApi {
  addExport(
    uploads: Upload[],
    onProgress: (p: ImportProgress) => void,
  ): Promise<{ export: StudioExport; shape: Shape }>;
  removeExport(id: number): Promise<void>;
  /** The derived tables of the loaded exports, with the first rows of each. */
  preview(tree: ProjectNode, rowLimit: number): Promise<PreviewTable[]>;
  /** A chart over all rows of the loaded exports. Only counts and summaries come back. */
  chart(tree: ProjectNode, spec: ChartSpec): Promise<ChartData>;
}
