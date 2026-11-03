import { locateRoot, UploadListing, type UploadProblem } from '@combray/core';
import { packs } from '@combray/importers';
import { describe, expect, it } from 'vitest';

import { fixtureFiles, fixtureListing, fixtureZip, uploadFiles } from '../../../importers/test/load';
import { foldedPath } from '../src/format';
import { uploadPoints } from '../src/projectConfig';
import type { ColumnInfo, UploadPoint } from '../src/worker/api';
import { deriveImport, pointTree, type DerivedImport } from '../src/worker/derived';
import { valueAt } from '../src/worker/tables';

const TAKEOUT: UploadPoint = { id: 'takeout', pack: 'google-takeout' };
const TIKTOK: UploadPoint = { id: 'tiktok', pack: 'tiktok' };

const names = (columns: ColumnInfo[]) => columns.map((c) => (typeof c.name === 'string' ? c.name : c.name.en));
const english = (t: DerivedImport['tables'][number]) => (t.table.name as Record<string, string>).en;

/** An upload through one upload point, as the data worker does it. */
async function through(point: UploadPoint, listing: UploadListing | Promise<UploadListing>): Promise<DerivedImport | UploadProblem | 'choose'> {
  const tree = pointTree(point)!;
  const located = await locateRoot(await listing, tree);
  if (located.status === 'found') return deriveImport(located.root, tree, point);
  return located.status;
}

async function derived(point: UploadPoint, listing: UploadListing | Promise<UploadListing>): Promise<DerivedImport> {
  const result = await through(point, listing);
  if (typeof result === 'string') throw new Error(result);
  return result;
}

describe('importing through an upload point', () => {
  it('makes collections from what the pack shows', async () => {
    const result = await derived(TIKTOK, fixtureListing('tiktok-2025'));
    const collections = result.tables.filter((t) => t.table.collection);
    expect(collections.map(english).sort()).toEqual(['TikTok likes', 'TikTok searches', 'TikTok watch history']);
    const watch = collections.find((t) => english(t) === 'TikTok watch history')!;
    expect(names(watch.table.columns)).toEqual(['Time', 'Video']);
    expect(watch.table.display).toEqual({ date: 'Date', url: 'Link' });
    // Converted as the pack says: dates as ISO text.
    expect(String(watch.rows[0]!.Date)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps nested tables inside their rows, and lets views count through them', async () => {
    const result = await derived(TAKEOUT, fixtureListing('google-takeout-en'));
    const watch = result.tables.find((t) => english(t) === 'YouTube watch history')!;
    const channel = watch.table.columns.find((c) => c.type === 'table')!;
    expect(channel.id).toBe('subtitles/[*]');
    expect(names(channel.columns!)).toEqual(['Channel', 'Channel link']);
    expect(watch.table.display.group_by).toEqual(['subtitles/[*]/name']);
    const nested = watch.rows[0]![channel.id] as Record<string, unknown>[];
    expect(nested[0]).toHaveProperty('name');
    expect(valueAt(watch.rows[0]!, 'subtitles/[*]/name')).toEqual([nested[0]!.name]);
  });

  it('shows new parts where the pack asks about them, marked new, and skips them elsewhere', async () => {
    const notes = JSON.stringify([{ note: 'hi' }]);
    const result = await derived(
      TAKEOUT,
      fixtureListing('google-takeout-en', {
        'Takeout/YouTube and YouTube Music/history/notes.json': notes,
        // The Takeout pack skips Google products it does not know.
        'Takeout/Drive/plans.json': notes,
      }),
    );
    const added = result.tables.filter((t) => t.table.new);
    expect(added).toHaveLength(1);
    expect(added[0]!.table.path).toEqual(['YouTube and YouTube Music', 'history', 'notes.json', '[*]']);
    expect(added[0]!.table.collection).toBe(false);
    expect(added[0]!.table.columns[0]).toMatchObject({ id: 'note', new: true, undecided: true });
    // Known but undecided parts are other data, not new.
    const tiktok = await derived(TIKTOK, fixtureListing('tiktok-2023'));
    const profile = tiktok.tables.find((t) => !t.table.collection)!;
    expect(profile.table.record).toBe(true);
    expect(profile.table.new).toBeUndefined();
  });

  it('takes a TikTok file as it is, whatever it is called', async () => {
    const [bytes] = Object.values(fixtureFiles('tiktok-2023'));
    const result = await derived(TIKTOK, UploadListing.open(uploadFiles({ 'my tiktok (1).json': bytes! })));
    expect(result.tables.filter((t) => t.table.collection)).toHaveLength(3);
  });

  it('finds the export inside a bigger folder by the pack\'s name patterns', async () => {
    const files = {
      'Downloads/holiday.jpg': 'jpg',
      'Downloads/notes.json': JSON.stringify({ Activity: {} }),
      'Downloads/takeout-20240305T000000Z-001.zip': fixtureZip('google-takeout-en'),
      'Downloads/tiktok/user_data_tiktok.json': Object.values(fixtureFiles('tiktok-2025'))[0]!,
    };
    const takeout = await derived(TAKEOUT, UploadListing.open(uploadFiles(files)));
    expect(takeout.tables.some((t) => english(t) === 'YouTube watch history')).toBe(true);
    const tiktok = await derived(TIKTOK, UploadListing.open(uploadFiles(files)));
    expect(tiktok.tables.filter((t) => t.table.collection)).toHaveLength(3);
  });

  it('gives the same tables for an unzipped Takeout in a picked folder', async () => {
    const unzipped = Object.fromEntries(
      Object.entries(fixtureFiles('google-takeout-en')).map(([path, bytes]) => [`takeout-20240305/${path}`, bytes]),
    );
    const viaFolder = await derived(TAKEOUT, UploadListing.open(uploadFiles(unzipped)));
    const viaZip = await derived(TAKEOUT, fixtureListing('google-takeout-en'));
    expect(viaFolder.tables.map((t) => t.rows.length)).toEqual(viaZip.tables.map((t) => t.rows.length));
  });

  it('does not fit an export of another platform, or a single file from inside an export', async () => {
    expect(await through(TAKEOUT, fixtureListing('tiktok-2023'))).toBe('no-fit');
    const watch = fixtureFiles('google-takeout-en')['Takeout/YouTube and YouTube Music/history/watch-history.json']!;
    expect(await through(TAKEOUT, UploadListing.open(uploadFiles({ 'watch-history.json': watch })))).toBe('no-fit');
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

  it("reads a project's own tree, published from the studio", () => {
    const structure = { format: 'combray-structure/1' };
    const importer = { format: 'combray-importer/1', entries: [] };
    expect(uploadPoints([{ id: 'own', structure, importer }, { id: 'half', structure }, { id: 'both', pack: 'tiktok', structure, importer }])).toEqual([
      { id: 'own', structure, importer },
      { id: 'both', pack: 'tiktok', structure, importer },
    ]);
  });

  it("uses the project's own tree over the pack, and the pack when the tree cannot be read", () => {
    const pack = packs.find((p) => p.id === 'tiktok')!;
    const renamed = { ...pack.importer, name: { en: 'Our TikTok' } };
    const own = pointTree({ id: 'own-tiktok', pack: 'tiktok', structure: pack.structure, importer: renamed });
    expect(own).toBeDefined();
    expect(own).not.toBe(pointTree(TIKTOK));
    const unreadable = pointTree({ id: 'broken-tiktok', pack: 'tiktok', structure: { format: 'nope' }, importer: {} });
    expect(unreadable).toBe(pointTree(TIKTOK));
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
