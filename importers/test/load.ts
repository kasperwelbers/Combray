/** Reading fixtures from disk, as an upload would be read in the browser. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseEntries, type TreeNode } from '@combray/core';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** A fixture's input as one tree, like a picked folder. */
export function loadFixture(fixture: string): TreeNode {
  const input = join(FIXTURES, fixture, 'input');
  return parseEntries(
    fixture,
    files(input).map((path) => ({ path: relative(input, path).split('\\').join('/'), bytes: readFileSync(path) })),
  );
}

export const fixtureNames = () => readdirSync(FIXTURES).sort();
