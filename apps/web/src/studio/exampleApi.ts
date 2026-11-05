/**
 * Example projects: real projects to try the studio on, without an account. They are the
 * project screens over this module instead of the server: kept in this tab (sessionStorage, so
 * they reset when the tab closes), never published, without researchers or donations. Their test
 * packages are the synthetic fixtures of the platform packs (`@combray/importers`).
 *
 * Examples contain data, so a project is never started from one.
 */
import type { Localized, Shape, TreeNode } from '@combray/core';
import { examplePackages, packs } from '@combray/importers';

import example from '../../../../deploy/examples/projects/example.json';
import type { PackageStore, StoredPackage } from './api';
import { studio } from './client';
import { ApiFailure, type Draft, type PlatformDraft, type PlatformValue, type ProjectApi, type ProjectDetails } from './projectApi';

interface ExampleConfig {
  name: Localized;
  description?: Localized;
  participants: ProjectDetails['participants'];
  consent?: ProjectDetails['consent'];
  story?: unknown;
  uploads: { id: string; pack?: string; name: Localized; structure?: unknown; importer?: unknown }[];
}

export interface ExampleProject {
  /** In the address: `/studio/example/{id}/`. */
  id: string;
  config: ExampleConfig;
}

/** The examples on offer; the studio's copy says what each one is (`studio.examples.about.{id}`). */
export const EXAMPLES: ExampleProject[] = [{ id: 'youtube', config: example as ExampleConfig }];

/**
 * A test package a researcher added to an example: its structure kept in this tab, its values
 * (their own export) in this page's memory only.
 */
interface AddedPackage {
  id: string;
  name: string;
  shape: Shape;
  added: number;
}
const addedValues = new Map<string, TreeNode>();

/** What researchers changed: the whole example, as the project screens see it. */
interface ExampleState {
  details: ProjectDetails;
  platforms: (PlatformValue & { id: string })[];
  story: unknown;
  /** Per platform: the bundled packages taken away, and the packages added. */
  packages: Record<string, { removed: string[]; added: AddedPackage[] }>;
}

const storageKey = (id: string) => `combray:studio:example:${id}`;

function startState(config: ExampleConfig): ExampleState {
  return {
    details: {
      name: config.name,
      ...(config.description ? { description: config.description } : {}),
      participants: config.participants,
      ...(config.consent ? { consent: config.consent } : {}),
    },
    platforms: config.uploads.map((u) => {
      const pack = packs.find((p) => p.id === u.pack);
      return {
        id: u.id,
        name: u.name,
        ...(pack ? { pack: pack.id, structure: pack.structure, importer: pack.importer } : { structure: u.structure, importer: u.importer }),
      };
    }),
    story: config.story ?? null,
    packages: {},
  };
}

/** Each example's state, as long as this page is open; sessionStorage keeps it across reloads. */
const states = new Map<string, ExampleState>();

function stateOf(example: ExampleProject): ExampleState {
  let state = states.get(example.id);
  if (state) return state;
  try {
    const raw = sessionStorage.getItem(storageKey(example.id));
    if (raw) state = JSON.parse(raw) as ExampleState;
  } catch {
    // Unreadable: start again.
  }
  state ??= startState(example.config);
  states.set(example.id, state);
  return state;
}

function change(example: ExampleProject, edit: (state: ExampleState) => void): void {
  const state = stateOf(example);
  edit(state);
  try {
    sessionStorage.setItem(storageKey(example.id), JSON.stringify(state));
  } catch {
    // Without sessionStorage: kept until the page reloads.
  }
}

/** Start an example over. */
export function resetExample(id: string): void {
  states.delete(id);
  try {
    sessionStorage.removeItem(storageKey(id));
  } catch {
    // Nothing kept.
  }
}

/** The bundled packages' trees, read once per page. */
const bundled = new Map<string, Promise<{ tree: TreeNode; shape: Shape }>>();
function readBundled(id: string): Promise<{ tree: TreeNode; shape: Shape }> {
  let read = bundled.get(id);
  if (!read) {
    const pkg = examplePackages.find((p) => p.id === id);
    read = pkg ? pkg.load().then((files) => studio.readPackage(files)) : Promise.reject(new ApiFailure(404, 'not_found'));
    bundled.set(id, read);
  }
  return read;
}

const notFound = () => new ApiFailure(404, 'not_found');

