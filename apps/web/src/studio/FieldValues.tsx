import { useTranslation } from 'react-i18next';

import type { FieldValues as Values } from './api';

/**
 * What a field holds in the researcher's test packages: how often it occurs, how many different
 * values it has, and the most common ones. Read in this tab only; nothing is stored or sent.
 */
export function FieldValues({ values, hasPackages }: { values: Values | undefined; hasPackages: boolean }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <section className="field-values" aria-label={t('studio.values.title')}>
      {!hasPackages ? (
        <p className="meta">{t('studio.values.noPackages')}</p>
      ) : !values ? null : values.total === 0 ? (
        <p className="meta">{t('studio.values.notFound')}</p>
      ) : (
        <>
          <p className="meta">
            {t('studio.values.summary', { count: values.total, distinct: values.distinct })}
            {values.empty > 0 && ` ${t('studio.values.empty', { count: values.empty })}`}
          </p>
          {values.top.length > 0 && (
            <ol className="value-list">
              {values.top.map((v) => (
                <li key={v.value}>
                  <span className="value-text">{v.value}</span>
                  <span className="meta">{v.count > 1 ? ` ${t('studio.values.times', { count: v.count })}` : ''}</span>
                </li>
              ))}
            </ol>
          )}
          {values.distinct > values.top.length && <p className="meta">{t('studio.values.more', { count: values.distinct - values.top.length })}</p>}
        </>
      )}
    </section>
  );
}
