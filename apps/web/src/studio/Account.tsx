import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Who is signed in to the studio, and their projects. Researchers sign in on the key page (its
 * own origin, docs/researcher-keys.md); "Open the studio" there sends them here with a one-time
 * code in the fragment (`/studio/#handoff=…`), which this card trades for a studio session. The
 * studio session can list projects and donations but never receives key material: opening
 * donations happens on the key page only.
 *
 * On a server without researcher accounts, or in `pnpm dev` without a server, the card is not
 * shown and the studio works as a local workspace.
 */

interface Site {
  researchers: boolean;
  keys_url?: string;
}

interface Project {
  id: string;
  name: unknown;
  has_access: boolean;
  fingerprint: string | null;
}

type State =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'signed-out'; keysUrl: string; failed?: boolean }
  | { kind: 'signed-in'; keysUrl: string; email: string; projects: Project[] };

const HANDOFF = /^[A-Za-z0-9_-]{20,100}$/;

/** Take the handoff code out of the address bar, so it is not kept in history. */
function takeHandoff(): string | undefined {
  const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('handoff');
  if (location.hash) history.replaceState(null, '', location.pathname);
  return code && HANDOFF.test(code) ? code : undefined;
}

async function getJson<T>(path: string): Promise<T | undefined> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) return undefined;
  return (await response.json()) as T;
}

async function post(path: string, body?: unknown): Promise<boolean> {
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.ok;
}

export function projectName(project: Pick<Project, 'id' | 'name'>): string {
  const name = project.name;
  if (typeof name === 'string' && name) return name;
  if (name && typeof name === 'object') {
    const values = name as Record<string, unknown>;
    const text = values.en ?? Object.values(values).find((v) => typeof v === 'string');
    if (typeof text === 'string' && text) return text;
  }
  return project.id;
}

async function load(handoff: string | undefined): Promise<State> {
  const site = await getJson<Site>('/site').catch(() => undefined);
  if (!site?.researchers || !site.keys_url) return { kind: 'hidden' };
  const keysUrl = site.keys_url;
  let failed = false;
  if (handoff) failed = !(await post('/auth/handoff/redeem', { code: handoff }));
  const me = await getJson<{ email: string; signed_in: boolean }>('/me');
  if (!me?.signed_in) return { kind: 'signed-out', keysUrl, failed };
  const list = await getJson<{ projects: Project[] }>('/projects');
  return { kind: 'signed-in', keysUrl, email: me.email, projects: list?.projects ?? [] };
}

export function Account() {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const handoff = takeHandoff();
    void load(handoff)
      .catch((): State => ({ kind: 'hidden' }))
      .then((s) => {
        if (!cancelled) setState(s);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading' || state.kind === 'hidden') return null;

  if (state.kind === 'signed-out') {
    return (
      <section className="card studio-account" aria-labelledby="studio-account">
        <h2 id="studio-account">{t('studio.accountTitle')}</h2>
        {state.failed && <p role="alert">{t('studio.handoffFailed')}</p>}
        <p className="meta">{t('studio.signedOut')}</p>
        <a className="button" href={state.keysUrl}>
          {t('studio.signInOnKeyPage')}
        </a>
      </section>
    );
  }

  async function signOut() {
    await post('/auth/logout').catch(() => false);
    setState({ kind: 'signed-out', keysUrl: (state as { keysUrl: string }).keysUrl });
  }

  return (
    <section className="card studio-account" aria-labelledby="studio-account">
      <h2 id="studio-account">{t('studio.accountTitle')}</h2>
      <p className="meta">{t('studio.signedInAs', { email: state.email })}</p>
      {state.projects.length === 0 ? (
        <p>{t('studio.noProjects')}</p>
      ) : (
        <ul className="export-list">
          {state.projects.map((p) => (
            <li key={p.id}>
              <span>{projectName(p)}</span>
              <span className="meta">
                {' · '}
                {!p.fingerprint ? t('studio.projectNoKey') : p.has_access ? t('studio.projectReady') : t('studio.projectNoAccess')}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="meta">{t('studio.keysElsewhere')}</p>
      <p>
        <a href={state.keysUrl}>{t('studio.openKeyPage')}</a>
        {' · '}
        <button type="button" className="link-button" onClick={() => void signOut()}>
          {t('studio.signOut')}
        </button>
      </p>
    </section>
  );
}
