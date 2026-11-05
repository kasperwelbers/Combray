import type { ChartData, ChartSpec, ColumnDef, Localized, ProjectNode, Shape, Story, TableDef, TreeNode } from '@combray/core';

import type { ImportProgress, StoryView, Upload } from '../worker/api';

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
  /** The first row holds the column names (shown as names when there are rows). */
  headerRow?: true;
  parent?: number;
  state: TableDef['state'];
  columns: ColumnDef[];
  rowCount: number;
  rows: PreviewRow[];
}

/** A field's values in the loaded test packages: a summary, for the tree editor. */
export interface FieldValues {
  /** How many times the field occurs (items that have it). */
  total: number;
  /** How many of those are empty (null or an empty text). */
  empty: number;
  /** How many different values there are. */
  distinct: number;
  /** The most common values, most common first. */
  top: { value: string; count: number }[];
}

export interface StudioApi {
  addExport(
    uploads: Upload[],
    onProgress: (p: ImportProgress) => void,
  ): Promise<{ export: StudioExport; shape: Shape }>;
  /** Read a package's files (an example's) into a tree, without loading it. */
  readPackage(files: { path: string; text: string }[]): Promise<{ tree: TreeNode; shape: Shape }>;
  /** A package kept with the project: its tree as read before, from the server. */
  addTree(name: string, tree: TreeNode): Promise<{ export: StudioExport; shape: Shape }>;
  /** A loaded package's tree, to keep it with the project. */
  exportTree(id: number): Promise<TreeNode>;
  removeExport(id: number): Promise<void>;
  /** The derived tables of the loaded exports, with the first rows of each. */
  /**
   * The participant view of one loaded package (`source`, an export id), or of the structure
   * alone (no source): tables and columns without rows.
   */
  preview(tree: ProjectNode, rowLimit: number, source?: number): Promise<PreviewTable[]>;
  /** A field's values in the loaded test packages, summarised. */
  fieldValues(tree: ProjectNode, path: string[], limit: number): Promise<FieldValues>;
  /**
   * The most common values of each field (by path) across all loaded packages, a few per field,
   * keyed by `JSON.stringify(path)`; fields without values are left out.
   */
  examples(tree: ProjectNode, paths: string[][], perField: number): Promise<Record<string, string[]>>;
  /** A chart over all rows of the loaded exports. Only counts and summaries come back. */
  chart(tree: ProjectNode, spec: ChartSpec): Promise<ChartData>;
  /** Keep a test package for previewing the story, apart from the loaded exports. */
  loadStoryPackage(key: string, tree: TreeNode): Promise<void>;
  /**
   * What the story's data blocks show for one test package per platform, read the way a
   * participant's device reads it. Only counts come back.
   */
  storyViews(story: Story, sources: StoryPreviewSource[]): Promise<Record<string, StoryView>>;
}

/** A platform's files as the draft has them, with the test package (`loadStoryPackage` key) to preview with. */
export interface StoryPreviewSource {
  platform: string;
  structure?: unknown;
  importer?: unknown;
  pack?: string;
  package: string;
}

/** A test package kept with a project's platform on the server (`/test-packages`). */
export interface StoredPackage {
  id: string;
  name: string;
  structure_hash: string;
  has_data: boolean;
  data_bytes: number;
  added: number;
  added_by: string | null;
}

/**
 * Where a platform's test packages are kept: its structure always, its values when the
 * researcher declares they are synthetic or not sensitive. In an example project, they are kept in
 * this tab (`exampleApi.ts`).
 */
export interface PackageStore {
  list(): Promise<{ packages: StoredPackage[]; shapes: { hash: string; shape: Shape }[] }>;
  add(name: string, shape: Shape, data?: TreeNode): Promise<{ id: string; new_structure: boolean; existing: boolean }>;
  data(id: string): Promise<TreeNode>;
  remove(id: string): Promise<void>;
}
