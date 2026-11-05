/**
 * The Texts tab: everything participants read that is not in the story or the consent tabs, per
 * language (docs/translation.md#project-texts). The project's languages; labels and descriptions
 * of the tables and fields participants see, over the platform pack's; and the app's own texts,
 * which a study can word its own way. All of it, story and consent included, goes out as one
 * YAML file to translate (by hand or with an AI) and comes back in the same way.
 */
import {
  applyTranslations,
  buildTree,
  checkProjectTexts,
  defaultLabel,
  deriveTables,
  localize,
  parseImporterFile,
  parseStory,
  parseStructureFile,
  readTranslations,
  TextsError,
  translationDocument,
  translationsToYaml,
  type Localized,
  type PlatformTexts,
  type ProjectTexts,
  type ShownTables,
  type Story,
  type Translations,
} from '@combray/core';
import { packs } from '@combray/importers';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CAREFUL_GROUPS, PROJECT_GROUPS, appTextKey } from '../appTexts';
import i18n, { LANGUAGES } from '../i18n';
import { HelpButton } from './Help';
import { asParticipantsSee, fromFiles } from './model';
import { download } from './prefs';
import { ApiFailure, useProjectApi, type Draft, type ProjectApi } from './projectApi';

/** The tables and fields participants see on each platform, and the platform's pack texts. */
interface PlatformInfo {
  id: string;
  name: Localized;
  pack?: PlatformTexts;
  tables: { table: string; fields: string[] }[];
}

async function loadPlatforms(projectApi: ProjectApi, draft: Draft): Promise<PlatformInfo[]> {
  const out: PlatformInfo[] = [];
  for (const summary of draft.platforms) {
    try {
      const platform = await projectApi.platform(draft.id, summary.id);
      const pack = packs.find((p) => p.id === platform.pack);
      const structure = platform.structure ?? pack?.structure;
      const importer = platform.importer ?? pack?.importer;
      if (!structure || !importer) continue;
      const { config, seen } = fromFiles(parseStructureFile(structure), parseImporterFile(importer));
      const tables = deriveTables(asParticipantsSee(buildTree(config, seen).tree));
      const byName = new Map<string, Set<string>>();
      for (const table of tables) {
        // The record of loose fields has no name to label it by.
        if (table.id === '') continue;
        const fields = table.columns.filter((c) => c.type === 'value' || c.type === 'list').map((c) => c.id);
        byName.set(table.id, new Set([...(byName.get(table.id) ?? []), ...fields]));
      }
      out.push({
        id: summary.id,
        name: summary.name,
        ...(pack?.texts ? { pack: pack.texts } : {}),
        tables: [...byName].map(([table, fields]) => ({ table, fields: [...fields] })),
      });
    } catch {
      // A platform that cannot be read has no tables here; the data explorer says why.
    }
  }
  return out;
}

/** Every app text a study can word its own way, by `group:key`, with the app's English. */
function appTexts(): { key: string; group: string; en: string }[] {
  const out: { key: string; group: string; en: string }[] = [];
  const bundle = (i18n.getResourceBundle('en', 'translation') ?? {}) as Record<string, unknown>;
  const walk = (group: string, value: unknown, path: string[]) => {
    if (typeof value === 'string') out.push({ key: `${group}:${path.join('.')}`, group, en: value });
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(group, v, [...path, k]);
  };
  for (const group of PROJECT_GROUPS) walk(group, bundle[group], []);
  return out;
}

/** The app's text for a key in a language, as participants see it without the study's own. */
const appDefault = (key: string, language: string) => i18n.getResource(language, 'translation', appTextKey(key)) as string | undefined;

/** Set one language of one text; empty texts are taken out when saved (`checkProjectTexts`). */
const withText = (texts: Translations | undefined, language: string, text: string): Translations => ({ ...(texts ?? {}), [language]: text });

const MAX_SHOWN = 25;

