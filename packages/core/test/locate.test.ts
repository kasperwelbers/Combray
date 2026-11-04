import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  defaultRoot,
  findPatternProblem,
  locateRoot,
  readSpot,
  UPLOAD_LIMITS,
  UploadListing,
  type ProjectNode,
  type TreeNode,
  type UploadFile,
} from '../src';

/** Files as the browser gives them, counting every read. */
function upload(files: Record<string, string | Uint8Array>) {
  const reads: string[] = [];
  const list: UploadFile[] = Object.entries(files).map(([path, content]) => {
    const bytes = typeof content === 'string' ? strToU8(content) : content;
    return {
      path,
      size: bytes.byteLength,
      read: async () => {
        reads.push(path);
        return bytes;
      },
    };
  });
  return { list, reads };
}

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const WATCH = JSON.stringify([
  { title: 'Watched a video', time: '2024-03-05T10:00:00Z' },
  { title: 'Watched another', time: '2024-03-06T10:00:00Z' },
]);
const NOTES = JSON.stringify({ notes: ['buy milk'] });

/** A config node, as a project tree has it: its first match is its name and its id. */
const node = (kind: ProjectNode['kind'], match: string[], extra: Partial<ProjectNode> = {}): ProjectNode => ({
  id: match[0]!,
  kind,
  name: match[0]!,
  match,
  ...extra,
});
const value = (name: string, extra: Partial<ProjectNode> = {}) => node('value', [name], extra);

/** A small Takeout-like tree: the study shows the watch history and ignores mail. */
function takeoutTree(extra: Partial<ProjectNode> = {}): ProjectNode {
  return {
    ...node('dir', [], { find: ['Takeout', 'takeout-*.zip'], newChildren: 'skip', ...extra }),
    id: 'root',
    name: '',
    children: [
      node('dir', ['YouTube', 'YouTube en YouTube Music'], {
        children: [
          node('dir', ['history'], {
            children: [
              node('list', ['watch-history.json', 'kijkgeschiedenis.json'], {
                children: [node('map', ['[*]'], { children: [value('title', { decision: 'show' }), value('time', { decision: 'show' })] })],
              }),
            ],
          }),
        ],
      }),
      node('dir', ['Mail'], { decision: 'ignore', children: [node('blob', ['All mail.mbox'])] }),
    ],
  };
}

/** A tree whose root is one JSON file: the list of watched videos. */
function fileTree(): ProjectNode {
  return {
    ...node('list', [], { find: ['watch-history*.json'] }),
    id: 'root',
    name: '',
    children: [node('map', ['[*]'], { children: [value('title', { decision: 'show' }), value('time')] })],
  };
}

const names = (tree: TreeNode) => (tree.kind === 'dir' ? tree.children.map((c) => c.name).sort() : []);

async function locate(files: Record<string, string | Uint8Array>, tree: ProjectNode, limits = UPLOAD_LIMITS) {
  const { list, reads } = upload(files);
  const listing = await UploadListing.open(list, limits);
  return { result: await locateRoot(listing, tree), reads };
}

describe('the upload is the root', () => {
  it('steps into the one folder of an archive', async () => {
    const { result } = await locate(
      { 'takeout-20240101.zip': zip({ 'Takeout/YouTube/history/watch-history.json': WATCH }) },
      takeoutTree(),
    );
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.root.tree.name).toBe('');
    expect(names(result.root.tree)).toEqual(['YouTube']);
  });

  it('takes a picked folder as it is, whatever it is called', async () => {
    const { result } = await locate({ 'my google stuff/YouTube/history/watch-history.json': WATCH }, takeoutTree());
    expect(result.status).toBe('found');
  });

  it('chooses the wrapper level that fits, not the deepest one', async () => {
    // Only YouTube was exported: Takeout holds one folder, which must stay part of the tree.
    const { result } = await locate(
      { 'takeout.zip': zip({ 'Takeout/YouTube/history/watch-history.json': WATCH }) },
      takeoutTree(),
    );
    if (result.status !== 'found') throw new Error(result.status);
    expect(names(result.root.tree)).toEqual(['YouTube']);
  });

  it('steps through an unzipped download folder and a zip inside a folder', async () => {
    const unzipped = await locate({ 'takeout-2024/Takeout/YouTube/history/watch-history.json': WATCH }, takeoutTree());
    expect(unzipped.result.status).toBe('found');
    const zipped = await locate(
      { 'Downloads/takeout-001.zip': zip({ 'Takeout/YouTube/history/watch-history.json': WATCH }) },
      takeoutTree(),
    );
    expect(zipped.result.status).toBe('found');
  });

  it('matches folders by alias, so a Dutch export fits', async () => {
    const { result } = await locate(
      { 'Takeout/YouTube en YouTube Music/history/kijkgeschiedenis.json': WATCH },
      takeoutTree(),
    );
    expect(result.status).toBe('found');
  });

  it('merges the parts of a split archive', async () => {
    const { result } = await locate(
      {
        'takeout-001.zip': zip({ 'Takeout/YouTube/history/watch-history.json': WATCH }),
        'takeout-002.zip': zip({ 'Takeout/YouTube/history/search-history.json': '[]' }),
      },
      takeoutTree({ newChildren: undefined }),
    );
    if (result.status !== 'found') throw new Error(result.status);
    expect(result.root.files.map((f) => f.path).sort()).toEqual([
      'YouTube/history/search-history.json',
      'YouTube/history/watch-history.json',
    ]);
  });

  it('takes a single file as the root of a file tree, without looking at its name', async () => {
    const { result } = await locate({ 'kaspers export (2).json': WATCH }, fileTree());
    if (result.status !== 'found') throw new Error(result.status);
    expect(result.root.tree).toMatchObject({ kind: 'list', name: '' });
    // Also from a zip that holds just that file.
    const zipped = await locate({ 'export.zip': zip({ 'whatever.json': WATCH }) }, fileTree());
    expect(zipped.result.status).toBe('found');
  });

  it('does not fit a file whose structure has nothing the study shows', async () => {
    const { result } = await locate({ 'watch-history.json': NOTES }, fileTree());
    expect(result.status).toBe('no-fit');
  });
});

