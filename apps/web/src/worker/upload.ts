/**
 * Reading dropped files, folders and archives into one tree. Shared by the data worker and the
 * studio worker; runs in a worker, never on the main thread.
 */
import { mergeDirs, parseEntries, parseFile, type DirNode, type FileEntry, type TreeNode } from '@combray/core';

import type { ImportProgress, SourceManifest, Upload } from './api';

export async function parseUpload(
  uploads: Upload[],
  onProgress: (p: ImportProgress) => void,
): Promise<{ tree: TreeNode; source: SourceManifest['source'] }> {
  const first = uploads[0];
  if (!first) throw new Error('no files');
  if (uploads.length === 1 && !first.path.includes('/')) {
    onProgress({ step: 'reading', files: 1 });
    const bytes = new Uint8Array(await first.file.arrayBuffer());
    onProgress({ step: 'parsing' });
    const tree = parseFile(first.file.name, bytes);
    return { tree, source: tree.kind === 'dir' ? 'archive' : 'file' };
  }
  // Several zips (a Takeout split into parts) become one archive.
  if (uploads.every((u) => !u.path.includes('/') && /\.zip$/i.test(u.file.name))) {
    const parts: DirNode[] = [];
    for (const { file } of uploads) {
      const tree = parseFile(file.name, new Uint8Array(await file.arrayBuffer()));
      if (tree.kind === 'dir') parts.push(tree);
      onProgress({ step: 'reading', files: parts.length });
    }
    onProgress({ step: 'parsing' });
    return { tree: mergeDirs(`${uploads.length} archives`, parts), source: 'archive' };
  }
  const entries: FileEntry[] = [];
  for (const { file, path } of uploads) {
    entries.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
    onProgress({ step: 'reading', files: entries.length });
  }
  // A picked folder gives paths like `Takeout/YouTube/...`: use the folder as the root.
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  const [top] = tops;
  const nested = tops.size === 1 && top !== undefined && entries.every((e) => e.path.includes('/'));
  const name = nested ? top : `${uploads.length} files`;
  const stripped = nested ? entries.map((e) => ({ ...e, path: e.path.slice(top.length + 1) })) : entries;
  onProgress({ step: 'parsing' });
  return { tree: parseEntries(name, stripped), source: 'folder' };
}
