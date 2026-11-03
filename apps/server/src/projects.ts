/**
 * Projects: a draft that researchers edit in the studio, in parts (details, platforms), and a live
 * version, one JSON document copied from the draft when it is published, which participants get.
 * Plus the participant policy checked when a participant's store is created.
 */
import { and, asc, eq, max, sql } from 'drizzle-orm';

import { changes, type Db, type Queries } from './db.ts';
import { projectDetails, projectPlatforms, projects } from './db/schema.ts';
import { nowSecs } from './util.ts';

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

export interface Details {
  name: Localized;
  description?: Localized;
  participants: { mode: ParticipantMode; pattern?: string };
}

export interface PlatformDraft {
  id: string;
  name: Localized;
  pack?: string;
  position: number;
  structure: unknown;
  importer: unknown;
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
  return {
    name: localized(value.name)!,
    ...(description !== undefined ? { description } : {}),
    participants: { mode: mode as ParticipantMode, ...(typeof pattern === 'string' && pattern ? { pattern } : {}) },
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
    const row = this.db.select({ live: projects.live }).from(projects).where(eq(projects.id, id)).get();
    if (!row?.live) return 'not_found';
    try {
      return projectFromJson(JSON.parse(row.live));
    } catch {
      return 'invalid';
    }
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

  setDetails(id: string, value: Record<string, unknown>): void {
    const d = checkDetails(value);
    const result = this.db
      .update(projectDetails)
      .set({
        name: JSON.stringify(d.name),
        description: d.description !== undefined ? JSON.stringify(d.description) : null,
        participantsMode: d.participants.mode,
        participantsPattern: d.participants.pattern ?? null,
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
    if (changes(this.db.delete(projectPlatforms).where(this.isPlatform(id, platform)).run()) === 0) fail('not_found');
    this.touch(id);
  }

  /** Copy the draft to the live version. Returns the new version number. */
  publish(id: string): number {
    const summary = this.draft(id);
    const live = {
      id,
      name: summary.details.name,
      ...(summary.details.description !== undefined ? { description: summary.details.description } : {}),
      participants: summary.details.participants,
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
    this.db
      .update(projects)
      .set({ live: JSON.stringify(live), liveVersion: version, publishedAt: nowSecs(), publishedRevision: sql`${projects.draftRevision}` })
      .where(eq(projects.id, id))
      .run();
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
      };
      tx.insert(projectDetails).values({ projectId: id, ...row }).onConflictDoUpdate({ target: projectDetails.projectId, set: row }).run();
      tx.delete(projectPlatforms).where(eq(projectPlatforms.projectId, id)).run();
      for (const p of platforms) tx.insert(projectPlatforms).values(p).run();
    });
    this.publish(id);
    return id;
  }
}
