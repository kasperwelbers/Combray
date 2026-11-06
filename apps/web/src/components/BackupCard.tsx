import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { data } from '../worker/client';

/** Save a file the worker made, through a temporary link. */
function save(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Large files take a moment to start; the link is not needed after that.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Offers a backup file of the participant's space: still encrypted, it opens with their password
 * on this or another computer (docs/key-design.md#8-the-backup-file).
 */
export function BackupCard() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function backup() {
    setBusy(true);
    try {
      const { file, name } = await data.backup();
      save(file, name);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card backup-call" aria-labelledby="backup-call-title">
      <h2 id="backup-call-title">{t('backup.title')}</h2>
      <p>{t('backup.intro')}</p>
      <p className="meta">{t('backup.after')}</p>
      <button type="button" className="button quiet" disabled={busy} onClick={() => void backup()}>
        {busy ? t('lock.working') : t('backup.save')}
      </button>
      {saved && (
        <p className="meta" role="status">
          {t('backup.saved')}
        </p>
      )}
    </section>
  );
}
