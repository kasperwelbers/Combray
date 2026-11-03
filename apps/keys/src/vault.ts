/**
 * The keys this page holds, in memory only. Nothing here is ever written to storage: closing the
 * tab, locking, or 15 minutes without input wipe it, and unlocking needs the passkey again.
 */
import { type ProjectKey, fromBase64Url, openProjectKey, personalKey, sealedFromJson } from '@combray/seal';

import type { Project } from './api';

const IDLE_MS = 15 * 60 * 1000;

interface Unlocked {
  researcherId: string;
  master: Uint8Array;
  seed: Uint8Array;
  publicKey: Uint8Array;
  projects: Map<string, ProjectKey>;
}

let unlocked: Unlocked | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let onLock: (() => void) | undefined;

function wipe(bytes: Uint8Array) {
  bytes.fill(0);
}

export function lock(): void {
  if (!unlocked) return;
  wipe(unlocked.master);
  wipe(unlocked.seed);
  for (const key of unlocked.projects.values()) wipe(key.seed);
  unlocked = undefined;
  clearTimeout(timer);
  onLock?.();
}

function touch() {
  clearTimeout(timer);
  if (unlocked) timer = setTimeout(lock, IDLE_MS);
}

export function watchIdle(callback: () => void): void {
  onLock = callback;
  for (const event of ['pointerdown', 'keydown']) addEventListener(event, touch, { passive: true });
  addEventListener('pagehide', lock);
}

export class KeyMismatch extends Error {
  constructor(what: string) {
    super(`The ${what} from the server does not match the one your key produces. Do not continue, and tell the server operator.`);
    this.name = 'KeyMismatch';
  }
}

/**
 * Hold the personal key from its master secret. `expected` is the public key the server has on
 * record; if the server ever returned another one, something is wrong.
 */
export async function unlock(researcherId: string, master: Uint8Array, expected?: string | null): Promise<Uint8Array> {
  const key = await personalKey(master);
  if (expected) {
    const server = fromBase64Url(expected);
    if (server.length !== key.publicKey.length || server.some((b, i) => b !== key.publicKey[i])) {
      wipe(key.seed);
      throw new KeyMismatch('personal key');
    }
  }
  lock();
  unlocked = { researcherId, master, seed: key.seed, publicKey: key.publicKey, projects: new Map() };
  touch();
  return key.publicKey;
}

export function isUnlocked(): boolean {
  return unlocked !== undefined;
}

export function personal(): Unlocked {
  if (!unlocked) throw new Error('Your keys are locked. Use your passkey to unlock them.');
  return unlocked;
}

/** Open this researcher's sealed copy of a project key, and check it is the project's key. */
export async function projectKey(project: Project): Promise<ProjectKey> {
  const me = personal();
  const cached = me.projects.get(project.id);
  if (cached) return cached;
  if (!project.sealed_key || !project.key) throw new Error('You do not have access to this project key yet.');
  const key = await openProjectKey(sealedFromJson(project.sealed_key), me.seed, project.id, me.researcherId);
  const server = fromBase64Url(project.key.public_key);
  if (server.length !== key.publicKey.length || server.some((b, i) => b !== key.publicKey[i])) {
    wipe(key.seed);
    throw new KeyMismatch('project key');
  }
  me.projects.set(project.id, key);
  return key;
}

/** Keep a project key just created on this page. */
export function rememberProjectKey(projectId: string, key: ProjectKey): void {
  personal().projects.set(projectId, key);
}
