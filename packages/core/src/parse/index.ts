import { unzipSync } from 'fflate';

import type { DirNode, TreeNode } from '../tree';
import { parseCsv } from './csv';
import { parseMarkup } from './html';
import { parseJson, parseJsonLines } from './json';
import { decodeText, parseText } from './text';

export { decodeText } from './text';
export { jsonToTree } from './json';

export interface ParseOptions {
  /** Files larger than this are kept as blobs instead of parsed. Default 512 MiB. */
  maxParseBytes?: number;
  /** How deep zips inside zips are opened. Default 3. */
  maxArchiveDepth?: number;
}

export interface FileEntry {
  /** Path relative to the dropped folder or archive, with `/` separators. */
  path: string;
  bytes: Uint8Array;
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  pdf: 'application/pdf',
  vcf: 'text/vcard',
  ics: 'text/calendar',
  mbox: 'application/mbox',
};

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'log']);

// Files that are noise in archives made on macOS or Windows.
const IGNORED = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/;

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function blob(name: string, bytes: Uint8Array): TreeNode {
  return {
    kind: 'blob',
    name,
    mime: MIME[extension(name)] ?? 'application/octet-stream',
    size: bytes.byteLength,
  };
}

/** True if the bytes look like text: no NUL bytes in the first 8 KiB. */
function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

function sniffText(name: string, text: string): TreeNode {
  const start = text.trimStart().replace(/^﻿/, '')[0];
  if (start === '{' || start === '[') {
    try {
      return parseJson(name, text);
    } catch {
      // Not JSON after all; fall through.
    }
  }
  if (start === '<') return parseMarkup(name, text, /^\s*<\?xml/.test(text));
  return parseText(name, text);
}

/**
 * Parse one file into a tree. The root is named after the file. Files that cannot be parsed in
 * their declared format fall back to text lines; binaries become blobs.
 */
export function parseFile(
  name: string,
  bytes: Uint8Array,
  options: ParseOptions = {},
  depth = 0,
): TreeNode {
  const ext = extension(name);
  const maxArchiveDepth = options.maxArchiveDepth ?? 3;
  if (ext === 'zip') {
    if (depth >= maxArchiveDepth) return blob(name, bytes);
    return parseZip(name, bytes, options, depth + 1);
  }
  if (MIME[ext] || bytes.byteLength > (options.maxParseBytes ?? 512 * 1024 * 1024)) {
    return blob(name, bytes);
  }
  if (!looksLikeText(bytes)) return blob(name, bytes);
  const text = decodeText(bytes);
  try {
    switch (ext) {
      case 'json':
      case 'js':
        return parseJson(name, text);
      case 'jsonl':
      case 'ndjson':
        return parseJsonLines(name, text);
      case 'csv':
      case 'tsv':
        return parseCsv(name, text);
      case 'html':
      case 'htm':
        return parseMarkup(name, text);
      case 'xml':
        return parseMarkup(name, text, true);
      default:
        return TEXT_EXTENSIONS.has(ext) ? parseText(name, text) : sniffText(name, text);
    }
  } catch {
    return parseText(name, text);
  }
}

/** Build a directory tree from files with relative paths (a dropped folder or an archive). */
export function parseEntries(
  name: string,
  entries: FileEntry[],
  options: ParseOptions = {},
  depth = 0,
): DirNode {
  const root: DirNode = { kind: 'dir', name, children: [] };
  const dirs = new Map<string, DirNode>([['', root]]);
  const dirFor = (path: string): DirNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf('/');
    const parent = dirFor(slash < 0 ? '' : path.slice(0, slash));
    const dir: DirNode = { kind: 'dir', name: path.slice(slash + 1), children: [] };
    parent.children.push(dir);
    dirs.set(path, dir);
    return dir;
  };
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    const path = entry.path.replace(/^\/+/, '');
    if (IGNORED.test(path)) continue;
    if (path.endsWith('/')) {
      dirFor(path.slice(0, -1));
      continue;
    }
    const slash = path.lastIndexOf('/');
    const parent = dirFor(slash < 0 ? '' : path.slice(0, slash));
    parent.children.push(parseFile(path.slice(slash + 1), entry.bytes, options, depth));
  }
  return root;
}

/** Unzip an archive into a directory tree. Zips inside zips are opened too. */
export function parseZip(
  name: string,
  bytes: Uint8Array,
  options: ParseOptions = {},
  depth = 1,
): DirNode {
  const files = unzipSync(bytes);
  const entries = Object.entries(files).map(([path, data]) => ({ path, bytes: data }));
  return parseEntries(name, entries, options, depth);
}

/**
 * Merge directory trees into one, for archives split into parts (Google Takeout's
 * `takeout-…-001.zip`, `-002.zip`): directories with the same name merge, other entries are
 * kept side by side. The parts' own names are dropped. See docs/tree-decisions.md.
 */
export function mergeDirs(name: string, parts: DirNode[]): DirNode {
  const root: DirNode = { kind: 'dir', name, children: [] };
  const into = (target: DirNode, source: DirNode) => {
    for (const child of source.children) {
      const existing =
        child.kind === 'dir'
          ? target.children.find((c): c is DirNode => c.kind === 'dir' && c.name === child.name)
          : undefined;
      if (existing && child.kind === 'dir') into(existing, child);
      else target.children.push(child.kind === 'dir' ? mergeDirs(child.name, [child]) : child);
    }
  };
  for (const part of parts) into(root, part);
  return root;
}
