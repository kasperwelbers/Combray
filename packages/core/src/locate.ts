/**
 * Finding the export in an upload (docs/tree-decisions.md#finding-the-export-in-an-upload).
 *
 * The file or folder a participant picks is the nameless root of their data, and wrappers
 * around it (a zip holding one `Takeout/` folder) are stepped into. A project tree can also
 * give name patterns, so the export can be found inside a bigger folder. Everything works on
 * names first: no file is opened until its name has passed, and only the files inside the
 * chosen root are read. Combray's limits on how much is looked at are fixed; researchers
 * cannot change them.
 *
 * File and folder names are only compared here, on the participant's device. They are never
 * recorded in the tree or sent anywhere.
 */
import { unzipSync } from 'fflate';

import { closedNodes, isDecidable, knownKeys, matchChild, matchShape, nameMatches, type ProjectNode } from './decisions';
import { normalizeTree } from './normalize';
import { isNoise, mergeDirs, parseEntries, parseFile, type ParseOptions } from './parse';
import { globMatch } from './path';
import { COLLAPSED_NAME, extractShape, type Shape } from './shape';
import type { DirNode, TreeNode } from './tree';

/** How much of an upload Combray looks at. Fixed: not a project setting. */
export interface UploadLimits {
  /** Files in an upload, counted by name, archives' contents included. */
  maxFiles: number;
  /** Files or folders whose name matches a project's patterns, all of which would be opened. */
  maxCandidates: number;
  /** Bytes read from one upload: archives opened, files checked, and the files of the root. */
  maxReadBytes: number;
}

export const UPLOAD_LIMITS: Readonly<UploadLimits> = Object.freeze({
  maxFiles: 100_000,
  maxCandidates: 10,
  maxReadBytes: 4 * 1024 ** 3,
});

/** Why an upload was not read. Each has a participant-facing message. */
export type UploadProblem = 'no-fit' | 'too-many-files' | 'too-many-candidates' | 'too-big';

export class UploadProblemError extends Error {
  constructor(readonly problem: UploadProblem) {
    super(problem);
    this.name = 'UploadProblemError';
  }
}

/** A file as the browser gives it: its path in the picked folder, its size, and its bytes on request. */
export interface UploadFile {
  /** `/`-separated; for a picked folder, starting with the folder's own name. */
  path: string;
  size: number;
  read(): Promise<Uint8Array>;
}

/** How wrappers are stepped into, at most: `takeout-….zip` › `Takeout/` › … */
const MAX_UNWRAP = 4;

const isZip = (name: string) => /\.zip$/i.test(name);
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** One zip archive, read once; entries are inflated on request, many in one pass. */
class Archive {
  constructor(private readonly bytes: Uint8Array) {}

  /** Names and sizes, without inflating anything. */
  entries(): { name: string; size: number }[] {
    const out: { name: string; size: number }[] = [];
    unzipSync(this.bytes, {
      filter: (file) => {
        if (!file.name.endsWith('/')) out.push({ name: file.name, size: file.originalSize });
        return false;
      },
    });
    return out;
  }

  extract(names: Set<string>): Record<string, Uint8Array> {
    return unzipSync(this.bytes, { filter: (file) => names.has(file.name) });
  }
}

interface Listed {
  path: string;
  size: number;
  read?: () => Promise<Uint8Array>;
  archive?: Archive;
  entry?: string;
}

/** A place in an upload that may be the root: a folder (path `''` or ending in `/`) or a file. */
export interface Spot {
  kind: 'folder' | 'file';
  path: string;
}

/**
 * An upload as a list of names. Archives the participant picked are opened right away (they
 * are the upload); archives inside it only when they are a wrapper or a name matches.
 */
export class UploadListing {
  private files: Listed[] = [];
  private readBytes = 0;

