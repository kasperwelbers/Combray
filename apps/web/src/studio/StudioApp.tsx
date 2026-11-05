import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { studioPath, type StudioTab } from '../route';
import { EXAMPLES, exampleApi, type ExampleProject } from './exampleApi';
import { Project } from './Project';
import { ApiFailure, createProject, ProjectApiContext, SIGNED_OUT_EVENT } from './projectApi';

/**
 * The researcher workspace: sign in, pick a project, work on it (docs/researcher-keys.md).
 *
 * Researchers sign in here with a code from their email, which gives a long studio session (the
 * studio never receives key material; opening donations needs the passkey on the key page). The
 * key page can also send researchers here with a one-time code in the fragment
 * (`/studio/#handoff=…`), traded for the same kind of session.
 *
 * Example projects (`/studio/example/{id}/`) are open without sign-in, and kept in the tab. On a
 * server without researcher accounts, or without a server, they are all the studio shows.
 */

interface Site {
  researchers: boolean;
  keys_url?: string;
  mail_outbox?: boolean;
}

export interface StudioProject {
  id: string;
  name: unknown;
  has_access: boolean;
  fingerprint: string | null;
}

type State =
  | { kind: 'loading' }
  | { kind: 'local' }
  | { kind: 'signed-out'; site: Site; handoffFailed?: boolean }
  | { kind: 'signed-in'; site: Site; email: string; projects: StudioProject[] };

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

/** POST to the researcher API; returns the error code on failure. */
async function post(path: string, body?: unknown): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return { ok: true };
  const answer = (await response.json().catch(() => ({}))) as { error?: string };
  return { ok: false, status: response.status, error: answer.error ?? 'unknown' };
}

export function projectName(project: Pick<StudioProject, 'id' | 'name'>): string {
  const name = project.name;
  if (typeof name === 'string' && name) return name;
  if (name && typeof name === 'object') {
    const values = name as Record<string, unknown>;
    const text = values.en ?? Object.values(values).find((v) => typeof v === 'string');
    if (typeof text === 'string' && text) return text;
  }
  return project.id;
}

async function load(handoff?: string): Promise<State> {
  const site = await getJson<Site>('/site').catch(() => undefined);
  if (!site?.researchers) return { kind: 'local' };
  let handoffFailed = false;
  if (handoff) handoffFailed = !(await post('/auth/handoff/redeem', { code: handoff })).ok;
  const me = await getJson<{ email: string; signed_in: boolean }>('/me');
  if (!me?.signed_in) return { kind: 'signed-out', site, handoffFailed };
  const list = await getJson<{ projects: StudioProject[] }>('/projects');
  return { kind: 'signed-in', site, email: me.email, projects: list?.projects ?? [] };
}

