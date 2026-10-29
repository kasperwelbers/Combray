import {
  effectiveStates,
  ignoreOverrides,
  mergeNodes,
  mergeShape,
  parseImporterFile,
  parseStructureFile,
  projectTreeFromShape,
  setDecision,
  setTable,
  getNode,
  type ImporterEntry,
  type ImporterFile,
  type LeafDecision,
  type NodePath,
  type ProjectNode,
  type StructureFile,
} from '@combray/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Dropzone } from '../components/Dropzone';
import type { ImportProgress, Upload } from '../worker/api';
import type { PreviewTable, StudioExport } from './api';
import { addExport, studio } from './client';
import { DecisionTree } from './DecisionTree';
import { countDecisions, fromFiles, pathKey, patchNode, toFiles, undecidedBelow, type NodePatch } from './model';
import { NodePanel } from './NodePanel';
import { Preview } from './Preview';

const DRAFT_KEY = 'combray:studio:draft';
const PREVIEW_ROWS = 25;
const PREVIEW_DELAY_MS = 300;

interface Draft {
  structure: StructureFile;
  importer: ImporterFile;
}

/** The draft holds structure and settings only, never values from the exports. */
function loadDraft(): { tree?: ProjectNode; pending: ImporterEntry[] } {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return { pending: [] };
    const draft = JSON.parse(raw) as Draft;
    return fromFiles(parseStructureFile(draft.structure), parseImporterFile(draft.importer));
  } catch {
    return { pending: [] };
  }
}

function saveDraft(tree: ProjectNode | undefined, pending: ImporterEntry[]): void {
  try {
    if (!tree) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(toFiles(tree, pending)));
  } catch {
    // Without local storage the draft lives as long as the tab.
  }
}