  private constructor(
    /** The picked file's or folder's name, shown to the participant only. */
    readonly name: string,
    /** What was picked: one file, one folder, archives, or loose files. */
    readonly source: 'file' | 'folder' | 'archive' | 'files',
    readonly limits: UploadLimits,
  ) {}

  static async open(uploads: UploadFile[], limits: UploadLimits = UPLOAD_LIMITS): Promise<UploadListing> {
    const first = uploads[0];
    if (!first) throw new Error('no files');
    const tops = new Set(uploads.map((u) => u.path.split('/')[0]));
    const [top] = tops;
    const folder = tops.size === 1 && top !== undefined && uploads.every((u) => u.path.includes('/'));
    const zips = !folder && uploads.every((u) => isZip(u.path));
    const source = folder ? 'folder' : zips ? 'archive' : uploads.length === 1 ? 'file' : 'files';
    const name = folder ? top! : uploads.length === 1 ? first.path : `${uploads.length} ${zips ? 'archives' : 'files'}`;
    const listing = new UploadListing(name, source, limits);
    listing.files = uploads
      .map((u) => ({ path: folder ? u.path.slice(top!.length + 1) : u.path, size: u.size, read: () => u.read() }))
      .filter((f) => !isNoise(f.path));
    listing.checkCount();
    // Archives that were picked are the upload: their contents merge at the root, so the
    // parts of a split Takeout become one.
    if (zips) for (const file of [...listing.files]) await listing.expand(file.path, '');
    return listing;
  }

  get count(): number {
    return this.files.length;
  }

  private checkCount() {
    if (this.files.length > this.limits.maxFiles) throw new UploadProblemError('too-many-files');
  }

  /** Count bytes about to be read against the limit. */
  spend(bytes: number) {
    this.readBytes += bytes;
    if (this.readBytes > this.limits.maxReadBytes) throw new UploadProblemError('too-big');
  }

  /** Replace an archive by its entries, under `prefix` (the archive's path as a folder). */
  async expand(path: string, prefix = `${path}/`): Promise<boolean> {
    const file = this.files.find((f) => f.path === path);
    if (!file) return false;
    this.spend(file.size);
    const archive = new Archive(await readListed(file));
    let entries: { name: string; size: number }[];
    try {
      entries = archive.entries();
    } catch {
      return false; // Not a readable zip: it stays a file.
    }
    this.files = this.files.filter((f) => f !== file);
    for (const e of entries) {
      const entryPath = prefix + e.name.replace(/^\/+/, '');
      if (!isNoise(entryPath)) this.files.push({ path: entryPath, size: e.size, archive, entry: e.name });
    }
    this.checkCount();
    return true;
  }

  /** The files below a folder spot, with their paths from it. */
  under(folder: string): { rel: string; file: Listed }[] {
    return this.files.filter((f) => f.path.startsWith(folder)).map((f) => ({ rel: f.path.slice(folder.length), file: f }));
  }

  file(path: string): Listed | undefined {
    return this.files.find((f) => f.path === path);
  }

  /** Every folder path in the upload, without the trailing `/`. */
  folders(): string[] {
    const out = new Set<string>();
    for (const { path } of this.files) {
      for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) out.add(path.slice(0, i));
    }
    return [...out];
  }

  /** The names directly in a folder, as folder or file. */
  childrenOf(folder: string): Map<string, 'folder' | 'file'> {
    const out = new Map<string, 'folder' | 'file'>();
    for (const { rel } of this.under(folder)) {
      const slash = rel.indexOf('/');
      if (slash < 0) out.set(rel, out.get(rel) ?? 'file');
      else out.set(rel.slice(0, slash), 'folder');
    }
    return out;
  }

  /** Read files, counting them against the limit. Entries of one archive inflate in one pass. */
  async read(files: Listed[]): Promise<Map<Listed, Uint8Array>> {
    this.spend(files.reduce((n, f) => n + f.size, 0));
    const out = new Map<Listed, Uint8Array>();
    const byArchive = new Map<Archive, Listed[]>();
    for (const file of files) {
      if (file.archive) byArchive.set(file.archive, [...(byArchive.get(file.archive) ?? []), file]);
      else out.set(file, await readListed(file));
    }
    for (const [archive, entries] of byArchive) {
      const inflated = archive.extract(new Set(entries.map((e) => e.entry!)));
      for (const e of entries) out.set(e, inflated[e.entry!] ?? new Uint8Array());
    }
    return out;
  }
}

