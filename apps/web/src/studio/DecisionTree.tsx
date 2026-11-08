import {
  getNode,
  isDecidable,
  isLeaf,
  outline,
  VALUE_COLUMN,
  type EffectiveState,
  type LeafDecision,
  type NodePath,
  type OutlineGroup,
  type ProjectNode,
} from '@combray/core';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useHelp } from './Help';
import { displayName, foldChain, isUndecided, nodeIcon, pathKey, shortNames, withSameNamesTogether, type RowInfo, type ShortName, type Shortcut } from './model';
import { isPositional, keysBehind, rowName, type SharedName } from './naming';
import { Popover } from './Popover';
import { isTableRows, type RowPanel } from './RowPanels';

/** The decisions a field can be given here; undecided is what nothing matched yet is. */
const LEAF_DECISIONS: Exclude<LeafDecision, 'undecided'>[] = ['ignore', 'show', 'donate'];

export type TreeView = 'tree' | 'named';

export interface TreeActions {
  /** Open one of a row's panels next to its button. */
  open: (path: NodePath, panel: RowPanel) => void;
  close: () => void;
  decide: (path: NodePath, decision: LeafDecision) => void;
  /** On a table or group: set every field below at once. */
  decideBelow: (path: NodePath, decision: 'show' | 'donate', undecidedOnly: boolean) => void;
  /** Keys 1 to 3 on a row: ignore, show, donate. */
  shortcut: (path: NodePath, key: Shortcut) => void;
  toggleOpen: (key: string) => void;
}

interface Props {
  tree: ProjectNode;
  /** The part of the tree shown: the content of one file group (paths stay from the root). */
  base: NodePath;
  /** Parts that share a name with others, by their path (`/`-joined): their number and colour. */
  shared: Map<string, SharedName>;
  /** Notes per row: not seen, conflicts, shared data, names with different decisions. */
  info: Map<ProjectNode, RowInfo>;
  states: Map<ProjectNode, EffectiveState>;
  undecided: Map<ProjectNode, number>;
  onlyUndecided: boolean;
  hideIgnored: boolean;
  view: TreeView;
  /** Open rows in the tree view; closed tables in the named view. */
  open: Set<string>;
  /** The panel that is open, and the row it belongs to. */
  panel?: { path: NodePath; kind: RowPanel };
  actions: TreeActions;
  /** The content of a row's panel. */
  renderPanel: (path: NodePath, kind: RowPanel) => ReactNode;
  /** Common values of fields in the loaded test packages, by `pathKey`. */
  examples: Record<string, string[]>;
  /** Parts that may be the same as another, by `pathKey`: the other's name. */
  hints: Map<string, string>;
}

const SHORTCUTS = new Set<string>(['1', '2', '3']);

/**
 * The extractor over the seen data, for matching and deciding. Rows are coloured by their
 * decision; parts nothing matches are "not matched", in a quiet style. A row's name opens the
 * match dialog; its other buttons open their own panels next to them; the pill sets its decision
 * (or keys 1 to 3 on the row). The named view shows only tables and fields, by their names,
 * which is all most researchers need to pick data. Parts that share a name have a number
 * (`#1`, `#2`: the first with a value gives it) and a bar in one colour.
 */
export function DecisionTree(props: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  if (props.view === 'named') return <NamedView {...props} />;
  const base = getNode(props.tree, props.base);
  if (!base) return null;
  const children = base.children ?? [];
  return (
    <ul className="decision-tree" aria-label={t('studio.tree')}>
      {isLeaf(base) ? (
        <Row {...props} node={base} path={props.base} />
      ) : (
        withSameNamesTogether(children).map((child) => <Row key={child.id} {...props} node={child} path={[...props.base, child.id]} />)
      )}
    </ul>
  );
}

/** The files of a group in one format each: named by what they hold, not by the group again. */
function branchLabel(props: Props, node: ProjectNode, path: NodePath, t: (key: string) => string): string | undefined {
  const parent = getNode(props.tree, path.slice(0, -1));
  return parent?.files !== undefined ? t(`studio.contents.branch.${node.kind}`) : undefined;
}

function stateClass(node: ProjectNode, states: Map<ProjectNode, EffectiveState>): string {
  const state = states.get(node) ?? 'show';
  if (state === 'ignore') return 'state-ignore';
  if (isUndecided(node, states)) return 'state-undecided';
  // Inner nodes take the colour of what is below them, more lightly.
  return `state-${state}${isDecidable(node) ? '' : ' inner'}`;
}