function download(name: string, content: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Ancestors of a path, to open them in the tree. */
const ancestorsOf = (path: NodePath) => path.slice(0, -1).map((_, i) => pathKey(path.slice(0, i + 1)));

/**
 * The researcher workspace: load your own exports, decide per node what happens to it, and
 * see the result as participants would. Exports stay in the studio worker's memory; only the
 * project tree (structure and settings) is kept as a draft in this browser.
 */
export function Studio() {
  const { t } = useTranslation();
  const [initial] = useState(loadDraft);
  const [tree, setTree] = useState<ProjectNode | undefined>(initial.tree);
  const [pending, setPending] = useState<ImporterEntry[]>(initial.pending);
  const [exports, setExports] = useState<StudioExport[]>([]);
  const [selected, setSelected] = useState<NodePath>();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [onlyUndecided, setOnlyUndecided] = useState(false);
  const [progress, setProgress] = useState<ImportProgress>();
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const [preview, setPreview] = useState<PreviewTable[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => saveDraft(tree, pending), [tree, pending]);

  useEffect(() => {
    if (!tree || exports.length === 0) return setPreview([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      void studio.preview(tree, PREVIEW_ROWS).then((tables) => {
        if (!cancelled) setPreview(tables);
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tree, exports]);

  const states = useMemo(() => (tree ? effectiveStates(tree) : new Map()), [tree]);
  const undecided = useMemo(() => (tree ? undecidedBelow(tree, states) : new Map()), [tree, states]);
  const counts = useMemo(() => (tree ? countDecisions(tree, states) : undefined), [tree, states]);

  /** Apply settings that were waiting for their paths, now that the tree may have them. */
  const settle = useCallback((next: ProjectNode, waiting: ImporterEntry[]) => {
    const { structure, importer } = toFiles(next, waiting);
    const joined = fromFiles(structure, importer);
    setTree(joined.tree);
    setPending(joined.pending);
  }, []);

  async function addFiles(uploads: Upload[]) {
    if (uploads.length === 0) return;
    setMessage(undefined);
    setProgress({ step: 'reading', files: 0 });
    try {
      const { export: info, shape } = await addExport(uploads, setProgress);
      setExports((e) => [...e, info]);
      if (tree) {
        const merged = mergeShape(tree, shape);
        settle(merged.tree, pending);
        setMessage({ text: t('studio.added', { count: merged.added.length }) });
      } else {
        settle(projectTreeFromShape(shape), pending);
        setOpen(new Set(shape.children?.map((c) => pathKey([c.name])) ?? []));
        setMessage({ text: t('studio.started') });
      }
    } catch {
      setMessage({ text: t('import.failed'), error: true });
    } finally {
      setProgress(undefined);
    }
  }

  async function removeExport(id: number) {
    await studio.removeExport(id);
    setExports((e) => e.filter((x) => x.id !== id));
  }

  async function openFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setMessage(undefined);
    try {
      let structure: StructureFile | undefined;
      let importer: ImporterFile | undefined;
      for (const file of files) {
        const json = JSON.parse(await file.text()) as { format?: unknown };
        if (json.format === 'combray-structure@1') structure = parseStructureFile(json);
        else importer = parseImporterFile(json);
      }
      // An opened structure adds to the tree; an opened importer replaces the settings.
      let next = tree ?? projectTreeFromShape(structure?.root ?? { kind: 'dir', name: '' });
      if (structure && tree) next = mergeShape(next, structure.root).tree;
      const settings = importer ?? toFiles(next, pending).importer;
      const joined = fromFiles(toFiles(next, []).structure, settings);
      setTree(joined.tree);
      setPending(joined.pending);
      setMessage({ text: t('studio.opened', { count: joined.pending.length }) });
    } catch (error) {
      setMessage({ text: t('studio.openFailed', { reason: (error as Error).message }), error: true });
    }
  }

  function saveFiles() {
    if (!tree) return;
    const { structure, importer } = toFiles(tree, pending);
    download('structure.json', structure);
    download('importer.json', importer);
  }

  function startOver() {
    if (!window.confirm(t('studio.confirmStartOver'))) return;
    setTree(undefined);
    setPending([]);
    setSelected(undefined);
    setOpen(new Set());
    setMessage(undefined);
  }

  const actions = {
    select: (path: NodePath) => setSelected(path),
    toggleOpen: (path: NodePath) =>
      setOpen((o) => {
        const next = new Set(o);
        const key = pathKey(path);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    setLeaf: (path: NodePath, decision: LeafDecision) => tree && setTree(setDecision(tree, path, decision)),
    toggleIgnore: (path: NodePath) => {
      if (!tree) return;
      const node = getNode(tree, path);
      if (node?.decision === 'ignore') return setTree(setDecision(tree, path, 'undecided'));
      const overridden = ignoreOverrides(tree, path).length;
      if (overridden > 0 && !window.confirm(t('studio.confirmIgnore', { count: overridden }))) return;
      setTree(setDecision(tree, path, 'ignore'));
    },
    toggleTable: (path: NodePath) => tree && setTree(setTable(tree, path, getNode(tree, path)?.table !== true)),
  };

  function patch(path: NodePath, change: NodePatch) {
    if (tree) setTree(patchNode(tree, path, change));
  }

  function merge(from: NodePath, into: NodePath) {
    if (!tree) return;
    try {
      const result = mergeNodes(tree, from, into);
      setTree(result.tree);
      setSelected(into);
      setOpen((o) => new Set([...o, ...ancestorsOf(into)]));
      setMessage({ text: t('studio.merged', { count: result.conflicts.length }) });
    } catch (error) {
      setMessage({ text: (error as Error).message, error: true });
    }
  }

  const busy = progress !== undefined;

  return (
    <div className="studio">
      <h1>{t('studio.title')}</h1>
      <p>{t('studio.intro')}</p>

      <div className="studio-top">
        <section className="card" aria-labelledby="studio-exports">
          <h2 id="studio-exports">{t('studio.exportsTitle')}</h2>
          <p className="meta">{t('studio.exportsIntro')}</p>
          <Dropzone busy={busy} onFiles={addFiles} />
          {exports.length > 0 && (
            <ul className="export-list">
              {exports.map((e) => (
                <li key={e.id}>
                  <span>{e.name}</span>
                  <span className="meta"> · {t('datasets.items', { count: e.nodeCount })}</span>
                  <button type="button" className="link-button" onClick={() => void removeExport(e.id)}>
                    {t('studio.remove')}
                    <span className="visually-hidden"> {e.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card" aria-labelledby="studio-files">
          <h2 id="studio-files">{t('studio.filesTitle')}</h2>
          <p className="meta">{t('studio.filesIntro')}</p>
          <div className="actions">
            <button className="button quiet" type="button" onClick={() => fileInput.current?.click()}>
              {t('studio.open')}
            </button>
            <button className="button" type="button" disabled={!tree} onClick={saveFiles}>
              {t('studio.save')}
            </button>
            <button className="button danger" type="button" disabled={!tree} onClick={startOver}>
              {t('studio.startOver')}
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            multiple
            hidden
            onChange={(e) => {
              void openFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {pending.length > 0 && <p className="meta">{t('studio.pending', { count: pending.length })}</p>}
        </section>
      </div>

      <div aria-live="polite">
        {progress && <p className="message">{t(`import.step.${progress.step}`, { count: progress.files ?? 0 })}</p>}
        {message && (
          <p className={`message${message.error ? ' error' : ''}`} role={message.error ? 'alert' : undefined}>
            {message.text}
          </p>
        )}
      </div>

      {tree && counts && (
        <>
          <section aria-labelledby="studio-decisions" className="studio-section">
            <h2 id="studio-decisions">{t('studio.decisionsTitle')}</h2>
            <p className="meta">
              {t('studio.counts', { ...counts })}
              {counts.undecided > 0 && ` ${t('studio.undecidedLeft', { count: counts.undecided })}`}
            </p>
            <label className="check">
              <input type="checkbox" checked={onlyUndecided} onChange={(e) => setOnlyUndecided(e.target.checked)} />
              {t('studio.onlyUndecided')}
            </label>
            <div className="studio-grid">
              <DecisionTree
                tree={tree}
                states={states}
                undecided={undecided}
                onlyUndecided={onlyUndecided}
                open={open}
                actions={actions}
                {...(selected ? { selected } : {})}
              />
              {selected && getNode(tree, selected) ? (
                <NodePanel
                  key={pathKey(selected)}
                  tree={tree}
                  path={selected}
                  states={states}
                  onPatch={patch}
                  onMerge={merge}
                />
              ) : (
                <p className="meta">{t('studio.selectHelp')}</p>
              )}
            </div>
          </section>

          <section aria-labelledby="studio-preview" className="studio-section">
            <h2 id="studio-preview">{t('studio.previewTitle')}</h2>
            <p className="meta">{t('studio.previewIntro')}</p>
            <Preview tables={preview} hasExports={exports.length > 0} />
          </section>
        </>
      )}
    </div>
  );
}
