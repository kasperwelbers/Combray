import { combineProblem, getNode, type NodePath, type ProjectNode } from '@combray/core';
import { useTranslation } from 'react-i18next';

import { displayName } from './model';

/**
 * The rows picked in select mode, and the two ways to join them (ADR 0012): combine into one
 * node (siblings of one kind: one set of settings for all their keys), or give them the same
 * name (each keeps its own settings; participants see one table or column).
 */
export function SelectionBar({
  tree,
  paths,
  onCombine,
  onSameName,
  onClear,
}: {
  tree: ProjectNode;
  paths: NodePath[];
  onCombine: () => void;
  onSameName: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const nodes = paths.flatMap((p) => getNode(tree, p) ?? []);
  const problem = paths.length > 1 ? combineProblem(tree, paths) : undefined;
  return (
    <div className="selection-bar" role="region" aria-label={t('studio.select.label')}>
      <p className="meta">
        {paths.length === 0
          ? t('studio.select.help')
          : t('studio.select.count', { count: paths.length, names: nodes.map((n) => displayName(n.name, t)).join(', ') })}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={paths.length < 2 || problem !== undefined}
          title={problem ? t('studio.combine.refused', { reason: problem }) : t('studio.combine.help')}
          onClick={onCombine}
        >
          {t('studio.combine.action')}
        </button>
        <button type="button" className="button quiet" disabled={paths.length < 2} title={t('studio.sameName.help')} onClick={onSameName}>
          {t('studio.sameName.action')}
        </button>
        <button type="button" className="link-button" disabled={paths.length === 0} onClick={onClear}>
          {t('studio.select.clear')}
        </button>
      </div>
      {paths.length > 1 && problem && <p className="meta">{t('studio.combine.refused', { reason: problem })}</p>}
    </div>
  );
}