async function readListed(file: Listed): Promise<Uint8Array> {
  if (file.read) return file.read();
  return file.archive!.extract(new Set([file.entry!]))[file.entry!] ?? new Uint8Array();
}

/**
 * The upload itself, and each wrapper level below it: while a folder holds exactly one entry,
 * that entry is tried too (a folder, an archive, which is opened, or a file).
 */
async function levels(listing: UploadListing, start: Spot, steps = MAX_UNWRAP): Promise<Spot[]> {
  let spot = start;
  if (spot.kind === 'file' && isZip(spot.path) && (await listing.expand(spot.path))) {
    spot = { kind: 'folder', path: `${spot.path}/` };
  }
  const out = [spot];
  for (let i = 0; i < steps && spot.kind === 'folder'; i++) {
    const children = listing.childrenOf(spot.path);
    if (children.size !== 1) break;
    const [name, kind] = [...children][0]!;
    const path = spot.path + name;
    if (kind === 'folder') spot = { kind: 'folder', path: `${path}/` };
    else if (isZip(name) && (await listing.expand(path))) spot = { kind: 'folder', path: `${path}/` };
    else spot = { kind: 'file', path };
    out.push(spot);
  }
  return out;
}

/**
 * The root used without a project tree (the researcher workspace, the YAML importers): a file
 * as it is, a picked folder as it is, and an archive stepped into once if it holds one entry.
 */
export async function defaultRoot(listing: UploadListing): Promise<Spot> {
  const top: Spot = { kind: 'folder', path: '' };
  if (listing.source !== 'file' && listing.source !== 'archive') return top;
  return (await levels(listing, top, 1))[1] ?? top;
}

/** What a project tree says about matching uploads, worked out once. */
interface TreeFacts {
  tree: ProjectNode;
  /** Nodes with a show or donate decision at or below them, outside ignored parts. */
  study: Set<ProjectNode>;
  /** Leaves (and `{*}` nodes) with a show or donate decision, outside ignored parts. */
  studyLeaves: ProjectNode[];
  required: ProjectNode[];
  /** Nodes with a required node at or below them. */
  holdsRequired: Set<ProjectNode>;
  closed: Set<ProjectNode>;
}

function treeFacts(tree: ProjectNode): TreeFacts {
  const study = new Set<ProjectNode>();
  const studyLeaves: ProjectNode[] = [];
  const required: ProjectNode[] = [];
  const holdsRequired = new Set<ProjectNode>();
  const visit = (node: ProjectNode, parentIgnored: boolean): { study: boolean; required: boolean } => {
    const ignored = parentIgnored || node.decision === 'ignore';
    const own = !ignored && isDecidable(node) && (node.decision === 'show' || node.decision === 'donate');
    if (own) studyLeaves.push(node);
    if (node.required) required.push(node);
    let below = { study: own, required: node.required === true };
    for (const child of node.children ?? []) {
      const c = visit(child, ignored);
      below = { study: below.study || c.study, required: below.required || c.required };
    }
    if (below.study) study.add(node);
    if (below.required) holdsRequired.add(node);
    return below;
  };
  visit(tree, false);
  return { tree, study, studyLeaves, required, holdsRequired, closed: closedNodes(tree) };
}