describe('what is read from the root', () => {
  it('skips ignored folders and unknown parts below a node that skips new children', async () => {
    const tree = takeoutTree();
    const { result, reads } = await locate(
      {
        'Takeout/YouTube/history/watch-history.json': WATCH,
        'Takeout/Mail/All mail.mbox': 'From someone',
        'Takeout/Drive/secret plans.txt': 'plans',
        'Takeout/YouTube/history/new-file.json': '[]',
      },
      tree,
    );
    if (result.status !== 'found') throw new Error(result.status);
    // Drive is new below the root, which skips new children, and so does everything below it.
    expect(reads).toEqual(['Takeout/YouTube/history/watch-history.json']);
    expect(names(result.root.tree)).toEqual(['YouTube']);
    // A node below can ask again.
    tree.children![0]!.newChildren = 'ask';
    const again = await locate(
      { 'Takeout/YouTube/history/watch-history.json': WATCH, 'Takeout/YouTube/history/new-file.json': '[]' },
      tree,
    );
    expect(again.reads.sort()).toEqual(['Takeout/YouTube/history/new-file.json', 'Takeout/YouTube/history/watch-history.json']);
  });

  it('reads unknown parts where the tree asks about new children', async () => {
    const { result, reads } = await locate(
      { 'Takeout/YouTube/history/watch-history.json': WATCH, 'Takeout/Drive/notes.txt': 'notes' },
      takeoutTree({ newChildren: undefined }),
    );
    expect(result.status).toBe('found');
    expect(reads).toContain('Takeout/Drive/notes.txt');
  });
});

describe('looking for the export inside a bigger upload', () => {
  it('finds the export folder by name and never opens anything else', async () => {
    const { result, reads } = await locate(
      {
        'Downloads/taxes 2023.pdf': 'pdf',
        'Downloads/photos/holiday.jpg': 'jpg',
        'Downloads/watch-history.json': WATCH,
        'Downloads/old/Takeout/YouTube/history/watch-history.json': WATCH,
      },
      takeoutTree(),
    );
    if (result.status !== 'found') throw new Error(result.status);
    expect(reads).toEqual(['Downloads/old/Takeout/YouTube/history/watch-history.json']);
  });

  it('opens a matching archive', async () => {
    const { result } = await locate(
      {
        'Downloads/report.docx': 'doc',
        'Downloads/takeout-20240101T000000Z-001.zip': zip({ 'Takeout/YouTube/history/watch-history.json': WATCH }),
        'Downloads/other.zip': zip({ 'Takeout/YouTube/history/watch-history.json': WATCH }),
      },
      takeoutTree(),
    );
    expect(result.status).toBe('found');
  });

  it('lets the participant choose when several fit, and adds folders together', async () => {
    const { result } = await locate(
      {
        'Downloads/takeout-001.zip': zip({ 'Takeout/YouTube/history/watch-history.json': WATCH }),
        'Downloads/takeout-002.zip': zip({ 'Takeout/YouTube/history/watch-history.json': WATCH }),
      },
      takeoutTree(),
    );
    if (result.status !== 'choose') throw new Error(result.status);
    expect(result.multiple).toBe(true);
    expect(result.choices.map((c) => c.path)).toEqual([
      'Downloads/takeout-001.zip',
      'Downloads/takeout-002.zip',
    ]);
    const chosen = await result.choose([0, 1]);
    if (chosen.status !== 'found') throw new Error(chosen.status);
    expect(chosen.root.files).toHaveLength(2);
  });

  it('asks for one file when several files fit a file tree', async () => {
    const { result } = await locate(
      {
        'export/watch-history.json': WATCH,
        'export/watch-history (1).json': WATCH,
        'export/watch-history-notes.json': NOTES,
      },
      fileTree(),
    );
    if (result.status !== 'choose') throw new Error(result.status);
    expect(result.multiple).toBe(false);
    expect(result.choices.map((c) => c.path).sort()).toEqual(['export/watch-history (1).json', 'export/watch-history.json']);
    await expect(result.choose([0, 1])).rejects.toThrow();
    expect((await result.choose([1])).status).toBe('found');
  });

  it('opens nothing in a folder without a matching name', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) files[`C/Users/me/Documents/file${i}.json`] = WATCH;
    const { result, reads } = await locate(files, takeoutTree());
    expect(result.status).toBe('no-fit');
    expect(reads).toEqual([]);
  });

  it('does not search without patterns', async () => {
    const { result } = await locate(
      { 'Downloads/Takeout/YouTube/history/watch-history.json': WATCH, 'Downloads/x.txt': 'x' },
      takeoutTree({ find: undefined }),
    );
    expect(result.status).toBe('no-fit');
  });
});

