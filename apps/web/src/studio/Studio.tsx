import {
  addMatch,
  buildTree,
  combineConflicts,
  combineProblem,
  configOf,
  currentName,
  effectiveStates,
  emptyConfig,
  getNode,
  ignoreOverrides,
  keepNames,
  isDecidable,
  newPositions,
  correctedShape,
  parseImporterFile,
  parseStructureFile,
  remapPath,
  removeMatch,
  setDecision,
  setKeysAreData,
  splitByKey,
  suggestCombines,
  toConfig,
  type CombineSuggestion,
  type ImporterFile,
  type LeafDecision,
  type NodePath,
  type ProjectConfig,
  type ProjectNode,
  type Shape,
  type StructureFile,
} from '@combray/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { examplePackages } from '@combray/importers';

import { Dropzone, fromInput } from '../components/Dropzone';
import type { ImportProgress, Upload } from '../worker/api';
import type { FieldValues as FieldValuesSummary, PackageStore, PreviewTable, StoredPackage, StudioExport } from './api';
import { addExport, studio } from './client';
import { DecisionTree, type TreeActions } from './DecisionTree';
import { HelpButton, HelpLink } from './Help';
import { MatchDialog, type MatchHint } from './MatchDialog';
import {
  addSeen,
  asParticipantsSee,
  notSeen,
  rowInfo,
  countDecisions,
  decideBelow,
  pathKey,
  patchNode,
  SHORTCUT_DECISIONS,
  toFiles,
  undecidedBelow,
  type NodePatch,
  type RowInfo,
  type StudioDraft,
} from './model';
import { download, loadView, VIEW_KEY } from './prefs';
import { rowName, saveMatch, sharedNames, unmatch, type MatchChoice, type Renamed, type SharedName } from './naming';
import { Popover } from './Popover';
import { MorePanel, PanelHead, PlatformPanel, ReadPanel, RowsPanel, type MatchListActions, type MoreActions, type RowPanel } from './RowPanels';

const PREVIEW_ROWS = 25;
const PREVIEW_DELAY_MS = 300;
/** How many of a field's most common values the tree editor shows. */
const FIELD_VALUES = 8;
/** How many common values each row of the tree shows. */
const ROW_EXAMPLES = 2;

import { ChartBuilder } from './ChartBuilder';
import { Preview } from './Preview';

/** The studio shows rows in the order of the structure, so they stay put when matched. */
const ORDER = { structureOrder: true } as const;

/** The tabs of the tree editor. */
const STUDIO_SECTIONS = ['packages', 'decisions', 'preview', 'chart', 'files'] as const;
type StudioSection = (typeof STUDIO_SECTIONS)[number];


