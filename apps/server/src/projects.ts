/**
 * Projects: a draft that researchers edit in the studio, in parts (details, platforms), and a live
 * version, one JSON document copied from the draft when it is published, which participants get.
 * Plus the participant policy checked when a participant's store is created.
 */
import { and, asc, desc, eq, max, sql } from 'drizzle-orm';

import { changes, type Db, type Queries } from './db.ts';
import { projectDetails, projectPlatforms, projects, projectVersions, researchers, testPackages } from './db/schema.ts';
import { nowSecs, random, sha256 } from './util.ts';

const sha256Hex = (text: string): string => sha256(text).toString('hex');

/**
 * Project ids are lowercase letters, digits and dashes. Participants open `/p/{project}/`, so no id
 * clashes with the web client's own paths and none need to be reserved (ADR 0008).
 */
export const validProjectId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id);

/** Participant ids are pseudonymous codes from the researcher, never names or emails. */
export const validParticipantId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id);

export type ParticipantMode = 'anonymous' | 'optional' | 'required';

export interface Project {
  config: Record<string, unknown>;
  mode: ParticipantMode;
  pattern?: RegExp;
}

export type LoadError = 'not_found' | 'invalid' | 'io';

/**
 * JavaScript regular expressions backtrack, so a careless pattern could make matching take very
 * long. Patterns are therefore limited to a safe subset: at most 100 characters, no quantified
 * groups (the cause of catastrophic backtracking) and at most two unbounded repetitions. Ids are
 * at most 64 characters, which keeps the worst case small. Ordinary patterns such as `P[0-9]{4}`
 * or `[A-Z]{2}-[0-9]{3}` are fine.
 */
export function safePattern(source: string): RegExp | undefined {
  if (source.length > 100) return undefined;
  if (/\)\s*[*+?{]/.test(source)) return undefined;
  const unbounded = (source.match(/(?<!\\)[*+]|\{\d+,\}/g) ?? []).length;
  if (unbounded > 2) return undefined;
  try {
    return new RegExp(`^(?:${source})$`, 'u');
  } catch {
    return undefined;
  }
}

export function projectFromJson(config: unknown): Project | 'invalid' {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'invalid';
  const c = config as Record<string, unknown>;
  const participants = c.participants;
  if (participants === undefined) return { config: c, mode: 'optional' };
  if (typeof participants !== 'object' || Array.isArray(participants)) return 'invalid';
  const p = participants as Record<string, unknown>;
  const mode = p.mode ?? 'optional';
  if (mode !== 'anonymous' && mode !== 'optional' && mode !== 'required') return 'invalid';
  if (p.pattern === undefined || p.pattern === null) return { config: c, mode };
  if (typeof p.pattern !== 'string') return 'invalid';
  const pattern = safePattern(p.pattern);
  return pattern ? { config: c, mode, pattern } : 'invalid';
}

/** The participant id to store with a new store, checked against the project's policy. */
export function checkParticipant(project: Project, id: string | undefined | null): string | null | 'required' | 'invalid' {
  if (project.mode === 'anonymous') return null;
  if (id === undefined || id === null) return project.mode === 'required' ? 'required' : null;
  return validParticipantId(id) && (!project.pattern || project.pattern.test(id)) ? id : 'invalid';
}

export type Localized = string | Record<string, string>;

export type ProjectError = 'not_found' | 'conflict' | 'invalid';

export class ProjectFailure extends Error {
  readonly error: ProjectError;
  constructor(error: ProjectError) {
    super(error);
    this.error = error;
  }
}

const fail = (error: ProjectError): never => {
  throw new ProjectFailure(error);
};

/** Platform (upload point) ids follow the same rules as project ids. */
export const validPlatformId = validProjectId;

const MAX_TEXT = 20_000;
/** A project tree (structure or settings) may be large, but not unbounded. */
export const MAX_TREE_BYTES = 2 * 1024 * 1024;

