import { describe, expect, it } from 'vitest';

import { examplePackages, packs } from '../index';
import { fixtureFiles } from './load';

describe('example data donation packages', () => {
  it('are the fixtures, each for a bundled platform pack', async () => {
    expect(examplePackages.length).toBeGreaterThan(0);
    for (const example of examplePackages) {
      expect(packs.map((p) => p.id), example.id).toContain(example.pack);
      const files = await example.load();
      expect(files.map((f) => f.path).sort(), example.id).toEqual(Object.keys(fixtureFiles(example.id)).sort());
    }
  });
});
