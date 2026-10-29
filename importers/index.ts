/**
 * The bundled platform packs: importer specs in YAML, one file per importer.
 * See README.md for how to write and test one.
 */
import { parseSpec, type ImporterSpec } from '@combray/core';

const sources = import.meta.glob<string>('./*/*.yaml', { query: '?raw', import: 'default', eager: true });

/** All bundled importer specs, validated. */
export const importers: ImporterSpec[] = Object.keys(sources)
  .sort()
  .map((path) => parseSpec(sources[path]!));

export const PLATFORMS = ['google-takeout', 'tiktok'] as const;