/** A localised text: a string, or an object of language codes to strings. */
export function localized(value: unknown, required = true): Localized | undefined {
  if (value === undefined || value === null || value === '') return required ? fail('invalid') : undefined;
  if (typeof value === 'string') return value.length <= MAX_TEXT ? value : fail('invalid');
  if (typeof value !== 'object' || Array.isArray(value)) return fail('invalid');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20 || entries.some(([k, v]) => !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(k) || typeof v !== 'string' || v.length > MAX_TEXT)) {
    return fail('invalid');
  }
  return value as Record<string, string>;
}

/** A tree file as stored: JSON text, within the size limit. */
function treeText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(value);
  return Buffer.byteLength(text) <= MAX_TREE_BYTES ? text : fail('invalid');
}

const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

/** What participants read, and agree to, before they donate. */
export interface Consent {
  /** About the study: who, why, what happens with the data, how to withdraw, whom to contact. */
  information?: Localized;
  /** Statements participants tick, every one, before they can donate. */
  statements?: Localized[];
}

export const MAX_STATEMENTS = 10;

/** The largest story, as JSON text. The web client checks its shape (`parseStory`). */
export const MAX_STORY_BYTES = 256 * 1024;

/**
 * A story as stored: an object with a list of slides, within the size limit; `null` for none. The
 * server only stores and publishes it: participants' devices check every block before they use it.
 */
function storyText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).slides)) return fail('invalid');
  const text = JSON.stringify(value);
  return Buffer.byteLength(text) <= MAX_STORY_BYTES ? text : fail('invalid');
}

export interface Details {
  name: Localized;
  description?: Localized;
  participants: { mode: ParticipantMode; pattern?: string };
  consent?: Consent;
}

function checkConsent(value: unknown): Consent | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return fail('invalid');
  const c = value as Record<string, unknown>;
  const information = localized(c.information, false);
  const statements = c.statements ?? [];
  if (!Array.isArray(statements) || statements.length > MAX_STATEMENTS) return fail('invalid');
  const checked = statements.map((s) => localized(s)!);
  if (information === undefined && checked.length === 0) return undefined;
  return { ...(information !== undefined ? { information } : {}), ...(checked.length > 0 ? { statements: checked } : {}) };
}

export interface PlatformDraft {
  id: string;
  name: Localized;
  pack?: string;
  position: number;
  structure: unknown;
  importer: unknown;
}

/** Packages with content a platform may keep; structure-only ones have a higher cap. */
export const MAX_TEST_DATA = 10;
export const MAX_TEST_PACKAGES = 200;

export interface NewTestPackage {
  name: string;
  /** The shape's JSON text. */
  shape: string;
  data?: { gzip: Buffer; bytes: number };
  by: string;
}

export interface AddedTestPackage {
  id: string;
  new_structure: boolean;
  existing: boolean;
}

export interface TestPackageList {
  packages: {
    id: string;
    name: string;
    structure_hash: string;
    has_data: boolean;
    data_bytes: number;
    added: number;
    added_by: string | null;
  }[];
  shapes: { hash: string; shape: unknown }[];
}

export interface DraftSummary {
  id: string;
  details: Details;
  platforms: { id: string; name: Localized; pack: string | null; position: number; has_tree: boolean }[];
  published: { version: number; at: number } | null;
  /** Whether the draft changed after the last publication. */
  unpublished_changes: boolean;
}

/** Check details from a request or a config file; throws `invalid`. */
export function checkDetails(value: Record<string, unknown>): Details {
  const participants = (value.participants ?? {}) as Record<string, unknown>;
  if (typeof participants !== 'object' || Array.isArray(participants)) fail('invalid');
  const mode = participants.mode ?? 'optional';
  if (mode !== 'anonymous' && mode !== 'optional' && mode !== 'required') fail('invalid');
  const pattern = participants.pattern;
  if (pattern !== undefined && pattern !== null && (typeof pattern !== 'string' || !safePattern(pattern))) fail('invalid');
  const description = localized(value.description, false);
  const consent = checkConsent(value.consent);
  return {
    name: localized(value.name)!,
    ...(description !== undefined ? { description } : {}),
    participants: { mode: mode as ParticipantMode, ...(typeof pattern === 'string' && pattern ? { pattern } : {}) },
    ...(consent ? { consent } : {}),
  };
}

