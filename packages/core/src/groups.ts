/**
 * Editing file groups (ADR 0016): which files each group reads. Pure functions on a
 * configuration, for the studio's files step. The content of a group is edited as before, in the
 * project tree.
 */
import { isGroup, matchOne, sameMatch, type ConfigNode, type FileMatch, type Match, type ProjectConfig } from './config';
import { emptyConfig, UPLOAD_GROUP } from './decisions';
import { keyName } from './derive';
import { ambiguousNames, assignFiles, fileGroups, fileMatches, shapeFiles, type FilePath } from './files';
import { freeName, isName } from './names';
import type { Shape } from './shape';

export class GroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupError';
  }
}

/** The groups of a configuration, in order. */
export const groupsOf = (config: ProjectConfig): ConfigNode[] => (config.root.children ?? []).filter(isGroup);

/** A group's name: its one match. */
export const groupKey = (group: ConfigNode): string => String(group.match[0] ?? '');

const findGroup = (config: ProjectConfig, key: string): ConfigNode | undefined => groupsOf(config).find((g) => groupKey(g) === key);

/** A copy of the configuration with the root's children changed. */
function withGroups(config: ProjectConfig, change: (groups: ConfigNode[]) => ConfigNode[]): ProjectConfig {
  const children = change(structuredClone(config.root.children ?? []));
  const root = { ...config.root };
  if (children.length > 0) root.children = children;
  else delete root.children;
  return { root };
}

/** The name a file gives a new group: its name without extension, as a name, free among the groups. */
export function newGroupKey(config: ProjectConfig, file: FilePath): string {
  const last = file.raw.at(-1);
  const base = last === undefined ? UPLOAD_GROUP : keyName(last, 'files');
  return freeName(base, new Set(groupsOf(config).map(groupKey)));
}

/** The exact match of a file: its path, step by step. */
export const pathMatch = (file: FilePath): FileMatch => ({ path: [...file.steps] });

const isFile = (match: FileMatch, file: FilePath) => 'path' in match && match.path.length === file.steps.length && match.path.every((m, i) => m === file.steps[i]);

/**
 * Let a group read a file, by its path: an existing group (`key`), or a new one named after the
 * file when `key` is a name no group has. A file is read by one group only: it leaves the group
 * that read it by its path before.
 */
export function includeFile(config: ProjectConfig, file: FilePath, key = newGroupKey(config, file)): ProjectConfig {
  if (!isName(key)) throw new GroupError(`${key} is not a name: use lowercase letters, digits and underscores`);
  const out = excludeFile(config, file);
  return withGroups(out, (groups) => {
    const group = groups.find((g) => isGroup(g) && groupKey(g) === key);
    if (group) {
      group.files = [...(group.files ?? []), pathMatch(file)];
      return groups;
    }
    return [...groups, { id: `g-${key}`, kind: 'dir', match: [key], files: [pathMatch(file)] }];
  });
}

/** Stop reading a file by its path (a name in any folder or a pattern that finds it stays). */
export function excludeFile(config: ProjectConfig, file: FilePath): ProjectConfig {
  return withGroups(config, (groups) =>
    groups.map((g) => (isGroup(g) ? { ...g, files: (g.files ?? []).filter((m) => !isFile(m, file)) } : g)),
  );
}

/** Rename a group. Its content follows: the files of a group are matched by their kind, not their name. */
export function renameGroup(config: ProjectConfig, from: string, to: string): ProjectConfig {
  if (from === to) return config;
  if (!isName(to)) throw new GroupError(`${to} is not a name: use lowercase letters, digits and underscores`);
  if (findGroup(config, to)) throw new GroupError(`there is already a group called ${to}`);
  return withGroups(config, (groups) => groups.map((g) => (isGroup(g) && groupKey(g) === from ? { ...g, match: [to] } : g)));
}

/** Remove a group, with its content. */
export function removeGroup(config: ProjectConfig, key: string): ProjectConfig {
  return withGroups(config, (groups) => groups.filter((g) => !(isGroup(g) && groupKey(g) === key)));
}

/** Change one setting of a group (`required`). */
export function setGroupRequired(config: ProjectConfig, key: string, required: boolean): ProjectConfig {
  return withGroups(config, (groups) =>
    groups.map((g) => {
      if (!isGroup(g) || groupKey(g) !== key) return g;
      const { required: _required, ...rest } = g;
      return required ? { ...rest, required: true } : rest;
    }),
  );
}

/** Add a file match to a group (a pattern, or a name in any folder). */
export function addFileMatch(config: ProjectConfig, key: string, match: FileMatch): ProjectConfig {
  return withGroups(config, (groups) =>
    groups.map((g) => (isGroup(g) && groupKey(g) === key && !(g.files ?? []).some((m) => sameFileMatch(m, match)) ? { ...g, files: [...(g.files ?? []), match] } : g)),
  );
}

