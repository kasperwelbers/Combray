import { localize, parseImporterFile, parseStructureFile, type Localized } from '@combray/core';
import { packs } from '@combray/importers';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { STUDIO_TABS, studioPath, type StudioTab } from '../route';
import { fromFiles, toFiles } from './model';
import { both, textIn } from './text';
import {
  ApiFailure,
  projectApi,
  type Donations,
  type Draft,
  type Member,
  type PlatformDraft,
  type ProjectDetails,
  type ProjectInfo,
} from './projectApi';
import { StoryEditor } from './StoryEditor';
import { Studio, type DraftStore } from './Studio';

const english = (text: Localized | undefined): string => (text === undefined ? '' : localize(text, 'en'));

/**
 * One project in the researcher workspace, in tabs: details, information and consent, the data
 * explorer (per platform: data donation packages and the tree editor), researchers and donations.
 * Everything is saved to the project's draft on the server; participants see it once a researcher
 * publishes it on the key page.
 */
export function Project({ projectId, tab: initialTab, account, keysUrl }: { projectId: string; tab?: StudioTab; account: ReactNode; keysUrl?: string }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [draft, setDraft] = useState<Draft>();
  const [info, setInfo] = useState<ProjectInfo>();
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<StudioTab>(initialTab ?? 'details');

  const refresh = useCallback(() => {
    void projectApi.draft(projectId).then(setDraft, () => setFailed(true));
    void projectApi.project(projectId).then(setInfo, () => undefined);
  }, [projectId]);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    const onPop = () => {
      const segment = location.pathname.split('/').filter(Boolean)[3];
      setTab((STUDIO_TABS as readonly string[]).includes(segment ?? '') ? (segment as StudioTab) : 'details');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function open(next: StudioTab) {
    if (next === tab) return;
    history.pushState(null, '', studioPath(projectId, next));
    setTab(next);
  }

  if (failed) {
    return (
      <div className="studio">
        <h1>{t('studio.projectNotFound')}</h1>
        {account}
        <p>
          <a href={studioPath()}>{t('studio.allProjects')}</a>
        </p>
      </div>
    );
  }
  if (!draft) return null;

  return (
    <div className="studio">
      <p className="meta">
        <a href={studioPath()}>{t('studio.allProjects')}</a>
      </p>
      <h1>{english(draft.details.name) || draft.id}</h1>
      {account}
      {info?.key && !info.has_access && <p className="message">{t('studio.project.noAccess')}</p>}
      {info && <SetupSteps draft={draft} info={info} keysUrl={keysUrl} onData={() => open('data')} onConsent={() => open('consent')} />}
      <nav className="tabs" aria-label={t('studio.project.tabsLabel')}>
        {STUDIO_TABS.map((key) => (
          <a
            key={key}
            href={studioPath(projectId, key)}
            className="tab"
            aria-current={key === tab ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              open(key);
            }}
          >
            {t(`studio.project.tab.${key}`)}
          </a>
        ))}
      </nav>
      <div className="tab-panel">
        {tab === 'details' && <DetailsTab draft={draft} onSaved={refresh} />}
        {tab === 'consent' && <ConsentTab draft={draft} onSaved={refresh} />}
        {tab === 'data' && <DataExplorer draft={draft} onChanged={refresh} />}
        {tab === 'story' && <StoryEditor draft={draft} />}
        {tab === 'researchers' && <ResearchersTab projectId={projectId} keysUrl={keysUrl} />}
        {tab === 'donations' && <DonationsTab projectId={projectId} />}
      </div>
    </div>
  );
}

/**
 * What a project needs before participants can use it, in order, with what is done. Once all is
 * done, only a note about unpublished changes remains.
 */