export class Projects {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  exists(id: string): boolean {
    return validProjectId(id) && this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get() !== undefined;
  }

  /** Create a project with a name; a conflict if the id is taken. */
  create(id: string, name: unknown): void {
    if (!validProjectId(id)) fail('invalid');
    const checked = localized(name)!;
    this.db.transaction((tx) => {
      const now = nowSecs();
      if (changes(tx.insert(projects).values({ id, created: now, draftUpdated: now }).onConflictDoNothing().run()) === 0) fail('conflict');
      tx.insert(projectDetails).values({ projectId: id, name: JSON.stringify(checked) }).run();
    });
  }

  /** The published project, as participants see it (with the pattern, which the server uses). */
  live(id: unknown): Project | LoadError {
    if (!validProjectId(id)) return 'not_found';
    const row = this.db.select({ live: projects.live, version: projects.liveVersion }).from(projects).where(eq(projects.id, id)).get();
    if (!row?.live) return 'not_found';
    try {
      // The version participants' devices stamp their donations with.
      return projectFromJson({ ...(JSON.parse(row.live) as object), version: row.version });
    } catch {
      return 'invalid';
    }
  }

  /** The published versions of a project, newest first. */
  versions(id: string): { version: number; at: number }[] {
    this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get() ?? fail('not_found');
    return this.db
      .select({ version: projectVersions.version, at: projectVersions.publishedAt })
      .from(projectVersions)
      .where(eq(projectVersions.projectId, id))
      .orderBy(desc(projectVersions.version))
      .all();
  }

  /** One published version, as participants got it (without the participant id pattern). */
  version(id: string, version: number): { version: number; at: number; config: Record<string, unknown> } {
    const row =
      this.db
        .select()
        .from(projectVersions)
        .where(and(eq(projectVersions.projectId, id), eq(projectVersions.version, version)))
        .get() ?? fail('not_found');
    const config = JSON.parse(row.config) as Record<string, unknown>;
    if (config.participants && typeof config.participants === 'object') {
      const { pattern: _hidden, ...rest } = config.participants as Record<string, unknown>;
      config.participants = rest;
    }
    return { version: row.version, at: row.publishedAt, config: { ...config, version: row.version } };
  }

  /** The project's name, from the draft (falls back to the id). */
  name(id: string): Localized {
    const row = this.db.select({ name: projectDetails.name }).from(projectDetails).where(eq(projectDetails.projectId, id)).get();
    return row ? (JSON.parse(row.name) as Localized) : id;
  }

  private details(id: string): Details {
    const row = this.db.select().from(projectDetails).where(eq(projectDetails.projectId, id)).get() ?? fail('not_found');
    return {
      name: JSON.parse(row.name) as Localized,
      ...(row.description ? { description: JSON.parse(row.description) as Localized } : {}),
      participants: { mode: row.participantsMode, ...(row.participantsPattern ? { pattern: row.participantsPattern } : {}) },
      ...(row.consent ? { consent: JSON.parse(row.consent) as Consent } : {}),
    };
  }

  draft(id: string): DraftSummary {
    const project = this.db.select().from(projects).where(eq(projects.id, id)).get() ?? fail('not_found');
    const platforms = this.db
      .select({ id: projectPlatforms.id, name: projectPlatforms.name, pack: projectPlatforms.pack, position: projectPlatforms.position, structure: projectPlatforms.structure })
      .from(projectPlatforms)
      .where(eq(projectPlatforms.projectId, id))
      .orderBy(asc(projectPlatforms.position), asc(projectPlatforms.id))
      .all();
    return {
      id,
      details: this.details(id),
      platforms: platforms.map((p) => ({ id: p.id, name: JSON.parse(p.name) as Localized, pack: p.pack, position: p.position, has_tree: p.structure !== null })),
      published: project.live && project.publishedAt !== null ? { version: project.liveVersion, at: project.publishedAt } : null,
      unpublished_changes: project.draftRevision !== project.publishedRevision,
    };
  }

