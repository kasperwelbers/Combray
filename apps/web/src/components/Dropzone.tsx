import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Upload } from '../worker/api';

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

/** A drop target with buttons for files and for a folder. */
export function Dropzone({ busy, onFiles }: { busy: boolean; onFiles: (files: Upload[]) => Promise<void> }) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  return (
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
        if (!busy) await onFiles(await droppedFiles(e));
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
          void onFiles(fromInput(e.target.files));
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          void onFiles(fromInput(e.target.files));
          e.target.value = '';
        }}
      />
    </div>
  );
}
