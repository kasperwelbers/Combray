import { placements } from '@combray/seal';
import { describe, expect, it } from 'vitest';

import { buildTree, emptyConfig, extractShape, importerFile, jsonToTree, nameMap, normalizeTree, parseImporterFile, renameNode, setDecision, structureOnlyTables, toConfig } from '../src';
import { parseMarkup } from '../src/parse/html';
import { at, rebuild, treeOf } from './trees';

const shape = extractShape(
  jsonToTree('', {
    'history.json': [{ title: 'Madeleines', tags: ['tea'], channel: { name: 'Léonie' } }],
    'notes.json': [{ text: 'not configured' }],
  }),
);

describe('nameMap', () => {
  it('holds the configured parts with their names, and nothing nobody configured', () => {
    let tree = treeOf(shape);
    tree = rebuild(setDecision(tree, at(tree, 'history.json', '[*]', 'title'), 'donate'), shape);
    tree = rebuild(setDecision(tree, at(tree, 'history.json', '[*]', 'tags', '[*]'), 'donate'), shape);
    const map = nameMap(tree);
    expect(placements(map, ['history.json', '[0]', 'title'])).toEqual([{ table: 'history', field: 'title', rows: [{ table: 'history', steps: 2 }] }]);
    expect(placements(map, ['history.json', '[0]', 'tags', '[0]'])[0]).toMatchObject({ table: 'history_tags', field: 'tags' });
    expect(placements(map, ['notes.json', '[0]', 'text'])).toEqual([]);
    expect(JSON.stringify(map)).not.toMatch(/Madeleines|tea|Léonie/);
  });

  it('follows a rename, so earlier paths come out under the new name', () => {
    let tree = treeOf(shape);
    tree = rebuild(setDecision(tree, at(tree, 'history.json', '[*]', 'title'), 'donate'), shape);
    const renamed = rebuild(renameNode(tree, at(tree, 'history.json', '[*]', 'title'), 'video').tree, shape);
    expect(placements(nameMap(renamed), ['history.json', '[3]', 'title'])[0]?.field).toBe('video');
  });

  it('goes with the importer file, which also lists donated tables named only by structure', () => {
    const page = normalizeTree(
      parseMarkup('page.html', '<html><body><div class="row"><a href="x">one</a><a href="y">two</a><a href="z">three</a></div><div class="row"><a href="v">four</a><a href="w">five</a></div></body></html>'),
    );
    const html = extractShape({ kind: 'dir', name: '', children: [page] });
    let tree = treeOf(html);
    tree = rebuild(setDecision(tree, at(tree, 'page.html', 'html', 'body', 'div.row', '[*]', 'a', '[*]', '@href'), 'donate'), html);
    const config = { root: toConfig(tree) };
    const file = importerFile(config, undefined, html);
    expect(parseImporterFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(file.unnamed).toEqual(structureOnlyTables(buildTree(config, html).tree));
    // The rows are named after the file; the links inside them only by their element.
    expect(file.unnamed).toEqual(['a']);
    expect(importerFile(emptyConfig('dir'))).not.toHaveProperty('names');
  });
});