  private touch(id: string, db: Queries = this.db): void {
    db.update(projects)
      .set({ draftUpdated: nowSecs(), draftRevision: sql`${projects.draftRevision} + 1` })
      .where(eq(projects.id, id))
      .run();
  }

  /** The draft's story, or `null`. */
  story(id: string): unknown {
    const row = this.db.select({ story: projectDetails.story }).from(projectDetails).where(eq(projectDetails.projectId, id)).get() ?? fail('not_found');
    return parse(row.story);
  }

  /** Replace the draft's story (`null` removes it); throws `invalid`. */
  setStory(id: string, value: unknown): void {
    const story = storyText(value);
    if (changes(this.db.update(projectDetails).set({ story }).where(eq(projectDetails.projectId, id)).run()) === 0) fail('not_found');
    this.touch(id);
  }

  setDetails(id: string, value: Record<string, unknown>): void {
    const d = checkDetails(value);
    const result = this.db
      .update(projectDetails)
      .set({
        name: JSON.stringify(d.name),
        description: d.description !== undefined ? JSON.stringify(d.description) : null,
        participantsMode: d.participants.mode,
        participantsPattern: d.participants.pattern ?? null,
        consent: d.consent ? JSON.stringify(d.consent) : null,
      })
      .where(eq(projectDetails.projectId, id))
      .run();
    if (changes(result) === 0) fail('not_found');
    this.touch(id);
  }

  platform(id: string, platform: string): PlatformDraft {
    const row = this.db.select().from(projectPlatforms).where(this.isPlatform(id, platform)).get() ?? fail('not_found');
    return {
      id: row.id,
      name: JSON.parse(row.name) as Localized,
      ...(row.pack ? { pack: row.pack } : {}),
      position: row.position,
      structure: parse(row.structure),
      importer: parse(row.importer),
    };
  }

  private isPlatform(id: string, platform: string) {
    return and(eq(projectPlatforms.projectId, id), eq(projectPlatforms.id, platform));
  }

  /** Add or replace a platform of the draft. */
  putPlatform(id: string, platform: string, value: Record<string, unknown>): void {
    if (!validPlatformId(platform)) fail('invalid');
    if (value.pack !== undefined && value.pack !== null && (typeof value.pack !== 'string' || !validPlatformId(value.pack))) fail('invalid');
    const name = localized(value.name)!;
    const row = {
      name: JSON.stringify(name),
      pack: typeof value.pack === 'string' ? value.pack : null,
      structure: treeText(value.structure),
      importer: treeText(value.importer),
    };
    this.db.transaction((tx) => {
      if (!tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get()) fail('not_found');
      const existing = tx.select({ id: projectPlatforms.id }).from(projectPlatforms).where(eq(projectPlatforms.projectId, id)).all();
      if (existing.some((p) => p.id === platform)) {
        tx.update(projectPlatforms).set(row).where(this.isPlatform(id, platform)).run();
      } else {
        if (existing.length >= 20) fail('invalid');
        const last = tx.select({ n: max(projectPlatforms.position) }).from(projectPlatforms).where(eq(projectPlatforms.projectId, id)).get()?.n ?? -1;
        tx.insert(projectPlatforms).values({ projectId: id, id: platform, position: Number(last) + 1, ...row }).run();
      }
      this.touch(id, tx);
    });
  }

  deletePlatform(id: string, platform: string): void {
    this.db.transaction((tx) => {
      if (changes(tx.delete(projectPlatforms).where(this.isPlatform(id, platform)).run()) === 0) fail('not_found');
      tx.delete(testPackages).where(and(eq(testPackages.projectId, id), eq(testPackages.platformId, platform))).run();
      this.touch(id, tx);
    });
  }

  // Test packages of a platform (docs/security.md#test-packages). They are the researchers' own
  // material for setting up the tree, not part of what participants get: changing them does not
  // change the draft's revision.