const isOpenPanel = (props: Props, path: NodePath, kind: RowPanel) =>
  props.panel !== undefined && props.panel.kind === kind && pathKey(props.panel.path) === pathKey(path);

/** The decision of a row, as a pill that opens a menu to change it. */
function DecisionButton({ node, path, name, states, actions }: { node: ProjectNode; path: NodePath; name: string; states: Map<ProjectNode, EffectiveState>; actions: TreeActions }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const state = states.get(node) ?? 'show';
  const decidable = isDecidable(node);
  const shown = decidable
    ? isUndecided(node, states)
      ? node.virtual
        ? 'notMatched'
        : 'undecided'
      : state
    : node.decision === 'ignore'
      ? 'ignore'
      : 'below';
  const choose = (action: () => void) => {
    action();
    setOpen(false);
  };
  return (
    <span className="decision-menu-anchor">
      <button
        ref={button}
        type="button"
        className={`pill pill-button pill-${shown}`}
        aria-expanded={open}
        aria-label={t('studio.decisionFor', { name })}
        onClick={() => setOpen((o) => !o)}
      >
        {t(`studio.pill.${shown}`)} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <Popover label={t('studio.decisionFor', { name })} anchor={button} onClose={() => setOpen(false)} className="decision-menu">
          {decidable ? (
            <>
              {LEAF_DECISIONS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  className={`menu-item item-${d}`}
                  aria-pressed={node.decision === d}
                  aria-keyshortcuts={String(i + 1)}
                  onClick={() => choose(() => actions.decide(path, d))}
                >
                  <span className={`dot dot-${d}`} aria-hidden="true" />
                  {t(`studio.decision.${d}`)}
                  <kbd aria-hidden="true">{i + 1}</kbd>
                </button>
              ))}
              {node.virtual && <p className="meta">{t('studio.matchesByKey')}</p>}
              {state === 'ignore' && node.decision !== 'ignore' && <p className="meta">{t('studio.ignoredAbove')}</p>}
            </>
          ) : node.decision === 'ignore' ? (
            <button type="button" className="menu-item" onClick={() => choose(() => actions.decide(path, 'undecided'))}>
              {t('studio.unignore')}
            </button>
          ) : (
            <>
              <button type="button" className="menu-item" onClick={() => choose(() => actions.decide(path, 'ignore'))}>
                <span className="dot dot-ignore" aria-hidden="true" />
                {t('studio.ignoreAll')}
              </button>
              <p className="menu-label">{t('studio.fieldsBelow')}</p>
              <button type="button" className="menu-item" onClick={() => choose(() => actions.decideBelow(path, 'show', true))}>
                <span className="dot dot-show" aria-hidden="true" />
                {t('studio.showAll')}
              </button>
              <button type="button" className="menu-item" onClick={() => choose(() => actions.decideBelow(path, 'donate', true))}>
                <span className="dot dot-donate" aria-hidden="true" />
                {t('studio.donateAll')}
              </button>
            </>
          )}
        </Popover>
      )}
    </span>
  );
}

