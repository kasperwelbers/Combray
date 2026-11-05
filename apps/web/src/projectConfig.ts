/** Reading the parts of a project config the client uses, without trusting its shape. */
import { checkProjectTexts, type Localized, type ProjectTexts } from '@combray/core';

import type { UploadPoint } from './worker/api';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isLocalized = (v: unknown): v is Localized =>
  typeof v === 'string' || (isObject(v) && Object.values(v).every((s) => typeof s === 'string'));

/**
 * The upload points of a project config: `[{ id, name?, pack?, structure?, importer? }]`, with the
 * project's own tree (published from the studio) or a bundled pack to start from. Malformed
 * entries are left out; the tree files are checked when they are used.
 */
export function uploadPoints(raw: unknown, texts: ProjectTexts = {}): UploadPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p): UploadPoint[] => {
    if (!isObject(p) || typeof p.id !== 'string') return [];
    const pack = typeof p.pack === 'string' ? p.pack : undefined;
    const tree = isObject(p.structure) && isObject(p.importer);
    if (!pack && !tree) return [];
    return [
      {
        id: p.id,
        ...(pack ? { pack } : {}),
        ...(isLocalized(p.name) ? { name: p.name } : {}),
        ...(tree ? { structure: p.structure, importer: p.importer } : {}),
        ...(texts.platforms?.[p.id] ? { texts: texts.platforms[p.id] } : {}),
      },
    ];
  });
}

/** A project config's texts, checked; texts that are not right are left out as a whole. */
export function projectTexts(raw: unknown): ProjectTexts {
  try {
    return checkProjectTexts(raw);
  } catch {
    return {};
  }
}
