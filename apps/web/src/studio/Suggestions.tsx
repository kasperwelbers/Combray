import { getNode, type CombineSuggestion, type NodePath, type ProjectNode } from '@combray/core';
import { useTranslation } from 'react-i18next';

import { displayName } from './model';

interface Props {
  tree: ProjectNode;
  suggestions: CombineSuggestion[];
  onCombine: (suggestion: CombineSuggestion) => void;
  onSameName: (suggestion: CombineSuggestion) => void;
  onDismiss: (suggestion: CombineSuggestion) => void;
  onShow: (path: NodePath) => void;
}

/**
 * Parts of a new package that may be a renamed or translated version of a part the configuration
 * already has (ADR 0012). The researcher combines them into one node (one set of settings for
 * both), gives them the same name (each keeps its own settings), or says they differ.
 */
export function Suggestions({ tree, suggestions, onCombine, onSameName, onDismiss, onShow }: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  if (suggestions.length === 0) return null;
  const name = (path: NodePath) => displayName(getNode(tree, path)?.name ?? '', t);
  const where = (path: NodePath) =>
    path
      .slice(0, -1)
      .map((_, i) => displayName(getNode(tree, path.slice(0, i + 1))?.name ?? '', t))
      .join(' / ') || t('studio.root');
  return (
    <section className="card suggestions" aria-labelledby="studio-suggestions">
      <h2 id="studio-suggestions">{t('studio.suggestTitle')}</h2>
      <p className="meta">{t('studio.suggestIntro')}</p>
      <ul>
        {suggestions.map((s) => (
          <li key={`${s.from.join('/')}>${s.into.join('/')}`}>
            <p>
              {t('studio.suggestQuestion', { from: name(s.from), into: name(s.into) })}{' '}
              <span className="meta">
                {t('studio.suggestWhere', { where: where(s.into) })} ·{' '}
                {t('studio.suggestScore', { score: Math.round(s.score * 100) })}
              </span>
            </p>
            <div className="actions">
              <button type="button" className="button" onClick={() => onCombine(s)}>
                {t('studio.combine.action')}
              </button>
              <button type="button" className="button quiet" onClick={() => onSameName(s)}>
                {t('studio.sameName.action')}
              </button>
              <button type="button" className="button quiet" onClick={() => onDismiss(s)}>
                {t('studio.suggestDismiss')}
              </button>
              <button type="button" className="link-button" onClick={() => onShow(s.from)}>
                {t('studio.suggestShow', { name: name(s.from) })}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
