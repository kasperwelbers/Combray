import { useTranslation } from 'react-i18next';

import { studioPath } from '../route';
import { localDraft } from './draft';
import { Studio } from './Studio';

const STEPS = ['packages', 'decisions', 'preview', 'chart'] as const;

/**
 * A place to practise with the tree editor, outside any project and without signing in. Packages
 * stay in the studio worker's memory; the tree and decisions are a draft in this browser only.
 */
export function Learn({ noServer }: { noServer?: boolean }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <div className="studio">
      {!noServer && (
        <p className="meta">
          <a href={studioPath()}>{t('studio.learn.back')}</a>
        </p>
      )}
      <h1>{t('studio.learn.title')}</h1>
      {noServer && <p className="message">{t('studio.learn.noServer')}</p>}
      <p>{t('studio.learn.intro')}</p>
      <details className="card">
        <summary>{t('studio.learn.stepsTitle')}</summary>
        <ol>
          {STEPS.map((step) => (
            <li key={step}>{t(`studio.learn.steps.${step}`)}</li>
          ))}
        </ol>
        <p className="meta">{t('studio.learn.privacy')}</p>
      </details>
      <Studio draft={localDraft()} intro={false} />
    </div>
  );
}