  private requirePlatform(id: string, platform: string, db: Queries = this.db): void {
    if (!validPlatformId(platform) || !db.select({ id: projectPlatforms.id }).from(projectPlatforms).where(this.isPlatform(id, platform)).get()) {
      fail('not_found');
    }
  }

  private isTestPackage(id: string, platform: string, pkg: string) {
    return and(eq(testPackages.projectId, id), eq(testPackages.platformId, platform), eq(testPackages.id, pkg));
  }

  /** The platform's test packages, oldest first, and each distinct structure once. */
  testPackages(id: string, platform: string): TestPackageList {
    this.requirePlatform(id, platform);
    const rows = this.db
      .select({
        id: testPackages.id,
        name: testPackages.name,
        hash: testPackages.structureHash,
        shape: testPackages.shape,
        hasData: sql<number>`${testPackages.data} is not null`,
        dataBytes: testPackages.dataBytes,
        added: testPackages.added,
        email: researchers.email,
      })
      .from(testPackages)
      .leftJoin(researchers, eq(researchers.id, testPackages.addedBy))
      .where(and(eq(testPackages.projectId, id), eq(testPackages.platformId, platform)))
      // In the order they were added (`added` is in seconds, so ties are common).
      .orderBy(asc(testPackages.added), sql`${testPackages}.rowid`)
      .all();
    const shapes = new Map<string, unknown>();
    for (const row of rows) if (!shapes.has(row.hash)) shapes.set(row.hash, JSON.parse(row.shape));
    return {
      packages: rows.map((r) => ({
        id: r.id,
        name: r.name,
        structure_hash: r.hash,
        has_data: Boolean(r.hasData),
        data_bytes: r.dataBytes,
        added: r.added,
        added_by: r.email ?? null,
      })),
      shapes: [...shapes].map(([hash, shape]) => ({ hash, shape })),
    };
  }

  /**
   * Add a test package: its shape (JSON text) and, if the researcher declared it fine to keep, its
   * content (gzip of the JSON text). The same structure under the same name is one package: adding
   * it again only adds content it did not have yet.
   */
  addTestPackage(id: string, platform: string, added: NewTestPackage): AddedTestPackage | 'too_many' {
    const hash = sha256Hex(added.shape);
    return this.db.transaction((tx) => {
      this.requirePlatform(id, platform, tx);
      const onPlatform = and(eq(testPackages.projectId, id), eq(testPackages.platformId, platform));
      const withData = () =>
        tx.select({ n: sql<number>`count(*)` }).from(testPackages).where(and(onPlatform, sql`${testPackages.data} is not null`)).get()!.n;
      const same = tx
        .select({ id: testPackages.id, hasData: sql<number>`${testPackages.data} is not null` })
        .from(testPackages)
        .where(and(onPlatform, eq(testPackages.structureHash, hash), eq(testPackages.name, added.name)))
        .get();
      if (same) {
        if (added.data && !same.hasData) {
          if (withData() >= MAX_TEST_DATA) return 'too_many';
          tx.update(testPackages)
            .set({ data: added.data.gzip, dataBytes: added.data.bytes })
            .where(this.isTestPackage(id, platform, same.id))
            .run();
        }
        return { id: same.id, new_structure: false, existing: true };
      }
      if (added.data && withData() >= MAX_TEST_DATA) return 'too_many';
      if (tx.select({ n: sql<number>`count(*)` }).from(testPackages).where(onPlatform).get()!.n >= MAX_TEST_PACKAGES) return 'too_many';
      const known = tx.select({ id: testPackages.id }).from(testPackages).where(and(onPlatform, eq(testPackages.structureHash, hash))).get();
      const pkg = random(16).toString('base64url');
      tx.insert(testPackages)
        .values({
          projectId: id,
          platformId: platform,
          id: pkg,
          name: added.name,
          structureHash: hash,
          shape: added.shape,
          data: added.data?.gzip ?? null,
          dataBytes: added.data?.bytes ?? 0,
          addedBy: added.by,
          added: nowSecs(),
        })
        .run();
      return { id: pkg, new_structure: known === undefined, existing: false };
    });
  }