/** Take a file match off a group. */
export function removeFileMatch(config: ProjectConfig, key: string, match: FileMatch): ProjectConfig {
  return withGroups(config, (groups) =>
    groups.map((g) => (isGroup(g) && groupKey(g) === key ? { ...g, files: (g.files ?? []).filter((m) => !sameFileMatch(m, match)) } : g)),
  );
}

export function sameFileMatch(a: FileMatch, b: FileMatch): boolean {
  if ('path' in a && 'path' in b) return a.path.length === b.path.length && a.path.every((m, i) => sameMatch(m, b.path[i]!));
  return 'name' in a && 'name' in b && sameMatch(a.name, b.name);
}

/**
 * Find a file of a group in any folder, by its name, instead of by its path; or (`on` false) by
 * its path again. Only for names that occur once in the seen structures (`anyFolderProblem`).
 */
export function setAnyFolder(config: ProjectConfig, key: string, file: FilePath, on: boolean): ProjectConfig {
  const name = file.steps.at(-1);
  if (name === undefined) throw new GroupError('the upload itself has no folder');
  const byName: FileMatch = { name };
  if (!on) return addFileMatch(removeFileMatch(config, key, byName), key, pathMatch(file));
  return addFileMatch(removeFileMatch(config, key, pathMatch(file)), key, byName);
}

/**
 * Why a file name cannot be found in any folder, or undefined if it can: it must occur once in
 * the seen structures, so the files it would find in a participant's package are this file.
 */
export function anyFolderProblem(seen: Shape | undefined, name: Match): string | undefined {
  const files = seen ? shapeFiles(seen) : [];
  const found = files.filter((f) => f.steps.length > 0 && matchOne(name, f.steps.at(-1)!));
  return found.length > 1 ? `${found.length} files with this name were seen, in different folders` : undefined;
}

/**
 * Copy the content settings of one group to another: its matches, names, decisions and
 * conversions, file kind by file kind. For groups that read files built the same way (the
 * `MyActivity.html` of two products). The files each reads stay its own.
 */
export function copyGroupContent(config: ProjectConfig, from: string, to: string): ProjectConfig {
  const source = findGroup(config, from);
  if (!source) throw new GroupError(`no group called ${from}`);
  return withGroups(config, (groups) =>
    groups.map((g) => {
      if (!isGroup(g) || groupKey(g) !== to) return g;
      const children = structuredClone(source.children ?? []).map((c) => renewIds(c));
      return { ...g, ...(children.length > 0 ? { children } : {}) };
    }),
  );
}

let counter = 0;
/** New ids for a copied subtree, so the copy and the original never share one. */
function renewIds(node: ConfigNode): ConfigNode {
  counter += 1;
  return { ...node, id: `${node.id}-c${Date.now().toString(36)}${counter}`, ...(node.children ? { children: node.children.map(renewIds) } : {}) };
}

/**
 * A configuration that reads every file of a structure, each in a group of its own named after
 * it. For starting a project quickly, and for tests.
 */
export function includeAll(seen: Shape, config: ProjectConfig = emptyConfig(seen.kind)): ProjectConfig {
  if (seen.kind !== 'dir') return config;
  let out = config;
  const read = assignFiles(shapeFiles(seen), fileGroups(config.root));
  shapeFiles(seen).forEach((file, i) => {
    if (read[i] === undefined) out = includeFile(out, file);
  });
  return out;
}

/** What the files step shows for each seen file: the group that reads it, and whether a name in any folder found it. */
export interface SeenFile extends FilePath {
  kind: Shape['kind'];
  group?: string;
  /** Read by a name in any folder (or a pattern), not by its exact path. */
  byName?: true;
}

/** The files of the seen structures, with the group that reads each. */
export function seenFiles(config: ProjectConfig, seen: Shape | undefined): SeenFile[] {
  if (!seen) return [];
  const files = shapeFiles(seen);
  const groups = fileGroups(config.root);
  const read = assignFiles(files, groups);
  return files.map((file, i) => {
    const g = read[i];
    const out: SeenFile = { steps: file.steps, raw: file.raw, kind: file.shape.kind };
    if (g === undefined) return out;
    out.group = groups[g]!.key;
    if (!groups[g]!.files.some((m) => isFile(m, file))) out.byName = true;
    return out;
  });
}

/** File matches of a group that find nothing in the seen structures (a language not seen yet, say). */
export function unseenMatches(config: ProjectConfig, seen: Shape | undefined, key: string): FileMatch[] {
  const group = findGroup(config, key);
  if (!group) return [];
  const files = seen ? shapeFiles(seen) : [];
  return (group.files ?? []).filter((m) => !files.some((f) => fileMatches(m, f)));
}

export { ambiguousNames };
