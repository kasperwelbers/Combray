import { localize } from '@combray/core';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Madeleine, Skyline } from './components/Madeleine';
import { useIdleLock } from './components/useIdleLock';
import { LANGUAGES } from './i18n';
import { readRoute } from './route';
import { Explore } from './screens/Explore';
import { Home } from './screens/Home';
import { Lock } from './screens/Lock';
import { Notice } from './screens/Notice';
import { Projects } from './screens/Projects';
import { Views } from './screens/Views';
import type { DatasetSummary, ProjectInfo, StoreStatus, TableSummary } from './worker/api';
import { data } from './worker/client';

const IDLE_MINUTES = 15;

export function App() {
  const [route] = useState(readRoute);
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
        const config = (await response.json()) as Partial<ProjectInfo>;
        await data.openProject(route.projectId);
        setProject({
          id: route.projectId,
          ...(config.name ? { name: config.name } : {}),
          participants: { mode: config.participants?.mode ?? 'optional' },
        });
      } catch {
        setProject('unreachable');
      }
    })();
  }, [route]);

  if (route.kind === 'home') {
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
    />
  );
}

function Shell({ project, actions, children }: { project?: ProjectInfo; actions?: ReactNode; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/">
          <Madeleine />
          Combray
          {project?.name && <span className="brand-project">{localize(project.name, i18n.language)}</span>}
        </a>
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
          {actions}
        </div>
      </header>
      <main>{children}</main>
      <footer>
        <Skyline />
        <div className="footer">{t('app.local')}</div>
      </footer>
    </div>
  );
}

interface ProjectAppProps {
  project: ProjectInfo;
  participantId?: string;
  resetToken?: string;
}

function ProjectApp({ project, participantId, resetToken }: ProjectAppProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<StoreStatus>();
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [open, setOpen] = useState<DatasetSummary>();
  const [table, setTable] = useState<TableSummary>();
  const [notice, setNotice] = useState<string>();
  const [reset, setReset] = useState(resetToken);

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
      setTable(undefined);
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
    setTable(undefined);
    setNotice(undefined);
    setReset(undefined);
    await refresh();
  }

  async function deleteAllConfirmed() {
    if (window.confirm(t('lock.confirmDelete'))) await deleteAll();
  }

  const needsId = project.participants.mode === 'required' && !participantId;
  const actions = status?.unlocked && (
    <button className="button quiet" type="button" onClick={() => void lock()}>
      🔒 {t('lock.lock')}
    </button>
  );

  return (
    <Shell project={project} actions={actions}>
      {!status ? null : !status.unlocked ? (
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
      ) : table ? (
        <Views table={table} onBack={() => setTable(undefined)} />
      ) : open ? (
        <Explore dataset={open} onBack={() => setOpen(undefined)} />
      ) : (
        <>
          <h1>{t('app.tagline')}</h1>
          <Home datasets={datasets} onChanged={refresh} onOpen={setOpen} onOpenTable={setTable} />
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