  /** The stored content of a test package, gzipped JSON; `no_data` if it only has a structure. */
  testPackageData(id: string, platform: string, pkg: string): Buffer | 'no_data' {
    this.requirePlatform(id, platform);
    const row = this.db.select({ data: testPackages.data }).from(testPackages).where(this.isTestPackage(id, platform, pkg)).get() ?? fail('not_found');
    return row.data ?? 'no_data';
  }

  deleteTestPackage(id: string, platform: string, pkg: string): void {
    this.requirePlatform(id, platform);
    if (changes(this.db.delete(testPackages).where(this.isTestPackage(id, platform, pkg)).run()) === 0) fail('not_found');
  }

  /** Copy the draft to the live version. Returns the new version number. */
  publish(id: string): number {
    const summary = this.draft(id);
    const story = this.story(id);
    const live = {
      id,
      name: summary.details.name,
      ...(summary.details.description !== undefined ? { description: summary.details.description } : {}),
      participants: summary.details.participants,
      ...(summary.details.consent ? { consent: summary.details.consent } : {}),
      ...(story !== null ? { story } : {}),
      uploads: summary.platforms.map((p) => {
        const draft = this.platform(id, p.id);
        return {
          id: p.id,
          name: p.name,
          ...(p.pack ? { pack: p.pack } : {}),
          ...(draft.structure !== null ? { structure: draft.structure } : {}),
          ...(draft.importer !== null ? { importer: draft.importer } : {}),
        };
      }),
    };
    const version = (summary.published?.version ?? 0) + 1;
    const at = nowSecs();
    const text = JSON.stringify({ ...live, version });
    this.db.transaction((tx) => {
      tx.update(projects)
        .set({ live: text, liveVersion: version, publishedAt: at, publishedRevision: sql`${projects.draftRevision}` })
        .where(eq(projects.id, id))
        .run();
      // Every version is kept as it went live: donations say which one they were made with.
      tx.insert(projectVersions).values({ projectId: id, version, config: text, publishedAt: at }).run();
    });
    return version;
  }

  /**
   * Create or replace a project from a config file (the operator's `project import`, and the example
   * projects), and publish it. Its upload points become the draft's platforms.
   */
  importConfig(config: unknown): string {
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalid');
    const c = config as Record<string, unknown>;
    const id = c.id;
    if (!validProjectId(id)) return fail('invalid');
    const details = checkDetails({ ...c, name: c.name ?? id });
    const story = storyText(c.story);
    const uploads = Array.isArray(c.uploads) ? c.uploads : [];
    const platforms = uploads.map((u, position) => {
      if (!u || typeof u !== 'object') return fail('invalid');
      const p = u as Record<string, unknown>;
      if (!validPlatformId(p.id) || (p.pack !== undefined && !validPlatformId(p.pack))) return fail('invalid');
      return {
        projectId: id,
        id: p.id,
        name: JSON.stringify(localized(p.name ?? p.id)),
        pack: typeof p.pack === 'string' ? p.pack : null,
        position,
        structure: treeText(p.structure),
        importer: treeText(p.importer),
      };
    });
    this.db.transaction((tx) => {
      const now = nowSecs();
      tx.insert(projects).values({ id, created: now, draftUpdated: now }).onConflictDoNothing().run();
      this.touch(id, tx);
      const row = {
        name: JSON.stringify(details.name),
        description: details.description !== undefined ? JSON.stringify(details.description) : null,
        participantsMode: details.participants.mode,
        participantsPattern: details.participants.pattern ?? null,
        consent: details.consent ? JSON.stringify(details.consent) : null,
        story,
      };
      tx.insert(projectDetails).values({ projectId: id, ...row }).onConflictDoUpdate({ target: projectDetails.projectId, set: row }).run();
      tx.delete(projectPlatforms).where(eq(projectPlatforms.projectId, id)).run();
      for (const p of platforms) tx.insert(projectPlatforms).values(p).run();
    });
    this.publish(id);
    return id;
  }
}