/** The project node a file or folder name in a folder maps to (by name or alias). */
function childByName(node: ProjectNode, name: string, folder: boolean): ProjectNode | undefined {
  if (folder) return matchChild(node, 'dir', name);
  const wanted = node.collapsed ? COLLAPSED_NAME : name;
  const files = (node.children ?? []).filter((c) => c.kind !== 'dir' || isZip(name));
  return files.find((c) => c.name === wanted) ?? files.find((c) => nameMatches(c, wanted));
}

/** The project nodes along a path of folder and file names, as far as the tree knows them. */
function walkNames(tree: ProjectNode, rel: string): ProjectNode[] {
  const names = rel.split('/');
  const out: ProjectNode[] = [];
  let node = tree;
  for (let i = 0; i < names.length; i++) {
    const next = childByName(node, names[i]!, i < names.length - 1);
    if (!next) break;
    out.push(next);
    node = next;
  }
  return out;
}

/**
 * A folder checked on names only. It fits when a file in it leads to something the study shows
 * or asks for, and every required folder or file is there. Required parts inside files are
 * checked once the root is read.
 */
function folderFit(listing: UploadListing, facts: TreeFacts, folder: string): number {
  if (facts.tree.kind !== 'dir') return 0;
  const reached = new Set<ProjectNode>();
  let hits = 0;
  for (const { rel } of listing.under(folder)) {
    const path = walkNames(facts.tree, rel);
    for (const node of path) reached.add(node);
    const last = path[path.length - 1];
    if (path.length === rel.split('/').length && last && facts.study.has(last)) hits++;
  }
  const missing = facts.required.some((n) => !reached.has(n) && onNamesLevel(facts.tree, n));
  return missing ? 0 : hits;
}

/** Whether a node is a folder or a file: every node above it is a folder. */
function onNamesLevel(tree: ProjectNode, target: ProjectNode): boolean {
  const visit = (node: ProjectNode): boolean =>
    (node.children ?? []).some((c) => c === target || (c.kind === 'dir' && visit(c)));
  return visit(tree);
}

/** A root that was read. */
export interface ReadSpot {
  /** Without a name, unless one was asked for. */
  tree: TreeNode;
  /** The files that were read, with their paths from the root, for keeping the raw bytes. */
  files: { path: string; bytes: Uint8Array }[];
}

/** A root read for a project tree: also normalised as the project sees it, and its shape. */
export interface ReadRoot extends ReadSpot {
  prepared: TreeNode;
  shape: Shape;
}

function prepare(tree: TreeNode, facts: TreeFacts): { prepared: TreeNode; shape: Shape } {
  // Header text from the participant's file only becomes a name when the project knows it.
  const prepared = normalizeTree(tree, { keys: knownKeys(facts.tree) });
  return { prepared, shape: extractShape(prepared) };
}

/** Whether a read root has every required part and something the study shows. */
function contentFits(facts: TreeFacts, shape: Shape, checkStudy: boolean): boolean {
  const seen = matchShape(facts.tree, shape);
  if (facts.required.some((n) => !seen.has(n))) return false;
  return !checkStudy || facts.studyLeaves.some((n) => seen.has(n));
}

async function readFile(listing: UploadListing, path: string, options: ParseOptions, keepName = false): Promise<ReadSpot> {
  const file = listing.file(path)!;
  const bytes = (await listing.read([file])).get(file)!;
  const name = baseName(path);
  const parsed = parseFile(name, bytes, options);
  const tree = parsed.kind === 'text' || keepName ? parsed : { ...parsed, name: '' };
  return { tree, files: [{ path: name, bytes }] };
}

/**
 * Which files of a folder root are read. Without a project tree, all of them. With one, files
 * in ignored parts are left out (unless they hold a required part), and so are files the tree
 * does not know below a folder that skips new children.
 */
