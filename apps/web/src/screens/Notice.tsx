import { useTranslation } from 'react-i18next';

import { Madeleine } from '../components/Madeleine';

export type NoticeKind = 'not-found' | 'unreachable' | 'needs-id' | 'reset-no-store';

/** A calm full-page message for when there is nothing to open (yet). */
export function Notice({ kind }: { kind: NoticeKind }) {
  const { t } = useTranslation();
  return (
    <div className="lock card">
      <Madeleine size={72} className="madeleine" />
      <h1>{t(`notice.${kind}.title`)}</h1>
      <p>{t(`notice.${kind}.text`)}</p>
      <p>
        <a href="/">{t('projects.all')}</a>
      </p>
    </div>
  );
}
