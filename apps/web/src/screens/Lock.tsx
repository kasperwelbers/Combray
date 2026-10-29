import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Madeleine } from '../components/Madeleine';

export const MIN_PASSPHRASE = 10;

interface Props {
  exists: boolean;
  notice?: string;
  onCreate: (passphrase: string) => Promise<void>;
  onUnlock: (passphrase: string) => Promise<boolean>;
  onDeleteAll: () => Promise<void>;
}

export function Lock({ exists, notice, onCreate, onUnlock, onDeleteAll }: Props) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!exists) {
      if (passphrase.length < MIN_PASSPHRASE) return setError(t('lock.tooShort', { min: MIN_PASSPHRASE }));
      if (passphrase !== confirm) return setError(t('lock.mismatch'));
    }
    setBusy(true);
    try {
      if (exists) {
        if (!(await onUnlock(passphrase))) setError(t('lock.wrong'));
      } else {
        await onCreate(passphrase);
      }
    } finally {
      setBusy(false);
    }
  }

  async function deleteAll() {
    if (window.confirm(t('lock.confirmDelete'))) await onDeleteAll();
  }

  return (
    <div className="lock card">
      <Madeleine size={72} className="madeleine" />
      <h1>{exists ? t('lock.unlockTitle') : t('lock.createTitle')}</h1>
      {notice && <p className="message">{notice}</p>}
      <p>{exists ? t('lock.unlockIntro') : t('lock.createIntro')}</p>
      <form onSubmit={submit} noValidate>
        <label className="field">
          {t('lock.passphrase')}
          <input
            type="password"
            autoComplete={exists ? 'current-password' : 'new-password'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            required
          />
        </label>
        {!exists && (
          <label className="field">
            {t('lock.confirm')}
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
        )}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        <button className="button" type="submit" disabled={busy}>
          {busy ? t('lock.working') : exists ? t('lock.unlock') : t('lock.create')}
        </button>
      </form>
      {exists && (
        <p style={{ marginTop: '1.5rem' }}>
          <button className="link-button" type="button" onClick={deleteAll}>
            {t('lock.forgot')}
          </button>
        </p>
      )}
    </div>
  );
}