/** The bundled packages count as added when the page was opened. */
const OPENED = Math.floor(Date.now() / 1000);
const size = (tree: TreeNode) => JSON.stringify(tree).length;

function packageStore(example: ExampleProject, platformId: string): PackageStore {
  const platform = () => stateOf(example).platforms.find((p) => p.id === platformId);
  const kept = () => stateOf(example).packages[platformId] ?? { removed: [], added: [] };
  const bundledHere = () => examplePackages.filter((p) => p.pack === platform()?.pack && !kept().removed.includes(p.id));
  const keep = (edit: (k: { removed: string[]; added: AddedPackage[] }) => void) =>
    change(example, (s) => {
      const k = s.packages[platformId] ?? { removed: [], added: [] };
      edit(k);
      s.packages[platformId] = k;
    });
  return {
    async list() {
      const packages: StoredPackage[] = [];
      const shapes: { hash: string; shape: Shape }[] = [];
      for (const pkg of bundledHere()) {
        const { tree, shape } = await readBundled(pkg.id);
        packages.push({ id: pkg.id, name: pkg.name, structure_hash: pkg.id, has_data: true, data_bytes: size(tree), added: OPENED, added_by: null });
        shapes.push({ hash: pkg.id, shape });
      }
      for (const pkg of kept().added) {
        const values = addedValues.get(pkg.id);
        packages.push({ id: pkg.id, name: pkg.name, structure_hash: pkg.id, has_data: values !== undefined, data_bytes: values ? size(values) : 0, added: pkg.added, added_by: null });
        shapes.push({ hash: pkg.id, shape: pkg.shape });
      }
      return { packages, shapes };
    },
    async add(name, shape, data) {
      const id = `added-${crypto.randomUUID()}`;
      if (data) addedValues.set(id, data);
      keep((k) => k.added.push({ id, name, shape, added: Math.floor(Date.now() / 1000) }));
      return { id, new_structure: true, existing: false };
    },
    async data(id) {
      const values = addedValues.get(id);
      if (values) return values;
      if (bundledHere().some((p) => p.id === id)) return (await readBundled(id)).tree;
      throw notFound();
    },
    async remove(id) {
      addedValues.delete(id);
      keep((k) => {
        if (k.added.some((p) => p.id === id)) k.added = k.added.filter((p) => p.id !== id);
        else k.removed.push(id);
      });
    },
  };
}

/** The project API of one example. */
export function exampleApi(example: ExampleProject): ProjectApi {
  return {
    example: true,
    async draft() {
      const s = stateOf(example);
      const draft: Draft = {
        id: example.id,
        details: s.details,
        platforms: s.platforms.map((p, position) => ({ id: p.id, name: p.name, pack: p.pack ?? null, position, has_tree: p.structure !== undefined })),
        published: null,
        unpublished_changes: false,
      };
      return structuredClone(draft);
    },
    async saveDetails(_id, details) {
      change(example, (s) => (s.details = structuredClone(details)));
    },
    async story() {
      return structuredClone(stateOf(example).story);
    },
    async saveStory(_id, story) {
      change(example, (s) => (s.story = structuredClone(story)));
    },
    async platform(_id, platformId) {
      const s = stateOf(example);
      const position = s.platforms.findIndex((p) => p.id === platformId);
      const p = s.platforms[position];
      if (!p) throw notFound();
      const draft: PlatformDraft = { id: p.id, name: p.name, ...(p.pack ? { pack: p.pack } : {}), position, structure: p.structure ?? null, importer: p.importer ?? null };
      return structuredClone(draft);
    },
    async savePlatform(_id, platformId, value) {
      change(example, (s) => {
        const next = { id: platformId, ...structuredClone(value) };
        const at = s.platforms.findIndex((p) => p.id === platformId);
        if (at >= 0) s.platforms[at] = next;
        else s.platforms.push(next);
      });
    },
    async removePlatform(_id, platformId) {
      change(example, (s) => {
        s.platforms = s.platforms.filter((p) => p.id !== platformId);
        delete s.packages[platformId];
      });
    },
    async project() {
      return { id: example.id, key: null, has_access: false, members: [] };
    },
    async members() {
      return [];
    },
    async donations() {
      return { donations: [], withdrawn: [] };
    },
    testPackages: (_id, platformId) => packageStore(example, platformId),
  };
}
