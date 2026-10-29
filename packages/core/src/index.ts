export * from './tree';
export { inferType } from './infer';
export { parsePath, findPath, globMatch, PathError } from './path';
export type { Path, PathMatch, Segment, NamePattern, ElementSelector } from './path';
export { extractShape, screenName, elementName, countBucket, mergeAll, shapeSize, ITEM_NAME, COLLAPSED_NAME } from './shape';
export type { Shape, CountBucket } from './shape';
export { parseFile, parseEntries, parseZip, mergeDirs, decodeText, jsonToTree } from './parse';
export type { ParseOptions, FileEntry } from './parse';
export { flatten, unflatten, locationOf } from './flat';
export type { FlatNode } from './flat';
export * from './importer';
export {
  projectTreeFromShape,
  mergeShape,
  effectiveStates,
  setDecision,
  setTable,
  ignoreOverrides,
  mergeNodes,
  compareShape,
  getNode,
  matchChild,
  nameMatches,
  isLeaf,
  DecisionError,
} from './decisions';
export type {
  ProjectNode,
  NodePath,
  Alias,
  LeafDecision,
  EffectiveState,
  MergeConflict,
  ShapeComparison,
} from './decisions';
export { deriveTables, deriveRows } from './derive';
export type { TableDef, ColumnDef, DerivedRow } from './derive';
export {
  splitProjectTree,
  joinProjectTree,
  parseStructureFile,
  parseImporterFile,
  ProjectFileError,
  STRUCTURE_FORMAT,
  IMPORTER_FORMAT,
} from './projectFiles';
export type { StructureFile, ImporterFile, ImporterEntry } from './projectFiles';