function SetupSteps({
  draft,
  info,
  keysUrl,
  onData,
  onConsent,
}: {
  draft: Draft;
  info: ProjectInfo;
  keysUrl?: string;
  onData: () => void;
  onConsent: () => void;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const steps = [
    { key: 'encryptionKey', done: info.key !== null, action: keysUrl ? <a href={keysUrl}>{t('studio.project.steps.encryptionKeyAction')}</a> : null },
    {
      key: 'platforms',
      done: draft.platforms.length > 0,
      action: (
        <button type="button" className="link-button" onClick={onData}>
          {t('studio.project.steps.platformsAction')}
        </button>
      ),
    },
    {
      key: 'consent',
      done: draft.details.consent?.information !== undefined,
      action: (
        <button type="button" className="link-button" onClick={onConsent}>
          {t('studio.project.steps.consentAction')}
        </button>
      ),
    },
    {
      key: 'publish',
      done: draft.published !== null && !draft.unpublished_changes,
      action: keysUrl && info.has_access ? <a href={keysUrl}>{t('studio.project.steps.publishAction')}</a> : null,
    },
  ];
  if (steps.every((s) => s.done)) return <PublishBar draft={draft} keysUrl={keysUrl} />;
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="card setup-steps" aria-labelledby="setup-steps">
      <h2 id="setup-steps">{t('studio.project.steps.title')}</h2>
      <ol>
        {steps.map((s, i) => (
          <li key={s.key} className={s.done ? 'done' : i === next ? 'next' : undefined}>
            <span className="step-mark" aria-hidden="true">
              {s.done ? '✓' : i + 1}
            </span>
            <div>
              <strong>{t(`studio.project.steps.${s.key}`)}</strong>
              {s.done && <span className="visually-hidden"> ({t('studio.project.steps.doneLabel')})</span>}
              {!s.done && (
                <p className="meta">
                  {t(`studio.project.steps.${s.key}Help`)} {i === next && s.action}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PublishBar({ draft, keysUrl }: { draft: Draft; keysUrl?: string }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <p className={`message${draft.unpublished_changes ? '' : ' quiet-message'}`}>
      {draft.published
        ? t('studio.project.published', { version: draft.published.version, date: new Date(draft.published.at * 1000).toLocaleDateString('en-GB') })
        : t('studio.project.notPublished')}{' '}
      {!draft.published && keysUrl && <a href={keysUrl}>{t('studio.project.publishOnKeyPage')}</a>}
      {draft.published && draft.unpublished_changes && (
        <>
          {t('studio.project.unpublished')}{' '}
          {keysUrl && <a href={keysUrl}>{t('studio.project.publishOnKeyPage')}</a>}
        </>
      )}
    </p>
  );
}

// Details.

function DetailsTab({ draft, onSaved }: { draft: Draft; onSaved: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const d = draft.details;
  const text = textIn;
  const [nameEn, setNameEn] = useState(text(d.name, 'en'));
  const [nameNl, setNameNl] = useState(text(d.name, 'nl'));
  const [descEn, setDescEn] = useState(text(d.description, 'en'));
  const [descNl, setDescNl] = useState(text(d.description, 'nl'));
  const [mode, setMode] = useState(d.participants.mode);
  const [pattern, setPattern] = useState(d.participants.pattern ?? '');
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();

  async function save(e: FormEvent) {
    e.preventDefault();
    const name = both(nameEn, nameNl);
    if (!name) return setStatus({ text: t('studio.project.nameRequired'), error: true });
    const description = both(descEn, descNl);
    const details: ProjectDetails = {
      name,
      ...(description ? { description } : {}),
      participants: { mode, ...(mode !== 'anonymous' && pattern.trim() ? { pattern: pattern.trim() } : {}) },
      ...(d.consent ? { consent: d.consent } : {}),
    };
    try {
      await projectApi.saveDetails(draft.id, details);
      setStatus({ text: t('studio.project.saved') });
      onSaved();
    } catch (error) {
      setStatus({ text: error instanceof ApiFailure && error.status === 400 ? t('studio.project.detailsInvalid') : t('studio.project.saveFailed'), error: true });
    }
  }

  return (
    <form className="card project-form" onSubmit={(e) => void save(e)}>
      <h2>{t('studio.project.tab.details')}</h2>
      <p className="meta">{t('studio.project.detailsIntro', { id: draft.id })}</p>
      <fieldset>
        <legend>{t('studio.project.name')}</legend>
        <label className="field">
          English
          <input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </label>
        <label className="field">
          Nederlands
          <input value={nameNl} onChange={(e) => setNameNl(e.target.value)} />
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('studio.project.description')}</legend>
        <p className="meta">{t('studio.project.descriptionHelp')}</p>
        <label className="field">
          English
          <textarea rows={3} value={descEn} onChange={(e) => setDescEn(e.target.value)} />
        </label>
        <label className="field">
          Nederlands
          <textarea rows={3} value={descNl} onChange={(e) => setDescNl(e.target.value)} />
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('studio.project.participants')}</legend>
        <label className="field">
          {t('studio.project.mode')}
          <select value={mode} onChange={(e) => setMode(e.target.value as ProjectDetails['participants']['mode'])}>
            {(['anonymous', 'optional', 'required'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`studio.project.modes.${m}`)}
              </option>
            ))}
          </select>
        </label>
        {mode !== 'anonymous' && (
          <label className="field">
            {t('studio.project.pattern')}
            <input value={pattern} placeholder="P[0-9]{4}" onChange={(e) => setPattern(e.target.value)} />
            <span className="meta">{t('studio.project.patternHelp')}</span>
          </label>
        )}
      </fieldset>
      {status && (
        <p className={`message${status.error ? ' error' : ''}`} role={status.error ? 'alert' : 'status'}>
          {status.text}
        </p>
      )}
      <button className="button" type="submit">
        {t('studio.project.saveDetails')}
      </button>
    </form>
  );
}

// Information and consent.

function ConsentTab({ draft, onSaved }: { draft: Draft; onSaved: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const consent = draft.details.consent;
  const [infoEn, setInfoEn] = useState(textIn(consent?.information, 'en'));
  const [infoNl, setInfoNl] = useState(textIn(consent?.information, 'nl'));
  const [statements, setStatements] = useState(() => (consent?.statements ?? []).map((s) => ({ en: textIn(s, 'en'), nl: textIn(s, 'nl') })));
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();

  const change = (i: number, language: 'en' | 'nl', value: string) =>
    setStatements((list) => list.map((s, j) => (j === i ? { ...s, [language]: value } : s)));

  async function save(e: FormEvent) {
    e.preventDefault();
    const information = both(infoEn, infoNl);
    const kept = statements.flatMap((s) => {
      const value = both(s.en, s.nl);
      return value ? [value] : [];
    });
    const next = { ...(information ? { information } : {}), ...(kept.length > 0 ? { statements: kept } : {}) };
    const { consent: _old, ...details } = draft.details;
    try {
      await projectApi.saveDetails(draft.id, { ...details, ...(Object.keys(next).length > 0 ? { consent: next } : {}) });
      setStatus({ text: t('studio.project.saved') });
      onSaved();
    } catch (error) {
      setStatus({ text: error instanceof ApiFailure && error.status === 400 ? t('studio.consent.invalid') : t('studio.project.saveFailed'), error: true });
    }
  }

  return (
    <form className="card project-form" onSubmit={(e) => void save(e)}>
      <h2>{t('studio.project.tab.consent')}</h2>
      <p className="meta">{t('studio.consent.intro')}</p>
      <fieldset>
        <legend>{t('studio.consent.information')}</legend>
        <p className="meta">{t('studio.consent.informationHelp')}</p>
        <label className="field">
          English
          <textarea rows={10} value={infoEn} onChange={(e) => setInfoEn(e.target.value)} />
        </label>
        <label className="field">
          Nederlands
          <textarea rows={10} value={infoNl} onChange={(e) => setInfoNl(e.target.value)} />
        </label>
      </fieldset>
      <fieldset>
        <legend>{t('studio.consent.statements')}</legend>
        <p className="meta">{t('studio.consent.statementsHelp')}</p>
        <ol className="statement-list">
          {statements.map((s, i) => (
            <li key={i}>
              <label className="field">
                English
                <input value={s.en} onChange={(e) => change(i, 'en', e.target.value)} />
              </label>
              <label className="field">
                Nederlands
                <input value={s.nl} onChange={(e) => change(i, 'nl', e.target.value)} />
              </label>
              <button type="button" className="link-button" onClick={() => setStatements((list) => list.filter((_, j) => j !== i))}>
                {t('studio.consent.remove')}
              </button>
            </li>
          ))}
        </ol>
        {statements.length < MAX_STATEMENTS && (
          <button type="button" className="button quiet" onClick={() => setStatements((list) => [...list, { en: '', nl: '' }])}>
            {t('studio.consent.add')}
          </button>
        )}
      </fieldset>
      <p className="meta">{t('studio.consent.always')}</p>
      {status && (
        <p className={`message${status.error ? ' error' : ''}`} role={status.error ? 'alert' : 'status'}>
          {status.text}
        </p>
      )}
      <button className="button" type="submit">
        {t('studio.consent.save')}
      </button>
    </form>
  );
}

/** As on the server: participants tick every statement, so a few clear ones work best. */
const MAX_STATEMENTS = 10;

// The data explorer.

function DataExplorer({ draft, onChanged }: { draft: Draft; onChanged: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [selected, setSelected] = useState<string | undefined>(draft.platforms[0]?.id);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  const available = packs.filter((p) => !draft.platforms.some((x) => x.id === p.id));

  async function addPlatform(packId: string) {
    const pack = packs.find((p) => p.id === packId);
    if (!pack) return;
    try {
      await projectApi.savePlatform(draft.id, pack.id, { name: pack.name, pack: pack.id, structure: pack.structure, importer: pack.importer });
      setSelected(pack.id);
      onChanged();
    } catch {
      setMessage({ text: t('studio.project.saveFailed'), error: true });
    }
  }

  async function removePlatform(id: string) {
    if (!window.confirm(t('studio.project.confirmRemovePlatform'))) return;
    await projectApi.removePlatform(draft.id, id).catch(() => undefined);
    setSelected(draft.platforms.find((p) => p.id !== id)?.id);
    onChanged();
  }

  return (
    <div>
      <section className="card">
        <h2>{t('studio.project.platformsTitle')}</h2>
        <p className="meta">{t('studio.project.platformsIntro')}</p>
        {draft.platforms.length > 0 && (
          <div className="segmented platform-choice" role="group" aria-label={t('studio.project.platformsTitle')}>
            {draft.platforms.map((p) => (
              <button key={p.id} type="button" className="seg" aria-pressed={p.id === selected} onClick={() => setSelected(p.id)}>
                {english(p.name)}
              </button>
            ))}
          </div>
        )}
        {available.length > 0 && (
          <label className="field add-platform">
            {t('studio.project.addPlatform')}
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) void addPlatform(e.target.value);
              }}
            >
              <option value="">{t('studio.project.choosePlatform')}</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {english(p.name)}
                </option>
              ))}
            </select>
          </label>
        )}
        {message && (
          <p className={`message${message.error ? ' error' : ''}`} role="alert">
            {message.text}
          </p>
        )}
      </section>
      {selected && draft.platforms.some((p) => p.id === selected) ? (
        <PlatformEditor key={selected} projectId={draft.id} platformId={selected} onSaved={onChanged} onRemove={() => void removePlatform(selected)} />
      ) : (
        draft.platforms.length === 0 && <p className="meta">{t('studio.project.noPlatforms')}</p>
      )}
    </div>
  );
}

