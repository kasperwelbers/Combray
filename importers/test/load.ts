/** Reading fixtures from disk, as an upload would be read in the browser. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { defaultRoot, parseEntries, readSpot, UploadListing, type TreeNode, type UploadFile } from '@combray/core';
import { strToU8, zipSync } from 'fflate';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

export const fixtureNames = () => readdirSync(FIXTURES).sort();

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** A fixture's input files, by their path inside `input/`. */
export function fixtureFiles(fixture: string): Record<string, Uint8Array> {
  const input = join(FIXTURES, fixture, 'input');
  return Object.fromEntries(files(input).map((path) => [relative(input, path).split('\\').join('/'), readFileSync(path)]));
}

/** A fixture's input as one tree, like a picked folder: the shape the YAML importers expect. */
export function loadFixture(fixture: string): TreeNode {
  return parseEntries(
    fixture,
    Object.entries(fixtureFiles(fixture)).map(([path, bytes]) => ({ path, bytes })),
  );
}

/** Files as the browser gives them. */
export function uploadFiles(files: Record<string, string | Uint8Array>): UploadFile[] {
  return Object.entries(files).map(([path, content]) => {
    const bytes = typeof content === 'string' ? strToU8(content) : content;
    return { path, size: bytes.byteLength, read: async () => bytes };
  });
}

/**
 * A fixture as it is downloaded: one zip of its input, optionally with more files in it.
 */
export function fixtureZip(fixture: string, extra: Record<string, string> = {}): Uint8Array {
  const entries: Record<string, Uint8Array> = fixtureFiles(fixture);
  for (const [path, text] of Object.entries(extra)) entries[path] = strToU8(text);
  return zipSync(entries);
}

/** A fixture's zip as a participant picks it. */
export const fixtureListing = (fixture: string, extra?: Record<string, string>) =>
  UploadListing.open(uploadFiles({ [`${fixture}.zip`]: fixtureZip(fixture, extra) }));

/** A fixture's root as the researcher workspace reads it, without a project tree. */
export async function readFixture(fixture: string): Promise<TreeNode> {
  const listing = await fixtureListing(fixture);
  return (await readSpot(listing, await defaultRoot(listing))).tree;
}
