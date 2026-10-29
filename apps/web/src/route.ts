/**
 * Where the participant is: the project overview at `/`, or a project at `/{project}/`. The
 * researcher workspace is at `/studio/`.
 *
 * A study link can carry a participant id (`#id=P1234`) or a password reset token
 * (`#reset=…`) in the fragment, which browsers never send to the server, so they stay out of
 * every log. Both are removed from the address bar right away; the participant id is kept for
 * this tab only, so a reload before the store is created does not lose it.
 */

export type Route =
  | { kind: 'home' }
  | { kind: 'studio' }
  | { kind: 'project'; projectId: string; participantId?: string; resetToken?: string };

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
  const [first, ...rest] = pathname.split('/').filter(Boolean);
  if (!first || rest.length > 0 || !PROJECT_ID.test(first)) return { kind: 'home' };
  if (first === 'studio') return { kind: 'studio' };
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const route: Route = { kind: 'project', projectId: first };
  const id = params.get('id');
  if (id && PARTICIPANT_ID.test(id)) route.participantId = id;
  const reset = params.get('reset');
  if (reset && /^[A-Za-z0-9_-]{20,100}$/.test(reset)) route.resetToken = reset;
  return route;
}

export function readRoute(): Route {
  const route = parseRoute(location.pathname, location.hash);
  if (route.kind === 'project') {
    if (location.hash) history.replaceState(null, '', `/${route.projectId}/`);
    if (route.participantId) remember(route.projectId, route.participantId);
    else {
      const id = remembered(route.projectId);
      if (id) route.participantId = id;
    }
  } else if (route.kind === 'studio') {
    if (location.pathname !== '/studio/') history.replaceState(null, '', '/studio/');
  } else if (location.pathname !== '/') {
    history.replaceState(null, '', '/');
  }
  return route;
}
