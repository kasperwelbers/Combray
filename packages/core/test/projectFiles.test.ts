import { describe, expect, it } from 'vitest';

import {
  buildTree,
  configOf,
  extractShape,
  importerFile,
  parseImporterFile,
  parseStructureFile,
  toConfig,
  ProjectFileError,
  setDecision,
  structureFile,
  type ConfigNode,
} from '../src';
import { watchHistory } from './fixtures';
import { at, nodeAt, treeOf } from './trees';

const shape = extractShape(watchHistory);

function decided() {
  let tree = treeOf(shape);
  tree = setDecision(tree, at(tree, '[*]', 'time'), 'donate');
  Object.assign(nodeAt(tree, '[*]', 'time'), { named: 'watched_at' });
  nodeAt(tree, '[*]', 'title').match = ['title', 'titel', { regex: '^Title$', flags: 'i' }];
  return tree;
}

/** An importer file whose one group reads the upload, a JSON object with these nodes in it. */
const importer = (children: object[], root: object = {}, group: object = {}) => ({
  format: 'combray-importer@3',
  root: {
    id: 'root',
    kind: 'dir',
    match: [],
    ...root,
    children: [{ id: 'g', kind: 'dir', match: ['export'], files: [{ path: [] }], ...group, children: [{ id: 'f', kind: 'map', match: [], children }] }],
  },
});
const leaf = (extra: object = {}) => ({ id: 'a', kind: 'value', match: ['a'], ...extra });

