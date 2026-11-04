import {
  effectiveStates,
  ignoreOverrides,
  mergeNodes,
  mergeShape,
  parseImporterFile,
  parseStructureFile,
  projectTreeFromShape,
  setDecision,
  seenTogether,
  setKeysAreData,
  suggestAfterMerge,
  suggestMerges,
  getNode,
  isDecidable,
  type ImporterEntry,
  type MergeSuggestion,
  type ImporterFile,
  type LeafDecision,
  type NodePath,
  type ProjectNode,
  type Shape,
  type StructureFile,
} from '@combray/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { examplePackages } from '@combray/importers';

import { Dropzone, fromInput } from '../components/Dropzone';
import type { ImportProgress, Upload } from '../worker/api';
import type { FieldValues as FieldValuesSummary, PackageStore, PreviewTable, StoredPackage, StudioExport } from './api';
import { addExport, studio } from './client';
import { DecisionTree } from './DecisionTree';
import {
  asParticipantsSee,
  countDecisions,
  decideBelow,
  fromFiles,
  pathKey,
  patchNode,
  SHORTCUT_DECISIONS,
  toFiles,
  undecidedBelow,
  type NodePatch,
  type Shortcut,
} from './model';
import { download, loadView, VIEW_KEY } from './draft';
import { NodeDetails, type DetailSection } from './NodeDetails';
import { Help, Popover } from './Popover';
import { Suggestions } from './Suggestions';

const PREVIEW_ROWS = 25;
const PREVIEW_DELAY_MS = 300;
/** How many of a field's most common values the tree editor shows. */
const FIELD_VALUES = 8;
/** How many common values each row of the tree shows. */
const ROW_EXAMPLES = 2;

import { ChartBuilder } from './ChartBuilder';
import { Preview } from './Preview';

const samePair = (a: Pick<MergeSuggestion, 'from' | 'into'>, b: Pick<MergeSuggestion, 'from' | 'into'>) =>
  pathKey(a.from) === pathKey(b.from) && pathKey(a.into) === pathKey(b.into);

/** The tabs of the tree editor. */
const STUDIO_SECTIONS = ['packages', 'decisions', 'preview', 'chart', 'files'] as const;
type StudioSection = (typeof STUDIO_SECTIONS)[number];

/** Ancestors of a path, to open them in the tree. */
const ancestorsOf = (path: NodePath) => path.slice(0, -1).map((_, i) => pathKey(path.slice(0, i + 1)));

/** Where the tree being edited is kept: the project's draft on the server, or this browser. */
export interface DraftStore {
  initial: { tree?: ProjectNode; pending: ImporterEntry[] };
  save(tree: ProjectNode | undefined, pending: ImporterEntry[]): void;
}

/**
 * The tree editor for one platform: load data donation packages (your own, or a synthetic example),
 * decide per node what happens to it, and see the result as participants would. Packages stay in
 * the studio worker's memory and are dropped when this closes; only the project tree (structure
 * and settings) is saved, through `draft`.
 */
