import type { MergeSuggestion, NodePath } from '@combray/core';
import { useTranslation } from 'react-i18next';

import { displayName } from './model';

interface Props {
  suggestions: MergeSuggestion[];
  onMerge: (suggestion: MergeSuggestion) => void;
  onDismiss: (suggestion: MergeSuggestion) => void;
  onShow: (path: NodePath) => void;
}

/**
 * Parts of a new export that may be a renamed or translated version of a part the project
 * already knows. Merging adds the new name as an alias; the researcher decides each one.
 */
export function Suggestions({ suggestions, onMerge, onDismiss, onShow }: Props) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  if (suggestions.length === 0) return null;
  const name = (path: NodePath) => displayName(path.at(-1)!, t);
  const where = (path: NodePath) => path.slice(0, -1).map((n) => displayName(n, t)).join(' / ') || t('studio.root');
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
              <button type="button" className="button" onClick={() => onMerge(s)}>
                {t('studio.suggestMerge')}
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
