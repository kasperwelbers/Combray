import type {
  Answer,
  ColumnDef,
  DisplayHints,
  Localized,
  NodeKind,
  NodePath,
  PlatformTexts,
  Role,
  RootChoice,
  Row,
  Shape,
  Story,
  UploadProblem,
  ValueType,
} from '@combray/core';
import type { DonationConsent } from '@combray/seal';
import type { BackupProblem } from '@combray/store';

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
  /** The upload point it was imported through (missing on imports from before donations). */
  point?: string;
}

/**
 * Where participants add data for one platform, from the project config: matched against the
 * tree of a platform pack (docs/tree-decisions.md#upload-points-and-the-nameless-root).
 */
export interface UploadPoint {
  id: string;
  /** The bundled platform pack it started from (`google-takeout`, `tiktok`), if any. */
  pack?: string;
  name?: Localized;
  /** The project's own tree, as published from the studio (structure and settings files). */
  structure?: unknown;
  importer?: unknown;
  /** The project's labels and descriptions for this platform's tables, over its pack's. */
  texts?: PlatformTexts;
}

/** A column of a table derived through a project tree. */
export interface ColumnInfo {
  id: string;
  /** Its label, or its name with spaces; empty for the key and value of a key/value table. */
  name: Localized;
  type: ColumnDef['type'];
  state: ColumnDef['state'];
  role?: Role;
  /** Read as a date and time, or as a link: shown as such. */
  as?: 'datetime' | 'url';
  /** Named by structure only (`#cell[0]`, `div/#text[1]`): its header is left empty. */
  unnamed?: true;
  /** The researcher has not decided on it: shown, never requested. */
  undecided?: true;
  /** Not in the project's structure yet: new to the researchers too. */
  new?: true;
  /** For nested tables: their columns. Their rows are inside each row, under the column id. */
  columns?: ColumnInfo[];
}

/** What a table derived through a project tree adds to its manifest. */
export interface DerivedTable {
  /**
   * The table's name in the project (`TableDef.id`), which stories refer to it by. Missing on
   * tables imported before stories.
   */
  key?: string;
  name: Localized;
  /** What the table is, from the project's texts. */
  description?: Localized;
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
  /**
   * The first row, when the researcher says it holds the column names: shown as the names and
   * left out of the rows, but kept here so a donation can give the data as it was.
   */
  headerRow?: Row;
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
  /** Path inside the root that was read, or the file name. */
  path: string;
  mime: string;
  size: number;
}

/** Rows the participant left out of their donation, by `DonationRow.key`. Encrypted. */
export interface LeftOutManifest {
  type: 'left-out';
}

/** A donation that was sent, with what is needed to withdraw it. Encrypted. */
export interface DonationManifest {
  type: 'donation';
  /** The donation id the server knows it by. */
  donation: string;
  /** The withdrawal token: with the id, it withdraws the donation. */
  token: string;
  /** When it was sent, ISO time. */
  sent: string;
  rows: number;
  /** Names of the tables in it, as the participant saw them. */
  tables: Localized[];
  withdrawn?: string;
}

/** The participant's answers to the story's questions, by question id. Encrypted. */
export interface AnswersManifest {
  type: 'answers';
}

export type DatasetManifest = SourceManifest | TableManifest | FileManifest | LeftOutManifest | DonationManifest | AnswersManifest;

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

export type ImportStep = 'looking' | 'encrypting' | 'importers' | 'done';

export interface ImportProgress {
  step: ImportStep;
}

/**
 * How an import went. `choose`: more than one place in the upload fits; the participant picks
 * with `chooseRoots`. The other problems have a message each (docs/tree-decisions.md).
 */
export type ImportResult =
  | { status: 'done'; dataset: DatasetSummary }
  | { status: 'choose'; choices: RootChoice[]; multiple: boolean }
  | { status: UploadProblem };

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
  /** The study has a story for participants. */
  story?: true;
  /** The languages the study is in, the first one it is written in. */
  languages?: string[];
}

/** A project that has a store on this device. */
export interface LocalProject {
  id: string;
  name?: Localized;
  participantId?: string;
}

/** Why a store could not be created or opened. `retryAfter` is in seconds. */
export type KeyServiceProblem = { status: 'too-many-attempts'; retryAfter: number } | { status: 'unreachable' };

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
  /** Too many wrong passwords in a row: only a reset link from the researchers opens it again. */
  | { status: 'locked' }
  /** The server no longer has this store's key, so the data cannot be opened again. */
  | { status: 'store-gone' }
  | KeyServiceProblem;

/** Restoring a backup file on this device. */
export type RestoreResult = { status: 'ok' } | { status: BackupProblem };

/**
 * What a data block of a story shows, computed from the participant's own tables on their device
 * (`apps/web/src/worker/story.ts`). Dates are local days (`YYYY-MM-DD`).
 */
export type StoryView =
  | {
      view: 'amount';
      count: number;
      first?: string;
      last?: string;
      days?: number;
    }
  | { view: 'top'; items: { value: string; count: number }[]; distinct: number }
  | {
      view: 'over-time';
      unit: TimeUnit;
      buckets: { start: string; count: number }[];
    }
  /** Counts per hour (0 to 23) or per weekday (Monday first). */
  | { view: 'rhythm'; by: 'hour' | 'weekday'; counts: number[] };

/** The study's story, with what its data blocks show of this participant's data, and their answers. */
export interface StoryOverview {
  story: Story;
  /** By data block id; blocks without data for this participant are missing. */
  views: Record<string, StoryView>;
  answers: Record<string, Answer>;
}

