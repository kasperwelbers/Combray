import type { TreeNode } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { loadFixture } from '../../../importers/test/load';
import { foldedPath } from '../src/format';
import { uploadPoints } from '../src/projectConfig';
import type { ColumnInfo } from '../src/worker/api';
import { deriveImport } from '../src/worker/derived';
import { valueAt } from '../src/worker/tables';

const POINTS = [
  { id: 'takeout', pack: 'google-takeout' },
  { id: 'tiktok', pack: 'tiktok' },
];

const names = (columns: ColumnInfo[]) => columns.map((c) => (typeof c.name === 'string' ? c.name : c.name.en));

describe('deriveImport', () => {
  it('picks the upload point that fits and makes collections from what the pack shows', () => {
    const result = deriveImport(loadFixture('tiktok-2025'), true, POINTS)!;
    expect(result.point.id).toBe('tiktok');
    const collections = result.tables.filter((t) => t.table.collection);
    expect(collections.map((t) => (t.table.name as Record<string, string>).en).sort()).toEqual([
      'TikTok likes',
      'TikTok searches',
      'TikTok watch history',
    ]);
    const watch = collections.find((t) => (t.table.name as Record<string, string>).en === 'TikTok watch history')!;
    expect(names(watch.table.columns)).toEqual(['Time', 'Video']);
    expect(watch.table.display).toEqual({ date: 'Date', url: 'Link' });
    // Converted as the pack says: dates as ISO text.
    expect(String(watch.rows[0]!.Date)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps nested tables inside their rows, and lets views count through them', () => {
    const result = deriveImport(loadFixture('google-takeout-en'), true, POINTS)!;
    expect(result.point.id).toBe('takeout');
    const watch = result.tables.find((t) => (t.table.name as Record<string, string>).en === 'YouTube watch history')!;
    const channel = watch.table.columns.find((c) => c.type === 'table')!;
    expect(channel.id).toBe('subtitles/[*]');
    expect(names(channel.columns!)).toEqual(['Channel', 'Channel link']);
    expect(watch.table.display.group_by).toEqual(['subtitles/[*]/name']);
    const nested = watch.rows[0]![channel.id] as Record<string, unknown>[];
    expect(nested[0]).toHaveProperty('name');
    expect(valueAt(watch.rows[0]!, 'subtitles/[*]/name')).toEqual([nested[0]!.name]);
  });

  it('shows data the project does not know as other data, marked new', () => {
    const tree = loadFixture('tiktok-2023');
    const result = deriveImport(tree, true, [{ id: 'tiktok', pack: 'tiktok' }])!;
    // The profile is in the pack's structure but undecided: other data, not new.
    const profile = result.tables.find((t) => !t.table.collection)!;
    expect(profile.table.record).toBe(true);
    expect(profile.table.new).toBeUndefined();
    // A file the pack has never seen.
    const extra = loadFixture('tiktok-2023');
    if (extra.kind !== 'dir') throw new Error('expected a folder');
    extra.children.push({ kind: 'list', name: 'notes.json', children: [{ kind: 'map', name: '0', children: [{ kind: 'value', name: 'note', value: 'hi', type: 'string' }] }] });
    const withExtra = deriveImport(extra, true, [{ id: 'tiktok', pack: 'tiktok' }])!;
    const notes = withExtra.tables.find((t) => t.table.new)!;
    expect(notes.table.collection).toBe(false);
    expect(notes.table.columns[0]).toMatchObject({ id: 'note', new: true, undecided: true });
  });

  it('finds a single file that the pack knows inside a folder', () => {
    const folder = loadFixture('tiktok-2023');
    if (folder.kind !== 'dir') throw new Error('expected a folder');
    const result = deriveImport(folder.children[0]!, false, POINTS)!;
    expect(result.point.id).toBe('tiktok');
    expect(result.tables.filter((t) => t.table.collection)).toHaveLength(3);
  });

  it('places a single file where the pack knows a file by that name', () => {
    const takeout = loadFixture('google-takeout-en');
    const find = (node: TreeNode, name: string): TreeNode | undefined =>
      node.name === name ? node : node.kind === 'dir' ? node.children.map((c) => find(c, name)).find(Boolean) : undefined;
    const result = deriveImport(find(takeout, 'watch-history.json')!, false, POINTS)!;
    expect(result.point.id).toBe('takeout');
    const collections = result.tables.filter((t) => t.table.collection);
    expect(collections.map((t) => (t.table.name as Record<string, string>).en)).toEqual(['YouTube watch history']);
  });

  it('finds an unzipped Takeout inside the folder a participant picked', () => {
    // Unzipping `takeout-….zip` gives `takeout-…/Takeout/…`; picking the outer folder strips
    // its own name, which leaves one `Takeout` folder in the root.
    const takeout = loadFixture('google-takeout-en');
    const picked: TreeNode = { kind: 'dir', name: 'takeout-20240305', children: [{ kind: 'dir', name: 'extracted', children: [takeout] }] };
    const viaZip = deriveImport(takeout, true, POINTS)!;
    const viaFolder = deriveImport(picked, false, POINTS)!;
    expect(viaFolder.point.id).toBe('takeout');
    expect(viaFolder.tables.map((t) => t.rows.length)).toEqual(viaZip.tables.map((t) => t.rows.length));
  });

  it('fits nothing when no point knows the upload', () => {
    expect(deriveImport(loadFixture('tiktok-2023'), true, [{ id: 'takeout', pack: 'google-takeout' }])).toBeUndefined();
    expect(deriveImport(loadFixture('tiktok-2023'), true, [{ id: 'x', pack: 'no-such-pack' }])).toBeUndefined();
  });
});

describe('project config', () => {
  it('reads upload points and drops malformed ones', () => {
    expect(uploadPoints([{ id: 'a', pack: 'tiktok', name: { en: 'TikTok' } }, { id: 1 }, 'x', { id: 'b', pack: 'p', name: 3 }])).toEqual([
      { id: 'a', pack: 'tiktok', name: { en: 'TikTok' } },
      { id: 'b', pack: 'p' },
    ]);
    expect(uploadPoints(undefined)).toEqual([]);
  });
});

describe('foldedPath', () => {
  it('folds long paths and drops item markers and classes', () => {
    expect(foldedPath(['user_data.json', 'Profile', 'Profile Information', 'ProfileMap'])).toBe(
      'user_data.json › … › Profile Information › ProfileMap',
    );
    expect(foldedPath(['a.json', '[*]', 'b'])).toBe('a.json › b');
    expect(foldedPath(['x.html', 'html', 'body', 'div.mdl-grid', 'div.outer-cell', '[*]'])).toBe('x.html › … › div › div');
  });
});
