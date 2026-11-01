/**
 * Platform packs as project trees: the structure is built from the fixtures, and the tables
 * derived through each pack give the same rows as the YAML importers did.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deriveRows,
  deriveTables,
  extractShape,
  joinProjectTree,
  knownKeys,
  mergeShape,
  prepareUpload,
  projectTreeFromShape,
  splitProjectTree,
  type ImporterFile,
  type ProjectNode,
  type Row,
} from '@combray/core';
import { describe, expect, it } from 'vitest';

import { packs, packTree, PACK_IDS } from '../packs';
import { FIXTURES, fixtureNames, loadFixture } from './load';

const ROOT = join(import.meta.dirname, '..');
const fixturesOf = (pack: string) => fixtureNames().filter((f) => f.startsWith(`${pack}-`));

/** The union of a pack's fixtures, merged in order so the importer's aliases join languages. */
function buildStructure(pack: string, importer: ImporterFile) {
  let tree: ProjectNode | undefined;
  for (const fixture of fixturesOf(pack)) {
    // The researcher's own (here: synthetic) exports, so header text may name columns.
    const shape = extractShape(prepareUpload(loadFixture(fixture), true, { keys: () => true }));
    tree = tree ? mergeShape(tree, shape).tree : projectTreeFromShape(shape);
    tree = joinProjectTree(splitProjectTree(tree).structure, importer).tree;
  }
  const { structure } = splitProjectTree(tree!);
  return { structure, pending: joinProjectTree(structure, importer).pending };
}

describe.each(PACK_IDS)('pack %s', (id) => {
  const importer = JSON.parse(readFileSync(join(ROOT, id, 'importer.json'), 'utf8')) as ImporterFile;

  it('has a structure built from its fixtures', () => {
    const { structure, pending } = buildStructure(id, importer);
    // Every setting finds its node: a typo in a path would leave it waiting forever.
    expect(pending.map((e) => e.path.join('/'))).toEqual([]);
    const path = join(ROOT, id, 'structure.json');
    if (process.env.UPDATE_EXPECTED) writeFileSync(path, `${JSON.stringify(structure, null, 2)}\n`);
    expect(structure).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });

  it('is bundled and valid', () => {
    expect(packs.map((p) => p.id)).toContain(id);
  });
});

const MA = ['My Activity', 'Search'];
const YT = ['YouTube and YouTube Music'];
const HTML_ROWS = ['html', 'body', 'div.mdl-grid', 'div.mdl-cell.mdl-cell--12-col.mdl-shadow--2dp.outer-cell', '[*]'];
const BODY = 'div.mdl-grid/div.content-cell.mdl-cell.mdl-cell--6-col.mdl-typography--body-1';
const TIKTOK = ['user_data.json', 'Activity'];

/** Where each YAML importer's rows are in the pack's tree, and which column gives each field. */
const OLD: Record<string, { rows: string[]; fields: Record<string, string> }> = {
  'google-takeout/browser-history': {
    rows: ['Chrome', 'BrowserHistory.json', 'Browser History', '[*]'],
    fields: { title: 'title', url: 'url', date: 'time_usec', transition: 'page_transition' },
  },
  'google-takeout/search-history': {
    rows: [...MA, 'MyActivity.json', '[*]'],
    fields: { query: 'title', url: 'titleUrl', date: 'time' },
  },
  'google-takeout/search-history-html': {
    rows: [...MA, 'MijnActiviteit.html', ...HTML_ROWS],
    fields: { query: `${BODY}/a[0]/#text[0]`, url: `${BODY}/a[0]/@href`, date: `${BODY}/#text[1]` },
  },
  'google-takeout/youtube-search-history': {
    rows: [...YT, 'history', 'search-history.json', '[*]'],
    fields: { query: 'title', url: 'titleUrl', date: 'time' },
  },
  'google-takeout/youtube-subscriptions': {
    rows: [...YT, 'subscriptions', 'subscriptions.csv', '[*]'],
    fields: { channel: 'Channel title', channel_url: 'Channel URL' },
  },
  'google-takeout/youtube-watch-history': {
    rows: [...YT, 'history', 'watch-history.json', '[*]'],
    fields: { title: 'title', url: 'titleUrl', date: 'time', channel: 'subtitles/[*]/name', channel_url: 'subtitles/[*]/url' },
  },
  'google-takeout/youtube-watch-history-html': {
    rows: [...YT, 'history', 'kijkgeschiedenis.html', ...HTML_ROWS],
    fields: {
      title: `${BODY}/a[0]/#text[0]`,
      url: `${BODY}/a[0]/@href`,
      channel: `${BODY}/a[1]/#text[0]`,
      channel_url: `${BODY}/a[1]/@href`,
      date: `${BODY}/#text[1]`,
    },
  },
  'tiktok/likes': { rows: [...TIKTOK, 'Like List', 'ItemFavoriteList', '[*]'], fields: { date: 'Date', url: 'Link' } },
  'tiktok/searches': { rows: [...TIKTOK, 'Search History', 'SearchList', '[*]'], fields: { date: 'Date', query: 'SearchTerm' } },
  'tiktok/watch-history': { rows: [...TIKTOK, 'Video Browsing History', 'VideoList', '[*]'], fields: { date: 'Date', url: 'Link' } },
};

describe.each(fixtureNames())('fixture %s through its pack', (fixture) => {
  const id = PACK_IDS.find((p) => fixture.startsWith(`${p}-`))!;
  const expected = JSON.parse(readFileSync(join(FIXTURES, fixture, 'expected.json'), 'utf8')) as Record<string, Row[]>;

  it.each(Object.keys(expected))('gives the rows of %s', (old) => {
    const pack = packs.find((p) => p.id === id)!;
    const tree = packTree(pack);
    // A participant: header text only becomes a key when the pack knows it.
    const upload = prepareUpload(loadFixture(fixture), true, { keys: knownKeys(tree) });
    const tables = deriveTables(tree);
    const rows = deriveRows(upload, tree, tables);
    const { rows: path, fields } = OLD[old]!;
    const index = tables.findIndex((t) => t.rows?.join('/') === path.join('/'));
    expect(index, `no table at ${path.join('/')}`).toBeGreaterThanOrEqual(0);
    const actual = rows[index]!.map((row, r) =>
      Object.fromEntries(
        Object.entries(fields).map(([field, column]) => {
          if (column in row.values) return [field, row.values[column]];
          // A column of a nested table (the channel): its first row for this row.
          const nested = tables.findIndex((t) => t.parent === index && column.startsWith(t.rows!.slice(path.length).join('/')));
          const prefix = tables[nested]!.rows!.slice(path.length).join('/');
          const first = rows[nested]!.find((n) => n.parent === r);
          return [field, first?.values[column.slice(prefix.length + 1)] ?? null];
        }),
      ),
    );
    const want = expected[old]!.map((row) => Object.fromEntries(Object.keys(fields).map((f) => [f, row[f] ?? null])));
    expect(actual).toEqual(want);
  });
});
