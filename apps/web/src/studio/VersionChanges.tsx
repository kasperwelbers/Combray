/**
 * What publishing the draft would change for donations, compared with the published version
 * (docs/decisions/0013-names-labels-versions.md#changes-after-publishing): safe, narrowing or
 * breaking changes, so a researcher publishes knowing what earlier donations will differ in.
 */
import { localize, parseImporterFile, parseStructureFile, versionChanges, type ChangeKind, type Localized, type PlatformVersion, type VersionChange } from '@combray/core';
import { useEffect, useState } from 'react';
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