/** A question the participant answered, for the donation review. */
export interface DonationAnswer {
  id: string;
  prompt: Localized;
  answer: Answer;
  /** For a choice: the option chosen, to show in the participant's language. */
  option?: Localized;
}

/** A table of the donation, as the participant reviews it. */
export interface DonationTable {
  id: string;
  name: Localized;
  fields: { id: string; name: Localized }[];
  /** For a nested table: the table its rows are in. */
  parent?: string;
  rowCount: number;
  leftOut: number;
}

/** What the study tells participants, and asks them to agree to, before they donate. */
export interface StudyConsent {
  information?: Localized;
  statements?: Localized[];
}

/** What a donation would hold right now. */
export interface DonationOverview {
  tables: DonationTable[];
  consent?: StudyConsent;
  /** Rows in the donation, and rows left out. */
  rows: number;
  leftOut: number;
}

/** A row of the donation, for review. */
export interface DonationRow {
  /** Stable while the uploads and the study's settings stay the same. */
  key: string;
  cells: Record<string, string[]>;
  leftOut: boolean;
  /** Left out because the row it is in was. */
  withParent: boolean;
}

export type DonationProblem =
  /** Nothing the study asks for is in the uploads, or everything was left out. */
  | 'nothing'
  /** The study has no key to encrypt donations to yet. */
  | 'no-key'
  /** The key is not the one in the link the participant came in through. */
  | 'wrong-key'
  /** The study's settings changed since the review: the participant should look again. */
  | 'changed'
  | 'too-big'
  | 'unreachable'
  | 'failed';

export type DonateResult = { status: 'done'; receipt: DonationReceipt } | { status: DonationProblem };

export interface DonationReceipt {
  id: string;
  donation: string;
  /** The code that withdraws it: the donation id and the token, for the participant to keep. */
  code: string;
  sent: string;
  rows: number;
  tables: Localized[];
  withdrawn?: string;
}

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
  /** The open project's store as a backup file, still encrypted. Works while locked. */
  backup(): Promise<{ file: Blob; name: string }>;
  /** Fill this device's (empty) store for the open project from a backup file. It stays locked. */
  restore(file: Blob): Promise<RestoreResult>;
  /**
   * Import an upload. With an upload point, its root is found for the point's project tree;
   * without, everything is read for the YAML importers.
   */
  importFiles(uploads: Upload[], onProgress: (progress: ImportProgress) => void, point?: UploadPoint): Promise<ImportResult>;
  /** Continue an import that returned `choose`, with the ids of the chosen places. */
  chooseRoots(ids: number[], onProgress: (progress: ImportProgress) => void): Promise<ImportResult>;
  /** Forget an import that is waiting for a choice. */
  cancelImport(): Promise<void>;
  listDatasets(): Promise<DatasetSummary[]>;
  deleteDataset(id: string): Promise<void>;
  getNode(datasetId: string, index: number): Promise<NodeDetail>;
  getChildren(datasetId: string, index: number, offset: number, limit: number): Promise<Page<NodeSummary>>;
  getShape(datasetId: string): Promise<Shape>;
  search(datasetId: string, query: string, limit: number): Promise<Page<SearchHit>>;
  getRows(tableId: string, filter: RowFilter, offset: number, limit: number): Promise<Page<Row>>;
  getTimeline(tableId: string, filter: RowFilter, unit?: TimeUnit): Promise<Timeline>;
  getTopItems(tableId: string, field: string, filter: RowFilter, limit: number): Promise<TopItems>;
  /**
   * The study's story, with its data blocks computed from this participant's tables, and their
   * answers. `none` when the study has no story; `unreachable` when its settings cannot be fetched.
   */
  story(): Promise<StoryOverview | 'none' | 'unreachable'>;
  /** Keep an answer to a question of the story on this device; `null` removes it. */
  answer(questionId: string, answer: Answer | null): Promise<void>;
  /** The answers that would go with a donation, to the story's questions as they are now. */
  donationAnswers(): Promise<DonationAnswer[] | 'unreachable'>;
  /**
   * What a donation would hold: the fields the study asks for, from every upload, with the
   * study's current settings (fetched fresh). `unreachable` when the settings cannot be fetched.
   */
  donationOverview(): Promise<DonationOverview | 'unreachable'>;
  /** Rows of a table in the donation; with a query, only rows that contain it. */
  donationRows(tableId: string, query: string, offset: number, limit: number): Promise<Page<DonationRow>>;
  /** Leave rows out of the donation, or put them back. Remembered on this device. */
  leaveOut(keys: string[], out: boolean): Promise<DonationOverview>;
  /** Leave out every row of a table (or of all tables) that contains the text. Returns how many. */
  leaveOutMatching(tableId: string | undefined, query: string): Promise<{ count: number; overview: DonationOverview }>;
  /** Put every left-out row back. */
  putBackAll(): Promise<DonationOverview>;
  /**
   * Encrypt the reviewed donation to the study's key and send it. `pin` is the key fingerprint
   * from the study link, if there was one; the key must match it.
   */
  donate(pin: string | undefined, consent: DonationConsent): Promise<DonateResult>;
  /** Donations sent from this device, newest first. */
  donations(): Promise<DonationReceipt[]>;
  /** Withdraw a donation: the server forgets its key, so nobody can open it any more. */
  withdraw(id: string): Promise<'done' | 'unreachable' | 'failed'>;
}
