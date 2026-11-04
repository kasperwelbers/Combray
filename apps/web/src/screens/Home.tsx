import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { localize } from '@combray/core';

import { ImportCard } from '../components/ImportCard';
import { foldedPath } from '../format';
import { RawData } from './Explore';
import type { DatasetSummary, TableSummary, UploadPoint } from '../worker/api';
import { data } from '../worker/client';

interface Props {
  datasets: DatasetSummary[];
  /** The project's upload points, one uploader each; without them, the YAML importers run. */
  points?: UploadPoint[];
  onChanged: () => Promise<void>;
  onOpenTable: (table: TableSummary) => void;
  /** Open the donation. Offered once something the study asks for has been added. */
  onDonate: () => void;
  /** Open the study's story, when it has one. Offered once data has been added. */
  onStory?: () => void;
}

/** Whether something the study asks participants to share has been added. */
export function asksForData(datasets: DatasetSummary[]): boolean {
  return datasets.some((d) => d.tables.some((table) => table.derived?.requested));
}

/** Tables the project shows or asks for come first, the ones it asks for before the others. */
function collections(tables: TableSummary[]): TableSummary[] {
  return tables
    .filter((t) => !t.derived || t.derived.collection)
    .sort((a, b) => Number(b.derived?.requested ?? false) - Number(a.derived?.requested ?? false));
}

function TableButton({ table, onOpen, path }: { table: TableSummary; onOpen: (t: TableSummary) => void; path?: boolean }) {
  const { t, i18n } = useTranslation();
  const name = localize(table.name, i18n.language) || t('datasets.unnamed');
  return (
    <button type="button" className="found-item" onClick={() => onOpen(table)}>
      <strong>
        {name}
        {table.derived?.requested && <span className="tag">{t('table.requested')}</span>}
        {table.derived?.new && <span className="tag">{t('table.new')}</span>}
      </strong>
      <span className="meta">
        {table.derived?.record ? t('datasets.record') : t('datasets.items', { count: table.rowCount })}
      </span>
      {path && table.derived && <span className="meta path">{foldedPath(table.derived.path)}</span>}
    </button>
  );
}

export function Home({ datasets, points, onChanged, onOpenTable, onDonate, onStory }: Props) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);

  async function remove(dataset: DatasetSummary) {
    if (!window.confirm(t('datasets.confirmDelete', { name: dataset.name }))) return;
    await data.deleteDataset(dataset.id);
    await onChanged();
  }

  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'long' });

  return (
    <>
      <div className="import-cards">
        {(points?.length ? points : [undefined]).map((point) => (
          <ImportCard key={point?.id ?? ''} point={point} disabled={busy} onBusy={setBusy} onDone={onChanged} />
        ))}
      </div>

      {onStory && datasets.length > 0 && (
        <section className="card story-call" aria-labelledby="story-call-title">
          <h2 id="story-call-title">{t('story.open')}</h2>
          <p>{t('story.openIntro')}</p>
          <button type="button" className="button" onClick={onStory}>
            {t('story.openButton')}
          </button>
        </section>
      )}

      {asksForData(datasets) && (
        <section className="card donate-call" aria-labelledby="donate-call-title">
          <h2 id="donate-call-title">{t('donate.open')}</h2>
          <p>{t('donate.openIntro')}</p>
          <button type="button" className="button" onClick={onDonate}>
            {t('donate.openButton')}
          </button>
        </section>
      )}

      <section aria-labelledby="datasets-title" style={{ marginTop: '2.5rem' }}>
        <h2 id="datasets-title">{t('home.title')}</h2>
        {datasets.length === 0 ? (
          <p className="meta">{t('home.empty')}</p>
        ) : (
          <ul className="datasets">
            {datasets.map((d) => (
              <DatasetCard key={d.id} dataset={d} date={date(d.importedAt)} onRemove={() => void remove(d)} onOpenTable={onOpenTable} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * One upload: what the researchers' settings make of it (processed), or everything in it as it
 * is (raw data). Both are read from this computer only.
 */
function DatasetCard({
  dataset: d,
  date,
  onRemove,
  onOpenTable,
}: {
  dataset: DatasetSummary;
  date: string;
  onRemove: () => void;
  onOpenTable: (table: TableSummary) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<'processed' | 'raw'>('processed');
  const others = d.tables.filter((table) => table.derived && !table.derived.collection);
  return (
    <li className="card">
      <div className="dataset">
        <div>
          <h3>{d.name}</h3>
          <div className="meta">
            {t('datasets.files', { count: d.fileCount })} · {t('datasets.items', { count: d.nodeCount })} ·{' '}
            {t('datasets.imported', { date })}
          </div>
        </div>
        <div className="topbar-actions">
          <span className="segmented" role="group" aria-label={t('datasets.view', { name: d.name })}>
            {(['processed', 'raw'] as const).map((v) => (
              <button key={v} type="button" className="seg" aria-pressed={view === v} onClick={() => setView(v)}>
                {t(`datasets.${v}`)}
              </button>
            ))}
          </span>
          <button className="button danger" type="button" onClick={onRemove}>
            {t('datasets.delete')}
          </button>
        </div>
      </div>
      {view === 'raw' ? (
        <>
          <p className="meta found-title">{t('datasets.rawIntro')}</p>
          <RawData dataset={d} />
        </>
      ) : (
        <>
          {collections(d.tables).length > 0 ? (
            <>
              <h4 className="found-title">{t('datasets.found')}</h4>
              <ul className="found">
                {collections(d.tables).map((table) => (
                  <li key={table.id}>
                    <TableButton table={table} onOpen={onOpenTable} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="meta found-title">{t('datasets.nothingFound')}</p>
          )}
          {others.length > 0 && (
            <details className="other-data">
              <summary>{t('datasets.other', { count: others.length })}</summary>
              <p className="meta">{t('datasets.otherIntro')}</p>
              <ul className="found">
                {others.map((table) => (
                  <li key={table.id}>
                    <TableButton table={table} onOpen={onOpenTable} path />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </li>
  );
}
