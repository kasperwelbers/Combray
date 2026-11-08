import { placements } from '@combray/seal';
import { describe, expect, it } from 'vitest';

import {
  anyFolderProblem,
  assignFiles,
  buildTree,
  contentShape,
  contentTree,
  copyGroupContent,
  deriveTables,
  donationValues,
  emptyConfig,
  excludeFile,
  extractShape,
  fileGroups,
  includeFile,
  jsonToTree,
  nameMap,
  namePattern,
  patternText,
  renameGroup,
  removeGroup,
  seenFiles,
  setAnyFolder,
  setDecision,
  setGroupRequired,
  shapeFiles,
  addFileMatch,
  treeFiles,
  unseenMatches,
  uploadTree,
  GroupError,
  type FilePath,
  type ProjectConfig,
  toConfig,
  type ProjectNode,
  type TreeNode,
} from '../src';
import { parseMarkup } from '../src/parse/html';
import { at, rebuild } from './trees';

/** An upload folder: keys with an extension are JSON files, other keys are folders. */
function folder(name: string, entries: Record<string, unknown>): TreeNode {
  return {
    kind: 'dir',
    name,
    children: Object.entries(entries).map(([k, v]) => (/\.\w+$/.test(k) ? jsonToTree(k, v) : folder(k, v as Record<string, unknown>))),
  };
}

// Two exports of one platform: the same searches in a different folder, under another name.
const upload = folder('', {
  data: { history: { 'search.json': [{ query: 'madeleines' }, { query: 'tea' }] }, 'profile.json': { name: 'Marcel' } },
});
const other = folder('', {
  google: { geschiedenis: { 'zoeken.json': [{ query: 'combray' }] } },
});
const seen = extractShape({ kind: 'dir', name: '', children: [...(upload as { children: TreeNode[] }).children, ...(other as { children: TreeNode[] }).children] });
const file = (...steps: string[]): FilePath => ({ steps, raw: steps });
const search = file('data', 'history', 'search.json');
const zoeken = file('google', 'geschiedenis', 'zoeken.json');

/** Both search files in one group, `searches`. */
const searches = (): ProjectConfig => includeFile(includeFile(emptyConfig(), search, 'searches'), zoeken, 'searches');

describe('file groups', () => {
  it('reads files from different folders into one content tree, named after the group', () => {
    const content = contentShape(seen, searches().root);
    expect(content.children!.map((c) => [c.name, c.children!.map((f) => [f.name, f.kind])])).toEqual([['searches', [['searches', 'list']]]]);
    // The profile is read by no group: it is not in the content.
    expect(JSON.stringify(content)).not.toContain('profile');
  });

  it('keeps raw paths in donations and the name map, whichever folder a file came from', () => {
    let tree = buildTree(searches(), seen).tree;
    tree = rebuild(setDecision(tree, at(tree, 'searches', 'searches', '[*]', 'query'), 'donate'), seen);
    const map = nameMap(tree);
    for (const data of [upload, other]) {
      const content = donationValues(data, tree, deriveTables(tree));
      for (const v of content.values) {
        const entry = content.entries[v.entry]!;
        expect(placements(map, v.path)).toContainEqual({ table: entry.table, field: entry.field, rows: entry.rows });
      }
    }
    const first = donationValues(upload, tree, deriveTables(tree));
    expect(first.values.map((v) => [v.path.join('/'), v.value])).toEqual([
      ['data/history/search.json/[0]/query', 'madeleines'],
      ['data/history/search.json/[1]/query', 'tea'],
    ]);
    // Rows are told apart on the raw path, so files at different depths each get their own steps.
    expect(first.entries[0]!.rows).toEqual([{ table: expect.any(String), steps: 4 }]);
    const second = donationValues(other, tree, deriveTables(tree));
    expect(second.values.map((v) => v.path.join('/'))).toEqual(['google/geschiedenis/zoeken.json/[0]/query']);
    // The group is matched by its files, never by its name; its files by their kind.
    const group = map.root.c![0]!;
    expect([group.m, group.g, group.c!.map((c) => c.m)]).toEqual([undefined, [{ p: ['data', 'history', 'search.json'] }, { p: ['google', 'geschiedenis', 'zoeken.json'] }], [undefined]]);
  });

  it('turns content back into the upload it came from', () => {
    const content = contentTree(upload, searches().root);
    expect(treeFiles(uploadTree(content)).map((f) => f.steps.join('/'))).toEqual(['data/history/search.json']);
    // Content made twice is the same content.
    expect(contentTree(content, searches().root)).toBe(content);
  });

  it('shows a JSON and an HTML file of one group as two branches', () => {
    const html = parseMarkup('zoeken.html', '<html><body><div class="q">tea</div></body></html>');
    const both = extractShape({ kind: 'dir', name: '', children: [...(upload as { children: TreeNode[] }).children, html] });
    const config = includeFile(includeFile(emptyConfig(), search, 'searches'), file('zoeken.html'), 'searches');
    const tree = buildTree(config, both).tree;
    const group = tree.children!.find((c) => c.name === 'searches')!;
    expect(group.children!.map((c) => [c.name, c.kind])).toEqual([
      ['searches', 'list'],
      ['searches', 'element'],
    ]);
  });
});


