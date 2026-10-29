import { flatten, jsonToTree } from '@combray/core';
import { describe, expect, it } from 'vitest';

import { children, countFiles, nodeDetail, search } from '../src/worker/queries';

const nodes = flatten({
  kind: 'dir',
  name: 'upload',
  children: [
    jsonToTree('a.json', { title: 'x'.repeat(300), list: [1, 2, 3] }),
    { kind: 'blob', name: 'p.jpg', mime: 'image/jpeg', size: 10 },
    { kind: 'dir', name: 'sub', children: [jsonToTree('b.json', { name: 'Combray Kitchen' })] },
  ],
});

describe('tree queries', () => {
  it('pages through children', () => {
    const page = children(nodes, 0, 1, 1);
    expect(page.total).toBe(3);
    expect(page.items.map((n) => n.name)).toEqual(['p.jpg']);
  });

  it('truncates long values in previews', () => {
    const a = children(nodes, 0, 0, 1).items[0]!;
    const title = children(nodes, a.index, 0, 1).items[0]!;
    expect(title.preview).toHaveLength(201);
  });

  it('returns ancestors and the location of a node', () => {
    const hit = search(nodes, 'kitchen', 10).items[0]!;
    expect(hit.location).toEqual(['sub', 'b.json', 'name']);
    const detail = nodeDetail(nodes, hit.node.index);
    expect(detail.ancestors.map((a) => a.name)).toEqual(['upload', 'sub', 'b.json']);
  });

  it('counts files', () => {
    expect(countFiles(nodes)).toBe(3);
  });

  it('limits search results but counts all', () => {
    const page = search(nodes, 'json', 1);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
  });
});
