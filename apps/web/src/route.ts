/**
 * Where the visitor is: the landing page at `/`, which explains Combray and leads to the two areas;
 * the participant area at `/p/` (the studies with data on this computer), a project at
 * `/p/{project}/`, with its questions and answers at `/p/{project}/faq`. The researcher workspace is at `/studio/` (sign-in
 * and the researcher's projects) `/studio/p/{project}/` (one project's workspace) and `/studio/learn/` (a practice tree editor
 * with example data, open without sign-in). Projects
 * live under `/p/` so their ids never clash with the app's own pages (ADR 0008).
 *
 * The studio may carry a one-time sign-in code from the key page (`/studio/#handoff=…`), which
 * `studio/StudioApp.tsx` reads and removes.
 *
 * A study link can carry a participant id (`#id=P1234`), a password reset token (`#reset=…`)
 * and the fingerprint of the study's key (`#k=…`, docs/researcher-keys.md) in the fragment, which
 * browsers never send to the server, so they stay out of every log. All are removed from the
 * address bar right away. The participant id is kept for this tab only, so a reload before the
 * store is created does not lose it; the key fingerprint is kept on this device, so a donation
 * made in a later visit is still checked against the key of the link.
 */

export type Route =
  | { kind: 'home' }
  | { kind: 'studies' }
  | { kind: 'studio'; projectId?: string; tab?: StudioTab; learn?: true }
  | { kind: 'project'; projectId: string; participantId?: string; resetToken?: string; keyPin?: string; page?: 'faq' };

const PROJECT_ID = /^[a-z0-9-]{1,64}$/;

/** The tabs of a project in the researcher workspace (`/studio/p/{project}/{tab}/`). */
export const STUDIO_TABS = ['details', 'consent', 'data', 'story', 'researchers', 'donations'] as const;
export type StudioTab = (typeof STUDIO_TABS)[number];
const isTab = (s: string | undefined): s is StudioTab => (STUDIO_TABS as readonly string[]).includes(s ?? '');
const PARTICIPANT_ID = /^[A-Za-z0-9._-]{1,64}$/;

const KEY_PIN = /^[A-Za-z0-9_-]{22}$/;

function remembered(storage: () => Storage, key: string): string | undefined {
  try {
    return storage().getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Without storage, a reload just needs the link again.
  }
}

const session = () => sessionStorage;
const device = () => localStorage;

/** Parse a location. Pure, for tests; `readRoute` also cleans up the address bar. */
export function parseRoute(pathname: string, hash: string): Route {
  const [first, projectId, ...rest] = pathname.split('/').filter(Boolean);
  if (first === 'studio') {
    if (projectId === undefined) return { kind: 'studio' };
    if (projectId === 'learn') return rest.length === 0 ? { kind: 'studio', learn: true } : { kind: 'home' };
    const [id, tab, ...more] = rest;
    if (projectId !== 'p' || !id || !PROJECT_ID.test(id) || more.length > 0) return { kind: 'home' };
    if (tab === undefined) return { kind: 'studio', projectId: id };
    return isTab(tab) ? { kind: 'studio', projectId: id, tab } : { kind: 'home' };
  }
  if (first === 'p' && projectId === undefined) return { kind: 'studies' };
  const faq = rest.length === 1 && rest[0] === 'faq';
  if (first !== 'p' || !projectId || !PROJECT_ID.test(projectId) || (rest.length > 0 && !faq)) {
    return { kind: 'home' };
  }
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const route: Route = { kind: 'project', projectId };
  if (faq) route.page = 'faq';
  const id = params.get('id');
  if (id && PARTICIPANT_ID.test(id)) route.participantId = id;
  const reset = params.get('reset');
  if (reset && /^[A-Za-z0-9_-]{20,100}$/.test(reset)) route.resetToken = reset;
  const k = params.get('k');
  if (k && KEY_PIN.test(k)) route.keyPin = k;
  return route;
}

/** The participant area: the studies with data on this computer. */
export const STUDIES_PATH = '/p/';

/** The address of a project page. */
export function projectPath(projectId: string, page?: 'faq'): string {
  return page ? `/p/${projectId}/${page}` : `/p/${projectId}/`;
}

/** The practice page of the researcher workspace: the tree editor with example data, no sign-in. */
export const STUDIO_LEARN_PATH = '/studio/learn/';

/** The address of the researcher workspace, of one project in it, or of one of its tabs. */
export function studioPath(projectId?: string, tab?: StudioTab): string {
  if (!projectId) return '/studio/';
  return tab ? `/studio/p/${projectId}/${tab}/` : `/studio/p/${projectId}/`;
}

export function readRoute(): Route {
  const route = parseRoute(location.pathname, location.hash);
  if (route.kind === 'project') {
    if (location.hash) history.replaceState(null, '', projectPath(route.projectId, route.page));
    const idKey = `combray:participant:${route.projectId}`;
    if (route.participantId) remember(session, idKey, route.participantId);
    else {
      const id = remembered(session, idKey);
      if (id) route.participantId = id;
    }
    const pinKey = `combray:key:${route.projectId}`;
    if (route.keyPin) remember(device, pinKey, route.keyPin);
    else {
      const pin = remembered(device, pinKey);
      if (pin) route.keyPin = pin;
    }
  } else if (route.kind === 'studio') {
    // Keep the fragment: the studio reads a handoff code from the key page there.
    const path = route.learn ? STUDIO_LEARN_PATH : studioPath(route.projectId, route.tab);
    if (location.pathname !== path) history.replaceState(null, '', path + location.hash);
  } else if (route.kind === 'studies') {
    if (location.pathname !== STUDIES_PATH) history.replaceState(null, '', STUDIES_PATH);
  } else if (location.pathname !== '/') {
    history.replaceState(null, '', '/');
  }
  return route;
}
