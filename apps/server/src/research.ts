/**
 * The HTTP side of researcher accounts, project keys and donations. See docs/researcher-keys.md
 * for the design and docs/security.md#researcher-sign-in-and-keys for the reasoning behind checks.
 *
 * Two sites, one server:
 *
 * - The **key page** (`COMBRAY_KEYS_URL`) is the only place where researchers use passkeys, and the
 *   only one that can fetch key material. Passkeys are bound to its host name.
 * - The **main site** (`COMBRAY_PUBLIC_URL`) serves participants and the studio. The studio signs in
 *   with the emailed code (or a handoff from the key page), and never receives a key.
 *
 * Every researcher request must come from the site's own origin (`Origin` and `Sec-Fetch-Site`), so
 * a page on the main site cannot drive the key page's API, even though both are the same site for
 * cookies.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import {
  AccountFailure,
  Accounts,
  EMAIL_SESSION_TTL_SECS,
  KEYS_SESSION_TTL_SECS,
  LOGIN_CODE_TTL_SECS,
  type Level,
  normalizeEmail,
  type Session,
  type Site,
  SoleAccess,
  STUDIO_SESSION_TTL_SECS,
  type StoredPasskey,
} from './accounts.ts';
import { base, type Config, hostOf, originOf, type ResearchConfig } from './config.ts';
import type { Db } from './db.ts';
import { DonationFailure, Donations, readHeader } from './donations.ts';
import { empty, HttpError, json, jsonBody, noStore, type Reply, type Request, str } from './http.ts';
import { RateLimit } from './limits.ts';
import { log } from './log.ts';
import { Mailer } from './mail.ts';
import { MAX_TREE_BYTES, ProjectFailure, Projects, validPlatformId, validProjectId } from './projects.ts';
import { b64, fromB64, randomToken, sha256, validRandomId } from './util.ts';

/** How long a passkey ceremony may take between its start and finish. */
const CEREMONY_TTL_MS = 300_000;
/** Passkey sign-ins that may be in progress at once, so unauthenticated starts cannot fill memory. */
const MAX_CEREMONIES = 10_000;

type Ceremony = { kind: 'register' | 'authenticate' | 'discover'; challenge: string; start: number };

const fail = (status: number, code: string): HttpError => new HttpError(status, code);
const tooMany = (retryAfter: number): HttpError => new HttpError(429, 'too_many_attempts', retryAfter);

/** Turn errors from the account and donation stores into answers. */
export function storeError(e: unknown): never {
  if (e instanceof AccountFailure) {
    const map = { not_found: [404, 'not_found'], forbidden: [403, 'forbidden'], conflict: [409, 'conflict'], invalid: [400, 'invalid'] } as const;
    const [status, code] = map[e.error];
    throw fail(status, code);
  }
  if (e instanceof ProjectFailure) {
    const map = { not_found: [404, 'no_such_project'], conflict: [409, 'conflict'], invalid: [400, 'invalid'] } as const;
    const [status, code] = map[e.error];
    throw fail(status, code);
  }
  if (e instanceof DonationFailure) {
    const map = { not_found: [404, 'no_such_donation'], forbidden: [403, 'wrong_token'], conflict: [409, 'conflict'] } as const;
    const [status, code] = map[e.error];
    throw fail(status, code);
  }
  throw e;
}

/** Run store code, turning its errors into answers. */
function call<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    return storeError(e);
  }
}

function decodeB64(value: unknown): Buffer {
  return fromB64(value) ?? (() => {
    throw fail(400, 'invalid');
  })();
}

