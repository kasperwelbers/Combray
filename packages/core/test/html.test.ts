/**
 * HTML normalisation on synthetic examples of common export formats (test/html/README.md):
 * each should become tables with one column per thing a row says.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  deriveRows,
  deriveTables,
  extractShape,
  localize,
  normalizeTree,
  parseFile,
  projectTreeFromShape,
  type NormalizeOptions,
  type TableDef,
} from '../src';

function load(file: string, options?: NormalizeOptions) {
  const bytes = new Uint8Array(readFileSync(new URL(`./html/${file}`, import.meta.url)));
  const tree = normalizeTree(parseFile(file, bytes), options);
  const project = projectTreeFromShape(extractShape(tree));
  const tables = deriveTables(project);
  const rows = deriveRows(tree, project, tables);
  /** The largest table, with its rows as objects keyed by column name. */
  const main = (filter: (t: TableDef) => boolean = () => true) => {
    const candidates = tables.map((t, i) => ({ t, i })).filter(({ t }) => t.rows !== undefined && filter(t));
    const { t, i } = candidates.sort((a, b) => rows[b.i]!.length - rows[a.i]!.length)[0]!;
    const names = t.columns.map((c) => localize(c.name, 'en'));
    const records = rows[i]!.map((r) => Object.fromEntries(t.columns.map((c, k) => [names[k], r.values[c.id]])));
    const types: Record<string, string[]> = Object.fromEntries(t.columns.map((c, k) => [names[k], c.types ?? []]));
    return { table: t, names, records, types };
  };
  return { tables, rows, main };
}

describe('Google My Activity (YouTube)', () => {
  const { tables, main } = load('my-activity-youtube.html');
  const { names, records, types } = main();

  it('is one table of rows, with links as positions instead of a nested table', () => {
    expect(records).toHaveLength(5);
    expect(tables.filter((t) => t.parent !== undefined)).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['a[0]/@href', 'a[1]/@href', 'a[0]/#text[0]', 'a[1]/#text[0]']));
  });

  it('keeps the date in one column, also for removed videos and ads', () => {
    const date = names.find((n) => types[n]!.includes('date-like'))!;
    expect(records.map((r) => r[date])).toEqual([
      'Mar 4, 2024, 10:20:30 AM CET',
      'Mar 4, 2024, 9:02:11 PM CET',
      'Mar 3, 2024, 8:15:00 AM CET',
      'Mar 3, 2024, 8:14:00 AM CET',
      'Feb 28, 2024, 6:45:59 PM CET',
    ]);
  });

  it('has the title and channel link in their own columns', () => {
    expect(records.map((r) => r['a[0]/#text[0]'])).toEqual([
      'Baking madeleines',
      'The steeples of Martinville',
      null,
      'Buy a whistling kettle',
      'Hawthorn in bloom',
    ]);
    expect(records[3]!['a[1]/@href']).toBeNull();
  });

  it('shows ad rows by their second caption line', () => {
    const details = names.find((n) => n.endsWith('caption/#text[1]'))!;
    expect(records.map((r) => r[details])).toEqual([null, null, null, 'From Google Ads', null]);
  });
});

describe('Google My Activity (Search)', () => {
  const { records, names } = load('my-activity-search.html').main();

  it('keeps the action, query and date of each row', () => {
    const action = names.find((n) => n.endsWith('body-1/#text[0]'))!;
    expect(records.map((r) => r[action])).toEqual(['Searched for', 'Visited', 'Searched for']);
    expect(records.map((r) => r['div.mdl-cell--6-col.mdl-typography--body-1/a[0]/#text[0]'])).toEqual([
      'hawthorn hedge',
      'Flowers of Combray',
      'madeleine recipe',
    ]);
  });

  it('gives an optional location link its own column', () => {
    const location = names.find((n) => n.endsWith('caption/a[0]/@href'))!;
    expect(records.filter((r) => r[location] !== null)).toHaveLength(1);
  });
});

describe('Instagram liked posts', () => {
  const { records, names, types } = load('instagram-likes.html').main();

  it('is one table, with two bare divs as two positions rather than a list', () => {
    expect(records).toHaveLength(3);
    expect(names).toContain('div[1]/#text[0]');
    expect(records.map((r) => r['@href'])).toEqual([
      'https://www.instagram.com/p/AbCdEf01/',
      'https://www.instagram.com/p/GhIjKl02/',
      'https://www.instagram.com/p/MnOpQr03/',
    ]);
    expect(Object.values(types).filter((t) => t.includes('date-like'))).toHaveLength(1);
  });
});

