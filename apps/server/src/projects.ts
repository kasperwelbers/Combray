/**
 * Project configs and their participant policy. For now configs are JSON files placed in the data
 * directory by the operator (`projects/{id}.json`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export async function loadProject(dataDir: string, id: unknown): Promise<Project | LoadError> {
  if (!validProjectId(id)) return 'not_found';
  let text: string;
  try {
    text = await readFile(join(dataDir, 'projects', `${id}.json`), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'io';
  }
  try {
    return projectFromJson(JSON.parse(text));
  } catch {
    return 'invalid';
  }
}
