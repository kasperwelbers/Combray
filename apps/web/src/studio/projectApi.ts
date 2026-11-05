/**
 * The studio's calls about one project: to the project API on its own site (`/api/v1`), with the
 * studio session cookie, or to an example project kept in this tab (`exampleApi.ts`). The
 * project's screens get them from `useProjectApi`.
 */
import type { Localized } from '@combray/core';
import { createContext, useContext } from 'react';

import type { PackageStore } from './api';

export interface ProjectDetails {
  name: Localized;
  description?: Localized;
  participants: { mode: 'anonymous' | 'optional' | 'required'; pattern?: string };
  /** What participants read and agree to before donating. */
  consent?: { information?: Localized; statements?: Localized[] };
}

export interface PlatformSummary {
  id: string;
  name: Localized;
  pack: string | null;
  position: number;
  has_tree: boolean;
}

export interface Draft {
  id: string;
  details: ProjectDetails;
  platforms: PlatformSummary[];
  published: { version: number; at: number } | null;
  unpublished_changes: boolean;
}

export interface PlatformDraft {
  id: string;
  name: Localized;
  pack?: string;
  position: number;
  structure: unknown;
  importer: unknown;
}

export interface PublishedVersion {
  version: number;
  at: number;
  config: { uploads?: { id: string; name?: Localized; structure?: unknown; importer?: unknown }[] };
}

export interface Member {
  researcher_id: string;
  email: string;
  public_key: string | null;
  has_access: boolean;
  added: number;
}

/** A project as a member sees it: its encryption key, whether you have access, and the members. */
export interface ProjectInfo {
  id: string;
  key: { public_key: string; fingerprint: string; created: number } | null;
  has_access: boolean;
  members: Member[];
}

export interface Donations {
  donations: { id: string; day: string; bytes: number }[];
  withdrawn: { id: string; day: string }[];
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Sent on `window` when the server says the studio session has ended. */
export const SIGNED_OUT_EVENT = 'combray:signed-out';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const answer = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
    throw new ApiFailure(response.status, answer.error ?? 'unknown');
  }
  return (response.status === 204 || response.status === 202 ? undefined : await response.json()) as T;
}

const project = (id: string) => `/projects/${encodeURIComponent(id)}`;

/** What is saved for a platform. */
export interface PlatformValue {
  name: Localized;
  pack?: string;
  structure?: unknown;
  importer?: unknown;
}

/** Everything a project's screens ask about it. */
export interface ProjectApi {
  /** An example project: kept in this tab, never published, without researchers or donations. */
  example: boolean;
  draft(id: string): Promise<Draft>;
  saveDetails(id: string, details: ProjectDetails): Promise<void>;
  /** The draft's story, as stored (participants' devices check it block by block); `null` for none. */
  story(id: string): Promise<unknown>;
  saveStory(id: string, story: unknown): Promise<void>;
  platform(id: string, platform: string): Promise<PlatformDraft>;
  /** A published version, as participants got it: to compare the draft with. */
  version(id: string, version: number): Promise<PublishedVersion>;
  savePlatform(id: string, platform: string, value: PlatformValue): Promise<void>;
  removePlatform(id: string, platform: string): Promise<void>;
  project(id: string): Promise<ProjectInfo>;
  members(id: string): Promise<Member[]>;
  donations(id: string): Promise<Donations>;
  /** A platform's test packages, as a store for the tree editor. */
  testPackages(id: string, platform: string): PackageStore;
}

/** Start a project on the server; its creator is its first member. */
export const createProject = (id: string, name: Localized) => call<{ id: string }>('POST', '/projects', { id, name });

export const serverApi: ProjectApi = {
  example: false,
  draft: (id) => call<Draft>('GET', `${project(id)}/draft`),
  saveDetails: (id, details) => call<void>('PUT', `${project(id)}/draft/details`, details),
  story: (id) => call<{ story: unknown }>('GET', `${project(id)}/draft/story`).then((r) => r.story),
  saveStory: (id, story) => call<void>('PUT', `${project(id)}/draft/story`, { story }),
  platform: (id, platform) => call<PlatformDraft>('GET', `${project(id)}/draft/platforms/${encodeURIComponent(platform)}`),
  savePlatform: (id, platform, value) => call<void>('PUT', `${project(id)}/draft/platforms/${encodeURIComponent(platform)}`, value),
  version: (id, version) => call<PublishedVersion>('GET', `${project(id)}/versions/${version}`),
  removePlatform: (id, platform) => call<void>('DELETE', `${project(id)}/draft/platforms/${encodeURIComponent(platform)}`),
  project: (id) => call<ProjectInfo>('GET', project(id)),
  members: (id) => call<{ members: Member[] }>('GET', project(id)).then((p) => p.members),
  donations: (id) => call<Donations>('GET', `${project(id)}/donations`),
  testPackages: (id, platform) => {
    const base = `${project(id)}/draft/platforms/${encodeURIComponent(platform)}/test-packages`;
    return {
      list: () => call('GET', base),
      add: (name, shape, data) =>
        call('POST', base, data === undefined ? { name, shape } : { name, shape, data, declaration: 'synthetic-or-not-sensitive' }),
      data: (pkg) => call('GET', `${base}/${encodeURIComponent(pkg)}/data`),
      remove: (pkg) => call('DELETE', `${base}/${encodeURIComponent(pkg)}`),
    };
  },
};

export const ProjectApiContext = createContext<ProjectApi>(serverApi);

/** The project API of the project on screen: the server's, or an example's. */
export const useProjectApi = () => useContext(ProjectApiContext);
