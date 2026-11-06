/**
 * Platform packs as project trees: the structure is built from the fixtures, and the tables
 * derived through each pack give the same rows as the YAML importers did.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildTree,
  configOf,
  correctedShape,
  deriveRows,
  deriveTables,
  extractShape,
  locateRoot,
  normalizeTree,
  parseImporterFile,
  structureFile,
  treeNames,
  unionShape,
  type ProjectConfig,
  type ProjectNode,
  type Row,
  type TableDef,
} from '@combray/core';
import { describe, expect, it } from 'vitest';

import { packs, packTree, PACK_IDS } from '../packs';
import { FIXTURES, fixtureListing, fixtureNames, readFixture } from './load';

const ROOT = join(import.meta.dirname, '..');
const fixturesOf = (pack: string) => fixtureNames().filter((f) => f.startsWith(`${pack}-`));

/**
 * The structures seen in a pack's fixtures: their union, with the pack's corrections over it
 * (keys that are data), as the studio publishes it.
 */
async function buildStructure(pack: string, config: ProjectConfig) {
  const shapes = [];
  for (const fixture of fixturesOf(pack)) {
    // The researcher's own (here: synthetic) exports, so header text may name columns.
    shapes.push(extractShape(normalizeTree(await readFixture(fixture), { keys: () => true })));
  }
  return structureFile(correctedShape(config, unionShape(shapes)!));
}

/** Config nodes that matched nothing in the structure: a typo in a match would leave them unused. */
function unseen(tree: ProjectNode): string[] {
  const out: string[] = [];
  const visit = (node: ProjectNode, path: string[]) => {
    if (path.length > 0 && !node.virtual && !node.keys?.length) out.push(path.join('/'));
    for (const child of node.children ?? []) visit(child, [...path, child.name]);
  };
  visit(tree, []);
  return out;
}

describe.each(PACK_IDS)('pack %s', (id) => {
  const importer = parseImporterFile(JSON.parse(readFileSync(join(ROOT, id, 'importer.json'), 'utf8')));

  it('has a structure built from its fixtures', async () => {
    const structure = await buildStructure(id, configOf(importer));
    const path = join(ROOT, id, 'structure.json');
    if (process.env.UPDATE_EXPECTED) writeFileSync(path, `${JSON.stringify(structure, null, 2)}\n`);
    expect(structure).toEqual(JSON.parse(readFileSync(path, 'utf8')));
    // Every config node matches something the fixtures have.
    expect(unseen(buildTree(configOf(importer), structure.root).tree)).toEqual([]);
  });

  it('is bundled and valid', () => {
    expect(packs.map((p) => p.id)).toContain(id);
  });

  it('has texts only for tables and fields it names', () => {
    const pack = packs.find((p) => p.id === id)!;
    const names = treeNames(packTree(pack));
    const known = new Map(names.tables.map((t, i) => [t.id, new Set([...names.fields.values()].filter((f) => f.table === i).map((f) => f.id))]));
    for (const [table, texts] of Object.entries(pack.texts.tables ?? {})) {
      expect(known.has(table), table).toBe(true);
      for (const field of Object.keys(texts.fields ?? {})) expect(known.get(table)!.has(field), `${table}.${field}`).toBe(true);
    }
    expect(Object.keys(pack.texts.tables ?? {}).length).toBeGreaterThan(0);
  });
});

const MA = ['My Activity', 'Search'];
const YT = ['YouTube and YouTube Music'];
const HTML_ROWS = ['html', 'body', 'div.mdl-grid', 'div.mdl-cell.mdl-cell--12-col.mdl-shadow--2dp.outer-cell', '[*]'];
const BODY = 'div.mdl-grid/div.content-cell.mdl-cell.mdl-cell--6-col.mdl-typography--body-1';
const TIKTOK = ['Activity'];

/** Where each YAML importer's rows are in the pack's tree (by ids), and the path of each field. */
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

  it.each(Object.keys(expected))('gives the rows of %s', async (old) => {
    const pack = packs.find((p) => p.id === id)!;
    const tree = packTree(pack);
    // A participant: the root is found as on their device, and header text only becomes a key
    // when the pack knows it.
    const located = await locateRoot(await fixtureListing(fixture), tree);
    if (located.status !== 'found') throw new Error(`fixture does not fit its pack: ${located.status}`);
    const tables = deriveTables(tree);
    const rows = deriveRows(located.root.prepared, tree, tables);
    const { rows: path, fields } = OLD[old]!;
    const index = tables.findIndex((t) => t.rows?.join('/') === path.join('/'));
    expect(index, `no table at ${path.join('/')}`).toBeGreaterThanOrEqual(0);
    const actual = rows[index]!.map((row, r) =>
      Object.fromEntries(
        Object.entries(fields).map(([field, column]) => [field, valueAt(tables, rows, index, r, row.values, column)]),
      ),
    );
    const want = expected[old]!.map((row) => Object.fromEntries(Object.keys(fields).map((f) => [f, row[f] ?? null])));
    expect(actual).toEqual(want);
  });
});

/** The value of the field at a path below a table's rows; in a nested table, its first row's. */
function valueAt(
  tables: TableDef[],
  rows: ReturnType<typeof deriveRows>,
  index: number,
  r: number,
  values: Record<string, unknown>,
  path: string,
): unknown {
  const table = tables[index]!;
  const column = table.columns.find((c) => c.type !== 'table' && c.path.join('/') === path);
  if (column) return values[column.id];
  // A column of a nested table (the channel): its first row for this row.
  const nested = tables.findIndex((t) => t.parent === index && path.startsWith(`${t.rows!.slice(table.rows!.length).join('/')}/`));
  if (nested < 0) throw new Error(`no column at ${path}`);
  const prefix = tables[nested]!.rows!.slice(table.rows!.length).join('/');
  const first = rows[nested]!.find((n) => n.parent === r);
  return first ? valueAt(tables, rows, nested, -1, first.values, path.slice(prefix.length + 1)) : null;
}
