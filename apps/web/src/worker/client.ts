import * as Comlink from 'comlink';

import type { DataApi, ImportProgress, Upload } from './api';

const worker = new Worker(new URL('./data.worker.ts', import.meta.url), { type: 'module' });

/** The data worker, wrapped with Comlink. */
export const data = Comlink.wrap<DataApi>(worker);

export function importFiles(uploads: Upload[], onProgress: (p: ImportProgress) => void) {
  return data.importFiles(uploads, Comlink.proxy(onProgress));
}
