import { localize } from '@combray/core';
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Madeleine, Skyline } from './components/Madeleine';
import { useIdleLock } from './components/useIdleLock';
import i18n, { LANGUAGES } from './i18n';
import { saveLanguage } from './language';
import { uploadPoints } from './projectConfig';
import { projectPath, readRoute, STUDIES_PATH } from './route';
import { Donate } from './screens/Donate';
import { Faq } from './screens/Faq';
import { Home } from './screens/Home';
import { Landing } from './screens/Landing';
import { Lock } from './screens/Lock';
import { Notice } from './screens/Notice';
import { Projects } from './screens/Projects';
import { Views } from './screens/Views';
import type { DatasetSummary, ProjectInfo, StoreStatus, TableSummary } from './worker/api';
import { data } from './worker/client';

const IDLE_MINUTES = 15;

// The researcher workspace and its worker load only on /studio/.
const StudioApp = lazy(() => import('./studio/StudioApp').then((m) => ({ default: m.StudioApp })));

export function App() {
  const [route] = useState(() => {
    const found = readRoute();
    // The researcher workspace is English only, including the shared components it shows.
    if (found.kind === 'studio') void i18n.changeLanguage('en');
    return found;
  });
  const [project, setProject] = useState<ProjectInfo | 'not-found' | 'unreachable'>();

  // A study link opened while the app is already open only changes the fragment: start over.
  useEffect(() => {
    const reload = () => location.reload();
    window.addEventListener('hashchange', reload);
    return () => window.removeEventListener('hashchange', reload);
  }, []);

  useEffect(() => {
    if (route.kind !== 'project') return;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/p/${route.projectId}/config`, { cache: 'no-store' });
        if (response.status === 404) return setProject('not-found');
        if (!response.ok) return setProject('unreachable');
        const config = (await response.json()) as Partial<Omit<ProjectInfo, 'uploads'>> & { uploads?: unknown };
        await data.openProject(route.projectId);
        const uploads = uploadPoints(config.uploads);
        setProject({
          id: route.projectId,
          ...(config.name ? { name: config.name } : {}),
          participants: { mode: config.participants?.mode ?? 'optional' },
          ...(uploads.length > 0 ? { uploads } : {}),
        });
      } catch {
        setProject('unreachable');
      }
    })();
  }, [route]);

  if (route.kind === 'studio') {
    return (
      <Shell wide studio>
        <Suspense fallback={null}>
          <StudioApp {...(route.learn ? { learn: true } : {})} {...(route.projectId ? { projectId: route.projectId } : {})} {...(route.tab ? { tab: route.tab } : {})} />
        </Suspense>
      </Shell>
    );
  }
  if (route.kind === 'home') {
    return (
      <Shell home="/">
        <Landing />
      </Shell>
    );
  }
  if (route.kind === 'studies') {
    return (
      <Shell>
        <Projects />
      </Shell>
    );
  }
  if (!project) return <Shell>{null}</Shell>;
  if (project === 'not-found' || project === 'unreachable') {
    return (
      <Shell>
        <Notice kind={project} />
      </Shell>
    );
  }
  return (
    <ProjectApp
      project={project}
      {...(route.participantId ? { participantId: route.participantId } : {})}
      {...(route.resetToken ? { resetToken: route.resetToken } : {})}
      {...(route.keyPin ? { keyPin: route.keyPin } : {})}
      {...(route.page ? { page: route.page } : {})}
    />
  );
}

interface ShellProps {
  project?: ProjectInfo;
  actions?: ReactNode;
  wide?: boolean;
  /** The researcher workspace: English only, so no language menu, and no participant footer. */
  studio?: boolean;
  /**
   * Where the logo leads. Participants go back to their studies, not to the landing page, so the
   * way in for researchers never appears in the middle of a study.
   */
  home?: string;
  children: ReactNode;
}

function Shell({ project, actions, wide, studio = false, home = STUDIES_PATH, children }: ShellProps) {
  const { t, i18n } = useTranslation();
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href={studio ? '/studio/' : home}>
          <Madeleine />
          Combray
          {project?.name && <span className="brand-project">{localize(project.name, i18n.language)}</span>}
        </a>
        <div className="topbar-actions">
          {!studio && (
            <label>
              <span className="visually-hidden">{t('app.language')}</span>
              <select value={i18n.resolvedLanguage} onChange={(e) => {
                  saveLanguage(e.target.value);
                  void i18n.changeLanguage(e.target.value);
                }}
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l === 'nl' ? 'Nederlands' : 'English'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {actions}
        </div>
      </header>
      <main className={wide ? 'wide' : undefined}>{children}</main>
      <footer>
        <Skyline />
        {!studio && <div className="footer">{t('app.local')}</div>}
      </footer>
    </div>
  );
}

interface ProjectAppProps {
  project: ProjectInfo;
  participantId?: string;
  resetToken?: string;
  /** The study key's fingerprint from the study link: donations are only sealed to that key. */
  keyPin?: string;
  page?: 'faq';
}

function ProjectApp({ project, participantId, resetToken, keyPin, page }: ProjectAppProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<StoreStatus>();
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [table, setTable] = useState<TableSummary>();
  const [notice, setNotice] = useState<string>();
  const [reset, setReset] = useState(resetToken);
  const [faq, setFaq] = useState(page === 'faq');
  const [donating, setDonating] = useState(false);

  // The questions page is a pushed history entry, so the browser's back button closes it without
  // reloading, which would lock the store.
  useEffect(() => {
    const onPop = () => setFaq(/\/faq\/?$/.test(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function openFaq() {
    history.pushState({ faq: true }, '', projectPath(project.id, 'faq'));
    setFaq(true);
    window.scrollTo(0, 0);
  }

  function closeFaq() {
    if ((history.state as { faq?: boolean } | null)?.faq) history.back();
    else history.replaceState(null, '', projectPath(project.id));
    setFaq(false);
  }

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
      setTable(undefined);
      setDonating(false);
      setNotice(message);
      await refresh();
    },
    [refresh],
  );

  const onIdle = useCallback(() => void lock(t('lock.autoLocked')), [lock, t]);
  useIdleLock(status?.unlocked ?? false, IDLE_MINUTES, onIdle);

  async function deleteAll() {
    await data.destroy();
    setTable(undefined);
    setNotice(undefined);
    setReset(undefined);
    await refresh();
  }

  async function deleteAllConfirmed() {
    if (window.confirm(t('lock.confirmDelete'))) await deleteAll();
  }

  const needsId = project.participants.mode === 'required' && !participantId;
  const actions = (
    <>
      {!faq && (
        <button className="button quiet" type="button" onClick={openFaq}>
          {t('faq.link')}
        </button>
      )}
      {status?.unlocked && (
        <button className="button quiet" type="button" onClick={() => void lock()}>
          🔒 {t('lock.lock')}
        </button>
      )}
    </>
  );

  return (
    <Shell project={project} actions={actions}>
      {faq ? (
        <Faq onBack={closeFaq} />
      ) : !status ? null : !status.unlocked ? (
        !status.exists && reset ? (
          <Notice kind="reset-no-store" />
        ) : !status.exists && needsId ? (
          <Notice kind="needs-id" />
        ) : (
          <Lock
            exists={status.exists}
            reset={status.exists && reset !== undefined}
            {...(project.participants.mode !== 'anonymous' && (status.participantId ?? participantId)
              ? { participantId: status.participantId ?? participantId }
              : {})}
            {...(notice ? { notice } : {})}
            onCreate={async (password) => {
              const result = await data.create(password, project, participantId);
              if (result.status === 'ok') await refresh();
              return result;
            }}
            onUnlock={async (password) => {
              const result = await data.unlock(password);
              if (result.status === 'ok') {
                setNotice(undefined);
                await refresh();
              }
              return result;
            }}
            onReset={async (password) => {
              const result = await data.resetPassword(reset ?? '', password);
              if (result.status === 'ok') {
                setReset(undefined);
                setNotice(undefined);
                await refresh();
              }
              return result;
            }}
            onDeleteAll={deleteAll}
          />
        )
      ) : donating ? (
        <Donate {...(keyPin ? { keyPin } : {})} onBack={() => setDonating(false)} />
      ) : table ? (
        <Views table={table} onBack={() => setTable(undefined)} />
      ) : (
        <>
          <h1>{t('app.tagline')}</h1>
          <Home
            datasets={datasets}
            {...(project.uploads ? { points: project.uploads } : {})}
            onChanged={refresh}
            onOpenTable={setTable}
            onDonate={() => {
              setDonating(true);
              window.scrollTo(0, 0);
            }}
          />
          <p style={{ marginTop: '3rem' }}>
            <button className="link-button" type="button" onClick={deleteAllConfirmed}>
              {t('lock.deleteAll')}
            </button>
          </p>
        </>
      )}
    </Shell>
  );
}
