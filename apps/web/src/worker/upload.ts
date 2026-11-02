/**
 * Dropped files, folders and archives as an upload listing: names and sizes only, read later
 * and only where needed (`@combray/core`'s `locateRoot`). Shared by the data worker and the
 * studio worker; runs in a worker, never on the main thread.
 */
import { UploadListing } from '@combray/core';

import type { Upload } from './api';

export function listUpload(uploads: Upload[]): Promise<UploadListing> {
  return UploadListing.open(
    uploads.map(({ file, path }) => ({
      path,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    })),
  );
}