describe('project files', () => {
  it('keep the configuration apart from the structure, and lay over it to the same tree', () => {
    const tree = decided();
    const file = importerFile({ root: toConfig(tree) }, 'YouTube');
    // Only nodes someone touched: the untouched title is configured because its matches changed.
    expect(JSON.stringify(file)).not.toMatch(/subtitles|titleUrl|types/);
    const roundTrip = parseImporterFile(JSON.parse(JSON.stringify(file)));
    const again = buildTree(configOf(roundTrip), parseStructureFile(JSON.parse(JSON.stringify(structureFile(shape)))).root).tree;
    expect(nodeAt(again, '[*]', 'time')).toMatchObject({ decision: 'donate', named: 'watched_at' });
    expect(nodeAt(again, '[*]', 'title').keys).toEqual(['title']);
  });

  it('rejects malformed files', () => {
    expect(() => parseStructureFile({ format: 'nope' })).toThrow(ProjectFileError);
    expect(() => parseStructureFile({ format: 'combray-structure@1', root: { kind: 'x', name: '' } })).toThrow('unknown kind');
    expect(() => parseStructureFile({ format: 'combray-structure@1', root: { kind: 'list', name: '', repeat: '2-10' } })).toThrow('repeat');
    expect(() => parseImporterFile(importer([leaf({ decision: 'maybe' })]))).toThrow('unknown decision');
    expect(() => parseImporterFile(importer([leaf({ match: [{ regex: '(' }] })]))).toThrow('not a valid regular expression');
    expect(() => parseImporterFile(importer([leaf({ match: [] })]))).toThrow('at least one match');
    expect(() => parseImporterFile(importer([leaf({ match: ['[*]', 'b'] })]))).toThrow('matches of their own');
    expect(() => parseImporterFile(importer([leaf(), leaf()]))).toThrow('used twice');
    expect(() => parseImporterFile(importer([leaf({ name: 'Not A Name' })]))).toThrow('lowercase');
    expect(() => parseImporterFile({ ...importer([]), format: 'combray-importer@1' })).toThrow('combray-importer@3');
    expect(() => parseImporterFile(importer([], { match: ['x'] }))).toThrow('has no match');
    // File groups: a name, the files they read, and files matched by their kind.
    expect(() => parseImporterFile(importer([], {}, { match: ['Watch history'] }))).toThrow('one name');
    expect(() => parseImporterFile(importer([], {}, { files: undefined }))).toThrow('file groups only');
    expect(() => parseImporterFile(importer([], {}, { files: [{ path: ['a'], name: 'b' }] }))).toThrow('{ path } or { name }');
    expect(() => parseImporterFile(importer([], {}, { files: [{ name: { regex: '(' } }] }))).toThrow('not a valid regular expression');
    expect(() => parseImporterFile(importer([leaf({ files: [] })]))).toThrow('only file groups');
    const file = importer([]);
    file.root.children[0]!.children[0]!.match = ['user_data.json'] as never[];
    expect(() => parseImporterFile(file)).toThrow('matched by their kind');
  });

  it('accepts formats made of tokens only, so no values can travel in them', () => {
    const structure = (formats: unknown) => ({
      format: 'combray-structure@1',
      root: { kind: 'value', name: '', types: ['date-like'], formats },
    });
    expect(() => parseStructureFile(structure(['YYYY-MM-DD', 'MMM D, YYYY, H:mm:ss A Z', 'epoch-ms']))).not.toThrow();
    expect(() => parseStructureFile(structure(['Marcel YYYY']))).toThrow('formats');
    expect(() => parseStructureFile(structure(['2024-03-01']))).toThrow('formats');
    expect(() => parseStructureFile(structure(Array(9).fill('YYYY')))).toThrow('formats');
  });

  it('keeps conversions, roles and row filters, and checks them', () => {
    const time = leaf({ transform: ['trim', { replace: { pattern: '^At ', with: '' } }], as: 'datetime', format: 'YYYY-MM-DD HH:mm:ss', role: 'date' });
    const rows = (extra: object = {}) => ({ id: 'rows', kind: 'map', match: ['[*]'], filter: [{ column: 'ad', test: { empty: true } }], ...extra });
    const list = (child: object) => ({ id: 'l', kind: 'list', match: ['l'], children: [child] });
    expect(parseImporterFile(importer([time, list(rows())])).root.children![0]!.children![0]!.children).toHaveLength(2);
    expect(() => parseImporterFile(importer([{ ...time, as: 'money' }]))).toThrow('unknown type');
    expect(() => parseImporterFile(importer([{ ...time, role: 'author' }]))).toThrow('unknown role');
    expect(() => parseImporterFile(importer([{ ...time, format: 'Marcel' }]))).toThrow('format');
    expect(() => parseImporterFile(importer([{ ...time, transform: ['shout'] }]))).toThrow('unknown transform');
    expect(() => parseImporterFile(importer([list(rows({ filter: [{ column: 'ad', test: { like: 1 } }] }))]))).toThrow('unknown filter test');
    expect(() => parseImporterFile(importer([list(rows({ filter: [{ column: 'ad', test: { matches: '(' } }] }))]))).toThrow('invalid regular expression');
    expect(() => parseImporterFile(importer([rows()]))).toThrow('[*] is only below a list');
  });

  it('keeps how uploads are matched: find patterns on the root, required parts, new children', () => {
    const tree = decided();
    tree.find = ['watch-history*.json'];
    tree.newChildren = 'skip';
    nodeAt(tree, '[*]', 'time').required = true;
    const parsed = parseImporterFile(JSON.parse(JSON.stringify(importerFile({ root: toConfig(tree) }))));
    expect(parsed.root).toMatchObject({ find: ['watch-history*.json'], newChildren: 'skip' });
    expect(nodeAt(buildTree(configOf(parsed), shape).tree, '[*]', 'time').required).toBe(true);

    expect(() => parseImporterFile(importer([], { find: ['*.json'] }))).toThrow('three letters');
    expect(() => parseImporterFile(importer([], { find: [] }))).toThrow('find');
    expect(() => parseImporterFile(importer([leaf({ find: ['Takeout'] })]))).toThrow('only the root');
    expect(() => parseImporterFile(importer([], { newChildren: 'never' }))).toThrow('ask or skip');
    expect(() => parseImporterFile(importer([leaf({ required: false })]))).toThrow('required');
  });

  it('reads configurations from before file groups, with a group for every file they configured', () => {
    const old = {
      format: 'combray-importer@2',
      root: {
        id: 'root',
        kind: 'dir',
        match: [],
        find: ['Takeout'],
        newChildren: 'skip',
        children: [
          {
            id: 'yt',
            kind: 'dir',
            match: ['YouTube', 'YouTube en YouTube Music'],
            newChildren: 'ask',
            children: [
              { id: 'json', kind: 'list', match: ['watch-history.json', 'kijkgeschiedenis.json'], name: 'watch_history', required: true, children: [{ id: 'rows', kind: 'map', match: ['[*]'] }] },
              { id: 'html', kind: 'element', match: ['watch-history.html'], name: 'watch_history' },
              { id: 'subs', kind: 'list', match: ['subscriptions.csv'] },
            ],
          },
          { id: 'mail', kind: 'dir', match: ['Mail'], decision: 'ignore', children: [{ id: 'mbox', kind: 'blob', match: ['All mail.mbox'] }] },
        ],
      },
    };
    const parsed = parseImporterFile(old);
    expect(parsed.format).toBe('combray-importer@3');
    expect(parsed.root).toMatchObject({ kind: 'dir', find: ['Takeout'] });
    expect(parsed.root.newChildren).toBeUndefined();
    // The JSON and HTML history share a group (same table name, other kinds); ignored folders are left out.
    expect(parsed.root.children!.map((g) => [g.match[0], g.files, g.required, g.children!.map((c) => [c.kind, c.match])])).toEqual([
      [
        'watch_history',
        [
          { path: ['YouTube', 'watch-history.json'] },
          { path: ['YouTube', 'kijkgeschiedenis.json'] },
          { path: ['YouTube en YouTube Music', 'watch-history.json'] },
          { path: ['YouTube en YouTube Music', 'kijkgeschiedenis.json'] },
          { path: ['YouTube', 'watch-history.html'] },
          { path: ['YouTube en YouTube Music', 'watch-history.html'] },
        ],
        true,
        [
          ['list', []],
          ['element', []],
        ],
      ],
      ['subscriptions', [{ path: ['YouTube', 'subscriptions.csv'] }, { path: ['YouTube en YouTube Music', 'subscriptions.csv'] }], undefined, [['list', []]]],
    ]);
  });

  it('keeps a header row on the rows of a table only, and undecided parts shown on the root only', () => {
    const rows: ConfigNode = { id: 'rows', kind: 'map', match: ['[*]'], headerRow: true };
    expect(() => parseImporterFile(importer([{ id: 'l', kind: 'list', match: ['l'], children: [rows] }]))).not.toThrow();
    expect(() => parseImporterFile(importer([leaf({ headerRow: true })]))).toThrow('only the rows');
    expect(() => parseImporterFile(importer([], { undecided: 'show' }))).not.toThrow();
    expect(() => parseImporterFile(importer([], { undecided: 'hide' }))).toThrow('undecided must be show');
    expect(() => parseImporterFile(importer([leaf({ undecided: 'show' })]))).toThrow('only the root');
  });
});
