import {
  getNode,
  isDecidable,
  isLeaf,
  localize,
  outline,
  type EffectiveState,
  type LeafDecision,
  type NodePath,
  type OutlineGroup,
  type ProjectNode,
} from '@combray/core';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { displayName, foldChain, isUndecided, nodeIcon, pathKey, shortNames, type ShortName, type Shortcut } from './model';
import { Popover } from './Popover';

const LEAF_DECISIONS: LeafDecision[] = ['undecided', 'ignore', 'show', 'donate'];

export type TreeView = 'tree' | 'fields';

export interface TreeActions {
  /** Open a row's settings. */
  select: (path: NodePath) => void;
  /** Close them. */
  close: () => void;
  decide: (path: NodePath, decision: LeafDecision) => void;
  /** On a table or group: set every field below at once. */
  decideBelow: (path: NodePath, decision: 'show' | 'donate' | 'undecided', undecidedOnly: boolean) => void;
  /** Keys 1 to 4 on a row: undecided, ignore, show, donate. */
  shortcut: (path: NodePath, key: Shortcut) => void;
  toggleOpen: (key: string) => void;
}

interface Props {
  tree: ProjectNode;
  states: Map<ProjectNode, EffectiveState>;
  undecided: Map<ProjectNode, number>;
  onlyUndecided: boolean;
  hideIgnored: boolean;
  view: TreeView;
  /** Open rows in the tree view; closed tables in the fields view. */
  open: Set<string>;
  selected?: NodePath;
  actions: TreeActions;
  /** The settings of the selected row, shown in a popover below it. */
  details: (path: NodePath) => ReactNode;
  /** Common values of fields in the loaded test packages, by `pathKey`. */
  examples: Record<string, string[]>;
}

const SHORTCUTS = new Set<string>(['1', '2', '3', '4']);

/**
 * The project tree for decisions. Rows are coloured by their state. The pill on a row opens a
 * menu to change its decision (or keys 1 to 4 on the row); the row's name opens its settings. The fields view shows only tables and fields, named
 * as their columns, which is all most researchers need to pick data.
 */
export function DecisionTree(props: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  if (props.view === 'fields') return <FieldsView {...props} />;
  const children = props.tree.children ?? [];
  return (
    <ul className="decision-tree" aria-label={t('studio.tree')}>
      {isLeaf(props.tree) ? (
        <Row {...props} node={props.tree} path={[]} />
      ) : (
        children.map((child) => (
          <Row key={`${child.kind}:${child.name}`} {...props} node={child} path={[child.name]} />
        ))
      )}
    </ul>
  );
}

function stateClass(node: ProjectNode, states: Map<ProjectNode, EffectiveState>): string {
  const state = states.get(node) ?? 'show';
  if (state === 'ignore') return 'state-ignore';
  if (isUndecided(node, states)) return 'state-undecided';
  // Inner nodes take the colour of what is below them, more lightly.
  return `state-${state}${isDecidable(node) ? '' : ' inner'}`;
}

/** The decision of a row, as a pill that opens a menu to change it. */
function DecisionButton({ node, path, name, states, actions }: { node: ProjectNode; path: NodePath; name: string; states: Map<ProjectNode, EffectiveState>; actions: TreeActions }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const state = states.get(node) ?? 'show';
  const decidable = isDecidable(node);
  const shown = decidable ? (isUndecided(node, states) ? 'undecided' : state) : node.decision === 'ignore' ? 'ignore' : 'below';
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
                  aria-pressed={(node.decision ?? 'undecided') === d}
                  aria-keyshortcuts={String(i + 1)}
                  onClick={() => choose(() => actions.decide(path, d))}
                >
                  <span className={`dot dot-${d}`} aria-hidden="true" />
                  {t(`studio.decision.${d}`)}
                  <kbd aria-hidden="true">{i + 1}</kbd>
                </button>
              ))}
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
              <button type="button" className="menu-item" onClick={() => choose(() => actions.decideBelow(path, 'undecided', false))}>
                <span className="dot dot-undecided" aria-hidden="true" />
                {t('studio.clearAll')}
              </button>
            </>
          )}
        </Popover>
      )}
    </span>
  );
}

