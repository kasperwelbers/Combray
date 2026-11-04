/** The studio's calls to the project API on its own site (`/api/v1`), with the studio session cookie. */
import type { Localized } from '@combray/core';

import type { PackageStore } from './api';

export interface ProjectDetails {
  name: Localized;
  description?: Localized;
  participants: { mode: 'anonymous' | 'optional' | 'required'; pattern?: string };
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

export const projectApi = {
  create: (id: string, name: Localized) => call<{ id: string }>('POST', '/projects', { id, name }),
  draft: (id: string) => call<Draft>('GET', `${project(id)}/draft`),
  saveDetails: (id: string, details: ProjectDetails) => call<void>('PUT', `${project(id)}/draft/details`, details),
  platform: (id: string, platform: string) => call<PlatformDraft>('GET', `${project(id)}/draft/platforms/${encodeURIComponent(platform)}`),
  savePlatform: (id: string, platform: string, value: { name: Localized; pack?: string; structure?: unknown; importer?: unknown }) =>
    call<void>('PUT', `${project(id)}/draft/platforms/${encodeURIComponent(platform)}`, value),
  removePlatform: (id: string, platform: string) => call<void>('DELETE', `${project(id)}/draft/platforms/${encodeURIComponent(platform)}`),
  project: (id: string) => call<ProjectInfo>('GET', project(id)),
  members: (id: string) => call<{ members: Member[] }>('GET', project(id)).then((p) => p.members),
  donations: (id: string) => call<Donations>('GET', `${project(id)}/donations`),
  /** A platform's test packages, as a store for the tree editor. */
  testPackages: (id: string, platform: string): PackageStore => {
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
