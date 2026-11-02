import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { localize } from '@combray/core';

import { ImportCard } from '../components/ImportCard';
import { foldedPath } from '../format';
import type { DatasetSummary, TableSummary, UploadPoint } from '../worker/api';
import { data } from '../worker/client';

interface Props {
  datasets: DatasetSummary[];
  /** The project's upload points, one uploader each; without them, the YAML importers run. */
  points?: UploadPoint[];
  onChanged: () => Promise<void>;
  onOpen: (dataset: DatasetSummary) => void;
  onOpenTable: (table: TableSummary) => void;
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

export function Home({ datasets, points, onChanged, onOpen, onOpenTable }: Props) {
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

      <section aria-labelledby="datasets-title" style={{ marginTop: '2.5rem' }}>
        <h2 id="datasets-title">{t('home.title')}</h2>
        {datasets.length === 0 ? (
          <p className="meta">{t('home.empty')}</p>
        ) : (
          <ul className="datasets">
            {datasets.map((d) => (
              <li key={d.id} className="card">
                <div className="dataset">
                  <div>
                    <h3>{d.name}</h3>
                    <div className="meta">
                      {t('datasets.files', { count: d.fileCount })} · {t('datasets.items', { count: d.nodeCount })} ·{' '}
                      {t('datasets.imported', { date: date(d.importedAt) })}
                    </div>
                  </div>
                  <div className="topbar-actions">
                    <button className="button quiet" type="button" onClick={() => onOpen(d)}>
                      {t('datasets.browse')}
                    </button>
                    <button className="button danger" type="button" onClick={() => remove(d)}>
                      {t('datasets.delete')}
                    </button>
                  </div>
                </div>
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
                {d.tables.some((table) => table.derived && !table.derived.collection) && (
                  <details className="other-data">
                    <summary>
                      {t('datasets.other', { count: d.tables.filter((x) => x.derived && !x.derived.collection).length })}
                    </summary>
                    <p className="meta">{t('datasets.otherIntro')}</p>
                    <ul className="found">
                      {d.tables
                        .filter((table) => table.derived && !table.derived.collection)
                        .map((table) => (
                          <li key={table.id}>
                            <TableButton table={table} onOpen={onOpenTable} path />
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