function filesToRead(listing: UploadListing, folder: string, facts?: TreeFacts): { rel: string; file: Listed }[] {
  const all = listing.under(folder);
  if (!facts) return all;
  return all.filter(({ rel }) => {
    const names = rel.split('/');
    let node = facts.tree;
    let ignored = node.decision === 'ignore';
    for (let i = 0; i < names.length; i++) {
      const next = childByName(node, names[i]!, i < names.length - 1);
      if (!next) return !ignored && !facts.closed.has(node);
      ignored ||= next.decision === 'ignore';
      if (ignored && !facts.holdsRequired.has(next)) return false;
      node = next;
    }
    return true;
  });
}

async function readFolder(
  listing: UploadListing,
  folder: string,
  options: ParseOptions,
  facts?: TreeFacts,
  name = '',
): Promise<{ tree: DirNode; files: ReadSpot['files'] }> {
  const wanted = filesToRead(listing, folder, facts);
  const bytes = await listing.read(wanted.map((w) => w.file));
  const files = wanted.map(({ rel, file }) => ({ path: rel, bytes: bytes.get(file)! }));
  return { tree: parseEntries(name, files, options), files };
}

/** A root the participant may choose, when more than one fits. */
export interface RootChoice {
  id: number;
  /** The file or folder whose name matched, for the participant to recognise; never stored or sent. */
  path: string;
  kind: Spot['kind'];
}

export type Located = { status: 'found'; root: ReadRoot } | { status: UploadProblem };

export type LocateResult =
  | Located
  | {
      status: 'choose';
      choices: RootChoice[];
      /** Whether several may be chosen and added together. */
      multiple: boolean;
      choose: (ids: number[]) => Promise<Located>;
    };

interface Fit {
  /** Where it was found: the upload, or a name that matched. */
  start: Spot;
  /** The root: `start`, or a wrapper level below it. */
  spot: Spot;
  score: number;
  /** A file root parsed while checking it, kept so it is not read twice. */
  read?: ReadRoot;
}

/**
 * The best fitting level of an upload or of a candidate inside it. Folders are checked on
 * names; a file is opened and checked only when the tree's root is not a folder.
 */
async function bestLevel(
  listing: UploadListing,
  facts: TreeFacts,
  start: Spot,
  options: ParseOptions,
): Promise<Fit | undefined> {
  let best: Fit | undefined;
  for (const spot of await levels(listing, start)) {
    if (spot.kind === 'folder') {
      const score = folderFit(listing, facts, spot.path);
      if (score > (best?.score ?? 0)) best = { start, spot, score };
    } else if (facts.tree.kind !== 'dir' && !best) {
      const file = await readFile(listing, spot.path, options);
      const read = { ...file, ...prepare(file.tree, facts) };
      const fits = read.tree.kind === facts.tree.kind && contentFits(facts, read.shape, true);
      if (fits) best = { start, spot, score: 1, read };
    }
  }
  return best;
}

/**
 * Find the root of an upload for a project tree, and read it.
 *
 * 1. The upload itself, and each wrapper level below it, checked against the tree.
 * 2. If none fits and the tree's root has `find` patterns: every file, folder or archive in
 *    the upload whose name matches one, each with its own wrapper levels.
 * 3. One fit is read. Several are returned for the participant to choose from.
 */
