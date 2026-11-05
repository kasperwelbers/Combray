/** What the tree editor keeps in this browser (view preferences), and saving files to disk. */
import type { TreeView } from './DecisionTree';

export const VIEW_KEY = 'combray:studio:view';

export function loadView(): { view: TreeView; hideIgnored: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as { view?: unknown; hideIgnored?: unknown };
    return { view: saved.view === 'tree' ? 'tree' : 'named', hideIgnored: saved.hideIgnored === true };
  } catch {
    return { view: 'named', hideIgnored: false };
  }
}

/** Save JSON (or, given a string and its type, text) as a file. */
export function download(name: string, content: unknown, type?: string): void {
  const text = type === undefined ? JSON.stringify(content, null, 2) : String(content);
  const url = URL.createObjectURL(new Blob([text], { type: type ?? 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

