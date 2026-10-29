import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Madeleine } from '../components/Madeleine';
import type { CreateResult, ResetResult, UnlockResult } from '../worker/api';

/** The server's minimum; see crates/combray-server/src/keys.rs. */
export const MIN_PASSWORD = 8;

interface Props {
  exists: boolean;
  /** Choose a new password with a reset link, instead of unlocking. */
  reset: boolean;
  participantId?: string;
  notice?: string;
  onCreate: (password: string) => Promise<CreateResult>;
  onUnlock: (password: string) => Promise<UnlockResult>;
  onReset: (password: string) => Promise<ResetResult>;
  onDeleteAll: () => Promise<void>;
}

export function Lock({ exists, reset, participantId, notice, onCreate, onUnlock, onReset, onDeleteAll }: Props) {
  // A new password is chosen when creating the store and when resetting it.
  const choosing = !exists || reset;
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  function problem(result: CreateResult | UnlockResult | ResetResult): string | undefined {
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
      case 'invalid-participant':
      case 'participant-required':
        return t('lock.invalidParticipant');
      case 'no-such-project':
        return t('notice.not-found.text');
      case 'invalid-token':
        return t('lock.resetInvalid');
      case 'unreachable':
        return t('lock.unreachable');
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (choosing) {
      if ([...password].length < MIN_PASSWORD) return setError(t('lock.tooShort', { min: MIN_PASSWORD }));
      if (password !== confirm) return setError(t('lock.mismatch'));
    }
    setBusy(true);
    try {
      const result = reset ? await onReset(password) : exists ? await onUnlock(password) : await onCreate(password);
      setError(problem(result));
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
      <h1>{reset ? t('lock.resetTitle') : exists ? t('lock.unlockTitle') : t('lock.createTitle')}</h1>
      {notice && <p className="message">{notice}</p>}
      <p>{reset ? t('lock.resetIntro') : exists ? t('lock.unlockIntro') : t('lock.createIntro')}</p>
      {participantId && !exists && <p className="muted">{t('lock.participant', { id: participantId })}</p>}
      <form onSubmit={submit} noValidate>
        <label className="field">
          {t('lock.password')}
          <input
            type="password"
            autoComplete={choosing ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
        </label>
        {choosing && (
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
          {busy ? t('lock.working') : reset ? t('lock.reset') : exists ? t('lock.unlock') : t('lock.create')}
        </button>
      </form>
      {exists && !reset && (
        <p style={{ marginTop: '1.5rem' }}>
          {participantId && (
            <>
              {t('lock.askReset')}{' '}
            </>
          )}
          <button className="link-button" type="button" onClick={deleteAll}>
            {participantId ? t('lock.startOver') : t('lock.forgot')}
          </button>
        </p>
      )}
    </div>
  );
}
