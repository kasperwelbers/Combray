/**
 * What publishing the draft would change for donations, compared with the published version
 * (docs/decisions/0013-names-labels-versions.md#changes-after-publishing): safe, narrowing or
 * breaking changes, so a researcher publishes knowing what earlier donations will differ in.
 */
import { localize, parseImporterFile, parseStructureFile, versionChanges, type ChangeKind, type Localized, type PlatformVersion, type VersionChange } from '@combray/core';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fromFiles } from './model';
import { useProjectApi, type Draft } from './projectApi';

const KINDS: ChangeKind[] = ['breaking', 'narrowing', 'safe'];

function platformVersion(structure: unknown, importer: unknown): PlatformVersion | undefined {
  if (!structure || !importer) return undefined;
  try {
    const draft = fromFiles(parseStructureFile(structure), parseImporterFile(importer));
    return { config: draft.config, ...(draft.seen ? { seen: draft.seen } : {}) };
  } catch {
    return undefined;
  }
}

export function VersionChanges({ draft }: { draft: Draft }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const projectApi = useProjectApi();
  const [changes, setChanges] = useState<{ list: VersionChange[]; names: Map<string, Localized> }>();
  const published = draft.published;

  useEffect(() => {
    if (!published || !draft.unpublished_changes) return setChanges(undefined);
    let cancelled = false;
    void (async () => {
      const live = await projectApi.version(draft.id, published.version);
      const before = new Map<string, PlatformVersion>();
      const names = new Map<string, Localized>();
      for (const u of live.config.uploads ?? []) {
        const v = platformVersion(u.structure, u.importer);
        if (v) before.set(u.id, v);
        if (u.name) names.set(u.id, u.name);
      }
      const after = new Map<string, PlatformVersion>();
      for (const p of draft.platforms) {
        const platform = await projectApi.platform(draft.id, p.id);
        const v = platformVersion(platform.structure, platform.importer);
        if (v) after.set(p.id, v);
        names.set(p.id, p.name);
      }
      if (!cancelled) setChanges({ list: versionChanges(before, after), names });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectApi, draft, published]);

  if (!published || !changes || changes.list.length === 0) return null;
  const what = (c: VersionChange) => {
    const platform = localize(changes.names.get(c.platform) ?? c.platform, 'en');
    const at = c.table === undefined ? platform : `${platform} · ${c.table}${c.field ? `.${c.field}` : ''}`;
    return t(`studio.changes.change.${c.change}`, { what: at, to: c.to ?? '' });
  };
  return (
    <section className="card version-changes" aria-labelledby="version-changes">
      <h2 id="version-changes">{t('studio.changes.title', { version: published.version })}</h2>
      <p className="meta">{t('studio.changes.intro')}</p>
      {KINDS.map((kind) => {
        const list = changes.list.filter((c) => c.kind === kind);
        if (list.length === 0) return null;
        return (
          <div key={kind} className={`change-group change-${kind}`}>
            <h3>{t(`studio.changes.kind.${kind}`)}</h3>
            <p className="meta">{t(`studio.changes.kindHelp.${kind}`)}</p>
            <ul>
              {list.map((c, i) => (
                <li key={i}>{what(c)}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

/**
 * Donated tables still called by their HTML structure (`div_mdl_cell`), per platform, as the studio
 * saved them (`ImporterFile.unnamed`). The key page refuses to publish until they have a name.
 */
export function UnnamedTables({ draft }: { draft: Draft }) {
  const { t } = useTranslation(undefined, { lng: 'en' });
  const projectApi = useProjectApi();
  const [unnamed, setUnnamed] = useState<{ platform: string; tables: string[] }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out: { platform: string; tables: string[] }[] = [];
      for (const p of draft.platforms) {
        const importer = (await projectApi.platform(draft.id, p.id)).importer as { unnamed?: unknown } | null;
        const tables = Array.isArray(importer?.unnamed) ? importer.unnamed.filter((n): n is string => typeof n === 'string') : [];
        if (tables.length > 0) out.push({ platform: localize(p.name, 'en'), tables });
      }
      if (!cancelled) setUnnamed(out);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectApi, draft]);

  if (unnamed.length === 0) return null;
  return (
    <section className="card version-changes" aria-labelledby="unnamed-tables">
      <h2 id="unnamed-tables">{t('studio.unnamed.title')}</h2>
      <p className="meta">{t('studio.unnamed.intro')}</p>
      <ul>
        {unnamed.map((u) => (
          <li key={u.platform}>
            {u.platform}: {u.tables.map((n) => <code key={n}>{n}</code>).reduce<ReactNode[]>((all, c, i) => (i === 0 ? [c] : [...all, ', ', c]), [])}
          </li>
        ))}
      </ul>
    </section>
  );
}