describe('Facebook comments', () => {
  const { records, names } = load('facebook-comments.html').main();

  it('keeps the date in one position whether or not a link wraps it', () => {
    const dates = names.filter((n) => n.endsWith('/#text[0]') && records.some((r) => /2024/.test(String(r[n]))));
    expect(dates).toHaveLength(1);
    expect(records.every((r) => r[dates[0]!] !== null)).toBe(true);
    expect(records.map((r) => r['@href'])).toEqual([
      'https://www.facebook.com/permalink.php?story_fbid=1001',
      null,
      'https://www.facebook.com/photo.php?fbid=1003',
    ]);
  });

  it('has an empty comment text where a comment has no text', () => {
    expect(records.map((r) => r['div/#text[0]'])).toEqual(['What a beautiful hawthorn!', 'See you in Balbec.', null]);
  });
});

describe('Snapchat chat history (<table>)', () => {
  it('names columns by position when header text may not be used', () => {
    const { records, names } = load('snapchat-chats.html').main((t) => t.node.includes('table'));
    expect(records).toHaveLength(5);
    expect(names).toEqual(expect.arrayContaining(['#cell[0]', '#cell[1]', '#cell[2]']));
    // Header text never becomes a value or a name.
    expect(JSON.stringify(records)).not.toContain('Media Type');
    expect(names.join()).not.toContain('Media Type');
  });

  it('names columns by header when that is allowed', () => {
    const known = new Set(['From', 'To', 'Created', 'Media Type', 'Text']);
    const { records, names, types } = load('snapchat-chats.html', { keys: (k) => known.has(k) }).main((t) =>
      t.node.includes('table'),
    );
    expect(names).toEqual(expect.arrayContaining(['From', 'To', 'Created', 'Media Type', 'Text']));
    expect(types.Created).toEqual(['date-like']);
    expect(records.map((r) => r.From)).toEqual(['gilberte_s', 'robert_sl', 'gilberte_s', null, null]);
    expect(records.map((r) => r.To)).toEqual([null, null, null, 'gilberte_s', 'albertine_b']);
  });

  it('never takes header text that looks like a name normalisation makes', () => {
    const html = '<table><tr><th>#text[0]</th><th>@href</th></tr><tr><td>a</td><td>b</td></tr></table>';
    const tree = normalizeTree(parseFile('t.html', new TextEncoder().encode(html)), { keys: () => true });
    expect(JSON.stringify(tree)).not.toContain('"name":"@href"');
    expect(JSON.stringify(tree)).toContain('#cell[1]');
  });

  it('uses only allowed header text', () => {
    const { names } = load('snapchat-chats.html', { keys: (k) => k === 'Created' }).main((t) => t.node.includes('table'));
    expect(names).toContain('Created');
    expect(names).toContain('#cell[0]');
  });
});

describe('Account page (<dl> and a table without a header)', () => {
  it('keeps terms as values next to their descriptions by default', () => {
    const { tables, rows } = load('account-info.html');
    const record = tables.findIndex((t) => t.rows === undefined);
    const values = rows[record]![0]!.values;
    const byName = Object.fromEntries(tables[record]!.columns.map((c) => [localize(c.name, 'en'), values[c.id]]));
    expect(byName['#dt[1]']).toBe('Date joined');
    expect(byName['#dd[1]']).toBe('Jan 10, 2019');
    expect(byName['#dd[4]']).toEqual(['French', 'English']);
  });

  it('uses allowed terms as keys', () => {
    const { tables, rows } = load('account-info.html', { keys: () => true });
    const record = tables.findIndex((t) => t.rows === undefined);
    const columns = tables[record]!.columns;
    const named = Object.fromEntries(columns.map((c) => [localize(c.name, 'en'), rows[record]![0]!.values[c.id]]));
    expect(named.Username).toBe('marcel.p');
    expect(named.Email).toBe('marcel@combray.example');
    expect(named['@href']).toBe('https://combray.example/marcel');
    expect(columns.map((c) => localize(c.name, 'en'))).not.toContain('#dt[0]');
  });

  it('turns a table without a header into rows with positional cells', () => {
    const { records, names, types } = load('account-info.html').main((t) => t.node.some((n) => n.includes('logins')));
    expect(names).toEqual(['#cell[0]', '#cell[1]', '#cell[2]']);
    expect(types['#cell[0]']).toEqual(['date-like']);
    expect(records.map((r) => r['#cell[1]'])).toEqual(['Paris', 'Cabourg']);
  });
});

describe('header text and shapes', () => {
  it('never puts header text in a shape unless it is allowed', () => {
    const bytes = new Uint8Array(readFileSync(new URL('./html/snapchat-chats.html', import.meta.url)));
    const shape = JSON.stringify(extractShape(normalizeTree(parseFile('chats.html', bytes))));
    for (const header of ['From', 'Media Type', 'Created']) expect(shape).not.toContain(`"${header}"`);
  });
});
