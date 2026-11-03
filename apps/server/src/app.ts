/**
 * The Combray server: serves the web client, a health check, read-only project configs from the data
 * directory, the store key service, and, when both site URLs are set, researcher sign-in, project
 * keys and donations.
 *
 * The server answers on two host names. The main site (`COMBRAY_PUBLIC_URL`) serves the participant
 * app and the studio. The key page (`COMBRAY_KEYS_URL`) serves one small page, the only place where
 * researchers use passkeys and handle keys (docs/researcher-keys.md). Requests are routed by their
 * `Host` header; an unknown host gets the main site.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Site } from './accounts.ts';
import { type Config, hostOf, VERSION } from './config.ts';
import { openKeysDb, openMainDb } from './db.ts';
import { dispatch, errorReply, HttpError, json, logRequest, noStore, type Reply, type Request, Router, send, serveStatic } from './http.ts';
import { KeyService, loadStoreMasterKey } from './keys.ts';
import { log } from './log.ts';
import { Projects } from './projects.ts';
import { PLATFORM_BODY_LIMIT, Research } from './research.ts';
import { projectError, storeHandlers } from './stores.ts';

/**
 * Content Security Policy for the web client: no inline scripts, no third-party origins.
 * `wasm-unsafe-eval` allows compiling WebAssembly (the importer script sandbox), not JS `eval`.
 * Trusted Types make DOM sinks such as `innerHTML` refuse plain strings. See docs/security.md.
 */
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; " +
  "require-trusted-types-for 'script'; trusted-types default";

/** The main site may never use passkeys: not even a script injected into the participant app. */
const MAIN_PERMISSIONS =
  'camera=(), microphone=(), geolocation=(), interest-cohort=(), publickey-credentials-get=(), publickey-credentials-create=()';
const KEYS_PERMISSIONS =
  'camera=(), microphone=(), geolocation=(), interest-cohort=(), publickey-credentials-get=(self), publickey-credentials-create=(self)';

function securityHeaders(site: Site): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': site === 'main' ? MAIN_PERMISSIONS : KEYS_PERMISSIONS,
    'cross-origin-opener-policy': 'same-origin',
    // The main site sends the web client's CSP; the key page sets its own, and its responses may not
    // be embedded or read by other origins.
    ...(site === 'main' ? { 'content-security-policy': CSP } : { 'cross-origin-resource-policy': 'same-origin' }),
  };
}

/** Add the site's security headers where the reply has not set them itself. */
function withSecurityHeaders(site: Site, reply: Reply): Reply {
  return { ...reply, headers: { ...securityHeaders(site), ...reply.headers } };
}

/**
 * The key page: one self-contained HTML file. Its Content Security Policy is in a `<meta>` tag (so
 * the downloadable copy carries it too); the server sends the same policy as a header and adds what
 * a `<meta>` tag cannot express.
 */
function loadKeysPage(path: string): Reply {
  let html: string;
  try {
    html = readFileSync(path, 'utf8');
  } catch {
    log.error({}, 'the key page is not built (pnpm --filter @combray/keys build)');
    return json({ error: 'key_page_not_built' }, 503);
  }
  const csp = html.split('http-equiv="Content-Security-Policy" content="')[1]?.split('"')[0] ?? "default-src 'none'";
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': `${csp}; frame-ancestors 'none'` },
    body: html,
  };
}

/** The client IP, for rate limiting only. Never stored or logged. */
function clientIp(config: Config, req: IncomingMessage): string {
  if (config.clientIpHeader) {
    const value = req.headers[config.clientIpHeader];
    const last = (Array.isArray(value) ? value.join(',') : (value ?? '')).split(',').pop()?.trim() ?? '';
    return /^[0-9a-fA-F:.]+$/.test(last) ? last : '0.0.0.0';
  }
  return (req.socket.remoteAddress ?? '0.0.0.0').replace(/^::ffff:/, '');
}

const STORE_LIMIT = 8 * 1024;
const MAIN_RESEARCH_LIMIT = 16 * 1024;
const KEYS_LIMIT = 64 * 1024;