/** One line of the tree: open or close, the name (opens the settings), tags and the decision. */
function Line({
  props,
  node,
  path,
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
  name: string;
  toggle?: ReactNode;
  title?: string;
  tags?: ReactNode;
  /** Fold or unfold the row: also on a click on the row outside its buttons. */
  onToggle?: () => void;
  children: ReactNode;
}) {
  const nameButton = useRef<HTMLButtonElement>(null);
  const { selected, actions, states } = props;
  const isSelected = selected !== undefined && pathKey(selected) === pathKey(path);
  return (
    // A click on the row itself (not on a button in it) folds it; the toggle button does the
    // same for the keyboard.
    <div
      className={`decision-line${isSelected ? ' selected' : ''}${onToggle ? ' foldable' : ''}`}
      onClick={(e) => {
        if (!onToggle || (e.target as HTMLElement).closest('button, input, select, a, .popover')) return;
        onToggle();
      }}
    >
      {toggle ?? <span className="toggle" aria-hidden="true" />}
      <button
        ref={nameButton}
        type="button"
        className="decision-name"
        aria-expanded={isSelected}
        aria-haspopup="dialog"
        {...(title ? { title } : {})}
        onClick={() => (isSelected ? actions.close() : actions.select(path))}
        onKeyDown={rowKeys(path, actions)}
      >
        {children}
      </button>
      {props.examples[pathKey(path)] && (
        <span className="row-examples" title={props.examples[pathKey(path)]!.join('\n')}>
          {props.examples[pathKey(path)]!.join(' · ')}
        </span>
      )}
      <span className="decision-tags">{tags}</span>
      <DecisionButton node={node} path={path} name={name} states={states} actions={actions} />
      {isSelected && (
        <Popover label={name} anchor={nameButton} onClose={actions.close} className="row-popover">
          {props.details(path)}
        </Popover>
      )}
    </div>
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
  const { t, i18n } = useTranslation(undefined, { lng: 'en' });
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
  const shown = chainName(props.tree, chain, t);

  return (
    <li className={`decision-row ${stateClass(node, states)}`}>
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
            {node.count && node.count !== '1' && <span className="tag">× {node.count}</span>}
            {node.lifter !== undefined && <span className="tag">{t('studio.lifter')}</span>}
            {node.required && <span className="tag">{t('studio.requiredTag')}</span>}
            {node.newChildren === 'skip' && <span className="tag">{t('studio.skipTag')}</span>}
          </>
        }
      >
        <Icon node={node} />
        {node.label ? (
          <>
            <strong>{localize(node.label, i18n.language)}</strong>
            <span className="tag">{shown.text}</span>
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
          {children.map((child) => (
            <Row key={`${child.kind}:${child.name}`} {...props} node={child} path={[...path, child.name]} />
          ))}
        </ul>
      )}
    </li>
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
  const siblings = (getNode(tree, parentPath)?.children ?? []).map((c) => [...parentPath, c.name]);
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

/** The full path of a node for people: `tweets / each item / stats / likes`. */
function fullPath(path: NodePath, t: (key: string) => string): string {
  return path.map((n) => displayName(n, t)).join(' / ');
}

function FieldsView(props: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const groups = useMemo(() => outline(props.tree), [props.tree]);
  const short = useMemo(() => {
    const names = new Map<string, ShortName>();
    const visit = (group: OutlineGroup) => {
      const fields = group.fields.filter((f) => f.path.length > group.path.length);
      shortNames(props.tree, fields.map((f) => f.path), group.path).forEach((n, i) => names.set(pathKey(fields[i]!.path), n));
      group.groups.forEach(visit);
    };
    visit(groups);
    return names;
  }, [groups, props.tree]);
  return (
    <ul className="decision-tree fields-view" aria-label={t('studio.tree')}>
      <GroupBody {...props} short={short} group={groups} />
    </ul>
  );
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

type FieldsProps = Props & { short: Map<string, ShortName> };

function GroupBody(props: FieldsProps & { group: OutlineGroup }) {
  const { group } = props;
  return (
    <>
      {group.fields.map((field) => (
        <FieldRow key={pathKey(field.path)} {...props} group={group} field={field} />
      ))}
      {group.groups.filter((g) => visibleGroup(props, g)).map((g) => (
        <GroupRow key={pathKey(g.path)} {...props} group={g} />
      ))}
    </>
  );
}

function FieldRow(props: FieldsProps & { group: OutlineGroup; field: OutlineGroup['fields'][number] }) {
  const { t, i18n } = useTranslation(undefined, { lng: 'en' });
  const { group, field, states } = props;
  const node = visibleField(props, field.path);
  if (!node) return null;
  const short = node.label === undefined ? props.short.get(pathKey(field.path)) : undefined;
  const name = short?.short ?? (localize(field.name, i18n.language) || t('studio.valueColumn'));
  const where = fullPath(field.path, t);
  return (
    <li className={`decision-row ${stateClass(node, states)}`}>
      <Line props={props} node={node} path={field.path} name={name} title={where}>
        {/* A list of plain values below the row is one field: a list cell. */}
        <Icon node={node} list={field.path.slice(group.path.length).includes('[*]')} />
        {short?.shortened && <PathMore />}
        {name}
        <span className="visually-hidden"> ({where})</span>
      </Line>
    </li>
  );
}

function GroupRow(props: FieldsProps & { group: OutlineGroup }) {
  const { t, i18n } = useTranslation(undefined, { lng: 'en' });
  const { group, states, open, actions } = props;
  const node = getNode(props.tree, group.path)!;
  // The list a table's rows belong to holds its count and is what researchers think of.
  const list = getNode(props.tree, group.path.slice(0, -1));
  const key = `fields:${pathKey(group.path)}`;
  const isOpen = !open.has(key);
  const name = localize(group.name, i18n.language) || t('studio.unnamedTable');
  return (
    <li className={`decision-row group ${stateClass(node, states)}`}>
      <Line
        props={props}
        node={node}
        path={group.path}
        name={name}
        title={fullPath(group.path, t)}
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
            {(list?.count ?? node.count) && (list?.count ?? node.count) !== '1' && <span className="tag">× {list?.count ?? node.count}</span>}
            {group.keyed && <span className="tag">{t('studio.keysTag')}</span>}
            {node.headerRow && <span className="tag">{t('studio.headerRowTag')}</span>}
          </>
        }
      >
        <span className="node-icon icon-table" aria-hidden="true">
          ▦
        </span>
        <span className="visually-hidden">{t('studio.icon.table')}: </span>
        <strong>{name}</strong>
      </Line>
      {isOpen && (
        <ul>
          <GroupBody {...props} group={group} />
        </ul>
      )}
    </li>
  );
}