/** A researcher id (a UUID) as the 16 bytes passkeys carry as their user handle, and back. */
const uuidBytes = (id: string): Buffer => Buffer.from(id.replace(/-/g, ''), 'hex');
function uuidFromBytes(bytes: Buffer): string | undefined {
  if (bytes.length !== 16) return undefined;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function cookie(headers: Request['headers'], name: string): string | undefined {
  for (const part of String(headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

function setCookie(reply: Reply, value: string, append: boolean): Reply {
  const existing = reply.headers?.['set-cookie'];
  const list = append ? (Array.isArray(existing) ? existing : existing ? [existing] : []) : [];
  return noStore({ ...reply, headers: { ...reply.headers, 'set-cookie': [...list, value] } });
}

export class Research {
  readonly accounts: Accounts;
  readonly donations: Donations;
  readonly projects: Projects;
  readonly mailer: Mailer;
  readonly config: ResearchConfig;
  private readonly rpId: string;
  private readonly ceremonies = new Map<string, Ceremony>();
  readonly emailPerIp = new RateLimit(20, 600);
  readonly emailPerAddress = new RateLimit(3, 900);
  readonly passkeyPerIp = new RateLimit(60, 600);
  readonly recoveryPerResearcher = new RateLimit(5, 3600);
  readonly donationsPerIp = new RateLimit(60, 600);

  constructor(config: Config, research: ResearchConfig, main: Db, keys: Db, projects: Projects) {
    this.config = research;
    this.projects = projects;
    this.accounts = new Accounts(main);
    this.donations = new Donations(main, keys, config.dataDir);
    this.mailer = new Mailer(research.mail);
    this.rpId = research.keysUrl.hostname;
  }

  siteUrl(site: Site): URL {
    return site === 'keys' ? this.config.keysUrl : this.config.publicUrl;
  }

  private secure(site: Site): boolean {
    return this.siteUrl(site).protocol === 'https:';
  }

  /** `__Host-` cookies must be Secure, have no Domain and Path=/, so no other host can plant them. */
  cookieName(site: Site): string {
    return this.secure(site) ? '__Host-combray' : 'combray';
  }

  /** The cookie that ties an emailed sign-in code to the browser that asked for it. */
  loginCookieName(site: Site): string {
    return this.secure(site) ? '__Host-combray-login' : 'combray-login';
  }

  private cookieValue(name: string, value: string, maxAge: number, site: Site): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure(site) ? '; Secure' : ''}`;
  }

  /** A reply that sets (or, with an empty value, clears) the session cookie. */
  withCookie(site: Site, value: string, level: Level, reply: Reply): Reply {
    const maxAge = !value ? 0 : level === 'email' ? EMAIL_SESSION_TTL_SECS : site === 'keys' ? KEYS_SESSION_TTL_SECS : STUDIO_SESSION_TTL_SECS;
    return setCookie(reply, this.cookieValue(this.cookieName(site), value, maxAge, site), false);
  }

  /** Add a cookie for the pending email sign-in (or, with an empty value, clear it). */
  withLoginCookie(site: Site, value: string, reply: Reply): Reply {
    return setCookie(reply, this.cookieValue(this.loginCookieName(site), value, value ? LOGIN_CODE_TTL_SECS : 0, site), true);
  }

  /**
   * Refuse requests from other origins. Browsers send `Sec-Fetch-Site` on every request and `Origin`
   * on every POST, PUT and DELETE; the latter is required for anything that changes state.
   */
  checkOrigin(site: Site, method: string, headers: Request['headers']): void {
    const fetchSite = headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') throw fail(403, 'cross_origin');
    const origin = headers.origin;
    if (origin === undefined) {
      if (method !== 'GET') throw fail(403, 'cross_origin');
      return;
    }
    if (origin !== originOf(this.siteUrl(site))) throw fail(403, 'cross_origin');
  }

  private putCeremony(key: string, kind: Ceremony['kind'], challenge: string): void {
    const now = Date.now();
    for (const [k, c] of this.ceremonies) if (now - c.start >= CEREMONY_TTL_MS) this.ceremonies.delete(k);
    if (this.ceremonies.size >= MAX_CEREMONIES) throw fail(503, 'busy');
    this.ceremonies.set(key, { kind, challenge, start: now });
  }

  private takeCeremony(key: string, kind: Ceremony['kind']): string | undefined {
    const c = this.ceremonies.get(key);
    this.ceremonies.delete(key);
    return c && c.kind === kind && Date.now() - c.start < CEREMONY_TTL_MS ? c.challenge : undefined;
  }

  /** Complete sign-in: a new session id, so a cookie seen before the second step is worthless. */
  private upgrade(site: Site, session: Session, reply: Reply): Reply {
    if (session.level === 'full') return noStore(reply);
    return this.withCookie(site, call(() => this.accounts.upgradeSession(session)), 'full', reply);
  }

  private async projectName(_dataDir: string, project: string): Promise<unknown> {
    return this.projects.name(project);
  }

  /** The routes of both sites, as handlers taking the site the request came to. */
  handlers(config: Config) {
    const r = this;
    const dataDir = config.dataDir;
    const keysOrigin = originOf(this.config.keysUrl);

    /** A same-origin request to either site, signed in or not. */
    const caller = (req: Request, site: Site) => {
      r.checkOrigin(site, req.method, req.headers);
      return site;
    };
    const keysOnly = (site: Site) => {
      if (site !== 'keys') throw fail(403, 'key_page_only');
    };
    /** A researcher who used the email code; the passkey or recovery code may still be missing. */
    const started = (req: Request, site: Site): Session => {
      caller(req, site);
      const token = cookie(req.headers, r.cookieName(site));
      const session = token ? call(() => r.accounts.session(token, site)) : undefined;
      if (!session) throw fail(401, 'not_signed_in');
      return session;
    };
    /** A fully signed-in researcher. */
    const signedIn = (req: Request, site: Site): Session => {
      const session = started(req, site);
      if (session.level !== 'full') throw fail(401, 'not_signed_in');
      return session;
    };
    /** The researcher must be a member of the project; returns whether they have key access. */
    const memberOf = (session: Session, project: string | undefined): boolean => {
      if (!validProjectId(project)) throw fail(404, 'no_such_project');
      const access = call(() => r.accounts.membership(project, session.researcherId));
      if (access === undefined) throw fail(404, 'no_such_project');
      return access;
    };
    const rpId = this.rpId;

    const verifyPasskey = async (credential: Record<string, unknown>, challenge: string, passkey: StoredPasskey): Promise<StoredPasskey> => {
      try {
        const result = await verifyAuthenticationResponse({
          response: { clientExtensionResults: {}, ...credential } as never,
          expectedChallenge: challenge,
          expectedOrigin: keysOrigin,
          expectedRPID: rpId,
          credential: { id: passkey.id, publicKey: new Uint8Array(passkey.publicKey), counter: passkey.counter, ...(passkey.transports ? { transports: passkey.transports } : {}) } as never,
          requireUserVerification: true,
        });
        if (!result.verified) throw new Error('not verified');
        return { ...passkey, counter: result.authenticationInfo.newCounter };
      } catch {
        throw fail(401, 'passkey_rejected');
      }
    };
    const credentialOf = (body: Record<string, unknown>): Record<string, unknown> => {
      const c = body.credential;
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw fail(422, 'invalid_body');
      return c as Record<string, unknown>;
    };

    return {
      /** Where the two sites are, so each page can link to the other. */
      siteInfo: (): Reply =>
        json({
          researchers: true,
          public_url: base(r.config.publicUrl),
          keys_url: base(r.config.keysUrl),
          // Development servers write mails to a folder; the pages say where to look.
          mail_outbox: r.mailer.isOutbox,
        }),

      /**
       * Mail a sign-in code, if there is an account for this email. Works on both sites: on the key
       * page it is the first step before the passkey, in the studio the whole sign-in. The code only
       * works in this browser, on this site: the answer sets a cookie with a random secret the code
       * is tied to. The answer is the same either way, and the mail goes out in the background.
       */
      requestEmailCode: (req: Request, site: Site): Reply => {
        caller(req, site);
        const body = jsonBody(req);
        if (!r.mailer.enabled) throw fail(503, 'mail_disabled');
        const ipWait = r.emailPerIp.hit(req.ip);
        if (ipWait !== undefined) throw tooMany(ipWait);
        const address = normalizeEmail(str(body, 'email'));
        if (!address) throw fail(400, 'invalid_email');
        const addressWait = r.emailPerAddress.hit(sha256(address).toString('hex'));
        if (addressWait !== undefined) throw tooMany(addressWait);
        const request = randomToken();
        setImmediate(() => {
          try {
            const code = r.accounts.createLoginCode(site, request, address);
            if (!code) return;
            const text =
              `Hello,\n\nYour Combray sign-in code is:\n\n    ${code.slice(0, 4)} ${code.slice(4)}\n\n` +
              `Type it on the page where you asked for it. It works for ${LOGIN_CODE_TTL_SECS / 60} minutes, only in that browser.\n\n` +
              'If you did not ask to sign in, you can ignore this email.\n';
            void r.mailer.send(address, 'Your Combray sign-in code', text);
          } catch {
            log.error({ error_class: 'login_code' }, 'could not create a sign-in code');
          }
        });
        return r.withLoginCookie(site, b64(request), empty(202));
      },

      /**
       * Check the emailed code, in the browser that asked for it. On the key page this starts a session
       * that still needs the passkey or recovery code; in the studio it signs in (studio sessions
       * never receive key material).
       */
      verifyEmailCode: (req: Request, site: Site): Reply => {
        caller(req, site);
        const body = jsonBody(req);
        const code = str(body, 'code');
        const request = fromB64(cookie(req.headers, r.loginCookieName(site)) ?? '');
        if (!request || !cookie(req.headers, r.loginCookieName(site))) throw fail(403, 'invalid_code');
        let researcher: string;
        try {
          researcher = r.accounts.useLoginCode(site, request, code);
        } catch (e) {
          if (e instanceof AccountFailure && (e.error === 'forbidden' || e.error === 'invalid')) throw fail(403, 'invalid_code');
          throw e;
        }
        const level: Level = site === 'keys' ? 'email' : 'full';
        const token = call(() => r.accounts.createSession(researcher, site, level));
        const me = call(() => r.accounts.me(researcher));
        const reply = r.withCookie(site, token, level, json({ email: me.email, has_passkey: me.passkeys.length > 0, has_key: me.public_key !== null }));
        return r.withLoginCookie(site, '', reply);
      },

      redeemHandoff: (req: Request, site: Site): Reply => {
        caller(req, site);
        if (site !== 'main') throw fail(403, 'studio_only');
        const code = str(jsonBody(req), 'code');
        let researcher: string;
        try {
          researcher = r.accounts.useHandoff(code);
        } catch (e) {
          if (e instanceof AccountFailure && (e.error === 'forbidden' || e.error === 'invalid')) throw fail(403, 'invalid_code');
          throw e;
        }
        return r.withCookie(site, call(() => r.accounts.createSession(researcher, site, 'full')), 'full', empty(204));
      },

      /** A one-time code for the studio, so the researcher is signed in there too. */
      createHandoff: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        return noStore(json({ code: call(() => r.accounts.createHandoff(who.researcherId)) }));
      },

      signOut: (req: Request, site: Site): Reply => {
        caller(req, site);
        const token = cookie(req.headers, r.cookieName(site));
        const session = token ? call(() => r.accounts.session(token, site)) : undefined;
        if (session) call(() => r.accounts.endSession(session));
        return r.withCookie(site, '', 'email', empty(204));
      },

      me: (req: Request, site: Site): Reply => {
        const who = started(req, site);
        const me = call(() => r.accounts.me(who.researcherId));
        return noStore(json({ id: me.id, email: me.email, signed_in: who.level === 'full', public_key: me.public_key, passkeys: me.passkeys }));
      },

      setPersonalKey: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const body = jsonBody(req);
        call(() => r.accounts.setPersonalKey(who.researcherId, decodeB64(str(body, 'public_key')), decodeB64(str(body, 'recovery_verifier'))));
        return empty(204);
      },

      setWrappedKey: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const body = jsonBody(req);
        call(() => r.accounts.setWrappedMaster(who.researcherId, req.params.id!, decodeB64(str(body, 'wrapped_key'))));
        return empty(204);
      },

      removePasskey: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        call(() => r.accounts.removePasskey(who.researcherId, req.params.id!));
        return empty(204);
      },

      startRegistration: async (req: Request, site: Site): Promise<Reply> => {
        const who = started(req, site);
        keysOnly(site);
        const existing = call(() => r.accounts.passkeys(who.researcherId));
        // With only the email code, a passkey can be added only to an account that has none yet.
        if (who.level === 'email' && existing.length > 0) throw fail(403, 'passkey_required');
        const email = call(() => r.accounts.emailOf(who.researcherId));
        const options = await generateRegistrationOptions({
          rpName: 'Combray',
          rpID: rpId,
          userName: email,
          userDisplayName: email,
          userID: new Uint8Array(uuidBytes(who.researcherId)),
          attestationType: 'none',
          timeout: CEREMONY_TTL_MS,
          excludeCredentials: existing.map((p) => ({ id: p.id, ...(p.transports ? { transports: p.transports } : {}) })),
          // Discoverable, so the passkey alone can sign in; user verification always.
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          extensions: { credProps: true } as never,
        });
        r.putCeremony(who.key.toString('hex'), 'register', options.challenge);
        return noStore(json({ publicKey: options }));
      },

      finishRegistration: async (req: Request, site: Site): Promise<Reply> => {
        const who = started(req, site);
        keysOnly(site);
        const body = jsonBody(req);
        const challenge = r.takeCeremony(who.key.toString('hex'), 'register');
        if (!challenge) throw fail(400, 'no_ceremony');
        const credential = credentialOf(body);
        let passkey: StoredPasskey;
        try {
          const result = await verifyRegistrationResponse({
            response: { clientExtensionResults: {}, ...credential } as never,
            expectedChallenge: challenge,
            expectedOrigin: keysOrigin,
            expectedRPID: rpId,
            requireUserVerification: true,
          });
          if (!result.verified) throw new Error('not verified');
          const c = result.registrationInfo.credential;
          passkey = { id: c.id, publicKey: c.publicKey, counter: c.counter, ...(c.transports ? { transports: c.transports } : {}) };
        } catch {
          throw fail(400, 'passkey_rejected');
        }
        const name = typeof body.name === 'string' ? body.name : '';
        const id = call(() => r.accounts.addPasskey(who.researcherId, passkey, name));
        return r.upgrade(site, who, json({ credential_id: id }));
      },

      startAuthentication: async (req: Request, site: Site): Promise<Reply> => {
        const who = started(req, site);
        keysOnly(site);
        const passkeys = call(() => r.accounts.passkeys(who.researcherId));
        if (passkeys.length === 0) throw fail(409, 'no_passkey');
        const options = await generateAuthenticationOptions({
          rpID: rpId,
          allowCredentials: passkeys.map((p) => ({ id: p.id, ...(p.transports ? { transports: p.transports } : {}) })),
          userVerification: 'required',
          timeout: CEREMONY_TTL_MS,
        });
        r.putCeremony(who.key.toString('hex'), 'authenticate', options.challenge);
        return noStore(json({ publicKey: options }));
      },

      /**
       * Check the passkey. Returns the personal key wrapped under this passkey, if it holds one: the
       * only way to get it is a fresh passkey assertion.
       */
      finishAuthentication: async (req: Request, site: Site): Promise<Reply> => {
        const who = started(req, site);
        keysOnly(site);
        const body = jsonBody(req);
        const challenge = r.takeCeremony(who.key.toString('hex'), 'authenticate');
        if (!challenge) throw fail(400, 'no_ceremony');
        const credential = credentialOf(body);
        const passkey = call(() => r.accounts.passkeys(who.researcherId)).find((p) => p.id === credential.id);
        if (!passkey) throw fail(401, 'passkey_rejected');
        const used = await verifyPasskey(credential, challenge, passkey);
        call(() => r.accounts.passkeyUsed(who.researcherId, used));
        const wrapped = call(() => r.accounts.wrappedMaster(who.researcherId, used.id));
        return r.upgrade(site, who, json({ credential_id: used.id, wrapped_key: wrapped }));
      },

      /**
       * Start signing in with a passkey alone: the browser offers the researcher's passkeys for the
       * key page, and the server learns from the answer whose it is.
       */
      startPasskeySignIn: async (req: Request, site: Site): Promise<Reply> => {
        caller(req, site);
        keysOnly(site);
        const wait = r.passkeyPerIp.hit(req.ip);
        if (wait !== undefined) throw tooMany(wait);
        const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'required', timeout: CEREMONY_TTL_MS });
        const id = randomToken();
        r.putCeremony(`discover/${id.toString('hex')}`, 'discover', options.challenge);
        return noStore(json({ ceremony: b64(id), options: { publicKey: options } }));
      },

      /** Finish signing in with a passkey alone: a full key page session, and the wrapped personal key. */
      finishPasskeySignIn: async (req: Request, site: Site): Promise<Reply> => {
        caller(req, site);
        keysOnly(site);
        const body = jsonBody(req);
        const ceremony = decodeB64(str(body, 'ceremony'));
        const challenge = r.takeCeremony(`discover/${ceremony.toString('hex')}`, 'discover');
        if (!challenge) throw fail(400, 'no_ceremony');
        const credential = credentialOf(body);
        const response = (credential.response ?? {}) as Record<string, unknown>;
        // Passkeys are registered with the researcher id as their user handle.
        const handle = fromB64(response.userHandle);
        const id = handle ? uuidFromBytes(handle) : undefined;
        if (!id) throw fail(401, 'passkey_rejected');
        const passkey = call(() => r.accounts.passkeys(id)).find((p) => p.id === credential.id);
        if (!passkey) throw fail(401, 'passkey_rejected');
        const used = await verifyPasskey(credential, challenge, passkey);
        call(() => r.accounts.passkeyUsed(id, used));
        const wrapped = call(() => r.accounts.wrappedMaster(id, used.id));
        const token = call(() => r.accounts.createSession(id, 'keys', 'full'));
        return r.withCookie('keys', token, 'full', json({ credential_id: used.id, wrapped_key: wrapped }));
      },

      /** Sign in with the recovery code instead of a passkey (the key page derives the secret from it). */
      recoverySignIn: (req: Request, site: Site): Reply => {
        const who = started(req, site);
        keysOnly(site);
        const wait = r.recoveryPerResearcher.hit(who.researcherId);
        if (wait !== undefined) throw tooMany(wait);
        const secret = decodeB64(str(jsonBody(req), 'secret'));
        if (!call(() => r.accounts.checkRecovery(who.researcherId, secret))) throw fail(401, 'wrong_recovery_code');
        return r.upgrade(site, who, empty(204));
      },

      /**
       * A researcher who lost both passkey and recovery code resets their own key, after the email
       * code. Refused while they are the only member with access to a project (the answer names the
       * projects). Afterwards their sessions are gone but a new email-level one, so they can set up
       * a new passkey and key; colleagues then give access again. A mail tells them it happened.
       */
      resetOwnKey: async (req: Request, site: Site): Promise<Reply> => {
        const who = started(req, site);
        keysOnly(site);
        try {
          r.accounts.resetOwnKey(who.researcherId);
        } catch (e) {
          if (e instanceof SoleAccess) {
            const projects = [];
            for (const id of e.projects) projects.push({ id, name: await r.projectName(dataDir, id) });
            return noStore(json({ error: 'sole_access', projects }, 409));
          }
          return storeError(e);
        }
        const token = call(() => r.accounts.createSession(who.researcherId, 'keys', 'email'));
        const address = call(() => r.accounts.emailOf(who.researcherId));
        const text =
          'Hello,\n\nThe key for your Combray researcher account was just reset, after a sign-in with an email code. ' +
          'Your old passkeys no longer work, and colleagues need to give you access to your projects again.\n\n' +
          'If this was not you, tell your colleagues not to give this account access, and contact your server operator.\n\n' +
          `${base(r.config.keysUrl)}\n`;
        setImmediate(() => void r.mailer.send(address, 'Your Combray key was reset', text));
        return r.withCookie('keys', token, 'email', empty(204));
      },

      // Projects: creating, the draft (edited in the studio, in parts), and publishing (key page).

      /** A researcher creates a project in the studio and becomes its first member. */
      createProject: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        const body = jsonBody(req);
        const id = str(body, 'id');
        if (!validProjectId(id)) throw fail(400, 'invalid_project_id');
        call(() => r.projects.create(id, body.name));
        call(() => r.accounts.addMember(id, who.researcherId));
        return json({ id }, 201);
      },

      getDraft: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        memberOf(who, req.params.id);
        return noStore(json(call(() => r.projects.draft(req.params.id!))));
      },

      putDetails: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        memberOf(who, req.params.id);
        call(() => r.projects.setDetails(req.params.id!, jsonBody(req)));
        return empty(204);
      },

      getPlatform: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        memberOf(who, req.params.id);
        return noStore(json(call(() => r.projects.platform(req.params.id!, req.params.platform!))));
      },

      putPlatform: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        memberOf(who, req.params.id);
        if (!validPlatformId(req.params.platform)) throw fail(400, 'invalid_platform_id');
        call(() => r.projects.putPlatform(req.params.id!, req.params.platform!, jsonBody(req)));
        return empty(204);
      },

      deletePlatform: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        memberOf(who, req.params.id);
        call(() => r.projects.deletePlatform(req.params.id!, req.params.platform!));
        return empty(204);
      },

      /**
       * Make the draft live: what participants see and are asked to donate. Only on the key page,
       * with a passkey session: a studio session (from an email code alone) cannot change it.
       */
      publish: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        memberOf(who, req.params.id);
        const version = call(() => r.projects.publish(req.params.id!));
        log.info({ event: 'project_published', version }, 'a project was published');
        return noStore(json({ version }));
      },

      listProjects: async (req: Request, site: Site): Promise<Reply> => {
        const who = signedIn(req, site);
        const projects = [];
        for (const { project, hasAccess } of call(() => r.accounts.projectsOf(who.researcherId))) {
          projects.push({
            id: project,
            name: await r.projectName(dataDir, project),
            has_access: hasAccess,
            fingerprint: call(() => r.accounts.projectKey(project))?.fingerprint ?? null,
          });
        }
        return noStore(json({ projects }));
      },

      getProject: async (req: Request, site: Site): Promise<Reply> => {
        const who = signedIn(req, site);
        const project = req.params.id!;
        const hasAccess = memberOf(who, project);
        // Only the key page receives this member's sealed copy of the project key.
        const sealed = site === 'keys' && hasAccess ? call(() => r.accounts.sealedProjectKey(project, who.researcherId)) : null;
        return noStore(
          json({
            id: project,
            name: await r.projectName(dataDir, project),
            key: call(() => r.accounts.projectKey(project)),
            has_access: hasAccess,
            sealed_key: sealed,
            members: call(() => r.accounts.members(project)),
          }),
        );
      },

      createProjectKey: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const project = req.params.id!;
        memberOf(who, project);
        const body = jsonBody(req);
        const sealed = (body.sealed_key ?? {}) as Record<string, unknown>;
        if (typeof sealed !== 'object') throw fail(422, 'invalid_body');
        call(() =>
          r.accounts.createProjectKey(
            project,
            who.researcherId,
            decodeB64(str(body, 'public_key')),
            str(body, 'fingerprint'),
            decodeB64(str(sealed, 'enc')),
            decodeB64(str(sealed, 'ciphertext')),
          ),
        );
        return empty(201);
      },

      /** Add a colleague, creating their account if needed. Access follows once a member grants it. */
      addMember: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const project = req.params.id!;
        memberOf(who, project);
        const email = normalizeEmail(str(jsonBody(req), 'email'));
        if (!email) throw fail(400, 'invalid_email');
        const id = call(() => r.accounts.addResearcher(email));
        call(() => r.accounts.addMember(project, id));
        const inviter = call(() => r.accounts.emailOf(who.researcherId));
        const text =
          `Hello,\n\n${inviter} added you to the project "${project}" on Combray.\n\n` +
          `Sign in at ${base(r.config.keysUrl)} with this email address to set up your passkey and key. ` +
          `Then ask ${inviter} to give you access; you will compare a short code with each other.\n`;
        setImmediate(() => void r.mailer.send(email, 'You were added to a Combray project', text));
        return empty(201);
      },

      grantAccess: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const project = req.params.id!;
        memberOf(who, project);
        const body = jsonBody(req);
        call(() => r.accounts.grant(project, who.researcherId, req.params.researcher!, decodeB64(str(body, 'enc')), decodeB64(str(body, 'ciphertext'))));
        log.info({ event: 'project_key_granted' }, 'a member granted project key access');
        return empty(204);
      },

      removeMember: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const project = req.params.id!;
        memberOf(who, project);
        call(() => r.accounts.removeMember(project, req.params.researcher!));
        return empty(204);
      },

      // Donations, researcher side.

      listDonations: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        const project = req.params.id!;
        memberOf(who, project);
        return noStore(json(call(() => r.donations.list(project))));
      },

      getEnvelope: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const project = req.params.id!;
        memberOf(who, project);
        const envelope = call(() => r.donations.envelope(project, req.params.donation!));
        return noStore({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: envelope });
      },

      /** The sealed keys of some donations, for a member with access, on the key page only. */
      donationKeys: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const project = req.params.id!;
        if (!memberOf(who, project)) throw fail(403, 'no_key_access');
        const ids = jsonBody(req).ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw fail(422, 'invalid_body');
        if (ids.length > 1000) throw fail(400, 'too_many_ids');
        const keys = call(() => r.donations.sealedKeys(project, ids));
        log.info({ event: 'donation_keys_fetched', count: keys.length }, 'sealed keys fetched');
        return noStore(json({ keys }));
      },

      withdrawForParticipant: (req: Request, site: Site): Reply => {
        const who = signedIn(req, site);
        keysOnly(site);
        const project = req.params.id!;
        memberOf(who, project);
        call(() => r.donations.withdrawForProject(project, req.params.donation!));
        return empty(204);
      },

      // Donations, participant side.

      /**
       * Accept a donation. The body is `u32 length (big-endian) | sealed key JSON | envelope`. The
       * server checks the envelope header against the project and its key; the header is
       * authenticated by the sealed key, so a client that lies here only makes a donation that does
       * not open.
       */
      donate: async (req: Request, site: Site): Promise<Reply> => {
        caller(req, site);
        const wait = r.donationsPerIp.hit(req.ip);
        if (wait !== undefined) throw tooMany(wait);
        const project = req.params.id!;
        if (typeof r.projects.live(project) !== 'object') throw fail(404, 'no_such_project');
        const key = call(() => r.accounts.projectKey(project));
        if (!key) throw fail(409, 'no_project_key');
        const invalid = () => fail(400, 'invalid_donation');
        const body = req.body;
        if (body.length < 4) throw invalid();
        const length = body.readUInt32BE(0);
        if (length > 8 * 1024 || 4 + length > body.length) throw invalid();
        let sealed: Record<string, unknown>;
        try {
          sealed = JSON.parse(body.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>;
        } catch {
          throw invalid();
        }
        if (!sealed || typeof sealed.enc !== 'string' || typeof sealed.ciphertext !== 'string') throw invalid();
        const envelope = body.subarray(4 + length);
        const h = readHeader(envelope);
        if (!h || h.v !== 1 || h.project !== project || !validRandomId(h.donation) || h.key !== key.fingerprint) throw invalid();
        const enc = fromB64(sealed.enc);
        const ct = fromB64(sealed.ciphertext);
        if (!enc || !ct || enc.length > 2048 || ct.length > 256) throw invalid();
        const token = call(() =>
          r.donations.store({ project, id: h.donation, keyFingerprint: key.fingerprint, enc, ciphertext: ct, envelope }),
        );
        return noStore(json({ donation: h.donation, withdrawal_token: token }, 201));
      },

      withdraw: (req: Request, site: Site): Reply => {
        caller(req, site);
        const wait = r.donationsPerIp.hit(req.ip);
        if (wait !== undefined) throw tooMany(wait);
        const token = fromB64(str(jsonBody(req), 'token'));
        if (!token) throw fail(403, 'wrong_token');
        call(() => r.donations.withdrawWithToken(req.params.id!, token));
        return empty(204);
      },
    };
  }
}

export { hostOf };

/** Platform drafts carry two project tree files. */
export const PLATFORM_BODY_LIMIT = 2 * MAX_TREE_BYTES + 64 * 1024;