/** Suggestions without repeats: a pair counts once, whichever way round. */
function uniquePairs(suggestions: CombineSuggestion[]): CombineSuggestion[] {
  const seen = new Set<string>();
  return suggestions.filter((s) => {
    const key = [pathKey(s.from), pathKey(s.into)].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Open rows after an edit: the same rows, where the edit made virtual ones real. */
function remapOpen(open: Set<string>, before: ProjectNode | undefined, after: ProjectNode): Set<string> {
  if (!before) return open;
  const out = new Set<string>();
  for (const key of open) {
    const fields = key.startsWith('fields:');
    const path = JSON.parse(fields ? key.slice('fields:'.length) : key) as NodePath;
    const moved = remapPath(before, after, path);
    if (moved) out.add(fields ? `fields:${pathKey(moved)}` : pathKey(moved));
  }
  return out;
}

/** Where the configuration being edited is kept: the project's draft (on the server, or an example's). */
export interface DraftStore {
  initial: StudioDraft | undefined;
  save(draft: StudioDraft | undefined): void;
}

/**
 * The tree editor for one platform: load data donation packages (your own, or a synthetic example),
 * decide per node what happens to it, and see the result as participants would. Packages stay in
 * the studio worker's memory and are dropped when this closes; only the configuration and the
 * structures seen (never values) are saved, through `draft`.
 */
export function Studio({
  draft,
  pack,
  packages,
  onRename,
}: {
  draft: DraftStore;
  pack?: string;
  /** Where the platform's test packages are kept. */
  packages: PackageStore;
  /** Move the story's references to a renamed table or field; resolves to how many blocks changed. */
  onRename?: (renamed: Renamed) => Promise<number>;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [initial] = useState(() => draft.initial);
  /** The researcher's configuration: config nodes, with their names (ADR 0012, ADR 0013). */
  const [config, setConfig] = useState<ProjectConfig | undefined>(initial?.config);
  /** The structures seen so far, as one union: it only grows. */
  const [seen, setSeen] = useState<Shape | undefined>(initial?.seen);
  const built = useMemo(() => (config ? buildTree(config, seen, ORDER) : undefined), [config, seen]);
  const tree = built?.tree;
  const [exports, setExports] = useState<StudioExport[]>([]);
  /** The shapes of the loaded exports: what each one has, to tell which nodes occur together. */
  const [shapes, setShapes] = useState<Map<number, Shape>>(new Map());
  /** The row panel that is open: a row's match dialog or one of its settings, or the platform's. */
  const [panel, setPanel] = useState<{ path: NodePath; kind: RowPanel }>();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [onlyUndecided, setOnlyUndecided] = useState(false);
  const [{ view, hideIgnored }, setViewSettings] = useState(loadView);
  const [progress, setProgress] = useState<ImportProgress>();
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const [preview, setPreview] = useState<PreviewTable[]>([]);
  /** The one package "view as participant" shows; none: the structure with placeholders. */
  const [previewSource, setPreviewSource] = useState<number>();
  const [suggestions, setSuggestions] = useState<CombineSuggestion[]>([]);
  const [fieldValues, setFieldValues] = useState<FieldValuesSummary>();
  const fileInput = useRef<HTMLInputElement>(null);
  const platformButton = useRef<HTMLButtonElement>(null);
  /** Test packages kept with the platform, and the structures they have. */
  const [stored, setStored] = useState<StoredPackage[]>([]);
  const [storedShapes, setStoredShapes] = useState<Shape[]>([]);
  /** Loaded packages that are kept with the platform: export id to package id. */
  const [storedOf, setStoredOf] = useState<Map<number, string>>(new Map());
  const [keepValues, setKeepValues] = useState(false);
  const [loadingKept, setLoadingKept] = useState(false);
  const [tab, setTab] = useState<StudioSection>(initial ? 'decisions' : 'packages');

  /** Every structure seen one by one: the loaded packages and those kept with the platform. */
  const structures = useMemo(() => [...shapes.values(), ...storedShapes], [shapes, storedShapes]);

  // The first package gives a tree: go on to deciding what happens to it.
  const hadTree = useRef(initial !== undefined);
  useEffect(() => {
    if (tree && !hadTree.current) setTab('decisions');
    hadTree.current = tree !== undefined;
  }, [tree]);

  // Save changes, not the draft as it was loaded (saving marks the draft as changed).
  const loaded = useRef(true);
  const store = useRef(draft);
  useEffect(() => {
    if (loaded.current) {
      loaded.current = false;
      return;
    }
    store.current.save(config ? { config, ...(seen ? { seen } : {}) } : undefined);
  }, [config, seen]);

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

  // Packages kept with the platform: their structures, seen like any other, and their values
  // loaded into this tab.
  const refreshStored = useCallback(async () => {
    const list = await packages.list();
    const kept = list.shapes.map((s) => s.shape);
    setStored(list.packages);
    setStoredShapes(kept);
    if (kept.length > 0) {
      setSeen((s) => addSeen(s, ...kept));
      setConfig((c) => c ?? emptyConfig(kept[0]!.kind));
    }
    return list.packages;
  }, [packages]);
  useEffect(() => {
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
        if (node.lifter === undefined) for (const child of node.children ?? []) visit(child, [...path, child.id]);
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
    const selected = panel?.kind === 'name' ? panel.path : undefined;
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
  }, [tree, panel, exports]);

  const states = useMemo(() => (tree ? effectiveStates(tree) : new Map()), [tree]);
  const undecided = useMemo(() => (tree ? undecidedBelow(tree, states) : new Map()), [tree, states]);
  const counts = useMemo(() => (tree ? countDecisions(tree, states) : undefined), [tree, states]);
  const shared = useMemo(() => (tree ? sharedNames(tree) : new Map<string, SharedName>()), [tree]);
  const info = useMemo(() => (built && config ? rowInfo(built, config, structures) : new Map<ProjectNode, RowInfo>()), [built, config, structures]);
  /** Rows that may be the same as another part, by `pathKey`: the other part's name. */
  const hinted = useMemo(() => {
    const out = new Map<string, string>();
    for (const s of suggestions) {
      const from = tree && getNode(tree, s.from);
      const into = tree && getNode(tree, s.into);
      if (from?.virtual && into && !out.has(pathKey(s.from))) out.set(pathKey(s.from), currentName(tree, s.into) ?? rowName(into, t));
    }
    return out;
  }, [suggestions, tree, t]);

  /**
   * Take the configuration back out of an edited tree. Rows that were open or selected stay so,
   * also where the edit made a virtual row a config node.
   */
  function commit(next: ProjectNode): ProjectNode {
    // Names keys give to what is shown, donated or filtered are kept, so they do not move when
    // the structure does (ADR 0013).
    const nextConfig: ProjectConfig = { root: toConfig(keepNames(next)) };
    const after = buildTree(nextConfig, seen, ORDER).tree;
    const before = tree;
    if (before) {
      setPanel((open) => {
        const path = open && remapPath(before, after, open.path);
        return open && path ? { ...open, path } : undefined;
      });
      setOpen((o) => remapOpen(o, before, after));
    }
    setConfig(nextConfig);
    return after;
  }

  /** Run an edit, and say why when it cannot be done. */
  function attempt(edit: () => void) {
    try {
      edit();
    } catch (error) {
      setMessage({ text: (error as Error).message, error: true });
    }
  }

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
      const kept = await keepPackage(info, shape, keep);
      if (same) {
        setMessage({ text: kept ?? t('studio.sameStructure', { name: same.name }) });
        return info.id;
      }
      setShapes((m) => new Map(m).set(info.id, shape));
      // Keys the researcher says are data are one position, however many new ones there are.
      const corrected = (s: Shape) => (config ? correctedShape(config, s) : s);
      const added = newPositions(seen && corrected(seen), corrected(shape)).size;
      const nextSeen = addSeen(seen, shape);
      setSeen(nextSeen);
      if (config) {
        const next = buildTree(config, nextSeen, ORDER).tree;
        setSuggestions((s) => [...s, ...suggestCombines(next, shape)]);
        setMessage({ text: [t('studio.added', { count: added }), kept].filter(Boolean).join(' ') });
      } else {
        const first = emptyConfig(shape.kind);
        setConfig(first);
        setOpen(new Set(buildTree(first, nextSeen, ORDER).tree.children?.map((c) => pathKey([c.id])) ?? []));
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
      const saved = await packages.add(info.name, shape, data);
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
    if (!window.confirm(t('studio.kept.confirmRemove', { name }))) return;
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

  async function openFiles(files: File[]) {
    if (files.length === 0) return;
    setMessage(undefined);
    try {
      let structure: StructureFile | undefined;
      let importer: ImporterFile | undefined;
      for (const file of files) {
        const json = JSON.parse(await file.text()) as { format?: unknown };
        if (json.format === 'combray-structure@1') structure = parseStructureFile(json);
        else importer = parseImporterFile(json);
      }
      // An opened structure adds to what was seen; an opened importer replaces the configuration.
      const nextSeen = structure ? addSeen(seen, structure.root) : seen;
      const nextConfig = importer ? configOf(importer) : (config ?? emptyConfig(structure?.root.kind ?? 'dir'));
      if (structure && config && !importer) {
        setSuggestions((s) => [...s, ...suggestCombines(buildTree(config, nextSeen, ORDER).tree, structure.root)]);
      }
      setSeen(nextSeen);
      setConfig(nextConfig);
      setPanel(undefined);
      setMessage({ text: t('studio.opened', { count: notSeen(buildTree(nextConfig, nextSeen).tree).length }) });
    } catch (error) {
      setMessage({ text: t('studio.openFailed', { reason: (error as Error).message }), error: true });
    }
  }

  function saveFiles() {
    if (!config) return;
    const { structure, importer } = toFiles({ config, ...(seen ? { seen } : {}) });
    download('structure.json', structure);
    download('importer.json', importer);
  }

  function startOver() {
    if (!window.confirm(t('studio.confirmStartOver'))) return;
    // What was seen stays: it is what the packages have, not a decision.
    setConfig(seen ? emptyConfig(seen.kind) : undefined);
    setPanel(undefined);
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
    commit(setDecision(tree, path, decision));
  }

  const actions: TreeActions = {
    open: (path, kind) => setPanel({ path, kind }),
    close: () => setPanel(undefined),
    decide,
    decideBelow: (path, decision, undecidedOnly) => tree && commit(decideBelow(tree, path, decision, undecidedOnly)),
    toggleOpen: (key) =>
      setOpen((o) => {
        const next = new Set(o);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    shortcut: (path, key) => {
      const node = tree && getNode(tree, path);
      if (!node) return;
      const decision = SHORTCUT_DECISIONS[key];
      // On inner nodes, 1 switches ignore on and off.
      if (!isDecidable(node)) {
        if (decision === 'ignore') decide(path, node.decision === 'ignore' ? 'undecided' : 'ignore');
        return;
      }
      decide(path, decision);
    },
  };

  function patch(path: NodePath, change: NodePatch) {
    if (tree) commit(patchNode(tree, path, change));
  }

  function keysAreData(path: NodePath) {
    if (!tree || !window.confirm(t('studio.confirmKeys'))) return;
    attempt(() => commit(setKeysAreData(tree, path)));
  }

  /** Why a part cannot be merged into a node next to it: one node cannot hold two keys side by side. */
  function mergeProblem(path: NodePath, target: NodePath): string | undefined {
    if (!tree) return undefined;
    const problem = combineProblem(tree, [target, path]);
    if (problem) return t('studio.combine.refused', { reason: problem });
    const together = combineConflicts(tree, structures, [target, path]);
    return together > 0 ? t('studio.combine.together', { count: together }) : undefined;
  }

  /** Match a part: its name and decision, in one step (the match dialog). */
  function match(path: NodePath, choice: MatchChoice) {
    if (!tree) return;
    attempt(() => {
      const result = saveMatch(tree, path, choice);
      const after = commit(result.tree);
      setPanel(undefined);
      if (result.renamed) void followRename(result.renamed);
      if (choice.join === 'combine') {
        // What was inside each now sits side by side: suggest pairs there next.
        const below = (p: NodePath) => pathKey(p.slice(0, result.path.length)) === pathKey(result.path);
        const inside = structures.flatMap((shape) => suggestCombines(after, shape)).filter((x) => below(x.into));
        setSuggestions((s) => uniquePairs([...inside, ...s]));
      }
    });
  }

  function unmatchPart(path: NodePath) {
    if (!tree || !window.confirm(t('studio.matchDialog.confirmUnmatch'))) return;
    attempt(() => {
      commit(unmatch(tree, path));
      setPanel(undefined);
    });
  }

  const moreActions: MoreActions = { keysAreData };

  /** After a rename: the story follows (when it should), and the researcher hears what changed. */
  async function followRename(renamed: Renamed) {
    if (!renamed.references || !onRename) return;
    try {
      const count = await onRename(renamed);
      if (count > 0) setMessage({ text: t('studio.renamedInStory', { count, name: renamed.to }) });
    } catch {
      setMessage({ text: t('studio.renameStoryFailed', { name: renamed.from }), error: true });
    }
  }

  const matchListActions: MatchListActions = {
    add: (path, m) => tree && attempt(() => commit(addMatch(tree, path, m).tree)),
    remove: (path, m) => tree && attempt(() => commit(removeMatch(tree, path, m))),
    split: (path) => tree && attempt(() => commit(splitByKey(tree, path))),
  };

  /** Parts that may be the same as this one, from the suggestions made when packages were added. */
  const hintsFor = (path: NodePath): MatchHint[] =>
    tree
      ? suggestions.flatMap((s) => {
          if (pathKey(s.from) !== pathKey(path)) return [];
          const into = getNode(tree, s.into);
          return into ? [{ path: s.into, name: currentName(tree, s.into) ?? rowName(into, t), score: s.score }] : [];
        })
      : [];

  const renderPanel = (path: NodePath, kind: RowPanel) => {
    const node = tree && getNode(tree, path);
    if (!tree || !node) return null;
    const close = () => setPanel(undefined);
    const onPatch = (change: NodePatch) => patch(path, change);
    if (kind === 'name') {
      return (
        <MatchDialog
          key={pathKey(path)}
          tree={tree}
          path={path}
          info={info.get(node)}
          values={fieldValues}
          hasPackages={exports.length > 0}
          hints={hintsFor(path)}
          ignoredAbove={path.slice(0, -1).some((_, i) => getNode(tree, path.slice(0, i + 1))?.decision === 'ignore')}
          mergeProblem={(target) => mergeProblem(path, target)}
          onSave={(choice) => match(path, choice)}
          onUnmatch={() => unmatchPart(path)}
          match={matchListActions}
          onClose={close}
        />
      );
    }
    const title = kind === 'platform' ? t('studio.platformSettings') : `${t(`studio.details.${kind}`)}: ${rowName(node, t)}`;
    return (
      <div className="node-details">
        <PanelHead title={title} onClose={close} />
        <div className="details-body">
          {kind === 'read' && <ReadPanel node={node} onPatch={onPatch} />}
          {kind === 'rows' && <RowsPanel tree={tree} path={path} node={node} onPatch={onPatch} />}
          {kind === 'more' && <MorePanel tree={tree} path={path} node={node} onPatch={onPatch} actions={moreActions} />}
          {kind === 'platform' && <PlatformPanel tree={tree} node={node} onPatch={onPatch} />}
        </div>
      </div>
    );
  };

  const busy = progress !== undefined;
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
      <p>{t('studio.intro')}</p>

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
              <p className="meta">{t('studio.kept.addIntro')}</p>
              <Dropzone busy={busy} onFiles={async (files) => void (await addFiles(files, keepValues))} />
              <div className="section-head check-row">
                <label className="check">
                  <input type="checkbox" checked={keepValues} onChange={(e) => setKeepValues(e.target.checked)} />
                  {t('studio.kept.keepValues')}
                </label>
                <HelpButton topic="keep-values" />
              </div>
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
              <section className="studio-section">
                <TemporaryUpload busy={busy} onFiles={async (files) => void (await addFiles(files))} />
                <p className="meta">
                  {t('studio.counts', { ...counts })}
                  {counts.undecided > 0 && ` ${t('studio.undecidedLeft', { count: counts.undecided })}`}
                </p>
                <div className="tree-controls">
                  <span className="segmented" role="group" aria-label={t('studio.viewLabel')}>
                    {(['named', 'tree'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="seg"
                        aria-pressed={view === v}
                        title={t(`studio.viewHelp.${v}`)}
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
                      aria-expanded={panel?.kind === 'platform'}
                      aria-haspopup="dialog"
                      onClick={() => setPanel(panel?.kind === 'platform' ? undefined : { path: [], kind: 'platform' })}
                    >
                      {t('studio.platformSettings')}
                    </button>
                    {panel?.kind === 'platform' && (
                      <Popover
                        label={t('studio.platformSettings')}
                        anchor={platformButton}
                        onClose={() => setPanel(undefined)}
                        className="row-popover platform-popover"
                      >
                        {renderPanel([], 'platform')}
                      </Popover>
                    )}
                  </span>
                  <HelpLink />
                </div>
                <DecisionTree
                  tree={tree}
                  shared={shared}
                  info={info}
                  states={states}
                  undecided={undecided}
                  onlyUndecided={onlyUndecided}
                  hideIgnored={hideIgnored}
                  view={view}
                  open={open}
                  actions={actions}
                  renderPanel={renderPanel}
                  hints={hinted}
                  examples={rowValues}
                  {...(panel && panel.kind !== 'platform' ? { panel } : {})}
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
              <TemporaryUpload busy={busy} onFiles={async (files) => {
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
              <button className="button" type="button" disabled={!config} onClick={saveFiles}>
                {t('studio.save')}
              </button>
              <button className="button danger" type="button" disabled={!config} onClick={startOver}>
                {t('studio.startOver')}
              </button>
            </div>
            {tree && notSeen(tree).length > 0 && <p className="meta">{t('studio.pending', { count: notSeen(tree).length })}</p>}
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
          // Copied first: clearing the input below empties its file list.
          void openFiles([...(e.target.files ?? [])]);
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
function TemporaryUpload({ busy, onFiles }: { busy: boolean; onFiles: (files: Upload[]) => Promise<void> }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const input = useRef<HTMLInputElement>(null);
  return (
    <p className="temporary-upload">
      <button type="button" className="button quiet" disabled={busy} onClick={() => input.current?.click()}>
        {t('studio.kept.temporaryButton')}
      </button>
      <HelpButton topic="test-packages" />
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