const SAVE_DELAY_MS = 800;

/** One platform: its tree loaded from the draft and saved back shortly after every change. */
function PlatformEditor({ projectId, platformId, onSaved, onRemove }: { projectId: string; platformId: string; onSaved: () => void; onRemove: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [platform, setPlatform] = useState<PlatformDraft | 'failed'>();
  const [saving, setSaving] = useState<'saving' | 'saved' | 'failed'>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef<() => Promise<void>>(undefined);

  useEffect(() => {
    void projectApi.platform(projectId, platformId).then(setPlatform, () => setPlatform('failed'));
  }, [projectId, platformId]);

  // Save what is waiting when the editor closes (another platform, another tab).
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void latest.current?.();
      }
    },
    [],
  );

  const packages = useMemo(() => projectApi.testPackages(projectId, platformId), [projectId, platformId]);

  const store = useMemo((): DraftStore | 'unreadable' | undefined => {
    if (!platform || platform === 'failed') return undefined;
    let initial: DraftStore['initial'];
    if (platform.structure && platform.importer) {
      try {
        initial = fromFiles(parseStructureFile(platform.structure), parseImporterFile(platform.importer));
      } catch {
        return 'unreadable';
      }
    }
    return {
      initial,
      save(draft) {
        const files = draft ? toFiles(draft) : undefined;
        latest.current = async () => {
          setSaving('saving');
          try {
            await projectApi.savePlatform(projectId, platformId, {
              name: platform.name,
              ...(platform.pack ? { pack: platform.pack } : {}),
              ...(files ? { structure: files.structure, importer: files.importer } : {}),
            });
            setSaving('saved');
            onSaved();
          } catch {
            setSaving('failed');
          }
        };
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = undefined;
          void latest.current?.();
        }, SAVE_DELAY_MS);
      },
    };
  }, [platform, projectId, platformId, onSaved]);

  if (platform === 'failed' || store === 'unreadable') return <p className="message error">{t('studio.project.platformFailed')}</p>;
  if (!platform || !store) return null;
  return (
    <div className="platform-editor">
      <div className="platform-bar">
        <h2>{english(platform.name)}</h2>
        <span className="meta" role="status">
          {saving ? t(`studio.project.save.${saving}`) : ''}
        </span>
        <button type="button" className="link-button" onClick={onRemove}>
          {t('studio.project.removePlatform')}
        </button>
      </div>
      <Studio draft={store} packages={packages} {...(platform.pack ? { pack: platform.pack } : {})} />
    </div>
  );
}