export function Studio({
  title,
  header,
  draft,
  pack,
  packages,
  intro = true,
}: {
  title?: string;
  header?: ReactNode;
  draft: DraftStore;
  pack?: string;
  /** Where the platform's test packages are kept; without it, every package is temporary. */
  packages?: PackageStore;
  /** Explain what the editor is for (the practice page has its own introduction). */
  intro?: boolean;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [initial] = useState(() => draft.initial);
  const [tree, setTree] = useState<ProjectNode | undefined>(initial.tree);
  const [pending, setPending] = useState<ImporterEntry[]>(initial.pending);
  const [exports, setExports] = useState<StudioExport[]>([]);
  /** The shapes of the loaded exports: what each one has, to tell which nodes occur together. */
  const [shapes, setShapes] = useState<Map<number, Shape>>(new Map());
  const [selected, setSelected] = useState<NodePath>();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [onlyUndecided, setOnlyUndecided] = useState(false);
  const [{ view, hideIgnored }, setViewSettings] = useState(loadView);
  const [progress, setProgress] = useState<ImportProgress>();
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const [preview, setPreview] = useState<PreviewTable[]>([]);
  /** The one package "view as participant" shows; none: the structure with placeholders. */
  const [previewSource, setPreviewSource] = useState<number>();
  const [suggestions, setSuggestions] = useState<MergeSuggestion[]>([]);
  const [fieldValues, setFieldValues] = useState<FieldValuesSummary>();
  const fileInput = useRef<HTMLInputElement>(null);
  const platformButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<DetailSection>('values');
  /** Test packages kept with the platform, and the structures they have. */
  const [stored, setStored] = useState<StoredPackage[]>([]);
  const [storedShapes, setStoredShapes] = useState<Shape[]>([]);
  /** Loaded packages that are kept with the platform: export id to package id. */
  const [storedOf, setStoredOf] = useState<Map<number, string>>(new Map());
  const [keepValues, setKeepValues] = useState(false);
  const [loadingKept, setLoadingKept] = useState(false);
  const [tab, setTab] = useState<StudioSection>(initial.tree ? 'decisions' : 'packages');

  // The first package gives a tree: go on to deciding what happens to it.
  const hadTree = useRef(initial.tree !== undefined);
  useEffect(() => {
    if (tree && !hadTree.current) setTab('decisions');
    hadTree.current = tree !== undefined;
  }, [tree]);

  // Save changes, not the tree as it was loaded (saving marks the draft as changed).
  const loaded = useRef(true);
  const store = useRef(draft);
  useEffect(() => {
    if (loaded.current) {
      loaded.current = false;
      return;
    }
    store.current.save(tree, pending);
  }, [tree, pending]);

  // The packages loaded here belong to this platform: drop them from the worker when it closes.
  const loadedIds = useRef<number[]>([]);
  useEffect(() => {
    loadedIds.current = exports.map((e) => e.id);
  }, [exports]);
  useEffect(
    () => () => {
      for (const id of loadedIds.current) void studio.removeExport(id);
    },
    [],
  );

  const examples = useMemo(() => examplePackages.filter((e) => !pack || e.pack === pack), [pack]);
  const [loadingExample, setLoadingExample] = useState<string>();

  async function addExample(id: string): Promise<number | undefined> {
    const example = examples.find((e) => e.id === id);
    if (!example) return undefined;
    setLoadingExample(id);
    try {
      const files = await example.load();
      return await addFiles(files.map((f) => ({ file: new File([f.text], f.path.split('/').pop() ?? f.path), path: f.path })));
    } finally {
      setLoadingExample(undefined);
    }
  }
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ view, hideIgnored }));
    } catch {
      // A convenience only.
    }
  }, [view, hideIgnored]);

  useEffect(() => {
    if (!tree) return setPreview([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      void studio.preview(asParticipantsSee(tree), PREVIEW_ROWS, previewSource).then((tables) => {
        if (!cancelled) setPreview(tables);
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tree, previewSource]);

  // Packages kept with the platform: their structures for the merge check, and their values loaded
  // into this tab.
  const refreshStored = useCallback(async () => {
    if (!packages) return [];
    const list = await packages.list();
    setStored(list.packages);
    setStoredShapes(list.shapes.map((s) => s.shape));
    return list.packages;
  }, [packages]);
  useEffect(() => {
    if (!packages) return;
    let cancelled = false;
    void (async () => {
      setLoadingKept(true);
      try {
        for (const kept of (await refreshStored()).filter((p) => p.has_data)) {
          const tree = await packages.data(kept.id);
          if (cancelled) return;
          const { export: info } = await studio.addTree(kept.name, tree);
          setExports((e) => [...e, info]);
          setStoredOf((m) => new Map(m).set(info.id, kept.id));
        }
      } catch {
        if (!cancelled) setMessage({ text: t('studio.kept.loadFailed'), error: true });
      } finally {
        if (!cancelled) setLoadingKept(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packages, refreshStored, t]);

  // A few common values per field, from all loaded packages, shown on the rows of the tree.
  const [rowValues, setRowValues] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!tree || exports.length === 0) return setRowValues({});
    let cancelled = false;
    const timer = setTimeout(() => {
      const paths: NodePath[] = [];
      const visit = (node: ProjectNode, path: NodePath) => {
        if (isDecidable(node) && path.length > 0) paths.push(path);
        if (node.lifter === undefined) for (const child of node.children ?? []) visit(child, [...path, child.name]);
      };
      visit(tree, []);
      void studio.examples(tree, paths, ROW_EXAMPLES).then((found) => {
        if (!cancelled) setRowValues(found);
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tree, exports]);

  // A package that is removed is no longer shown.
  useEffect(() => {
    if (previewSource !== undefined && !exports.some((e) => e.id === previewSource)) setPreviewSource(undefined);
  }, [exports, previewSource]);

  // What the selected field holds in the loaded test packages.
  useEffect(() => {
    setFieldValues(undefined);
    const node = tree && selected && getNode(tree, selected);
    if (!tree || !selected || !node || !isDecidable(node) || exports.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void studio.fieldValues(tree, selected, FIELD_VALUES).then((values) => {
        if (!cancelled) setFieldValues(values);
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tree, selected, exports]);

  // Nodes that occur together in a loaded export are different nodes: never suggest merging them.
  const together = useCallback(
    (from: NodePath, into: NodePath) => (tree ? seenTogether(tree, [...shapes.values(), ...storedShapes], from, into) : 0),
    [tree, shapes, storedShapes],
  );
  const shownSuggestions = useMemo(
    () => suggestions.filter((s) => together(s.from, s.into) === 0),
    [suggestions, together],
  );

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

  /** Load a package; returns its id, or that of the same package loaded before. */
  async function addFiles(uploads: Upload[], keep = false): Promise<number | undefined> {
    if (uploads.length === 0) return undefined;
    setMessage(undefined);
    setProgress({ step: 'looking' });
    // Progress comes from the worker on its own channel, and can arrive after the result: once
    // this upload is finished, late reports must not make the workspace look busy again.
    let finished = false;
    try {
      const { export: info, shape } = await addExport(uploads, (p) => {
        if (!finished) setProgress(p);
      });
      // A structure counts once: the same package again adds nothing, and another package with
      // the same structure adds values but nothing to the tree.
      const structure = JSON.stringify(shape);
      const same = exports.find((e) => JSON.stringify(shapes.get(e.id)) === structure);
      if (same && same.name === info.name) {
        await studio.removeExport(info.id);
        setMessage({ text: t('studio.sameAgain', { name: same.name }) });
        return same.id;
      }
      setExports((e) => [...e, info]);
      const kept = packages ? await keepPackage(info, shape, keep) : undefined;
      if (same) {
        setMessage({ text: kept ?? t('studio.sameStructure', { name: same.name }) });
        return info.id;
      }
      setShapes((m) => new Map(m).set(info.id, shape));
      if (tree) {
        setSuggestions((s) => [...s, ...suggestMerges(tree, shape)]);
        const merged = mergeShape(tree, shape);
        settle(merged.tree, pending);
        setMessage({ text: [t('studio.added', { count: merged.added.length }), kept].filter(Boolean).join(' ') });
      } else {
        settle(projectTreeFromShape(shape), pending);
        setOpen(new Set(shape.children?.map((c) => pathKey([c.name])) ?? []));
        setMessage({ text: [t('studio.started'), kept].filter(Boolean).join(' ') });
      }
      return info.id;
    } catch (error) {
      // Combray's fixed limits apply to the researcher's own exports too.
      const problem = error instanceof Error && ['too-many-files', 'too-big'].includes(error.message) ? error.message : undefined;
      setMessage({ text: problem ? t(`studio.problem.${problem}`) : t('import.failed'), error: true });
      return undefined;
    } finally {
      finished = true;
      setProgress(undefined);
    }
  }

  /**
   * Keep a package's structure with the platform, and its values when the researcher says so.
   * Returns what to tell them; a failure leaves the package loaded in this tab only.
   */
  async function keepPackage(info: StudioExport, shape: Shape, keep: boolean): Promise<string> {
    try {
      const data = keep ? await studio.exportTree(info.id) : undefined;
      const saved = await packages!.add(info.name, shape, data);
      if (keep) setStoredOf((m) => new Map(m).set(info.id, saved.id));
      await refreshStored();
      return keep ? t('studio.kept.savedWithValues') : saved.new_structure ? t('studio.kept.savedStructure') : t('studio.kept.knownStructure');
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : '';
      if (code === 'too_big' || code === 'too_large') return t('studio.kept.too_big');
      return code === 'too_many' ? t('studio.kept.too_many') : t('studio.kept.saveFailed');
    }
  }

  async function removeStored(id: string, name: string) {
    if (!packages || !window.confirm(t('studio.kept.confirmRemove', { name }))) return;
    try {
      await packages.remove(id);
    } catch {
      setMessage({ text: t('studio.kept.saveFailed'), error: true });
      return;
    }
    for (const [exportId, packageId] of storedOf) if (packageId === id) await removeExport(exportId);
    await refreshStored();
  }

  async function removeExport(id: number) {
    setStoredOf((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
    await studio.removeExport(id);
    setExports((e) => e.filter((x) => x.id !== id));
    setShapes((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
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
      if (structure && tree) {
        setSuggestions((s) => [...s, ...suggestMerges(tree, structure.root)]);
        next = mergeShape(next, structure.root).tree;
      }
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
    setSuggestions([]);
  }

  function decide(path: NodePath, decision: LeafDecision) {
    if (!tree) return;
    const node = getNode(tree, path);
    if (!node) return;
    if (!isDecidable(node) && decision !== 'ignore' && decision !== 'undecided') return;
    const overridden = decision === 'ignore' ? ignoreOverrides(tree, path).length : 0;
    if (overridden > 0 && !window.confirm(t('studio.confirmIgnore', { count: overridden }))) return;
    setTree(setDecision(tree, path, decision));
  }

  const actions = {
    select: (path: NodePath) => setSelected(path),
    close: () => setSelected(undefined),
    decide,
    decideBelow: (path: NodePath, decision: 'show' | 'donate' | 'undecided', undecidedOnly: boolean) =>
      setBelow(path, decision, undecidedOnly),
    toggleOpen: (key: string) =>
      setOpen((o) => {
        const next = new Set(o);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    shortcut: (path: NodePath, key: Shortcut) => {
      const node = tree && getNode(tree, path);
      if (!node) return;
      const decision = SHORTCUT_DECISIONS[key];
      // On inner nodes, 2 switches ignore on and off.
      if (!isDecidable(node)) {
        if (decision === 'ignore') decide(path, node.decision === 'ignore' ? 'undecided' : 'ignore');
        return;
      }
      decide(path, decision);
    },
  };

  function setBelow(path: NodePath, decision: 'show' | 'donate' | 'undecided', undecidedOnly: boolean) {
    if (tree) setTree(decideBelow(tree, path, decision, undecidedOnly));
  }

  function patch(path: NodePath, change: NodePatch) {
    if (tree) setTree(patchNode(tree, path, change));
  }

  function keysAreData(path: NodePath) {
    if (!tree || !window.confirm(t('studio.confirmKeys'))) return;
    const result = setKeysAreData(tree, path);
    setTree(result.tree);
    setSelected(path);
    setMessage({ text: t('studio.merged', { count: result.conflicts.length }) });
  }

  function merge(from: NodePath, into: NodePath) {
    if (!tree) return;
    const count = together(from, into);
    if (count > 0) {
      setMessage({ text: t('studio.mergeTogether', { count }), error: true });
      return;
    }
    try {
      const result = mergeNodes(tree, from, into);
      // What was inside both now sits side by side: suggest pairs there next.
      const next = suggestAfterMerge(tree, from, into);
      setSuggestions((s) =>
        [...next, ...s.filter((x) => !samePair(x, { from, into }))].filter(
          (x) => getNode(result.tree, x.from) && getNode(result.tree, x.into),
        ),
      );
      setTree(result.tree);
      setSelected(into);
      setOpen((o) => new Set([...o, ...ancestorsOf(into)]));
      setMessage({ text: t('studio.merged', { count: result.conflicts.length }) });
    } catch (error) {
      setMessage({ text: (error as Error).message, error: true });
    }
  }

  const busy = progress !== undefined;
  const details = (path: NodePath) =>
    tree ? (
      <NodeDetails
        tree={tree}
        path={path}
        section={section}
        onSection={setSection}
        values={fieldValues}
        hasPackages={exports.length > 0}
        onPatch={patch}
        onMerge={merge}
        onKeysAreData={keysAreData}
        onClose={() => setSelected(undefined)}
      />
    ) : null;
  const needsPackage = (
    <p className="meta">
      {t('studio.tabs.needsPackage')}{' '}
      <button type="button" className="link-button" onClick={() => setTab('packages')}>
        {t('studio.tabs.toPackages')}
      </button>
    </p>
  );

  return (
    <div className="studio">
      {title && <h1>{title}</h1>}
      {header}
      {intro && <p>{t('studio.intro')}</p>}

      {tree && (
        <p className={`data-status ${exports.length > 0 ? 'with-data' : 'structure-only'}`}>
          <strong className="data-status-badge">
            {exports.length > 0 ? t('studio.dataStatus.withData') : t('studio.dataStatus.structureOnly')}
          </strong>{' '}
          {exports.length > 0
            ? [
                exports.some((e) => storedOf.has(e.id)) &&
                  t('studio.dataStatus.keptHelp', { names: exports.filter((e) => storedOf.has(e.id)).map((e) => e.name).join(', ') }),
                exports.some((e) => !storedOf.has(e.id)) &&
                  t('studio.dataStatus.temporaryHelp', { names: exports.filter((e) => !storedOf.has(e.id)).map((e) => e.name).join(', ') }),
              ]
                .filter(Boolean)
                .join(' ')
            : t('studio.dataStatus.structureOnlyHelp')}
          {exports.length === 0 && tab !== 'packages' && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={() => setTab('packages')}>
                {t('studio.dataStatus.load')}
              </button>
            </>
          )}
        </p>
      )}

      <div className="tabs" role="tablist" aria-label={t('studio.tabs.label')}>
        {STUDIO_SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`studio-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`studio-panel-${id}`}
            onClick={() => {
              setTab(id);
              setMessage(undefined);
            }}
          >
            {t(`studio.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div aria-live="polite">
        {progress && <p className="message">{t(`import.step.${progress.step}`)}</p>}
        {message && (
          <p className={`message${message.error ? ' error' : ''}`} role={message.error ? 'alert' : undefined}>
            {message.text}
          </p>
        )}
      </div>

      <div role="tabpanel" id={`studio-panel-${tab}`} aria-labelledby={`studio-tab-${tab}`}>
        {tab === 'packages' && (
          <>
            <section className="card">
              <h3>{t('studio.kept.addTitle')}</h3>
              <p className="meta">{packages ? t('studio.kept.addIntro') : t('studio.exportsIntro')}</p>
              <Dropzone busy={busy} onFiles={async (files) => void (await addFiles(files, keepValues))} />
              {packages && (
                <div className="section-head check-row">
                  <label className="check">
                    <input type="checkbox" checked={keepValues} onChange={(e) => setKeepValues(e.target.checked)} />
                    {t('studio.kept.keepValues')}
                  </label>
                  <Help topic={t('studio.kept.keepValues')}>{t('studio.kept.keepValuesHelp')}</Help>
                </div>
              )}
              {examples.length > 0 && (
                <div className="examples">
                  <p className="meta">{t('studio.examplesIntro')}</p>
                  <ul className="example-list">
                    {examples.map((e) => (
                      <li key={e.id}>
                        <button type="button" className="button quiet" disabled={busy} onClick={() => void addExample(e.id)}>
                          {loadingExample === e.id ? t('studio.examplesLoading') : e.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            {packages && (
              <section className="card">
                <h3>{t('studio.kept.title')}</h3>
                {loadingKept && <p className="meta">{t('studio.kept.loading')}</p>}
                {stored.length === 0 ? (
                  <p className="meta">{t('studio.kept.none')}</p>
                ) : (
                  <ul className="export-list">
                    {stored.map((p) => (
                      <li key={p.id}>
                        <span>{p.name}</span>
                        <span className="meta">
                          {' · '}
                          {p.has_data ? t('studio.kept.withValues', { size: megabytes(p.data_bytes) }) : t('studio.kept.structureOnly')}
                          {' · '}
                          {t('studio.kept.added', { date: new Date(p.added * 1000).toLocaleDateString('en-GB'), by: p.added_by ?? '–' })}
                        </span>
                        <button type="button" className="link-button" onClick={() => void removeStored(p.id, p.name)}>
                          {t('studio.remove')}
                          <span className="visually-hidden"> {p.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {exports.some((e) => !storedOf.has(e.id)) && (
              <section className="card">
                <h3>{t('studio.kept.temporaryTitle')}</h3>
                <p className="meta">{t('studio.kept.temporaryIntro')}</p>
                <ul className="export-list">
                  {exports
                    .filter((e) => !storedOf.has(e.id))
                    .map((e) => (
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
              </section>
            )}
          </>
        )}

        {tab === 'decisions' &&
          (tree && counts ? (
            <>
              <Suggestions
                suggestions={shownSuggestions}
                onMerge={(s) => merge(s.from, s.into)}
                onDismiss={(s) => setSuggestions((all) => all.filter((x) => !samePair(x, s)))}
                onShow={(path) => {
                  setViewSettings({ view: 'tree', hideIgnored });
                  setOpen((o) => new Set([...o, ...ancestorsOf(path)]));
                  setSelected(path);
                }}
              />
              <section className="studio-section">
                <TemporaryUpload busy={busy} keeps={packages !== undefined} onFiles={async (files) => void (await addFiles(files))} />
                <p className="meta">
                  {t('studio.counts', { ...counts })}
                  {counts.undecided > 0 && ` ${t('studio.undecidedLeft', { count: counts.undecided })}`}
                </p>
                <div className="tree-controls">
                  <span className="segmented" role="group" aria-label={t('studio.viewLabel')}>
                    {(['fields', 'tree'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="seg"
                        aria-pressed={view === v}
                        onClick={() => setViewSettings({ view: v, hideIgnored })}
                      >
                        {t(`studio.view.${v}`)}
                      </button>
                    ))}
                  </span>
                  <label className="check">
                    <input type="checkbox" checked={onlyUndecided} onChange={(e) => setOnlyUndecided(e.target.checked)} />
                    {t('studio.onlyUndecided')}
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={hideIgnored}
                      onChange={(e) => setViewSettings({ view, hideIgnored: e.target.checked })}
                    />
                    {t('studio.hideIgnored')}
                  </label>
                  <span className="decision-menu-anchor">
                    <button
                      ref={platformButton}
                      type="button"
                      className="button quiet"
                      aria-expanded={selected?.length === 0}
                      aria-haspopup="dialog"
                      onClick={() => setSelected(selected?.length === 0 ? undefined : [])}
                    >
                      {t('studio.platformSettings')}
                    </button>
                    {selected?.length === 0 && (
                      <Popover
                        label={t('studio.platformSettings')}
                        anchor={platformButton}
                        onClose={() => setSelected(undefined)}
                        className="row-popover platform-popover"
                      >
                        {details([])}
                      </Popover>
                    )}
                  </span>
                </div>
                <p className="meta">{t(`studio.viewHelp.${view}`)}</p>
                <DecisionTree
                  tree={tree}
                  states={states}
                  undecided={undecided}
                  onlyUndecided={onlyUndecided}
                  hideIgnored={hideIgnored}
                  view={view}
                  open={open}
                  actions={actions}
                  details={details}
                  examples={rowValues}
                  {...(selected && selected.length > 0 ? { selected } : {})}
                />
              </section>
            </>
          ) : (
            needsPackage
          ))}

        {tab === 'preview' &&
          (tree ? (
            <section className="studio-section">
              <p className="meta">{t('studio.previewIntro')}</p>
              <label className="field preview-source">
                <span>{t('studio.previewSource.label')}</span>
                <select
                  value={previewSource ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value.startsWith('example:')) {
                      void addExample(value.slice('example:'.length)).then((id) => id !== undefined && setPreviewSource(id));
                    } else {
                      setPreviewSource(value === '' ? undefined : Number(value));
                    }
                  }}
                >
                  <option value="">{t('studio.previewSource.structure')}</option>
                  {[
                    { label: t('studio.previewSource.kept'), list: exports.filter((e) => storedOf.has(e.id)) },
                    { label: t('studio.previewSource.temporary'), list: exports.filter((e) => !storedOf.has(e.id)) },
                  ]
                    .filter((g) => g.list.length > 0)
                    .map((g) => (
                      <optgroup key={g.label} label={g.label}>
                        {g.list.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  {examples.length > 0 && (
                    <optgroup label={t('studio.previewSource.examples')}>
                      {examples.map((e) => (
                        <option key={e.id} value={`example:${e.id}`}>
                          {e.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              <TemporaryUpload busy={busy} keeps={packages !== undefined} onFiles={async (files) => {
                const id = await addFiles(files);
                if (id !== undefined) setPreviewSource(id);
              }} />
              <Preview tables={preview} hasExports={previewSource !== undefined} />
            </section>
          ) : (
            needsPackage
          ))}

        {tab === 'chart' &&
          (tree ? (
            <section className="studio-section">
              <p className="meta">{t('studio.chartIntro')}</p>
              <ChartBuilder tree={tree} hasExports={exports.length > 0} />
            </section>
          ) : (
            needsPackage
          ))}

        {tab === 'files' && (
          <section className="card">
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
            {pending.length > 0 && <p className="meta">{t('studio.pending', { count: pending.length })}</p>}
          </section>
        )}
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
    </div>
  );
}

const megabytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Load a package for this tab only: its values are shown here and gone on reload. Its structure
 * is still kept with the platform, like any test package's.
 */
function TemporaryUpload({ busy, keeps, onFiles }: { busy: boolean; keeps: boolean; onFiles: (files: Upload[]) => Promise<void> }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const input = useRef<HTMLInputElement>(null);
  return (
    <p className="temporary-upload">
      <button type="button" className="button quiet" disabled={busy} onClick={() => input.current?.click()}>
        {t('studio.kept.temporaryButton')}
      </button>
      <Help topic={t('studio.kept.temporaryButton')}>{keeps ? t('studio.kept.temporaryHelp') : t('studio.kept.temporaryHelpPractice')}</Help>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void onFiles(fromInput(e.target.files));
          e.target.value = '';
        }}
      />
    </p>
  );
}