/** Build the request handler. Fails if a database or the store master key cannot be opened. */
export function createApp(config: Config): (req: IncomingMessage, res: ServerResponse) => void {
  const db = openMainDb(config.dbPath);
  const keys = new KeyService(db, loadStoreMasterKey(config.storeMasterKeyFile), config.argon2);
  const projects = new Projects(db);
  const research = config.research ? new Research(config, config.research, db, openKeysDb(config.research.donationKeysDb), projects) : undefined;
  if (research && !research.mailer.enabled) log.warn({}, 'no mail settings: researchers cannot sign in (see docs/deployment.md)');
  const stores = storeHandlers(keys, projects);
  const h = research?.handlers(config);

  type SiteHandler = (req: Request, site: Site) => Reply | Promise<Reply>;
  /** Researcher routes answer `404 researchers_disabled` on a server without researcher accounts. */
  const on =
    (site: Site, handler: (handlers: NonNullable<typeof h>) => SiteHandler) =>
    (req: Request) => {
      if (!h) throw new HttpError(404, 'researchers_disabled');
      return handler(h)(req, site);
    };

  const health = () => json({ status: 'ok', version: VERSION });

  /** A project's config, with its public key once created. The participant pattern is left out. */
  const projectConfig = async (req: Request): Promise<Reply> => {
    const project = projects.live(req.params.id);
    if (typeof project !== 'object') throw projectError(project);
    const out: Record<string, unknown> = { ...project.config };
    if (out.participants && typeof out.participants === 'object') {
      const { pattern: _hidden, ...rest } = out.participants as Record<string, unknown>;
      out.participants = rest;
    }
    if (research) {
      const key = research.accounts.projectKey(req.params.id!);
      if (key) {
        out.donation_key = {
          public_key: key.public_key,
          fingerprint: key.fingerprint,
          // A withdrawal is complete once no backup holds the key.
          withdrawal_complete_days: research.config.keyBackupRetentionDays,
        };
      }
    }
    return json(out);
  };

  const main = new Router()
    .add('GET', '/health', health, 0)
    .add('GET', '/site', () => (h ? h.siteInfo() : json({ researchers: false })), 0)
    .add('GET', '/p/{id}/config', projectConfig, 0)
    .add('POST', '/stores', stores.create, STORE_LIMIT)
    .add('POST', '/stores/{id}/unlock', stores.unlock, STORE_LIMIT)
    .add('POST', '/stores/{id}/reset', stores.reset, STORE_LIMIT)
    .add('POST', '/stores/{id}/delete', stores.delete, STORE_LIMIT)
    .add('POST', '/auth/handoff/redeem', on('main', (x) => x.redeemHandoff), MAIN_RESEARCH_LIMIT)
    .add('POST', '/auth/logout', on('main', (x) => x.signOut), MAIN_RESEARCH_LIMIT)
    .add('GET', '/me', on('main', (x) => x.me), 0)
    .add('GET', '/projects', on('main', (x) => x.listProjects), 0)
    .add('POST', '/projects', on('main', (x) => x.createProject), MAIN_RESEARCH_LIMIT)
    .add('GET', '/projects/{id}', on('main', (x) => x.getProject), 0)
    .add('GET', '/projects/{id}/draft', on('main', (x) => x.getDraft), 0)
    .add('PUT', '/projects/{id}/draft/details', on('main', (x) => x.putDetails), MAIN_RESEARCH_LIMIT * 8)
    .add('GET', '/projects/{id}/draft/platforms/{platform}', on('main', (x) => x.getPlatform), 0)
    .add('PUT', '/projects/{id}/draft/platforms/{platform}', on('main', (x) => x.putPlatform), PLATFORM_BODY_LIMIT)
    .add('DELETE', '/projects/{id}/draft/platforms/{platform}', on('main', (x) => x.deletePlatform), MAIN_RESEARCH_LIMIT)
    .add('GET', '/projects/{id}/donations', on('main', (x) => x.listDonations), 0)
    .add('POST', '/donations/{id}/withdraw', on('main', (x) => x.withdraw), MAIN_RESEARCH_LIMIT)
    .add('POST', '/p/{id}/donations', on('main', (x) => x.donate), (config.research?.maxDonationBytes ?? 0) + 16 * 1024);

  const keysApi = new Router()
    .add('GET', '/health', health, 0)
    .add('GET', '/site', () => h!.siteInfo(), 0)
    .add('POST', '/auth/email', on('keys', (x) => x.requestEmailCode), KEYS_LIMIT)
    .add('POST', '/auth/email/verify', on('keys', (x) => x.verifyEmailCode), KEYS_LIMIT)
    .add('POST', '/auth/passkey/register/start', on('keys', (x) => x.startRegistration), KEYS_LIMIT)
    .add('POST', '/auth/passkey/register/finish', on('keys', (x) => x.finishRegistration), KEYS_LIMIT)
    .add('POST', '/auth/passkey/sign-in/start', on('keys', (x) => x.startPasskeySignIn), KEYS_LIMIT)
    .add('POST', '/auth/passkey/sign-in/finish', on('keys', (x) => x.finishPasskeySignIn), KEYS_LIMIT)
    .add('POST', '/auth/passkey/start', on('keys', (x) => x.startAuthentication), KEYS_LIMIT)
    .add('POST', '/auth/passkey/finish', on('keys', (x) => x.finishAuthentication), KEYS_LIMIT)
    .add('POST', '/auth/recovery', on('keys', (x) => x.recoverySignIn), KEYS_LIMIT)
    .add('POST', '/auth/logout', on('keys', (x) => x.signOut), KEYS_LIMIT)
    .add('POST', '/auth/handoff', on('keys', (x) => x.createHandoff), KEYS_LIMIT)
    .add('GET', '/me', on('keys', (x) => x.me), 0)
    .add('GET', '/me/contacts', on('keys', (x) => x.contacts), 0)
    .add('POST', '/me/key', on('keys', (x) => x.setPersonalKey), KEYS_LIMIT)
    .add('POST', '/me/reset-key', on('keys', (x) => x.resetOwnKey), KEYS_LIMIT)
    .add('DELETE', '/me/passkeys/{id}', on('keys', (x) => x.removePasskey), KEYS_LIMIT)
    .add('PUT', '/me/passkeys/{id}/wrapped', on('keys', (x) => x.setWrappedKey), KEYS_LIMIT)
    .add('GET', '/projects', on('keys', (x) => x.listProjects), 0)
    .add('GET', '/projects/{id}', on('keys', (x) => x.getProject), 0)
    .add('GET', '/projects/{id}/draft', on('keys', (x) => x.getDraft), 0)
    .add('POST', '/projects/{id}/publish', on('keys', (x) => x.publish), KEYS_LIMIT)
    .add('POST', '/projects/{id}/key', on('keys', (x) => x.createProjectKey), KEYS_LIMIT)
    .add('POST', '/projects/{id}/members', on('keys', (x) => x.addMember), KEYS_LIMIT)
    .add('DELETE', '/projects/{id}/members/{researcher}', on('keys', (x) => x.removeMember), KEYS_LIMIT)
    .add('PUT', '/projects/{id}/members/{researcher}/key', on('keys', (x) => x.grantAccess), KEYS_LIMIT)
    .add('GET', '/projects/{id}/donations', on('keys', (x) => x.listDonations), 0)
    .add('GET', '/projects/{id}/donations/{donation}', on('keys', (x) => x.getEnvelope), 0)
    .add('DELETE', '/projects/{id}/donations/{donation}', on('keys', (x) => x.withdrawForParticipant), KEYS_LIMIT)
    .add('POST', '/projects/{id}/donation-keys', on('keys', (x) => x.donationKeys), KEYS_LIMIT);

  const keysHost = config.research ? hostOf(config.research.keysUrl) : undefined;
  const keysPage = config.research ? loadKeysPage(config.research.keysPage) : undefined;

  return (req, res) => {
    const start = performance.now();
    const method = req.method ?? 'GET';
    const head = method === 'HEAD';
    const host = String(req.headers.host ?? '').toLowerCase();
    const site: Site = keysHost !== undefined && host === keysHost ? 'keys' : 'main';
    // Only the path: the query string is never looked at or logged.
    const rawPath = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
    const segments = rawPath.split('/').filter(Boolean);
    const ip = clientIp(config, req);

    const finish = (reply: Reply, route: string) => {
      send(res, withSecurityHeaders(site, reply), head);
      logRequest(method, route, reply.status, start);
    };

    void (async () => {
      try {
        if (segments[0] === 'api' && segments[1] === 'v1') {
          const { reply, route } = await dispatch(site === 'keys' ? keysApi : main, req, segments.slice(2), ip);
          finish(reply, `/api/v1${route.startsWith('/') ? route : `/${route}`}`);
          return;
        }
        if (site === 'keys') {
          if (rawPath === '/' && (method === 'GET' || head)) finish(keysPage!, '/');
          else finish(json({ error: 'not_found' }, 404), 'not_found');
          return;
        }
        if (method !== 'GET' && !head) {
          finish(json({ error: 'method_not_allowed' }, 405), 'static');
          return;
        }
        const status = await serveStatic(config.webDir, rawPath, res, head, securityHeaders('main'));
        logRequest(method, 'static', status, start);
      } catch (e) {
        if (!res.headersSent) finish(noStore(errorReply(e)), 'error');
        else res.destroy();
      }
    })();
  };
}