/** A button on a row that opens one of its panels, right below it. */
function PanelButton({
  props,
  path,
  kind,
  label,
  className,
  anchorClass,
  title,
  children,
  onKeyDown,
}: {
  props: Props;
  path: NodePath;
  kind: RowPanel;
  label: string;
  className: string;
  anchorClass?: string;
  title?: string;
  children: ReactNode;
  onKeyDown?: (event: KeyboardEvent) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const open = isOpenPanel(props, path, kind);
  return (
    <span className={`decision-menu-anchor${anchorClass ? ` ${anchorClass}` : ''}`}>
      <button
        ref={button}
        type="button"
        className={className}
        aria-expanded={open}
        aria-haspopup="dialog"
        {...(title ? { title } : {})}
        onClick={() => (open ? props.actions.close() : props.actions.open(path, kind))}
        {...(onKeyDown ? { onKeyDown } : {})}
      >
        {children}
      </button>
      {open && (
        <Popover label={label} anchor={button} onClose={props.actions.close} className="row-popover">
          {props.renderPanel(path, kind)}
        </Popover>
      )}
    </span>
  );
}

/** One line of the tree: open or close, the name (opens the match dialog), notes, settings and the decision. */
function Line({
  props,
  node,
  path,
  nameAt,
  name,
  toggle,
  title,
  tags,
  onToggle,
  children,
}: {
  props: Props;
  node: ProjectNode;
  path: NodePath;
  /** Where the name is, when not on this node: a table is named on its list (or file). */
  nameAt?: NodePath;
  name: string;
  toggle?: ReactNode;
  title?: string;
  tags?: ReactNode;
  /** Fold or unfold the row: also on a click on the row outside its buttons. */
  onToggle?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const { actions, states } = props;
  const named = nameAt ?? path;
  const nameNode = nameAt ? getNode(props.tree, nameAt) : node;
  const selected = props.panel !== undefined && (pathKey(props.panel.path) === pathKey(path) || pathKey(props.panel.path) === pathKey(named));
  return (
    // A click on the row itself (not on a button in it) folds it; the toggle button does the
    // same for the keyboard.
    <div
      className={`decision-line${selected ? ' selected' : ''}${onToggle ? ' foldable' : ''}`}
      onClick={(e) => {
        if (!onToggle || (e.target as HTMLElement).closest('button, input, select, a, .popover')) return;
        onToggle();
      }}
    >
      {toggle ?? <span className="toggle" aria-hidden="true" />}
      {named.length > 0 && nameNode && !isPositional(nameNode) ? (
        <PanelButton
          props={props}
          path={named}
          kind="name"
          label={t('studio.matchDialog.title')}
          className="decision-name"
          anchorClass="name-anchor"
          {...(title ? { title } : {})}
          onKeyDown={rowKeys(path, actions)}
        >
          {children}
        </PanelButton>
      ) : (
        <span className="decision-name static" tabIndex={0} onKeyDown={rowKeys(path, actions)} {...(title ? { title } : {})}>
          {children}
        </span>
      )}
      {props.examples[pathKey(path)] && (
        <span className="row-examples" title={props.examples[pathKey(path)]!.join('\n')}>
          {props.examples[pathKey(path)]!.join(' · ')}
        </span>
      )}
      {path.length > 0 && <RowNotes props={props} node={node} path={path} />}
      <span className="decision-tags">{tags}</span>
      {path.length > 0 && !node.virtual && <RowButtons props={props} node={node} path={path} name={name} />}
      <DecisionButton node={node} path={path} name={name} states={states} actions={actions} />
    </div>
  );
}

/** The keys behind a row's name, quietly, when they say more than the name. */
function KeysBehind({ node, shown }: { node: ProjectNode; shown: string }) {
  const keys = keysBehind(node, shown);
  if (keys.length === 0) return null;
  return (
    <span className="row-keys">
      <span aria-hidden="true"> ← </span>
      {keys.join(', ')}
    </span>
  );
}

/** The keys from a field's row to it, quietly and shortened, when its name is not simply its key. */
function FieldKeys({ keys, name }: { keys: ShortName | undefined; name: string }) {
  if (!keys || keys.short === name) return null;
  return (
    <span className="row-keys" title={keys.full}>
      <span aria-hidden="true"> ← </span>
      {keys.short}
    </span>
  );
}

/** What a row's configuration meets in the seen data: not matched, not seen, conflicts. */
function RowNotes({ props, node, path }: { props: Props; node: ProjectNode; path: NodePath }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const help = useHelp();
  const info = props.info.get(node);
  const hint = props.hints.get(pathKey(path));
  return (
    <span className="row-extras">
      {node.virtual && !isPositional(node) && <span className="tag not-matched-tag">{t('studio.notMatched')}</span>}
      {hint && (
        <button type="button" className="tag hint-tag" onClick={() => props.actions.open(path, 'name')}>
          {t('studio.matchDialog.maybe', { name: hint })}
        </button>
      )}
      {info?.notSeen && <span className="tag warn-tag">{t('studio.notSeen')}</span>}
      {info?.conflicts && (
        <button type="button" className="tag warn-tag" onClick={() => help('conflict')}>
          {t('studio.conflict', { count: info.conflicts })}
        </button>
      )}
      {info?.alsoMatchedBy && <span className="tag">{t('studio.alsoMatchedBy', { names: info.alsoMatchedBy.join(', ') })}</span>}
      {info?.nameMismatch && (
        <button type="button" className="tag warn-tag" onClick={() => help('name-mismatch')}>
          {t('studio.nameMismatch')}
        </button>
      )}
    </span>
  );
}

/**
 * Buttons to a row's settings, each with what is set: how it is read ("Read as date"), which rows
 * a table keeps ("2 filters"), and the rest under "More".
 */
function RowButtons({ props, node, path, name }: { props: Props; node: ProjectNode; path: NodePath; name: string }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const read = isDecidable(node) && node.kind !== 'blob';
  const conversion = node.as !== undefined || (node.transform?.length ?? 0) > 0;
  const filters = node.filter?.length ?? 0;
  return (
    <span className="row-buttons">
      {read && (
        <PanelButton props={props} path={path} kind="read" label={t('studio.details.read')} className={`row-setting${conversion ? ' set' : ''}`}>
          {node.as ? t('studio.readAsType', { type: t(`studio.as.${node.as}`).toLowerCase() }) : conversion ? t('studio.cleaned') : t('studio.details.read')}
          <span className="visually-hidden"> {name}</span>
        </PanelButton>
      )}
      {isTableRows(node) && (
        <PanelButton props={props} path={path} kind="rows" label={t('studio.details.rows')} className={`row-setting${filters > 0 ? ' set' : ''}`}>
          {filters > 0 ? t('studio.filterCount', { count: filters }) : t('studio.details.rows')}
          <span className="visually-hidden"> {name}</span>
        </PanelButton>
      )}
      <PanelButton props={props} path={path} kind="more" label={t('studio.details.more')} className="row-setting">
        {t('studio.details.more')}
        <span className="visually-hidden"> {name}</span>
      </PanelButton>
    </span>
  );
}

function Icon({ node, list }: { node: ProjectNode; list?: boolean }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const icon = list ? { kind: 'list' as const, glyph: '⋮' } : nodeIcon(node);
  return (
    <>
      <span className={`node-icon icon-${icon.kind}`} aria-hidden="true">
        {icon.glyph}
      </span>
      <span className="visually-hidden">{t(`studio.icon.${icon.kind}`)}: </span>
    </>
  );
}

function rowKeys(path: NodePath, actions: TreeActions) {
  return (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !SHORTCUTS.has(event.key)) return;
    event.preventDefault();
    actions.shortcut(path, event.key as Shortcut);
  };
}

function Row(props: Props & { node: ProjectNode; path: NodePath }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const { states, undecided, onlyUndecided, hideIgnored, open, actions } = props;
  const chain = foldChain(props.node, props.path);
  const top = chain[0]!;
  const { node, path } = chain.at(-1)!;
  if (onlyUndecided && (undecided.get(top.node) ?? 0) === 0) return null;
  if (hideIgnored && states.get(top.node) === 'ignore') return null;

  const leaf = isLeaf(node);
  const key = pathKey(path);
  const isOpen = open.has(key);
  const name = chain.map((c) => displayName(c.node.name, t)).join(' / ');
  const children = leaf ? [] : (node.children ?? []);
  const branch = branchLabel(props, top.node, top.path, t);
  const shown = branch && chain.length === 1 ? { text: branch, more: false } : chainName(props.tree, chain, t);
  const own = rowName(node, t);
  const mark = props.shared.get(path.join('/'));

  return (
    <li className={`decision-row ${stateClass(node, states)}${node.virtual ? ' virtual' : ''}${sharedClass(mark)}`}>
      <Line
        props={props}
        node={node}
        path={path}
        name={name}
        toggle={
          children.length > 0 ? (
            <button
              type="button"
              className="toggle"
              aria-expanded={isOpen}
              aria-label={isOpen ? t('studio.collapse', { name }) : t('studio.expand', { name })}
              onClick={() => actions.toggleOpen(key)}
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : undefined
        }
        title={name}
        {...(children.length > 0 ? { onToggle: () => actions.toggleOpen(key) } : {})}
        tags={
          <>
            {node.repeat === 'once' && <span className="tag">{t('studio.repeat.once')}</span>}
            {node.lifter !== undefined && <span className="tag">{t('studio.lifter')}</span>}
            {node.required && <span className="tag">{t('studio.requiredTag')}</span>}
            {node.newChildren === 'skip' && <span className="tag">{t('studio.skipTag')}</span>}
          </>
        }
      >
        <Icon node={node} />
        <NameMark mark={mark} />
        {node.named !== undefined ? (
          <>
            <strong>{own}</strong>
            <KeysBehind node={node} shown={own} />
          </>
        ) : (
          <>
            {shown.more && <PathMore />}
            {shown.text}
          </>
        )}
        <span className="visually-hidden"> ({name})</span>
      </Line>
      {isOpen && children.length > 0 && (
        <ul>
          {withSameNamesTogether(children).map((child) => (
            <Row key={child.id} {...props} node={child} path={[...path, child.id]} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The colour bar of a part that shares its name (a class), with its number in the group. */
const SHARED_COLOURS = 6;
const sharedClass = (mark: SharedName | undefined) => (mark ? ` shared-name shared-${mark.colour % SHARED_COLOURS}` : '');

function NameMark({ mark }: { mark: SharedName | undefined }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  if (!mark) return null;
  return (
    <span className="name-number" title={t('studio.sharedName', { number: mark.number, name: mark.name })}>
      #{mark.number}
    </span>
  );
}

/** A mark that the name is the end of a longer path: hover or open the row to see all of it. */
function PathMore() {
  return (
    <span className="path-more" aria-hidden="true">
      …/
    </span>
  );
}

/**
 * How a folded row is named: the file it is in (if the row goes deeper than that) and the
 * shortest form of its last step that tells it apart from the steps next to it.
 */
function chainName(
  tree: ProjectNode,
  chain: { node: ProjectNode; path: NodePath }[],
  t: (key: string) => string,
): { text: string; more: boolean } {
  const last = chain.at(-1)!;
  // "Each item" or "each key" says all there is, below the row it belongs to.
  if (last.node.name === '[*]' || last.node.name === '{*}') return { text: displayName(last.node.name, t), more: false };
  const parentPath = last.path.slice(0, -1);
  const siblings = (getNode(tree, parentPath)?.children ?? []).map((c) => [...parentPath, c.id]);
  const index = siblings.findIndex((p) => pathKey(p) === pathKey(last.path));
  const own = index >= 0 && last.path.length > 0 ? shortNames(tree, siblings, parentPath)[index]! : undefined;
  const end = own && !own.shortened ? displayName(last.node.name, t) : (own?.short ?? displayName(last.node.name, t));
  const file = chain
    .slice(0, -1)
    .filter((c) => c.node.kind !== 'dir' && getNode(tree, c.path.slice(0, -1))?.kind === 'dir')
    .at(-1);
  const text = file ? `${displayName(file.node.name, t)} / ${end}` : end;
  return { text, more: chain.length > (file ? 2 : 1) || own?.shortened === true };
}

/**
 * The full path of a node for people: `tweets / each item / stats / likes`. A file group is
 * named once, by its files (which carry the group's name).
 */
function fullPath(tree: ProjectNode, path: NodePath, t: (key: string) => string): string {
  const names = pathNames(tree, path).filter((_, i) => getNode(tree, path.slice(0, i + 1))?.files === undefined);
  return names.map((n) => displayName(n, t)).join(' / ');
}

/** The names along a path of ids. */
const pathNames = (tree: ProjectNode, path: NodePath) => path.map((id, i) => getNode(tree, path.slice(0, i + 1))?.name ?? id);

/**
 * The named view: only tables and fields, by their names, each table with its fields and the
 * tables nested in it (a field's table is the nearest table above it). Parts that share a name
 * are placed together, with their number.
 */
function NamedView(props: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  // Only the part shown (a file group), with paths from the root.
  const groups = useMemo(() => outline(scoped(props.tree, props.base)), [props.tree, props.base]);
  // The keys behind each field, as short as they can be while telling the fields of a table apart.
  const keys = useMemo(() => {
    const out = new Map<string, ShortName>();
    const visit = (group: OutlineGroup) => {
      const fields = group.fields.filter((f) => f.path.length > group.path.length);
      shortNames(props.tree, fields.map((f) => f.path), group.path).forEach((n, i) => out.set(fields[i]!.path.join('/'), n));
      group.groups.forEach(visit);
    };
    visit(groups);
    return out;
  }, [groups, props.tree]);
  return (
    <ul className="decision-tree named-view" aria-label={t('studio.tree')}>
      <GroupBody {...props} keys={keys} group={groups} />
    </ul>
  );
}

/** The tree with only the nodes along `base` and below it: what a view of part of it outlines. */
function scoped(tree: ProjectNode, base: NodePath): ProjectNode {
  if (base.length === 0) return tree;
  const [id, ...rest] = base;
  const child = tree.children?.find((c) => c.id === id);
  return { ...tree, children: child ? [scoped(child, rest)] : [] };
}

function visibleField(props: Props, path: NodePath): ProjectNode | undefined {
  const node = getNode(props.tree, path);
  if (!node) return undefined;
  if (props.hideIgnored && props.states.get(node) === 'ignore') return undefined;
  if (props.onlyUndecided && !isUndecided(node, props.states)) return undefined;
  return node;
}

function hasVisible(props: Props, group: OutlineGroup): boolean {
  return group.fields.some((f) => visibleField(props, f.path)) || group.groups.some((g) => visibleGroup(props, g));
}

function visibleGroup(props: Props, group: OutlineGroup): boolean {
  const node = getNode(props.tree, group.path);
  if (!node || (props.hideIgnored && props.states.get(node) === 'ignore')) return false;
  return hasVisible(props, group) || (!props.onlyUndecided && group.fields.length + group.groups.length === 0);
}

/** Items in runs: those with the same name together, where the first of them is. */
function sameNamesTogether<T extends { id: string }>(items: T[]): T[] {
  const runs: T[][] = [];
  for (const item of items) {
    const run = runs.find((r) => r[0]!.id === item.id);
    if (run) run.push(item);
    else runs.push([item]);
  }
  return runs.flat();
}

type NamedProps = Props & { keys: Map<string, ShortName> };

function GroupBody(props: NamedProps & { group: OutlineGroup }) {
  const { group } = props;
  return (
    <>
      {sameNamesTogether(group.fields).map((field) => (
        <FieldRow key={field.path.join('/')} {...props} group={group} field={field} />
      ))}
      {sameNamesTogether(group.groups.filter((g) => visibleGroup(props, g))).map((g) => (
        <GroupRow key={g.path.join('/')} {...props} group={g} />
      ))}
    </>
  );
}

function FieldRow(props: NamedProps & { group: OutlineGroup; field: OutlineGroup['fields'][number] }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const { group, field, states } = props;
  const node = visibleField(props, field.path);
  if (!node) return null;
  const name = field.id === VALUE_COLUMN ? t('studio.valueColumn') : field.id;
  const where = fullPath(props.tree, field.path, t);
  const mark = props.shared.get(field.path.join('/'));
  return (
    <li className={`decision-row ${stateClass(node, states)}${node.virtual ? ' virtual' : ''}${sharedClass(mark)}`}>
      <Line props={props} node={node} path={field.path} name={name} title={where}>
        {/* A list of plain values below the row is one field: a list cell. */}
        <Icon
          node={node}
          list={field.path.slice(group.path.length).some((_, i) => getNode(props.tree, field.path.slice(0, group.path.length + i + 1))?.name === '[*]')}
        />
        <NameMark mark={mark} />
        {field.own ? <strong>{name}</strong> : name}
        <FieldKeys keys={props.keys.get(field.path.join('/'))} name={name} />
        <span className="visually-hidden"> ({where})</span>
      </Line>
    </li>
  );
}

function GroupRow(props: NamedProps & { group: OutlineGroup }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const { group, states, open, actions } = props;
  const node = getNode(props.tree, group.path)!;
  // The list a table's rows belong to says whether it repeats, and is what researchers think of.
  const list = getNode(props.tree, group.path.slice(0, -1));
  const key = `fields:${pathKey(group.path)}`;
  const isOpen = !open.has(key);
  const name = group.id || t('studio.unnamedTable');
  const mark = group.source ? props.shared.get(group.source.join('/')) : undefined;
  return (
    <li className={`decision-row group ${stateClass(node, states)}${sharedClass(mark)}`}>
      <Line
        props={props}
        node={node}
        path={group.path}
        {...(group.source ? { nameAt: group.source } : {})}
        name={name}
        title={fullPath(props.tree, group.path, t)}
        onToggle={() => actions.toggleOpen(key)}
        toggle={
          <button
            type="button"
            className="toggle"
            aria-expanded={isOpen}
            aria-label={isOpen ? t('studio.collapse', { name }) : t('studio.expand', { name })}
            onClick={() => actions.toggleOpen(key)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        }
        tags={
          <>
            {(list?.repeat ?? node.repeat) === 'once' && <span className="tag">{t('studio.repeat.once')}</span>}
            {group.keyed && <span className="tag">{t('studio.keysTag')}</span>}
            {node.headerRow && <span className="tag">{t('studio.headerRowTag')}</span>}
          </>
        }
      >
        <span className="node-icon icon-table" aria-hidden="true">
          ▦
        </span>
        <span className="visually-hidden">{t('studio.icon.table')}: </span>
        <NameMark mark={mark} />
        {group.own ? <strong>{name}</strong> : name}
      </Line>
      {isOpen && (
        <ul>
          <GroupBody {...props} group={group} />
        </ul>
      )}
    </li>
  );
}
