/**
 * Where the visitor is: the landing page at `/`, which explains Combray and leads to the two areas;
 * the participant area at `/p/` (the studies with data on this computer), a project at
 * `/p/{project}/`, with its questions and answers at `/p/{project}/faq`. The researcher workspace is at `/studio/` (sign-in
 * and the researcher's projects) and `/studio/p/{project}/` (one project's workspace). Projects
 * live under `/p/` so their ids never clash with the app's own pages (ADR 0008).
 *
 * The studio may carry a one-time sign-in code from the key page (`/studio/#handoff=…`), which
 * `studio/StudioApp.tsx` reads and removes.
 *
 * A study link can carry a participant id (`#id=P1234`) or a password reset token
 * (`#reset=…`) in the fragment, which browsers never send to the server, so they stay out of
 * every log. Both are removed from the address bar right away; the participant id is kept for
 * this tab only, so a reload before the store is created does not lose it.
 */

export type Route =
  | { kind: 'home' }
  | { kind: 'studies' }
  | { kind: 'studio'; projectId?: string }
  | { kind: 'project'; projectId: string; participantId?: string; resetToken?: string; page?: 'faq' };

const PROJECT_ID = /^[a-z0-9-]{1,64}$/;
const PARTICIPANT_ID = /^[A-Za-z0-9._-]{1,64}$/;

function remembered(projectId: string): string | undefined {
  try {
    return sessionStorage.getItem(`combray:participant:${projectId}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(projectId: string, participantId: string): void {
  try {
    sessionStorage.setItem(`combray:participant:${projectId}`, participantId);
  } catch {
    // Without session storage, a reload just needs the link again.
  }
}

/** Parse a location. Pure, for tests; `readRoute` also cleans up the address bar. */
export function parseRoute(pathname: string, hash: string): Route {
  const [first, projectId, ...rest] = pathname.split('/').filter(Boolean);
  if (first === 'studio') {
    if (projectId === undefined) return { kind: 'studio' };
    const [id, ...more] = rest;
    if (projectId === 'p' && id && PROJECT_ID.test(id) && more.length === 0) return { kind: 'studio', projectId: id };
    return { kind: 'home' };
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
  return route;
}

/** The participant area: the studies with data on this computer. */
export const STUDIES_PATH = '/p/';

/** The address of a project page. */
export function projectPath(projectId: string, page?: 'faq'): string {
  return page ? `/p/${projectId}/${page}` : `/p/${projectId}/`;
}

/** The address of the researcher workspace, or of one project in it. */
export function studioPath(projectId?: string): string {
  return projectId ? `/studio/p/${projectId}/` : '/studio/';
}

export function readRoute(): Route {
  const route = parseRoute(location.pathname, location.hash);
  if (route.kind === 'project') {
    if (location.hash) history.replaceState(null, '', projectPath(route.projectId, route.page));
    if (route.participantId) remember(route.projectId, route.participantId);
    else {
      const id = remembered(route.projectId);
      if (id) route.participantId = id;
    }
  } else if (route.kind === 'studio') {
    // Keep the fragment: the studio reads a handoff code from the key page there.
    const path = studioPath(route.projectId);
    if (location.pathname !== path) history.replaceState(null, '', path + location.hash);
  } else if (route.kind === 'studies') {
    if (location.pathname !== STUDIES_PATH) history.replaceState(null, '', STUDIES_PATH);
  } else if (location.pathname !== '/') {
    history.replaceState(null, '', '/');
  }
  return route;
}