describe('fixed limits', () => {
  it('stops at too many files, too many candidates, or too many bytes', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`Downloads/x${i}/Takeout/a.txt`] = 'a';
    // Counted while listing names, before any file is opened.
    const { list, reads } = upload(many);
    await expect(UploadListing.open(list, { ...UPLOAD_LIMITS, maxFiles: 10 })).rejects.toThrow('too-many-files');
    expect(reads).toEqual([]);
    expect((await locate(many, takeoutTree(), { ...UPLOAD_LIMITS, maxCandidates: 5 })).result.status).toBe(
      'too-many-candidates',
    );
    const big = await locate(
      { 'Takeout/YouTube/history/watch-history.json': WATCH },
      takeoutTree(),
      { ...UPLOAD_LIMITS, maxReadBytes: 10 },
    );
    expect(big.result.status).toBe('too-big');
  });
});

describe('required parts', () => {
  const required = () => {
    const tree = takeoutTree();
    const history = tree.children![0]!.children![0]!;
    history.children![0]!.children![0]!.children![1]!.required = true; // [*]/time
    return tree;
  };

  it('fit when present by any name', async () => {
    const { result } = await locate({ 'Takeout/YouTube en YouTube Music/history/kijkgeschiedenis.json': WATCH }, required());
    expect(result.status).toBe('found');
  });

  it('do not fit when missing, also inside a file', async () => {
    const noTime = JSON.stringify([{ title: 'Watched a video' }]);
    const { result } = await locate({ 'Takeout/YouTube/history/watch-history.json': noTime }, required());
    expect(result.status).toBe('no-fit');
  });

  it('are checked on names before anything is opened', async () => {
    const tree = takeoutTree();
    tree.children!.push(node('blob', ['archive_browser.html'], { required: true }));
    const { result, reads } = await locate({ 'Takeout/YouTube/history/watch-history.json': WATCH }, tree);
    expect(result.status).toBe('no-fit');
    expect(reads).toEqual([]);
  });

  it('inside an ignored folder are still read to check them', async () => {
    const tree = takeoutTree();
    tree.children![1]!.children![0]!.required = true;
    const { result, reads } = await locate(
      { 'Takeout/YouTube/history/watch-history.json': WATCH, 'Takeout/Mail/All mail.mbox': 'x' },
      tree,
    );
    expect(result.status).toBe('found');
    expect(reads).toContain('Takeout/Mail/All mail.mbox');
  });
});

describe('without a project tree', () => {
  it('takes a file as it is, a folder as it is, and steps into an archive once', async () => {
    const root = async (files: Record<string, string | Uint8Array>) => {
      const listing = await UploadListing.open(upload(files).list);
      return readSpot(listing, await defaultRoot(listing));
    };
    expect((await root({ 'x.json': WATCH })).tree.kind).toBe('list');
    expect(names((await root({ 'Takeout/YouTube/a.json': WATCH })).tree)).toEqual(['YouTube']);
    expect(names((await root({ 't.zip': zip({ 'Takeout/YouTube/a.json': WATCH }) })).tree)).toEqual(['YouTube']);
    expect((await root({ 't.zip': zip({ 'user_data_tiktok.json': NOTES }) })).tree.kind).toBe('map');
    // Noise from macOS and Windows is never part of it.
    expect(names((await root({ 'f/a.json': WATCH, 'f/.DS_Store': 'x', 'f/__MACOSX/a.json': 'x' })).tree)).toEqual(['a.json']);
  });

  it('keeps the name when asked, for the YAML importers', async () => {
    const listing = await UploadListing.open(upload({ 'watch-history.json': WATCH }).list);
    const read = await readSpot(listing, { kind: 'folder', path: '' }, { name: listing.name });
    expect(read.tree).toMatchObject({ kind: 'dir', name: 'watch-history.json' });
  });
});

describe('find patterns', () => {
  it('must say something about the name', () => {
    expect(findPatternProblem('Takeout')).toBeUndefined();
    expect(findPatternProblem('watch-history*.json')).toBeUndefined();
    expect(findPatternProblem('*kijk*')).toBeUndefined();
    expect(findPatternProblem('*')).toBeDefined();
    expect(findPatternProblem('*.json')).toBeDefined();
    expect(findPatternProblem('a*.*')).toBeDefined();
    expect(findPatternProblem('Takeout/YouTube')).toBeDefined();
    expect(findPatternProblem(' ')).toBeDefined();
  });
});
