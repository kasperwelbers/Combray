import {
  deriveTables,
  extractShape,
  getNode,
  locateRoot,
  normalizeTree,
  parseFile,
  projectTreeFromShape,
  setDecision,
  UploadListing,
  type ProjectNode,
  type UploadProblem,
} from '@combray/core';
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

/** An upload point's tree, letting participants see undecided parts. */
function showingUndecided(point: UploadPoint): ProjectNode {
  return { ...structuredClone(pointTree(point)!), undecided: 'show' };
}

/** An upload through one upload point, as the data worker does it. */
async function through(
  point: UploadPoint,
  listing: UploadListing | Promise<UploadListing>,
  tree: ProjectNode = pointTree(point)!,
): Promise<DerivedImport | UploadProblem | 'choose'> {
  const located = await locateRoot(await listing, tree);
  if (located.status === 'found') return deriveImport(located.root, tree, point);
  return located.status;
}

async function derived(
  point: UploadPoint,
  listing: UploadListing | Promise<UploadListing>,
  tree?: ProjectNode,
): Promise<DerivedImport> {
  const result = await through(point, listing, tree);
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
      showingUndecided(TAKEOUT),
    );
    const added = result.tables.filter((t) => t.table.new);
    expect(added).toHaveLength(1);
    expect(added[0]!.table.path).toEqual(['YouTube and YouTube Music', 'history', 'notes.json', '[*]']);
    expect(added[0]!.table.collection).toBe(false);
    expect(added[0]!.table.columns[0]).toMatchObject({ id: 'note', new: true, undecided: true });
    // Known but undecided parts are other data, not new.
    const tiktok = await derived(TIKTOK, fixtureListing('tiktok-2023'), showingUndecided(TIKTOK));
    const profile = tiktok.tables.find((t) => !t.table.collection)!;
    expect(profile.table.record).toBe(true);
    expect(profile.table.new).toBeUndefined();
  });

  it('leaves out undecided parts, columns and values, unless the tree lets participants see them', async () => {
    const notes = JSON.stringify([{ note: 'hi' }]);
    const listing = () =>
      fixtureListing('google-takeout-en', { 'Takeout/YouTube and YouTube Music/history/notes.json': notes });
    const hidden = await derived(TAKEOUT, listing());
    const shown = await derived(TAKEOUT, listing(), showingUndecided(TAKEOUT));
    // Tables with nothing decided go, new parts included.
    expect(hidden.tables.every((t) => t.table.collection)).toBe(true);
    expect(hidden.tables.some((t) => t.table.new)).toBe(false);
    expect(shown.tables.some((t) => !t.table.collection)).toBe(true);
    expect(shown.tables.some((t) => t.table.new)).toBe(true);
    // In the tables that stay, no undecided column and none of its values, nested ones too.
    const undecidedIn = (columns: ColumnInfo[]): boolean =>
      columns.some((c) => c.undecided === true || undecidedIn(c.columns ?? []));
    for (const { table, rows } of hidden.tables) {
      expect(undecidedIn(table.columns)).toBe(false);
      const ids = new Set(table.columns.map((c) => c.id));
      for (const row of rows) for (const key of Object.keys(row)) expect(ids).toContain(key);
    }
    // A column left undecided in a table with decided ones: gone from that table and its rows.
    const tree = structuredClone(pointTree(TIKTOK)!);
    const firstShown = (node: ProjectNode): ProjectNode | undefined =>
      node.decision === 'show' ? node : (node.children ?? []).map(firstShown).find(Boolean);
    delete firstShown(tree)!.decision;
    const kept = await derived(TIKTOK, fixtureListing('tiktok-2025'), tree);
    const all = await derived(TIKTOK, fixtureListing('tiktok-2025'), { ...structuredClone(tree), undecided: 'show' });
    const lost = all.tables.find((t) => t.table.collection && undecidedIn(t.table.columns))!;
    const same = kept.tables.find((t) => english(t) === english(lost))!;
    expect(same.table.columns.length).toBeLessThan(lost.table.columns.length);
    expect(undecidedIn(same.table.columns)).toBe(false);
    const gone = lost.table.columns.find((c) => c.undecided)!.id;
    expect(same.rows.some((r) => gone in r)).toBe(false);
    expect(lost.rows.some((r) => gone in r)).toBe(true);
    // The same collections either way.
    expect(hidden.tables.map(english).sort()).toEqual(shown.tables.filter((t) => t.table.collection).map(english).sort());
  });

  it('names columns from the first row when the researcher says it holds them, keeping the row', () => {
    const html = '<table><tr><td>Name</td><td>City</td></tr><tr><td>Marcel</td><td>Paris</td></tr><tr><td>Odette</td><td>Cabourg</td></tr></table>';
    const prepared = normalizeTree(parseFile('t.html', new TextEncoder().encode(html)));
    const shape = extractShape(prepared);
    let project = projectTreeFromShape(shape);
    const rows = deriveTables(project).find((t) => t.rows !== undefined)!.rows!;
    expect(getNode(project, rows)).toBeDefined();
    project = setDecision(setDecision(project, [...rows, '#cell[0]'], 'show'), [...rows, '#cell[1]'], 'show');
    getNode(project, rows)!.headerRow = true;
    const [found] = deriveImport({ prepared, shape }, project, { id: 't' }).tables;
    expect(names(found!.table.columns)).toEqual(['Name', 'City']);
    expect(found!.table.columns.some((c) => c.unnamed)).toBe(false);
    expect(found!.rows.map((r) => Object.values(r))).toEqual([
      ['Marcel', 'Paris'],
      ['Odette', 'Cabourg'],
    ]);
    expect(Object.values(found!.table.headerRow!)).toEqual(['Name', 'City']);
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
