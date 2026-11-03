/**
 * What the workspace keeps in this browser: the draft project tree (structure and settings,
 * never values from exports) and view preferences. Plus saving files to disk.
 */
import {
  parseImporterFile,
  parseStructureFile,
  type ImporterEntry,
  type ImporterFile,
  type ProjectNode,
  type StructureFile,
} from '@combray/core';

import type { TreeView } from './DecisionTree';
import { fromFiles, toFiles } from './model';

const DRAFT_KEY = 'combray:studio:draft';

/** Each project keeps its own draft; the workspace without accounts keeps one. */
const draftKey = (projectId?: string) => (projectId ? `${DRAFT_KEY}:${projectId}` : DRAFT_KEY);
export const VIEW_KEY = 'combray:studio:view';

export function loadView(): { view: TreeView; hideIgnored: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as { view?: unknown; hideIgnored?: unknown };
    return { view: saved.view === 'tree' ? 'tree' : 'fields', hideIgnored: saved.hideIgnored === true };
  } catch {
    return { view: 'fields', hideIgnored: false };
  }
}

interface Draft {
  structure: StructureFile;
  importer: ImporterFile;
}

/** The draft holds structure and settings only, never values from the exports. */
export function loadDraft(projectId?: string): { tree?: ProjectNode; pending: ImporterEntry[] } {
  try {
    const raw = localStorage.getItem(draftKey(projectId));
    if (!raw) return { pending: [] };
    const draft = JSON.parse(raw) as Draft;
    return fromFiles(parseStructureFile(draft.structure), parseImporterFile(draft.importer));
  } catch {
    return { pending: [] };
  }
}

export function saveDraft(projectId: string | undefined, tree: ProjectNode | undefined, pending: ImporterEntry[]): void {
  try {
    if (!tree) localStorage.removeItem(draftKey(projectId));
    else localStorage.setItem(draftKey(projectId), JSON.stringify(toFiles(tree, pending)));
  } catch {
    // Without local storage the draft lives as long as the tab.
  }
}

export function download(name: string, content: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

