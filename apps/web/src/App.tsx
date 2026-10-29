import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Madeleine, Skyline } from './components/Madeleine';
import { useIdleLock } from './components/useIdleLock';
import { LANGUAGES } from './i18n';
import { Explore } from './screens/Explore';
import { Home } from './screens/Home';
import { Lock } from './screens/Lock';
import type { DatasetSummary, StoreStatus } from './worker/api';
import { data } from './worker/client';

const IDLE_MINUTES = 15;

export function App() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<StoreStatus>();
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [open, setOpen] = useState<DatasetSummary>();
  const [notice, setNotice] = useState<string>();

  const refresh = useCallback(async () => {
    const s = await data.status();
    setStatus(s);
    setDatasets(s.unlocked ? await data.listDatasets() : []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lock = useCallback(
    async (message?: string) => {
      await data.lock();
      setOpen(undefined);
      setNotice(message);
      await refresh();
    },
    [refresh],
  );

  const onIdle = useCallback(() => void lock(t('lock.autoLocked')), [lock, t]);
  useIdleLock(status?.unlocked ?? false, IDLE_MINUTES, onIdle);

  async function deleteAll() {
    await data.destroy();
    setOpen(undefined);
    setNotice(undefined);
    await refresh();
  }

  async function deleteAllConfirmed() {
    if (window.confirm(t('lock.confirmDelete'))) await deleteAll();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Madeleine />
          Combray
        </div>
        <div className="topbar-actions">
          <label>
            <span className="visually-hidden">{t('app.language')}</span>
            <select value={i18n.resolvedLanguage} onChange={(e) => void i18n.changeLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l === 'nl' ? 'Nederlands' : 'English'}
                </option>
              ))}
            </select>
          </label>
          {status?.unlocked && (
            <button className="button quiet" type="button" onClick={() => void lock()}>
              🔒 {t('lock.lock')}
            </button>
          )}
        </div>
      </header>

      <main>
        {!status ? null : !status.unlocked ? (
          <Lock
            exists={status.exists}
            {...(notice ? { notice } : {})}
            onCreate={async (passphrase) => {
              await data.create(passphrase);
              await refresh();
            }}
            onUnlock={async (passphrase) => {
              const result = await data.unlock(passphrase);
              if (result === 'ok') {
                setNotice(undefined);
                await refresh();
              }
              return result === 'ok';
            }}
            onDeleteAll={deleteAll}
          />
        ) : open ? (
          <Explore dataset={open} onBack={() => setOpen(undefined)} />
        ) : (
          <>
            <h1>{t('app.tagline')}</h1>
            <Home datasets={datasets} onChanged={refresh} onOpen={setOpen} />
            <p style={{ marginTop: '3rem' }}>
              <button className="link-button" type="button" onClick={deleteAllConfirmed}>
                {t('lock.deleteAll')}
              </button>
            </p>
          </>
        )}
      </main>

      <footer>
        <Skyline />
        <div className="footer">{t('app.local')}</div>
      </footer>
    </div>
  );
}
