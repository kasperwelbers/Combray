import { describe, expect, it } from 'vitest';

import { convertRecipe, jsonToTree, runImporter, validateSpec, type OldRecipe, type TreeNode } from '../src';
import { parseMarkup } from '../src/parse/html';

// Recipes copied from data-donation-importers (src/recipes.js), MIT licensed.
const browsing: OldRecipe = {
  name: 'Google Takeout Browsing History',
  file: ['BrowserHistory.json'],
  filetype: 'json',
  rows_selector: 'Browser History',
  columns: [
    { name: 'title', selector: 'title' },
    { name: 'url', selector: 'url' },
    { name: 'time', selector: 'time_usec' },
  ],
  transformers: [
    { transformer: 'int_to_date', column: 'time', new_column: 'date', arguments: { unit: 'microsecond' } },
    { transformer: 'filter_regex', column: 'url', new_column: '', arguments: { regex: 'google\\.com/search', 'rm selected': true } },
    { transformer: 'url_to_domain', column: 'url', new_column: 'domain', arguments: { 'rm prefix': true } },
  ],
};

const youtubeHtml: OldRecipe = {
  name: 'Google Takeout Youtube History (html)',
  file: ['watch-history.html', 'kijkgeschiedenis.html'],
  filetype: 'html',
  rows_selector: ['.mdl-grid > .outer-cell'],
  columns: [
    { name: 'title', selector: ['a'] },
    { name: 'title_url', selector: ['a @href'] },
    { name: 'channel', selector: ['a:nth-of-type(2)'] },
    { name: 'raw_date', selector: ['.content-cell @INNER'] },
  ],
  transformers: [
    { transformer: 'filter', column: '', new_column: '', arguments: { expression: 'channel == null', 'rm selected': true } },
  ],
};

const subscriptions: OldRecipe = {
  name: 'Google Takeout Youtube Subscriptions',
  file: ['subscriptions.csv', 'abonnementen.csv'],
  filetype: 'csv',
  rows_selector: [''],
  columns: [
    { name: 'channel_url', selector: ['Channel URL', 'Kanaal-URL'] },
    { name: 'channel', selector: ['Channel title', 'Kanaaltitel'] },
  ],
};

const wrap = (...children: TreeNode[]): TreeNode => ({ kind: 'dir', name: 'takeout.zip', children: [{ kind: 'dir', name: 'Takeout', children }] });

describe('convertRecipe', () => {
  it('converts a JSON recipe with dates, filters and derived columns', () => {
    const { spec, warnings } = convertRecipe(browsing);
    expect(warnings).toEqual([]);
    validateSpec(spec);
    expect(spec).toMatchObject({
      match: { file: '**/BrowserHistory.json' },
      select: {
        rows: 'Browser History/[*]',
        fields: {
          time: { path: 'time_usec' },
          date: { from: 'time', as: 'datetime', format: 'epoch-us' },
          domain: { from: 'url', transform: ['domain'] },
        },
      },
      where: "url !~* 'google\\.com/search'",
    });
    const tree = wrap(
      jsonToTree('BrowserHistory.json', {
        'Browser History': [
          { title: 'Tea', url: 'https://www.tisane.example/lime', time_usec: 1709284500000000 },
          { title: 'q', url: 'https://www.google.com/search?q=x', time_usec: 1709284500000000 },
        ],
      }),
    );
    expect(runImporter(tree, spec).rows).toEqual([
      { title: 'Tea', url: 'https://www.tisane.example/lime', time: '1709284500000000', date: '2024-03-01T09:15:00.000Z', domain: 'tisane.example' },
    ]);
  });

  it('converts an HTML recipe, with warnings for what it cannot express', () => {
    const { spec, warnings } = convertRecipe(youtubeHtml);
    validateSpec(spec);
    expect(warnings.join('\n')).toMatch(/@INNER/);
    expect(spec.select.rows).toBe('**/.mdl-grid/.outer-cell');
    expect(spec.select.fields.channel).toEqual({ path: '**/a', nth: 1 });
    const html = parseMarkup(
      'watch-history.html',
      `<div class="mdl-grid"><div class="outer-cell"><div class="content-cell">Watched <a href="https://www.youtube.com/watch?v=1">Tea</a><br><a href="https://www.youtube.com/channel/1">Tisane</a><br>Mar 4, 2024</div></div>
       <div class="outer-cell"><div class="content-cell">Watched <a href="https://www.youtube.com/watch?v=2">Ad</a></div></div></div>`,
    );
    expect(runImporter(wrap(html), spec).rows).toEqual([
      { title: 'Tea', title_url: 'https://www.youtube.com/watch?v=1', channel: 'Tisane', raw_date: 'Watched Tea Tisane Mar 4, 2024' },
    ]);
  });

  it('converts CSV recipes with language alternatives', () => {
    const { spec } = convertRecipe(subscriptions);
    expect(spec.match.file).toBe('**/{subscriptions.csv,abonnementen.csv}');
    expect(spec.select).toEqual({
      rows: '[*]',
      fields: { channel_url: { path: '{Channel URL,Kanaal-URL}' }, channel: { path: '{Channel title,Kanaaltitel}' } },
    });
  });
});
