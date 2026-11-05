/**
 * Platform packs as project trees: per platform a reference `structure.json`, the structures seen
 * in the synthetic fixtures; an `importer.json`, the configuration: matches, names, conversions
 * and decisions (docs/decisions/0012-names-and-matches.md); and a `texts.json`, the labels
 * participants see, per language (ADR 0013). A project starts from a pack and makes its own
 * decisions (docs/tree-decisions.md).
 */
import {
  buildTree,
  configOf,
  parseImporterFile,
  parseStructureFile,
  parseTextsFile,
  type ImporterFile,
  type PlatformTexts,
  type Localized,
  type ProjectNode,
  type StructureFile,
} from '@combray/core';

export interface PlatformPack {
  id: string;
  name: Localized;
  structure: StructureFile;
  importer: ImporterFile;
  /** Labels and descriptions of its tables and fields. */
  texts: PlatformTexts;
}

const files = import.meta.glob<unknown>('./*/{structure,importer,texts}.json', { eager: true, import: 'default' });

function pack(id: string): PlatformPack | undefined {
  const structure = files[`./${id}/structure.json`];
  const importer = files[`./${id}/importer.json`];
  if (!structure || !importer) return undefined;
  const parsed = parseImporterFile(importer);
  const texts = files[`./${id}/texts.json`];
  return { id, name: parsed.name ?? id, structure: parseStructureFile(structure), importer: parsed, texts: texts ? parseTextsFile(texts) : {} };
}

export const PACK_IDS = ['google-takeout', 'tiktok'] as const;

/** The bundled packs, validated. */
export const packs: PlatformPack[] = PACK_IDS.flatMap((id) => pack(id) ?? []);

/** A pack's project tree: its configuration laid over the structures it has seen. */
export function packTree(pack: PlatformPack): ProjectNode {
  return buildTree(configOf(pack.importer), pack.structure.root).tree;
}