export function StudioApp({ projectId, tab, example }: { projectId?: string; tab?: StudioTab; example?: boolean }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [state, setState] = useState<State>({ kind: 'loading' });

  // A session ends after an hour without activity: any answer "not signed in" brings back the sign-in.
  useEffect(() => {
    const onSignedOut = () => setState((s) => (s.kind === 'signed-in' ? { kind: 'signed-out', site: s.site } : s));
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  useEffect(() => {
    if (example) return;
    let cancelled = false;
    void load(takeHandoff())
      .catch((): State => ({ kind: 'local' }))
      .then((s) => {
        if (!cancelled) setState(s);
      });
    return () => {
      cancelled = true;
    };
  }, [example]);

  if (example && projectId) return <Example id={projectId} {...(tab ? { tab } : {})} />;

  if (state.kind === 'loading') return null;
  if (state.kind === 'local') {
    return (
      <div className="studio">
        <h1>{t('studio.examples.workspaceTitle')}</h1>
        <p className="message">{t('studio.examples.noServer')}</p>
        <Examples />
      </div>
    );
  }
  if (state.kind === 'signed-out') {
    return (
      <SignIn site={state.site} {...(state.handoffFailed ? { handoffFailed: true } : {})} />
    );
  }

  const signOut = async () => {
    await post('/auth/logout').catch(() => undefined);
    setState({ kind: 'signed-out', site: state.site });
  };
  const account = (
    <p className="meta studio-account">
      {t('studio.signedInAs', { email: state.email })}
      {' · '}
      <button type="button" className="link-button" onClick={() => void signOut()}>
        {t('studio.signOut')}
      </button>
    </p>
  );

  if (!projectId) {
    return (
      <div className="studio">
        <h1>{t('studio.projectsTitle')}</h1>
        {account}
        {state.projects.length === 0 ? (
          <p>{t('studio.noProjects')}</p>
        ) : (
          <ul className="studio-projects">
            {state.projects.map((p) => (
              <li key={p.id} className="card">
                <a href={studioPath(p.id)}>{projectName(p)}</a>
                <span className="meta">
                  {!p.fingerprint ? t('studio.projectNoKey') : p.has_access ? t('studio.projectReady') : t('studio.projectNoAccess')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <NewProject />
        <Examples />
        <p className="meta">
          {t('studio.keysElsewhere')}{' '}
          {state.site.keys_url && <a href={state.site.keys_url}>{t('studio.openKeyPage')}</a>}
        </p>
      </div>
    );
  }

  return <Project projectId={projectId} {...(tab ? { tab } : {})} account={account} {...(state.site.keys_url ? { keysUrl: state.site.keys_url } : {})} />;
}

/** Create a project: the researcher becomes its first member, and goes on to its details. */
function NewProject() {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [error, setError] = useState<string>();
  const slug = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await createProject(id, name.trim());
      location.assign(studioPath(id, 'details'));
    } catch (failure) {
      setError(
        failure instanceof ApiFailure && failure.status === 409
          ? t('studio.newProject.taken')
          : failure instanceof ApiFailure && failure.status === 400
            ? t('studio.newProject.invalid')
            : t('studio.project.saveFailed'),
      );
    }
  }

  return (
    <form className="card project-form" onSubmit={(e) => void create(e)}>
      <h2>{t('studio.newProject.title')}</h2>
      <label className="field">
        {t('studio.newProject.name')}
        <input
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!idEdited) setId(slug(e.target.value));
          }}
        />
      </label>
      <label className="field">
        {t('studio.newProject.id')}
        <input
          required
          pattern="[a-z0-9\-]{1,64}"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setIdEdited(true);
          }}
        />
        <span className="meta">{t('studio.newProject.idHelp', { path: `/p/${id || '…'}/` })}</span>
      </label>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <button className="button" type="submit">
        {t('studio.newProject.create')}
      </button>
    </form>
  );
}

/**
 * Not signed in (or the session ended): the studio signs in through the key page, with the
 * passkey, and comes straight back here.
 */
function SignIn({ site, handoffFailed }: { site: Site; handoffFailed?: boolean }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const keysUrl = site.keys_url;
  const back = location.pathname.startsWith('/studio/') ? location.pathname : '/studio/';
  return (
    <div className="studio studio-sign-in">
      <h1>{t('studio.signInTitle')}</h1>
      {handoffFailed && (
        <p className="message error" role="alert">
          {t('studio.handoffFailed')}
        </p>
      )}
      <section className="card">
        <p>{t('studio.signInIntro')}</p>
        {keysUrl ? (
          <a className="button" href={`${keysUrl}/#studio=${back}`}>
            {t('studio.signInWithPasskey')}
          </a>
        ) : (
          <p className="message error">{t('studio.noKeyPage')}</p>
        )}
        <p className="meta">{t('studio.signInFirstTime')}</p>
      </section>
      <Examples />
    </div>
  );
}

/** The example projects, open to anyone: no account or passkey needed. */
function Examples() {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <section className="card" aria-labelledby="studio-examples">
      <h2 id="studio-examples">{t('studio.examples.title')}</h2>
      <p className="meta">{t('studio.examples.intro')}</p>
      <ul className="studio-examples">
        {EXAMPLES.map((e) => (
          <li key={e.id}>
            <a href={studioPath(e.id, undefined, true)}>{projectName({ id: e.id, name: e.config.name })}</a>
            <span className="meta">{t(`studio.examples.about.${e.id}`)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One example project: the project screens over the example's API. */
function Example({ id, tab }: { id: string; tab?: StudioTab }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const example = EXAMPLES.find((e) => e.id === id);
  if (!example) {
    return (
      <div className="studio">
        <h1>{t('studio.projectNotFound')}</h1>
        <Examples />
      </div>
    );
  }
  return <ExampleProjectScreen example={example} {...(tab ? { tab } : {})} />;
}

function ExampleProjectScreen({ example, tab }: { example: ExampleProject; tab?: StudioTab }) {
  const api = useMemo(() => exampleApi(example), [example]);
  return (
    <ProjectApiContext.Provider value={api}>
      <Project projectId={example.id} {...(tab ? { tab } : {})} account={null} />
    </ProjectApiContext.Provider>
  );
}
