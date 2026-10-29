import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Madeleine } from '../components/Madeleine';
import type { CreateResult, UnlockResult } from '../worker/api';

/** The server's minimum; see crates/combray-server/src/keys.rs. */
export const MIN_PASSWORD = 8;

interface Props {
  exists: boolean;
  notice?: string;
  onCreate: (password: string) => Promise<CreateResult>;
  onUnlock: (password: string) => Promise<UnlockResult>;
  onDeleteAll: () => Promise<void>;
}

export function Lock({ exists, notice, onCreate, onUnlock, onDeleteAll }: Props) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  function problem(result: CreateResult | UnlockResult): string | undefined {
    const wait = (seconds: number) => t('lock.wait', { count: Math.ceil(seconds / 60) });
    switch (result.status) {
      case 'ok':
        return undefined;
      case 'invalid-password':
        return t('lock.tooShort', { min: MIN_PASSWORD });
      case 'wrong-password':
        return result.retryAfter ? `${t('lock.wrong')} ${wait(result.retryAfter)}` : t('lock.wrong');
      case 'too-many-attempts':
        return wait(result.retryAfter);
      case 'store-gone':
        return t('lock.storeGone');
      case 'unreachable':
        return t('lock.unreachable');
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (!exists) {
      if ([...password].length < MIN_PASSWORD) return setError(t('lock.tooShort', { min: MIN_PASSWORD }));
      if (password !== confirm) return setError(t('lock.mismatch'));
    }
    setBusy(true);
    try {
      setError(problem(exists ? await onUnlock(password) : await onCreate(password)));
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
          {t('lock.password')}
          <input
            type="password"
            autoComplete={exists ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
