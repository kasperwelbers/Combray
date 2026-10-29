import * as Comlink from 'comlink';

import type { ImportProgress, Upload } from '../worker/api';
import type { StudioApi } from './api';

const worker = new Worker(new URL('./studio.worker.ts', import.meta.url), { type: 'module' });

/** The studio worker, wrapped with Comlink. */
export const studio = Comlink.wrap<StudioApi>(worker);

export function addExport(uploads: Upload[], onProgress: (p: ImportProgress) => void) {
  return studio.addExport(uploads, Comlink.proxy(onProgress));
}
