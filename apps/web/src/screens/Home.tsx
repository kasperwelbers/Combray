import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { localize } from '@combray/core';

import type { DatasetSummary, ImportProgress, TableSummary, Upload } from '../worker/api';
import { data, importFiles } from '../worker/client';

interface Props {
  datasets: DatasetSummary[];
  onChanged: () => Promise<void>;
  onOpen: (dataset: DatasetSummary) => void;
  onOpenTable: (table: TableSummary) => void;
}

/** Files from a drop. Dropped folders are read recursively with their relative paths. */
async function droppedFiles(event: DragEvent): Promise<Upload[]> {
  const entries = [...event.dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.some((e) => e.isDirectory)) return fromInput(event.dataTransfer.files);
  const files: Upload[] = [];
  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push({ file, path: prefix + file.name });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  }
  for (const entry of entries) await walk(entry, '');
  return files;
}

function fromInput(list: FileList | null): Upload[] {
  return [...(list ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

export function Home({ datasets, onChanged, onOpen, onOpenTable }: Props) {
  const { t, i18n } = useTranslation();
  const [progress, setProgress] = useState<ImportProgress>();
  const [error, setError] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  async function run(files: Upload[]) {
    if (files.length === 0) return;
    setError(false);
    setProgress({ step: 'reading', files: 0 });
    try {
      await importFiles(files, setProgress);
      await onChanged();
    } catch {
      setError(true);
    } finally {
      setProgress(undefined);
    }
  }

  async function remove(dataset: DatasetSummary) {
    if (!window.confirm(t('datasets.confirmDelete', { name: dataset.name }))) return;
    await data.deleteDataset(dataset.id);
    await onChanged();
  }

  const busy = progress !== undefined;
  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'long' });

  return (
    <>
      <section className="card" aria-labelledby="import-title">
        <h2 id="import-title">{t('import.title')}</h2>
        <p>{t('import.intro')}</p>
        <div
          className={`dropzone${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setOver(false);
            if (!busy) await run(await droppedFiles(e));
          }}
        >
          <div className="actions">
            <button className="button" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
              {t('import.chooseFiles')}
            </button>
            <button className="button quiet" type="button" disabled={busy} onClick={() => folderInput.current?.click()}>
              {t('import.chooseFolder')}
            </button>
          </div>
          <span className="meta">{t('import.drop')}</span>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void run(fromInput(e.target.files));
              e.target.value = '';
            }}
          />
          <input
            ref={folderInput}
            type="file"
            hidden
            {...{ webkitdirectory: '' }}
            onChange={(e) => {
              void run(fromInput(e.target.files));
              e.target.value = '';
            }}
          />
        </div>
        <div aria-live="polite">
          {progress && (
            <p className="message" style={{ marginTop: '1rem' }}>
              {t(`import.step.${progress.step}`, { count: progress.files ?? 0 })}
            </p>
          )}
          {error && (
            <p className="message error" role="alert" style={{ marginTop: '1rem' }}>
              {t('import.failed')}
            </p>
          )}
        </div>
      </section>

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
                {d.tables.length > 0 ? (
                  <>
                    <h4 className="found-title">{t('datasets.found')}</h4>
                    <ul className="found">
                      {d.tables.map((table) => (
                        <li key={table.id}>
                          <button type="button" className="found-item" onClick={() => onOpenTable(table)}>
                            <strong>{localize(table.name, i18n.language)}</strong>
                            <span className="meta">{t('datasets.items', { count: table.rowCount })}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="meta found-title">{t('datasets.nothingFound')}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