describe('which group reads a file', () => {
  const groups = (config: ProjectConfig) => fileGroups(config.root);
  const files = shapeFiles(seen);

  it('reads exact paths before names in any folder', () => {
    let config = includeFile(emptyConfig(), search, 'exact');
    config = includeFile(config, file('elsewhere.json'), 'by_name');
    config = addFileMatch(config, 'by_name', { name: 'search.json' });
    const read = assignFiles(files, groups(config));
    expect(read[files.findIndex((f) => f.steps.join('/') === search.steps.join('/'))]).toBe(0);
  });

  it('reads none of the files when a name is found in more than one folder', () => {
    const twice = [file('a', 'search.json'), file('b', 'search.json')];
    const config = addFileMatch(includeFile(emptyConfig(), file('x.json'), 'searches'), 'searches', { name: 'search.json' });
    expect(assignFiles(twice, groups(config))).toEqual([undefined, undefined]);
    expect(assignFiles([twice[0]!], groups(config))).toEqual([0]);
  });

  it('reads the parts of a split file by a pattern', () => {
    const parts = [file('inbox', 'message_1.json'), file('inbox', 'message_2.json'), file('inbox', 'other.json')];
    const config = addFileMatch(includeFile(emptyConfig(), file('x.json'), 'messages'), 'messages', { name: { regex: '^message_\\d+\\.json$' } });
    expect(assignFiles(parts, groups(config))).toEqual([0, 0, undefined]);
  });
});

