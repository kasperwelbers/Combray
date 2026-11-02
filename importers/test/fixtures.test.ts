import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSandbox, matchingImporters, runImporter, type Row } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { importers } from '../index';
import { FIXTURES as root, fixtureNames, loadFixture } from './load';

describe('bundled importers', () => {
  it('are valid and have unique ids', () => {
    const ids = importers.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('are each exercised by at least one fixture', () => {
    const covered = new Set<string>();
    for (const fixture of fixtureNames()) {
      const expected = JSON.parse(readFileSync(join(root, fixture, 'expected.json'), 'utf8')) as Record<string, unknown>;
      for (const id of Object.keys(expected)) covered.add(id);
    }
    expect(importers.map((s) => s.id).filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe.each(fixtureNames())('fixture %s', (fixture) => {
  it('produces the expected rows', async () => {
    const tree = loadFixture(fixture);
    const sandbox = await createSandbox();
    const actual: Record<string, Row[]> = {};
    for (const spec of matchingImporters(tree, importers)) {
      const result = runImporter(tree, spec, sandbox);
      expect(result.errors, spec.id).toEqual([]);
      actual[spec.id] = result.rows;
    }
    sandbox.dispose();
    const expectedPath = join(root, fixture, 'expected.json');
    if (process.env.UPDATE_EXPECTED) writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(expectedPath, 'utf8')));
  });
});
