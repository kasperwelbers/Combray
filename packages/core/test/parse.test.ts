import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  findPath,
  flatten,
  jsonToTree,
  mergeDirs,
  parseEntries,
  parseFile,
  unflatten,
  uploadRoot,
  type DirNode,
  type TreeNode,
} from '../src';
import { takeout } from './fixtures';

const text = (s: string) => strToU8(s);
const find = (root: TreeNode, path: string) => findPath(root, path).map((m) => m.node);

describe('parseFile', () => {
  it('parses JSON into maps, lists and typed values', () => {
    const tree = parseFile('a.json', text('{"n": 3, "ok": true, "x": null, "when": "2024-01-01", "l": [1.5]}'));
    expect(tree).toEqual({
      kind: 'map',
      name: 'a.json',
      children: [
        { kind: 'value', name: 'n', value: '3', type: 'int' },
        { kind: 'value', name: 'ok', value: 'true', type: 'bool' },
        { kind: 'value', name: 'x', value: '', type: 'null' },
        { kind: 'value', name: 'when', value: '2024-01-01', type: 'date-like' },
        { kind: 'list', name: 'l', children: [{ kind: 'value', name: '0', value: '1.5', type: 'float' }] },
      ],
    });
  });

  it('accepts JSON wrapped in a script assignment', () => {
    const tree = parseFile('tweets.js', text('window.YTD.tweets.part0 = [{"id": "1"}];'));
    expect(tree.kind).toBe('list');
  });

  it('parses JSON Lines', () => {
    const tree = parseFile('a.jsonl', text('{"a":1}\n\n{"a":2}\n'));
    expect(find(tree, '[*]/a')).toHaveLength(2);
  });

  it('parses CSV with a sniffed delimiter, empty and duplicate headers', () => {
    const tree = parseFile('a.csv', text('Date;Link;;Link\n2024-01-01;https://x.org;a;b\n'));
    expect(tree).toMatchObject({
      kind: 'list',
      children: [
        {
          kind: 'map',
          name: '0',
          children: [
            { name: 'Date', type: 'date-like' },
            { name: 'Link', type: 'url-like' },
            { name: 'column_3', value: 'a' },
            { name: 'Link_2', value: 'b' },
          ],
        },
      ],
    });
  });

  it('parses quoted CSV fields with newlines', () => {
    const tree = parseFile('a.csv', text('a,b\n"line one\nline two",2\n'));
    expect(find(tree, '[0]/a')[0]).toMatchObject({ value: 'line one\nline two' });
  });

  it('falls back to Windows-1252 for invalid UTF-8', () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in Windows-1252
    const tree = parseFile('notes.txt', bytes);
    expect(find(tree, '[0]')[0]).toMatchObject({ value: 'café' });
  });

  it('keeps images and binaries as blobs', () => {
    expect(parseFile('p.jpg', new Uint8Array([1, 2, 3]))).toEqual({
      kind: 'blob',
      name: 'p.jpg',
      mime: 'image/jpeg',
      size: 3,
    });
    expect(parseFile('data.bin', new Uint8Array([0, 1, 2]))).toMatchObject({ kind: 'blob' });
  });

  it('sniffs files without a known extension', () => {
    expect(parseFile('README', text('[1,2]')).kind).toBe('list');
    expect(parseFile('page', text('<p>hi</p>')).kind).toBe('element');
    expect(parseFile('notes', text('one\ntwo')).kind).toBe('list');
  });

  it('falls back to text for broken JSON', () => {
    expect(parseFile('bad.json', text('{"a": ')).kind).toBe('list');
  });
});

describe('archives', () => {
  it('unzips into a directory tree, opening nested zips and skipping macOS noise', () => {
    const inner = zipSync({ 'c.json': text('{"x": 1}') });
    const zip = zipSync({
      'Takeout/a.json': text('[1]'),
      'Takeout/sub/b.csv': text('h\n1\n'),
      'Takeout/empty/': new Uint8Array(),
      'Takeout/inner.zip': inner,
      '__MACOSX/Takeout/._a.json': text('junk'),
      'Takeout/.DS_Store': new Uint8Array([0]),
    });
    const tree = parseFile('takeout.zip', zip);
    expect(tree.kind).toBe('dir');
    expect(find(tree, 'Takeout/*').map((n) => n.name)).toEqual(['a.json', 'empty', 'inner.zip', 'sub']);
    expect(find(tree, 'Takeout/inner.zip/c.json/x')).toHaveLength(1);
    expect(find(tree, '__MACOSX')).toHaveLength(0);
  });

  it('builds a tree from dropped folder entries', () => {
    const tree = parseEntries('upload', [
      { path: 'TikTok/user_data.json', bytes: text('{"Activity": {}}') },
      { path: 'TikTok/readme.txt', bytes: text('hi') },
    ]);
    expect(find(tree, 'TikTok/user_data.json/Activity')).toHaveLength(1);
  });
});

describe('flatten', () => {
  it('round-trips and keeps children contiguous', () => {
    const flat = flatten(takeout);
    expect(unflatten(flat)).toEqual(takeout);
    for (const node of flat) {
      if (node.first !== undefined) {
        for (let i = 0; i < node.count!; i++) expect(flat[node.first + i]!.parent).toBe(flat.indexOf(node));
      }
    }
  });
});

describe('uploadRoot', () => {
  it('drops the upload name and unwraps the one folder of an archive', () => {
    const zip: DirNode = {
      kind: 'dir',
      name: 'takeout-001.zip',
      children: [{ kind: 'dir', name: 'Takeout', children: [{ kind: 'dir', name: 'Chrome', children: [] }] }],
    };
    expect(uploadRoot(zip, true)).toEqual({ kind: 'dir', name: '', children: [{ kind: 'dir', name: 'Chrome', children: [] }] });
    expect(uploadRoot(zip, false)).toEqual({ ...zip, name: '' });
    expect(uploadRoot(jsonToTree('kaspers_tiktok.json', { a: 1 }), false).name).toBe('');
  });
});

describe('mergeDirs', () => {
  it('merges split archives into one tree and drops the part names', () => {
    const part = (name: string, file: string): DirNode => ({
      kind: 'dir',
      name,
      children: [{ kind: 'dir', name: 'Takeout', children: [{ kind: 'dir', name: file, children: [] }] }],
    });
    const merged = mergeDirs('upload', [part('takeout-001.zip', 'Chrome'), part('takeout-002.zip', 'YouTube')]);
    expect(merged).toEqual({
      kind: 'dir',
      name: 'upload',
      children: [
        {
          kind: 'dir',
          name: 'Takeout',
          children: [
            { kind: 'dir', name: 'Chrome', children: [] },
            { kind: 'dir', name: 'YouTube', children: [] },
          ],
        },
      ],
    });
  });
});