export function TextsEditor({ draft, onSaved }: { draft: Draft; onSaved: () => void }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const projectApi = useProjectApi();
  const [texts, setTexts] = useState<ProjectTexts>();
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();
  const [search, setSearch] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const all = useMemo(appTexts, []);

  useEffect(() => {
    void projectApi.texts(draft.id).then(
      (raw) => {
        try {
          setTexts(checkProjectTexts(raw));
        } catch {
          setTexts({});
        }
      },
      () => setStatus({ text: t('studio.texts.loadFailed'), error: true }),
    );
    void loadPlatforms(projectApi, draft).then(setPlatforms);
  }, [projectApi, draft, t]);

  if (!texts) return status ? <p className="message error">{status.text}</p> : null;
  const languages = texts.languages ?? [...LANGUAGES];

  const update = (next: ProjectTexts) => {
    setTexts(next);
    setDirty(true);
    setStatus(undefined);
  };

  async function save(next: ProjectTexts = texts!) {
    try {
      const checked = checkProjectTexts(next);
      await projectApi.saveTexts(draft.id, Object.keys(checked).length > 0 ? checked : null);
      setTexts(checked);
      setDirty(false);
      setStatus({ text: t('studio.texts.saved') });
      onSaved();
    } catch (error) {
      const invalid = error instanceof TextsError || (error instanceof ApiFailure && error.status === 400);
      setStatus({ text: invalid ? t('studio.texts.invalid', { problem: error instanceof TextsError ? error.message : '' }) : t('studio.project.saveFailed'), error: true });
    }
  }

  function setLanguages(next: string[]) {
    update({ ...texts!, languages: next });
  }

  function setPlatformText(platform: string, table: string, field: string | undefined, kind: 'label' | 'description', language: string, text: string) {
    const p = texts!.platforms?.[platform] ?? {};
    const tableTexts = p.tables?.[table] ?? {};
    const nextTable =
      field === undefined
        ? { ...tableTexts, [kind]: withText(tableTexts[kind], language, text) }
        : {
            ...tableTexts,
            fields: { ...(tableTexts.fields ?? {}), [field]: { ...(tableTexts.fields?.[field] ?? {}), [kind]: withText(tableTexts.fields?.[field]?.[kind], language, text) } },
          };
    update({ ...texts!, platforms: { ...(texts!.platforms ?? {}), [platform]: { ...p, tables: { ...(p.tables ?? {}), [table]: nextTable } } } });
  }

  function setAppText(key: string, language: string, text: string) {
    update({ ...texts!, app: { ...(texts!.app ?? {}), [key]: withText(texts!.app?.[key], language, text) } });
  }

  const shown: ShownTables = Object.fromEntries(platforms.map((p) => [p.id, p.tables]));

  async function exportYaml() {
    const story = parseStory(await projectApi.story(draft.id).catch(() => null)) ?? null;
    const doc = translationDocument({ texts: checkProjectTexts(texts), story, ...(draft.details.consent ? { consent: draft.details.consent } : {}) }, shown);
    download(`${draft.id}-texts.yaml`, translationsToYaml(doc), 'application/yaml');
  }

  async function importYaml(chosen: File) {
    try {
      const doc = readTranslations(await chosen.text());
      const rawStory = await projectApi.story(draft.id);
      const story = (rawStory as Story | null) ?? null;
      const consent = draft.details.consent;
      const { sources, changed } = applyTranslations({ texts: checkProjectTexts(texts), story, ...(consent ? { consent } : {}) }, doc);
      if (changed === 0) return setStatus({ text: t('studio.texts.nothingChanged') });
      if (JSON.stringify(sources.story ?? null) !== JSON.stringify(story)) await projectApi.saveStory(draft.id, sources.story);
      if (consent && JSON.stringify(sources.consent) !== JSON.stringify(consent)) await projectApi.saveDetails(draft.id, { ...draft.details, consent: sources.consent! });
      await save(sources.texts);
      setStatus({ text: t('studio.texts.read', { count: changed }) });
    } catch (error) {
      setStatus({ text: error instanceof TextsError ? t('studio.texts.badFile', { problem: error.message }) : t('studio.project.saveFailed'), error: true });
    }
  }

  const query = search.trim().toLowerCase();
  const own = Object.keys(texts.app ?? {});
  const matching = query.length >= 2 ? all.filter((a) => a.key.toLowerCase().includes(query) || a.en.toLowerCase().includes(query)) : all.filter((a) => own.includes(a.key));

  return (
    <div className="texts-editor">
      <section className="card">
        <h2>{t('studio.project.tab.texts')}</h2>
        <p className="meta">{t('studio.texts.intro')}</p>
        <div className="actions">
          <button type="button" className="button" disabled={!dirty} onClick={() => void save()}>
            {t('studio.texts.save')}
          </button>
          <button type="button" className="button quiet" onClick={() => void exportYaml()}>
            {t('studio.texts.export')}
          </button>
          <button type="button" className="button quiet" onClick={() => file.current?.click()}>
            {t('studio.texts.import')}
          </button>
          <HelpButton topic="texts" />
          <input
            ref={file}
            type="file"
            accept=".yaml,.yml,text/yaml"
            hidden
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = '';
              if (chosen) void importYaml(chosen);
            }}
          />
        </div>
        {status && (
          <p className={`message${status.error ? ' error' : ''}`} role={status.error ? 'alert' : 'status'}>
            {status.text}
          </p>
        )}
      </section>

      <section className="card">
        <h3>{t('studio.texts.languages')}</h3>
        <p className="meta">{t('studio.texts.languagesHelp')}</p>
        <div className="check-row">
          {LANGUAGES.map((language) => (
            <label key={language} className="check">
              <input
                type="checkbox"
                checked={languages.includes(language)}
                disabled={languages.length === 1 && languages[0] === language}
                onChange={(e) => setLanguages(e.target.checked ? [...languages, language] : languages.filter((l) => l !== language))}
              />
              {t(`studio.language.${language}`)}
            </label>
          ))}
        </div>
        <label className="field compact">
          <span>{t('studio.texts.mainLanguage')}</span>
          <select value={languages[0]} onChange={(e) => setLanguages([e.target.value, ...languages.filter((l) => l !== e.target.value)])}>
            {languages.map((language) => (
              <option key={language} value={language}>
                {t(`studio.language.${language}`)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card">
        <h3>{t('studio.texts.tables')}</h3>
        <p className="meta">{t('studio.texts.tablesHelp')}</p>
        {platforms.length === 0 && <p className="meta">{t('studio.texts.noTables')}</p>}
        {platforms.map((platform) => (
          <div key={platform.id} className="texts-platform">
            <h4>{localize(platform.name, 'en')}</h4>
            {platform.tables.map(({ table, fields }) => {
              const own = texts.platforms?.[platform.id]?.tables?.[table];
              const pack = platform.pack?.tables?.[table];
              return (
                <details key={table} className="texts-table">
                  <summary>
                    <code>{table}</code> <span className="meta">{localize(own?.label ?? pack?.label ?? defaultLabel(table), 'en')}</span>
                  </summary>
                  <TextInputs
                    languages={languages}
                    label={t('studio.texts.label')}
                    value={own?.label}
                    placeholder={(l) => pack?.label?.[l] ?? defaultLabel(table)}
                    onChange={(l, text) => setPlatformText(platform.id, table, undefined, 'label', l, text)}
                  />
                  <TextInputs
                    languages={languages}
                    label={t('studio.texts.description')}
                    value={own?.description}
                    placeholder={(l) => pack?.description?.[l] ?? ''}
                    long
                    onChange={(l, text) => setPlatformText(platform.id, table, undefined, 'description', l, text)}
                  />
                  <ul className="texts-fields">
                    {fields.map((field) => (
                      <li key={field}>
                        <code>{field}</code>
                        <TextInputs
                          languages={languages}
                          label={t('studio.texts.label')}
                          value={own?.fields?.[field]?.label}
                          placeholder={(l) => pack?.fields?.[field]?.label?.[l] ?? defaultLabel(field)}
                          onChange={(l, text) => setPlatformText(platform.id, table, field, 'label', l, text)}
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        ))}
      </section>

      <section className="card">
        <h3>{t('studio.texts.app')}</h3>
        <p className="meta">{t('studio.texts.appHelp')}</p>
        <label className="field compact">
          <span>{t('studio.texts.search')}</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {query.length < 2 && own.length === 0 && <p className="meta">{t('studio.texts.searchHint')}</p>}
        {matching.length > MAX_SHOWN && <p className="meta">{t('studio.texts.more', { count: matching.length - MAX_SHOWN })}</p>}
        <ul className="texts-app">
          {matching.slice(0, MAX_SHOWN).map((a) => (
            <li key={a.key}>
              <code>{a.key}</code>
              {CAREFUL_GROUPS.has(a.group) && <span className="tag warn-tag">{t('studio.texts.careful')}</span>}
              <TextInputs
                languages={languages}
                label={t('studio.texts.text')}
                value={texts.app?.[a.key]}
                placeholder={(l) => appDefault(a.key, l) ?? ''}
                long={a.en.length > 60}
                onChange={(l, text) => setAppText(a.key, l, text)}
              />
            </li>
          ))}
        </ul>
        {matching.some((a) => CAREFUL_GROUPS.has(a.group)) && <p className="meta">{t('studio.texts.carefulHelp')}</p>}
      </section>
    </div>
  );
}

/** One text in each of the project's languages; empty shows (and keeps) the text it has without. */
function TextInputs({
  languages,
  label,
  value,
  placeholder,
  long = false,
  onChange,
}: {
  languages: string[];
  label: string;
  value: Translations | undefined;
  placeholder: (language: string) => string;
  long?: boolean;
  onChange: (language: string, text: string) => void;
}) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  return (
    <fieldset className="text-inputs">
      <legend className="visually-hidden">{label}</legend>
      {languages.map((language) => (
        <label key={language} className="field compact">
          <span>
            {label} ({t(`studio.language.${language}`)})
          </span>
          {long ? (
            <textarea rows={2} value={value?.[language] ?? ''} placeholder={placeholder(language)} onChange={(e) => onChange(language, e.target.value)} />
          ) : (
            <input value={value?.[language] ?? ''} placeholder={placeholder(language)} onChange={(e) => onChange(language, e.target.value)} />
          )}
        </label>
      ))}
    </fieldset>
  );
}
