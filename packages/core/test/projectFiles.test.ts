import { describe, expect, it } from 'vitest';

import {
  extractShape,
  getNode,
  joinProjectTree,
  parseImporterFile,
  parseStructureFile,
  ProjectFileError,
  projectTreeFromShape,
  setDecision,
  setTable,
  splitProjectTree,
} from '../src';
import { watchHistory } from './fixtures';

function decided() {
  let tree = projectTreeFromShape(extractShape(watchHistory));
  tree = setTable(tree, [], true);
  tree = setDecision(tree, ['[*]', 'time'], 'donate');
  getNode(tree, ['[*]', 'time'])!.label = { en: 'Watched at', nl: 'Bekeken op' };
  getNode(tree, ['[*]', 'title'])!.aliases = ['titel', { regex: '^Title$', flags: 'i' }];
  return tree;
}

describe('project files', () => {
  it('split into structure and settings, and join back to the same tree', () => {
    const tree = decided();
    const { structure, importer } = splitProjectTree(tree, 'YouTube');
    expect(JSON.stringify(structure)).not.toMatch(/decision|label|aliases|table/);
    expect(importer.entries.map((e) => e.path)).toEqual([[], ['[*]', 'time'], ['[*]', 'title']]);
    const roundTrip = JSON.parse(JSON.stringify({ structure, importer }));
    const { tree: joined, pending } = joinProjectTree(
      parseStructureFile(roundTrip.structure),
      parseImporterFile(roundTrip.importer),
    );
    expect(pending).toEqual([]);
    expect(joined).toEqual(tree);
  });

  it('keeps settings for paths the structure does not have yet', () => {
    const { importer } = splitProjectTree(decided());
    const empty = { format: 'combray-structure@1' as const, root: { kind: 'list' as const, name: '' } };
    const { pending } = joinProjectTree(empty, importer);
    expect(pending.map((e) => e.path)).toEqual([['[*]', 'time'], ['[*]', 'title']]);
  });

  it('rejects malformed files', () => {
    expect(() => parseStructureFile({ format: 'nope' })).toThrow(ProjectFileError);
    expect(() => parseStructureFile({ format: 'combray-structure@1', root: { kind: 'x', name: '' } })).toThrow(
      'unknown kind',
    );
    const importer = (entry: object) => ({ format: 'combray-importer@1', entries: [entry] });
    expect(() => parseImporterFile(importer({ path: ['a'], kind: 'value', decision: 'maybe' }))).toThrow(
      'unknown decision',
    );
    expect(() => parseImporterFile(importer({ path: ['a'], kind: 'value', aliases: [{ regex: '(' }] }))).toThrow(
      'invalid regular expression',
    );
    expect(() => parseImporterFile(importer({ path: 'a', kind: 'value' }))).toThrow('path');
  });
});
