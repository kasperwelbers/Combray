import { buildTree, flatten, locateRoot, unflatten, type ConfigNode } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { fixtureListing } from '../../../importers/test/load';
import type { UploadPoint } from '../src/worker/api';
import { pointProject, type PointProject } from '../src/worker/derived';
import { Review, uploadDonation } from '../src/worker/donate';

const TAKEOUT: UploadPoint = { id: 'takeout', pack: 'google-takeout' };

/** The Takeout pack, asking for everything it shows. */
function asking(): PointProject {
  const project = pointProject(TAKEOUT)!;
  const config = structuredClone(project.config);
  const visit = (node: ConfigNode) => {
    if (node.decision === 'show') node.decision = 'donate';
    node.children?.forEach(visit);
  };
  visit(config.root);
  return { ...project, config, tree: buildTree(config, project.seen).tree };
}

/** The donation of a fixture, from its tree as the data worker stores it (flattened). */
async function donationOf(fixture: string, source = fixture) {
  const project = asking();
  const located = await locateRoot(await fixtureListing(fixture), project.tree);
  if (located.status !== 'found') throw new Error(located.status);
  return uploadDonation(source, unflatten(flatten(located.root.tree)), project);
}

describe('the donation of an upload', () => {
  it('holds what the study asks for, read from the stored tree as the import read it', async () => {
    const part = await donationOf('google-takeout-en');
    const review = new Review([part], 'settings');
    const overview = review.overview(new Set());
    expect(overview.tables.length).toBeGreaterThan(0);
    expect(overview.leftOut).toBe(0);
    // Names are for the participant, in their language; the pack names the history in Dutch too.
    const history = overview.tables.find((t) => t.id === 'youtube_watch_history')!;
    expect(history.name).toMatchObject({ nl: 'YouTube-kijkgeschiedenis' });
    expect(history.rowCount).toBeGreaterThan(0);
    expect(history.fields.length).toBeGreaterThan(0);
    // Keys are stable: the same upload gives the same keys.
    expect((await donationOf('google-takeout-en')).keys).toEqual(part.keys);
    expect(new Set(part.keys).size).toBe(part.keys.length);
  });

  it('leaves rows out by key or by text, with the rows nested in them, and sends the rest', async () => {
    const review = new Review([await donationOf('google-takeout-en')], 'settings');
    const all = review.content;
    const [table] = review.overview(new Set()).tables;
    const first = review.rows(table!.id, '', 0, 1, new Set()).items[0]!;
    const text = Object.values(first.cells).flat().find((v) => v.length > 3)!;

    const matching = review.matching(undefined, text.toUpperCase());
    expect(matching).toContain(first.key);
    const leftOut = new Set(matching);
    const overview = review.overview(leftOut);
    expect(overview.leftOut).toBeGreaterThanOrEqual(matching.length);
    const row = review.rows(table!.id, text, 0, 50, leftOut).items.find((r) => r.key === first.key)!;
    expect(row.leftOut).toBe(true);

    const sent = review.donated(leftOut);
    expect(sent.rows.length).toBe(all.rows.length - overview.leftOut);
    expect(JSON.stringify(sent.values)).not.toContain(JSON.stringify(text));
    // Nothing left out: everything goes.
    expect(review.donated(new Set()).values).toEqual(all.values);
  });

  it('combines uploads, keeping their rows apart', async () => {
    const one = await donationOf('google-takeout-en', 'a');
    const two = await donationOf('google-takeout-en', 'b');
    const review = new Review([one, two], 'settings');
    const [table] = review.overview(new Set()).tables;
    expect(table!.rowCount).toBe(2 * new Review([one], 'settings').overview(new Set()).tables[0]!.rowCount);
    // Leaving out a row of the first upload leaves the same row of the second in.
    const leftOut = new Set([one.keys[0]!]);
    expect(review.overview(leftOut).leftOut).toBeLessThan(new Review([one], 's').overview(leftOut).rows);
    expect(review.donated(leftOut).rows.length).toBeGreaterThan(0);
  });
});
