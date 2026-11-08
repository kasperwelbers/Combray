import { buildTree, flatten, locateRoot, unflatten, type ConfigNode } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { fixtureListing } from '../../../importers/test/load';
import type { UploadPoint } from '../src/worker/api';
import { pointProject, type PointProject } from '../src/worker/derived';
import { Review, uploadDonation, type LeftOut } from '../src/worker/donate';

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
async function donationOf(fixture: string, point = 'takeout') {
  const project = asking();
  const located = await locateRoot(await fixtureListing(fixture), project.tree);
  if (located.status !== 'found') throw new Error(located.status);
  return uploadDonation(point, unflatten(flatten(located.root.tree)), project);
}

const none = (): LeftOut => ({ rows: new Set(), rules: [] });

describe('the donation of an upload', () => {
  it('holds what the study asks for, read from the stored tree as the import read it', async () => {
    const part = await donationOf('google-takeout-en');
    const review = new Review([part], 'settings');
    const overview = review.overview(none());
    expect(overview.tables.length).toBeGreaterThan(0);
    expect(overview.leftOut).toBe(0);
    // Names are for the participant, in their language; the pack names the history in Dutch too.
    const history = overview.tables.find((t) => t.id === 'youtube_watch_history')!;
    expect(history.name).toMatchObject({ nl: 'YouTube-kijkgeschiedenis' });
    expect(history.rowCount).toBeGreaterThan(0);
    expect(history.fields.length).toBeGreaterThan(0);
    // Rows are known by what they are: the same upload gives the same hashes, one per row.
    const hashes = part.content.rows.map((r) => r.hash);
    expect((await donationOf('google-takeout-en')).content.rows.map((r) => r.hash)).toEqual(hashes);
    expect(new Set(hashes).size).toBe(hashes.length);
    // Every value's path is in the upload point's platform.
    expect(new Set(part.content.entries.map((e) => e.platform))).toEqual(new Set(['takeout']));
  });

  it('leaves rows out by hash or by text, with the rows nested in them, and sends the rest', async () => {
    const review = new Review([await donationOf('google-takeout-en')], 'settings');
    const all = review.content;
    const [table] = review.overview(none()).tables;
    const first = review.rows(table!.id, '', 0, 1, none()).items[0]!;
    const text = Object.values(first.cells).flat().find((v) => v.length > 3)!;

    // A text is found whatever its case.
    const count = review.countMatching(undefined, text.toUpperCase());
    expect(count).toBeGreaterThan(0);
    const byText: LeftOut = { rows: new Set(), rules: [{ text: text.toUpperCase() }] };
    const overview = review.overview(byText);
    expect(overview.leftOut).toBeGreaterThanOrEqual(count);
    expect(overview.rules).toEqual([{ text: text.toUpperCase(), count }]);
    const row = review.rows(table!.id, text, 0, 50, byText).items.find((r) => r.key === first.key)!;
    expect(row).toMatchObject({ leftOut: true, byText: true });

    const sent = review.donated(byText);
    expect(sent.rows.length).toBe(all.rows.length - overview.leftOut);
    expect(JSON.stringify(sent.values.map((v) => v.value))).not.toContain(JSON.stringify(text));
    // One row by its hash.
    const one: LeftOut = { rows: new Set([first.key]), rules: [] };
    expect(review.rows(table!.id, '', 0, 1, one).items[0]).toMatchObject({ leftOut: true, byText: false });
    expect(review.donated(one).rows).toHaveLength(all.rows.length - review.overview(one).leftOut);
    // Nothing left out: everything goes.
    expect(review.donated(none()).values).toEqual(all.values);
  });

  it('finds a text in the values as they are in the files too', async () => {
    const part = await donationOf('google-takeout-en');
    const review = new Review([part], 'settings');
    const converted = part.content.values.find((v) => typeof v.source === 'string' && v.source !== v.value && v.source.length > 4);
    if (!converted) return;
    const text = String(converted.source);
    expect(review.countMatching(converted.table, text)).toBeGreaterThan(0);
  });

  it('combines uploads of different platforms, keeping their rows apart', async () => {
    const one = await donationOf('google-takeout-en', 'a');
    const two = await donationOf('google-takeout-en', 'b');
    const review = new Review([one, two], 'settings');
    const [table] = review.overview(none()).tables;
    expect(table!.rowCount).toBe(2 * new Review([one], 'settings').overview(none()).tables[0]!.rowCount);
    expect(review.content.entries.length).toBe(2 * one.content.entries.length);
  });
});
