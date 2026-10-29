import { isLeaf, localize, type EffectiveState, type LeafDecision, type NodePath, type ProjectNode } from '@combray/core';
import { useTranslation } from 'react-i18next';

import { foldChain, isUndecided, pathKey } from './model';

const ICONS: Record<ProjectNode['kind'], string> = {
  dir: '📁',
  map: '◇',
  list: '☰',
  value: '·',
  element: '‹›',
  text: '¶',
  blob: '🖼',
};

const LEAF_DECISIONS: LeafDecision[] = ['undecided', 'ignore', 'show', 'donate'];

export interface TreeActions {
  select: (path: NodePath) => void;
  setLeaf: (path: NodePath, decision: LeafDecision) => void;
  toggleIgnore: (path: NodePath) => void;
  toggleTable: (path: NodePath) => void;
  toggleOpen: (path: NodePath) => void;
}

interface Props {
  tree: ProjectNode;
  states: Map<ProjectNode, EffectiveState>;
  undecided: Map<ProjectNode, number>;
  onlyUndecided: boolean;
  open: Set<string>;
  selected?: NodePath;
  actions: TreeActions;
}

/** The project tree with a decision control on every row. */
export function DecisionTree(props: Props) {
  const { t } = useTranslation();
  const children = props.tree.children ?? [];
  if (isLeaf(props.tree)) {
    return (
      <ul className="decision-tree" aria-label={t('studio.tree')}>
        <Row {...props} node={props.tree} path={[]} />
      </ul>
    );
  }
  return (
    <ul className="decision-tree" aria-label={t('studio.tree')}>
      {children.map((child) => (
        <Row key={`${child.kind}:${child.name}`} {...props} node={child} path={[child.name]} />
      ))}
    </ul>
  );
}

function Row(props: Props & { node: ProjectNode; path: NodePath }) {
  const { t, i18n } = useTranslation();
  const { states, undecided, onlyUndecided, open, selected, actions } = props;
  const chain = foldChain(props.node, props.path);
  const top = chain[0]!;
  const { node, path } = chain.at(-1)!;
  if (onlyUndecided && (undecided.get(top.node) ?? 0) === 0) return null;

  const state = states.get(node) ?? 'show';
  const leaf = isLeaf(node);
  const ignoredAbove = state === 'ignore' && top.node.decision !== 'ignore' && node.decision !== 'ignore';
  const isOpen = open.has(pathKey(path));
  const isSelected = selected !== undefined && pathKey(selected) === pathKey(path);
  const name = chain.map((c) => c.node.name || t('studio.root')).join(' / ');
  const children = leaf ? [] : (node.children ?? []);

  return (
    <li className={`decision-row state-${isUndecided(node, states) ? 'undecided' : state}`}>
      <div className={`decision-line${isSelected ? ' selected' : ''}`}>
        {children.length > 0 ? (
          <button
            type="button"
            className="toggle"
            aria-expanded={isOpen}
            aria-label={isOpen ? t('studio.collapse', { name }) : t('studio.expand', { name })}
            onClick={() => actions.toggleOpen(path)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="toggle" aria-hidden="true" />
        )}
        <button type="button" className="decision-name" aria-current={isSelected} onClick={() => actions.select(path)}>
          <span aria-hidden="true">{ICONS[node.kind]} </span>
          <span className="visually-hidden">{t(`kind.${node.kind}`)}: </span>
          {node.label ? <strong>{localize(node.label, i18n.language)}</strong> : name}
          {node.label && <span className="tag">{name}</span>}
        </button>
        <span className="decision-tags">
          {node.types?.map((type) => (
            <span key={type} className="tag">
              {t(`type.${type}`)}
            </span>
          ))}
          {node.count && <span className="tag">× {node.count}</span>}
          {node.aliases && node.aliases.length > 0 && (
            <span className="tag">{t('studio.aliases', { count: node.aliases.length })}</span>
          )}
          {node.lifter !== undefined && <span className="tag">{t('studio.lifter')}</span>}
        </span>
        <span className="decision-controls">
          {leaf ? (
            ignoredAbove ? (
              <span className="meta">{t('studio.ignoredAbove')}</span>
            ) : (
              <span className="segmented" role="group" aria-label={t('studio.decisionFor', { name })}>
                {LEAF_DECISIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`seg seg-${d}`}
                    aria-pressed={(node.decision ?? 'undecided') === d}
                    onClick={() => actions.setLeaf(path, d)}
                  >
                    {t(`studio.decision.${d}`)}
                  </button>
                ))}
              </span>
            )
          ) : (
            <span className="segmented" role="group" aria-label={t('studio.decisionFor', { name })}>
              <button
                type="button"
                className="seg seg-ignore"
                aria-pressed={top.node.decision === 'ignore'}
                disabled={ignoredAbove}
                onClick={() => actions.toggleIgnore(top.path)}
              >
                {t('studio.decision.ignore')}
              </button>
              <button
                type="button"
                className="seg seg-table"
                aria-pressed={node.table === true}
                disabled={state === 'ignore'}
                onClick={() => actions.toggleTable(path)}
              >
                {t('studio.table')}
              </button>
            </span>
          )}
        </span>
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
