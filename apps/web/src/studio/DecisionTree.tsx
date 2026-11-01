import {
  getNode,
  isDecidable,
  isLeaf,
  localize,
  outline,
  type EffectiveState,
  type NodePath,
  type OutlineGroup,
  type ProjectNode,
} from '@combray/core';
import { useMemo, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { displayName, foldChain, formsTable, isUndecided, nodeIcon, pathKey, type Shortcut } from './model';

export type TreeView = 'tree' | 'fields';

export interface TreeActions {
  select: (path: NodePath) => void;
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
}

const SHORTCUTS = new Set<string>(['1', '2', '3', '4']);

/**
 * The project tree for decisions. Rows are coloured by their state and selected to change it
 * (in the side panel, or with keys 1 to 4). The fields view shows only tables and fields, named
 * as their columns, which is all most researchers need to pick data.
 */
export function DecisionTree(props: Props) {
  const { t } = useTranslation();
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

function StatePill({ node, states }: { node: ProjectNode; states: Map<ProjectNode, EffectiveState> }) {
  const { t } = useTranslation();
  const state = states.get(node) ?? 'show';
  if (!isDecidable(node)) {
    return node.decision === 'ignore' ? <span className="pill pill-ignore">{t('studio.pill.ignore')}</span> : null;
  }
  const shown = isUndecided(node, states) ? 'undecided' : state;
  return <span className={`pill pill-${shown}`}>{t(`studio.pill.${shown}`)}</span>;
}

function Icon({ node, list }: { node: ProjectNode; list?: boolean }) {
  const { t } = useTranslation();
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
  const { t, i18n } = useTranslation();
  const { states, undecided, onlyUndecided, hideIgnored, open, selected, actions } = props;
  const chain = foldChain(props.node, props.path);
  const top = chain[0]!;
  const { node, path } = chain.at(-1)!;
  if (onlyUndecided && (undecided.get(top.node) ?? 0) === 0) return null;
  if (hideIgnored && states.get(top.node) === 'ignore') return null;

  const leaf = isLeaf(node);
  const key = pathKey(path);
  const isOpen = open.has(key);
  const isSelected = selected !== undefined && pathKey(selected) === key;
  const name = chain.map((c) => displayName(c.node.name, t)).join(' / ');
  const children = leaf ? [] : (node.children ?? []);

  return (
    <li className={`decision-row ${stateClass(node, states)}`}>
      <div className={`decision-line${isSelected ? ' selected' : ''}`}>
        {children.length > 0 ? (
          <button
            type="button"
            className="toggle"
            aria-expanded={isOpen}
            aria-label={isOpen ? t('studio.collapse', { name }) : t('studio.expand', { name })}
            onClick={() => actions.toggleOpen(key)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="toggle" aria-hidden="true" />
        )}
        <button
          type="button"
          className="decision-name"
          aria-current={isSelected}
          onClick={() => actions.select(path)}
          onKeyDown={rowKeys(path, actions)}
        >
          <Icon node={node} />
          {node.label ? <strong>{localize(node.label, i18n.language)}</strong> : name}
          {node.label && <span className="tag">{name}</span>}
        </button>
        <span className="decision-tags">
          {node.count && <span className="tag">× {node.count}</span>}
          {node.lifter !== undefined && <span className="tag">{t('studio.lifter')}</span>}
        </span>
        <StatePill node={node} states={states} />
      </div>
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

/** The full path of a node for people: `tweets / each item / stats / likes`. */
function fullPath(path: NodePath, t: (key: string) => string): string {
  return path.map((n) => displayName(n, t)).join(' / ');
}

function FieldsView(props: Props) {
  const { t } = useTranslation();
  const groups = useMemo(() => outline(props.tree), [props.tree]);
  return (
    <ul className="decision-tree fields-view" aria-label={t('studio.tree')}>
      <GroupBody {...props} group={groups} />
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

function GroupBody(props: Props & { group: OutlineGroup }) {
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

function FieldRow(props: Props & { group: OutlineGroup; field: OutlineGroup['fields'][number] }) {
  const { t, i18n } = useTranslation();
  const { group, field, states, selected, actions } = props;
  const node = visibleField(props, field.path);
  if (!node) return null;
  const isSelected = selected !== undefined && pathKey(selected) === pathKey(field.path);
  const name = localize(field.name, i18n.language) || t('studio.valueColumn');
  const where = fullPath(field.path, t);
  return (
    <li className={`decision-row ${stateClass(node, states)}`}>
      <div className={`decision-line${isSelected ? ' selected' : ''}`}>
        <button
          type="button"
          className="decision-name"
          aria-current={isSelected}
          title={where}
          onClick={() => actions.select(field.path)}
          onKeyDown={rowKeys(field.path, actions)}
        >
          {/* A list of plain values below the row is one field: a list cell. */}
          <Icon node={node} list={field.path.slice(group.path.length).includes('[*]')} />
          {name}
          <span className="visually-hidden"> ({where})</span>
        </button>
        <span className="decision-tags" />
        <StatePill node={node} states={states} />
      </div>
    </li>
  );
}

function GroupRow(props: Props & { group: OutlineGroup }) {
  const { t, i18n } = useTranslation();
  const { group, states, open, selected, actions } = props;
  const node = getNode(props.tree, group.path)!;
  // The list a table's rows belong to holds its count and is what researchers think of.
  const list = getNode(props.tree, group.path.slice(0, -1));
  const key = `fields:${pathKey(group.path)}`;
  const isOpen = !open.has(key);
  const isSelected = selected !== undefined && pathKey(selected) === pathKey(group.path);
  const name = localize(group.name, i18n.language) || t('studio.unnamedTable');
  return (
    <li className={`decision-row group ${stateClass(node, states)}`}>
      <div className={`decision-line${isSelected ? ' selected' : ''}`}>
        <button
          type="button"
          className="toggle"
          aria-expanded={isOpen}
          aria-label={isOpen ? t('studio.collapse', { name }) : t('studio.expand', { name })}
          onClick={() => actions.toggleOpen(key)}
        >
          {isOpen ? '▾' : '▸'}
        </button>
        <button
          type="button"
          className="decision-name"
          aria-current={isSelected}
          title={fullPath(group.path, t)}
          onClick={() => actions.select(group.path)}
          onKeyDown={rowKeys(group.path, actions)}
        >
          <span className="node-icon icon-table" aria-hidden="true">
            ▦
          </span>
          <span className="visually-hidden">{t('studio.icon.table')}: </span>
          <strong>{name}</strong>
        </button>
        <span className="decision-tags">
          {(list?.count ?? node.count) && <span className="tag">× {list?.count ?? node.count}</span>}
          {group.keyed && <span className="tag">{t('studio.keysTag')}</span>}
        </span>
        <StatePill node={node} states={states} />
      </div>
      {isOpen && (
        <ul>
          <GroupBody {...props} group={group} />
        </ul>
      )}
    </li>
  );
}