describe('editing groups', () => {
  it('moves a file to the group that includes it last: a file is read by one group', () => {
    let config = includeFile(emptyConfig(), search);
    expect(seenFiles(config, seen).find((f) => f.raw.join('/') === 'data/history/search.json')?.group).toBe('search');
    config = includeFile(config, search, 'history');
    expect(seenFiles(config, seen).filter((f) => f.group).map((f) => [f.steps.at(-1), f.group])).toEqual([['search.json', 'history']]);
    // The group it left stays, reading nothing, until it is removed.
    expect(fileGroups(config.root).map((g) => [g.key, g.files.length])).toEqual([['search', 0], ['history', 1]]);
    expect(fileGroups(excludeFile(config, search).root).every((g) => g.files.length === 0)).toBe(true);
  });

  it('renames a group and keeps its content, and refuses names that are not names or are taken', () => {
    let tree = buildTree(searches(), seen).tree;
    tree = rebuild(setDecision(tree, at(tree, 'searches', 'searches', '[*]', 'query'), 'donate'), seen);
    const config: ProjectConfig = { root: { ...searches().root, children: buildTreeConfig(tree) } };
    const renamed = renameGroup(config, 'searches', 'zoekopdrachten');
    const after = buildTree(renamed, seen).tree;
    expect(deriveTables(after).flatMap((t) => t.columns.map((c) => c.id))).toEqual(deriveTables(tree).flatMap((t) => t.columns.map((c) => c.id)));
    expect(() => renameGroup(config, 'searches', 'Zoek Opdrachten')).toThrow(GroupError);
    expect(() => renameGroup(includeFile(config, file('x.json'), 'other'), 'searches', 'other')).toThrow('already a group');
  });

  it('sets a group required, removes it, and copies content settings from another group', () => {
    let config = searches();
    config = includeFile(config, file('data', 'profile.json'), 'profile');
    expect(setGroupRequired(config, 'profile', true).root.children!.find((g) => g.match[0] === 'profile')!.required).toBe(true);
    expect(setGroupRequired(setGroupRequired(config, 'profile', true), 'profile', false).root.children!.find((g) => g.match[0] === 'profile')!.required).toBeUndefined();
    expect(fileGroups(removeGroup(config, 'profile').root).map((g) => g.key)).toEqual(['searches']);
    let tree = buildTree(config, seen).tree;
    tree = rebuild(setDecision(tree, at(tree, 'searches', 'searches', '[*]', 'query'), 'donate'), seen);
    const withContent: ProjectConfig = { root: { ...config.root, children: buildTreeConfig(tree) } };
    const copied = copyGroupContent(withContent, 'searches', 'profile');
    const [from, to] = ['searches', 'profile'].map((k) => copied.root.children!.find((g) => g.match[0] === k)!);
    expect(to!.children!.length).toBe(from!.children!.length);
    expect(to!.children![0]!.id).not.toBe(from!.children![0]!.id);
    expect(() => copyGroupContent(config, 'nothing', 'profile')).toThrow(GroupError);
  });

  it('finds a file in any folder only when its name is seen once, and back by its path', () => {
    expect(anyFolderProblem(seen, 'search.json')).toBeUndefined();
    const twice = extractShape(folder('', { a: { 'x.json': [1] }, b: { 'x.json': [2] } }));
    expect(anyFolderProblem(twice, 'x.json')).toBe('2 files with this name were seen, in different folders');
    let config = setAnyFolder(searches(), 'searches', search, true);
    expect(fileGroups(config.root)[0]!.files).toContainEqual({ name: 'search.json' });
    expect(seenFiles(config, seen).find((f) => f.steps.at(-1) === 'search.json')).toMatchObject({ group: 'searches', byName: true });
    config = setAnyFolder(config, 'searches', search, false);
    expect(fileGroups(config.root)[0]!.files).not.toContainEqual({ name: 'search.json' });
    expect(seenFiles(config, seen).find((f) => f.steps.at(-1) === 'search.json')?.byName).toBeUndefined();
  });

  it('lists matches that find nothing seen yet', () => {
    const config = addFileMatch(searches(), 'searches', { name: 'recherches.json' });
    expect(unseenMatches(config, seen, 'searches')).toEqual([{ name: 'recherches.json' }]);
  });
});

/** The configured children of a tree's root, as the studio commits them. */
const buildTreeConfig = (tree: ProjectNode) => toConfig(tree).children!;

describe('name patterns', () => {
  it('reads wildcards as researchers write them, and writes them back', () => {
    expect(namePattern('watch-history.json')).toBe('watch-history.json');
    const parts = namePattern('message_*.json');
    expect(parts).toEqual({ regex: '^message_.*\\.json$', flags: 'i' });
    expect(patternText(parts)).toBe('message_*.json');
    expect(patternText(namePattern('a?.(1).json'))).toBe('a?.(1).json');
    expect(patternText({ regex: 'json$' })).toBe('/json$/');
  });
});