// Researchers.

function ResearchersTab({ projectId, keysUrl }: { projectId: string; keysUrl?: string }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [members, setMembers] = useState<Member[]>();
  useEffect(() => {
    void projectApi.members(projectId).then(setMembers, () => setMembers([]));
  }, [projectId]);
  return (
    <section className="card">
      <h2>{t('studio.project.tab.researchers')}</h2>
      {members && (
        <ul className="member-list">
          {members.map((m) => (
            <li key={m.researcher_id}>
              <span>{m.email}</span>
              <span className="meta">
                {m.has_access ? t('studio.project.hasAccess') : m.public_key ? t('studio.project.waitingForAccess') : t('studio.project.noKeyYet')}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="meta">
        {t('studio.project.researchersHelp')} {keysUrl && <a href={keysUrl}>{t('studio.openKeyPage')}</a>}
      </p>
    </section>
  );
}

// Donations.

function DonationsTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const [donations, setDonations] = useState<Donations | 'failed'>();
  useEffect(() => {
    void projectApi.donations(projectId).then(setDonations, () => setDonations('failed'));
  }, [projectId]);
  if (donations === 'failed') return <p className="message error">{t('studio.project.donationsFailed')}</p>;
  if (!donations) return null;
  const byDay = new Map<string, number>();
  for (const d of donations.donations) byDay.set(d.day, (byDay.get(d.day) ?? 0) + 1);
  return (
    <section className="card">
      <h2>{t('studio.project.tab.donations')}</h2>
      <p>{t('studio.project.donationCounts', { count: donations.donations.length, withdrawn: donations.withdrawn.length })}</p>
      {byDay.size > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('studio.project.day')}</th>
              <th>{t('studio.project.donationsOnDay')}</th>
            </tr>
          </thead>
          <tbody>
            {[...byDay].map(([day, n]) => (
              <tr key={day}>
                <td>{day}</td>
                <td>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="meta">{t('studio.project.donationsHelp')}</p>
    </section>
  );
}
