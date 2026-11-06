// Parser corrections: texts that are names (corrections.ts). Keys that are data are tested
// with the decisions (decisions.test.ts, "keys that are data").
import { describe, expect, it } from 'vitest';

import {
  applyTextNames,
  buildTree,
  correctedShape,
  deriveRows,
  deriveTables,
  extractShape,
  normalizeTree,
  prepareTree,
  textNamesOf,
  toConfig,
  unionShape,
  type ProjectConfig,
  type ProjectNode,
  type Shape,
  type TreeNode,
} from '../src';
import { parseMarkup } from '../src/parse/html';
import { at, nodeAt, treeOf } from './trees';

/** A history page: one `div.entry` per visit, with the names written as text in it. */
const page = (entry: (i: number) => string, n = 3) =>
  parseMarkup('history.html', `<body>${Array.from({ length: n }, (_, i) => `<div class="entry"><span>History</span>${entry(i + 1)}</div>`).join('')}</body>`);

const SIDE_BY_SIDE = (i: number) =>
  `<div><div><h1>url</h1><h1>title</h1></div><div><span>https://example.com/${i}</span><span>Page ${i}</span></div></div>`;
const PAIRS = (i: number) =>
  `<div><div><span>url</span><span>https://example.com/${i}</span></div><div><span>title</span><span>Page ${i}</span></div></div>`;
const TAKING_TURNS = (i: number) => `<div><span>url</span><span>https://example.com/${i}</span><span>title</span><span>Page ${i}</span></div>`;
const LABELLED = (i: number) =>
  `<p class="row"><b>url</b> <a href="https://example.com/${i}">link</a></p><p class="row"><b>title</b> <i>Page ${i}</i></p>`;

/** As the studio reads the researcher's own export: any header text may be a name. */
const studioTree = (html: TreeNode) => normalizeTree(html, { keys: () => true });

/** The project tree after the researcher marks the history entries' texts as names. */
function marked(tree: TreeNode): { config: ProjectConfig; project: ProjectNode } {
  const project = treeOf(extractShape(tree));
  const entry = nodeAt(project, 'body', 'div.entry', '[*]');
  entry.textNames = textNamesOf(entry);
  const config = { root: toConfig(project) };
  return { config, project: buildTree(config, extractShape(applyTextNames(tree, buildTree(config).tree, () => true))).tree };
}

/** The names below the entries, as the corrected tree has them. */
const entryNames = (project: ProjectNode) => nodeAt(project, 'body', 'div.entry', '[*]').children!.map((c) => c.name).sort();

describe('texts that are names', () => {
  it.each([
    ['side by side', SIDE_BY_SIDE],
    ['pairs, one per element', PAIRS],
    ['taking turns', TAKING_TURNS],
    ['a label and then its value', LABELLED],
  ])('reads %s as names and values', (_, entry) => {
    const { project } = marked(studioTree(page(entry)));
    expect(entryNames(project)).toEqual(['span', 'title', 'url']);
    expect(nodeAt(project, 'body', 'div.entry', '[*]', 'title').types).toEqual(['string']);
  });

  it('gives each name its own column, with the values of each row', () => {
    const tree = studioTree(page(SIDE_BY_SIDE));
    const { project } = marked(tree);
    const read = applyTextNames(tree, project, () => true);
    const tables = deriveTables(project);
    const rows = deriveRows(read, project, tables)[0]!;
    const url = tables[0]!.columns.find((c) => c.id === 'url')!;
    expect(rows.map((r) => r.values[url.id])).toEqual(['https://example.com/1', 'https://example.com/2', 'https://example.com/3']);
  });

  it('keeps links and other content of a value', () => {
    const { project } = marked(studioTree(page(LABELLED)));
    expect(nodeAt(project, 'body', 'div.entry', '[*]', 'url').kind).toBe('map');
    expect(nodeAt(project, 'body', 'div.entry', '[*]', 'url', '@href')).toBeDefined();
  });

  it('leaves an element alone when the texts do not line up', () => {
    const odd = (i: number) => `<div><span>url</span><span>https://example.com/${i}</span><span>title</span></div>`;
    const uneven = (i: number) => `<div><div><h1>url</h1><h1>title</h1></div><div><span>https://example.com/${i}</span></div></div>`;
    for (const entry of [odd, uneven]) {
      // The mark was set on the rows that line up; this row has the same positions, but not
      // as many names as values.
      const tree = studioTree(page(entry));
      const project = treeOf(extractShape(tree));
      nodeAt(project, 'body', 'div.entry', '[*]').textNames = entry === odd ? 'pairs' : 'beside';
      expect(applyTextNames(tree, project, () => true)).toEqual(tree);
    }
  });

  it('is offered where the structure has one list of pairs, or two lists', () => {
    const offered = (entry: (i: number) => string) => textNamesOf(nodeAt(treeOf(extractShape(studioTree(page(entry)))), 'body', 'div.entry', '[*]'));
    expect([SIDE_BY_SIDE, PAIRS, TAKING_TURNS, LABELLED].map(offered)).toEqual(['beside', 'pairs', 'pairs', 'pairs']);
    expect(offered((i) => `<p>Visited ${i}</p>`)).toBeUndefined();
  });

  it('changes nothing without a mark', () => {
    const tree = studioTree(page(PAIRS));
    expect(applyTextNames(tree, treeOf(extractShape(tree)), () => true)).toBe(tree);
  });

  describe("on a participant's device", () => {
    const studio = studioTree(page(SIDE_BY_SIDE));
    const { config, project } = marked(studio);

    it('reads names the project knows, as the studio does', () => {
      const { shape } = prepareTree(page(SIDE_BY_SIDE, 2), project);
      const participant = buildTree(config, shape, { seen: extractShape(applyTextNames(studio, project, () => true)) });
      expect(entryNames(participant.tree)).toEqual(['span', 'title', 'url']);
      expect(participant.fresh.size).toBe(0);
    });

    it('keeps a label the project does not know as a position, without its text in the shape', () => {
      const extra = (i: number) =>
        `<div><div><h1>url</h1><h1>title</h1><h1>secret label</h1></div><div><span>https://example.com/${i}</span><span>Page ${i}</span><span>x</span></div></div>`;
      const { shape } = prepareTree(page(extra, 2), project);
      expect(JSON.stringify(shape)).not.toContain('secret');
      const participant = buildTree(config, shape, { seen: extractShape(applyTextNames(studio, project, () => true)) });
      expect(entryNames(participant.tree)).toEqual(['#dd[2]', '#dt[2]', 'span', 'title', 'url']);
      expect([...participant.fresh].map((n) => n.name).sort()).toEqual(['#dd[2]', '#dt[2]']);
    });
  });

  it('leaves the lists out of structures recorded before the mark', () => {
    const tree = studioTree(page(PAIRS));
    const before = extractShape(tree);
    const { config, project } = marked(tree);
    const after = extractShape(applyTextNames(tree, project, () => true));
    const seen = correctedShape(config, unionShape([before, after])!);
    const entry = (s: Shape) => s.children![0]!.children![0]!.children![0]!;
    expect(entry(seen).children!.map((c) => c.name)).toEqual(['span', 'title', 'url']);
    // Laid over the corrected structures, the tree has no leftovers of the lists.
    expect(entryNames(buildTree(config, seen).tree)).toEqual(['span', 'title', 'url']);
    expect(at(buildTree(config, seen).tree, 'body', 'div.entry', '[*]', 'url')).toHaveLength(4);
  });
});