export async function locateRoot(
  listing: UploadListing,
  tree: ProjectNode,
  options: ParseOptions = {},
): Promise<LocateResult> {
  const facts = treeFacts(tree);
  return problems(async (): Promise<LocateResult> => {
    const own = await bestLevel(listing, facts, { kind: 'folder', path: '' }, options);
    if (own) return readFit(listing, [own], facts, options);
    const patterns = (tree.find ?? []).filter((p) => findPatternProblem(p) === undefined);
    if (patterns.length === 0) return { status: 'no-fit' };
    const matches = (name: string) => patterns.some((p) => globMatch(p.toLowerCase(), name.toLowerCase()));
    const starts: Spot[] = [
      ...listing.folders().filter((p) => matches(baseName(p))).map((p): Spot => ({ kind: 'folder', path: `${p}/` })),
      ...listing.under('').filter(({ rel }) => matches(baseName(rel))).map(({ rel }): Spot => ({ kind: 'file', path: rel })),
    ];
    if (starts.length > listing.limits.maxCandidates) return { status: 'too-many-candidates' };
    const fits: Fit[] = [];
    for (const start of starts) {
      const fit = await bestLevel(listing, facts, start, options);
      if (fit && !fits.some((f) => f.spot.path === fit.spot.path)) fits.push(fit);
    }
    if (fits.length === 0) return { status: 'no-fit' };
    if (fits.length === 1) return readFit(listing, fits, facts, options);
    // Paths as the participant knows them: from the folder they picked.
    const shown = (path: string) => (listing.source === 'folder' ? `${listing.name}/${path}` : path).replace(/\/$/, '');
    const choices = fits.map((f, id) => ({ id, path: shown(f.start.path), kind: f.spot.kind }));
    return {
      status: 'choose',
      choices,
      // Folders can be added together (the parts of a split export); a file root is one file.
      multiple: fits.every((f) => f.spot.kind === 'folder'),
      choose: async (ids) => {
        const chosen = fits.filter((_, i) => ids.includes(i));
        if (chosen.length === 0 || (chosen.length > 1 && chosen.some((f) => f.spot.kind === 'file'))) {
          throw new Error('choose one file, or one or more folders');
        }
        return problems(() => readFit(listing, chosen, facts, options));
      },
    };
  });
}

/** Run a step, turning a limit or a failed check into its result. */
async function problems<T extends { status: string }>(step: () => Promise<T>): Promise<T | { status: UploadProblem }> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof UploadProblemError) return { status: error.problem };
    throw error;
  }
}

/** Read the chosen root (or roots, merged) and check the required parts inside its files. */
async function readFit(
  listing: UploadListing,
  fits: Fit[],
  facts: TreeFacts,
  options: ParseOptions,
): Promise<{ status: 'found'; root: ReadRoot }> {
  const [first] = fits;
  if (first!.spot.kind === 'file') {
    if (first!.read) return { status: 'found', root: first!.read };
    const file = await readFile(listing, first!.spot.path, options);
    return { status: 'found', root: { ...file, ...prepare(file.tree, facts) } };
  }
  const parts = [];
  for (const fit of fits) parts.push(await readFolder(listing, fit.spot.path, options, facts));
  const tree = parts.length === 1 ? parts[0]!.tree : mergeDirs('', parts.map((p) => p.tree));
  const root = { tree, ...prepare(tree, facts), files: parts.flatMap((p) => p.files) };
  if (!contentFits(facts, root.shape, false)) throw new UploadProblemError('no-fit');
  return { status: 'found', root };
}

/**
 * Read a root without a project tree: every file in it. With `name`, the root keeps a name (a
 * file its own), as the YAML importers expect.
 */
export async function readSpot(
  listing: UploadListing,
  spot: Spot,
  options: ParseOptions & { name?: string } = {},
): Promise<ReadSpot> {
  if (spot.kind === 'file') return readFile(listing, spot.path, options, options.name !== undefined);
  return readFolder(listing, spot.path, options, undefined, options.name);
}

/**
 * Why a `find` pattern cannot be used, or undefined if it can. A pattern is a file or folder
 * name with `*` wildcards, compared without regard to case. It must say something about the
 * name: at least three letters or digits besides an extension, so `*` or `*.json` (which
 * would open every file) are refused.
 */
export function findPatternProblem(pattern: string): string | undefined {
  if (pattern.trim() === '') return 'is empty';
  if (pattern.length > 100) return 'is longer than 100 characters';
  if (pattern.includes('/') || pattern.includes('\\')) return 'must be a name, without folders';
  const literal = pattern.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/\*/g, '');
  if ((literal.match(/[\p{L}\p{N}]/gu) ?? []).length < 3) return 'must have at least three letters or digits besides an extension';
  return undefined;
}
