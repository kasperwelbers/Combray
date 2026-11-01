/** Reading the parts of a project config the client uses, without trusting its shape. */
import type { Localized } from '@combray/core';

import type { UploadPoint } from './worker/api';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isLocalized = (v: unknown): v is Localized =>
  typeof v === 'string' || (isObject(v) && Object.values(v).every((s) => typeof s === 'string'));

/**
 * The upload points of a project config: `[{ id, pack, name? }]`. Malformed entries are left
 * out; packs the client does not have are ignored when importing.
 */
export function uploadPoints(raw: unknown): UploadPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p): UploadPoint[] => {
    if (!isObject(p) || typeof p.id !== 'string' || typeof p.pack !== 'string') return [];
    return [{ id: p.id, pack: p.pack, ...(isLocalized(p.name) ? { name: p.name } : {}) }];
  });
}
