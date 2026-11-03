/**
 * A black-box harness for the Combray server: starts a fresh server process in a temporary
 * directory on a free port, talks to it over HTTP, runs its command line, and reads the files it
 * writes. Nothing here knows how the server is built: the tests describe behaviour, not an
 * implementation (they passed against the earlier server too, ADR 0010).
 *
 * The server runs from its TypeScript sources (`apps/server/src/main.ts`).
 *
 * All data here is synthetic.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { onTestFinished } from 'vitest';

export const repo = fileURLToPath(new URL('../../..', import.meta.url));

/** The command that runs the server (and its CLI), with any leading arguments. */
export function serverCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', join(repo, 'apps/server/src/main.ts')] };
}

/** The CSP of the main site (participant app and studio). */
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; " +
  "require-trusted-types-for 'script'; trusted-types default";

export const MAIN_PERMISSIONS =
  'camera=(), microphone=(), geolocation=(), interest-cohort=(), ' +
  'publickey-credentials-get=(), publickey-credentials-create=()';
export const KEYS_PERMISSIONS =
  'camera=(), microphone=(), geolocation=(), interest-cohort=(), ' +
  'publickey-credentials-get=(self), publickey-credentials-create=(self)';

/** The key page's own CSP, from the `<meta>` tag of the test key page. */
export const KEYS_PAGE_CSP = "default-src 'none'; script-src 'sha256-abc'";

export interface ServerOptions {
  /** Researcher sign-in and donations (`COMBRAY_PUBLIC_URL` and `COMBRAY_KEYS_URL`). Default true. */
  research?: boolean;
  /** Write sign-in mails to an outbox directory. Default true. */
  mail?: boolean;
  /** `http` (default) or `https` for both site URLs. The server itself always speaks HTTP. */
  scheme?: 'http' | 'https';
  /** Extra environment variables; `undefined` removes one. */
  env?: Record<string, string | undefined>;
}

export interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  /** The body parsed as JSON, or null. */
  json: any;
}

export interface RequestOptions {
  method?: string;
  host: string;
  path: string;
  headers?: Record<string, string>;
  /** An object is sent as JSON; a Buffer or string as it is. */
  body?: unknown;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Same-origin requests to one site, as its own page would make them. */
export interface Site {
  host: string;
  origin: string;
  get(path: string, cookie?: string): Promise<Response>;
  post(path: string, body?: unknown, cookie?: string): Promise<Response>;
  put(path: string, body?: unknown, cookie?: string): Promise<Response>;
  delete(path: string, cookie?: string): Promise<Response>;
}

/** Send one HTTP request to 127.0.0.1 with an explicit `Host` header. */
export function send(port: number, r: RequestOptions): Promise<Response> {
  const headers: Record<string, string | number> = { host: r.host, ...r.headers };
  let body: Buffer | undefined;
  if (Buffer.isBuffer(r.body)) body = r.body;
  else if (typeof r.body === 'string') body = Buffer.from(r.body);
  else if (r.body !== undefined) {
    body = Buffer.from(JSON.stringify(r.body));
    headers['content-type'] ??= 'application/json';
  }
  if (body) headers['content-length'] = body.length;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: r.method ?? 'GET', path: r.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        const text = data.toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The test projects. */
const PROJECTS: Record<string, string> = {
  'willow.json': JSON.stringify({ id: 'willow', name: { en: 'Willow study' } }),
  'oak.json': JSON.stringify({ id: 'oak', participants: { mode: 'required', pattern: 'P[0-9]{4}' } }),
  'elm.json': JSON.stringify({ id: 'elm', participants: { mode: 'anonymous' } }),
  'broken.json': '{not json',
};

export class TestServer {
  readonly dir: string;
  readonly port: number;
  readonly mainHost: string;
  readonly keysHost: string;
  readonly main: Site;
  readonly keys: Site;
  readonly paths: {
    web: string;
    data: string;
    db: string;
    masterKey: string;
    outbox: string;
    keysPage: string;
    donationKeysDb: string;
  };
  private readonly options: ServerOptions;
  private process: ReturnType<typeof spawn> | undefined;
  private output = '';

  constructor(port: number, options: ServerOptions) {
    this.port = port;
    this.options = options;
    this.dir = mkdtempSync(join(tmpdir(), 'combray-server-test-'));
    this.mainHost = `localhost:${port}`;
    this.keysHost = `keys.localhost:${port}`;
    const scheme = options.scheme ?? 'http';
    this.main = this.site(this.mainHost, `${scheme}://${this.mainHost}`);
    this.keys = this.site(this.keysHost, `${scheme}://${this.keysHost}`);
    const data = join(this.dir, 'data');
    this.paths = {
      web: join(this.dir, 'web'),
      data,
      db: join(data, 'combray.sqlite'),
      masterKey: join(this.dir, 'secrets/store-master.key'),
      outbox: join(this.dir, 'outbox'),
      keysPage: join(this.dir, 'keys.html'),
      // On its own "volume", as in production.
      donationKeysDb: join(this.dir, 'keys/donation-keys.sqlite'),
    };
    mkdirSync(join(this.paths.web, 'assets'), { recursive: true });
    mkdirSync(join(data, 'projects'), { recursive: true });
    writeFileSync(join(this.paths.web, 'index.html'), '<!doctype html><title>Combray</title>');
    writeFileSync(join(this.paths.web, 'assets/app.js'), 'console.log(1)');
    for (const [name, text] of Object.entries(PROJECTS)) writeFileSync(join(data, 'projects', name), text);
    writeFileSync(
      this.paths.keysPage,
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="${KEYS_PAGE_CSP}"><title>Keys</title>`,
    );
  }

  /** The environment the server and its CLI run with. */
  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    // Only what a process needs from the outside; never COMBRAY_* settings of the developer.
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const scheme = this.options.scheme ?? 'http';
    Object.assign(env, {
      RUST_LOG: 'warn',
      COMBRAY_BIND: `127.0.0.1:${this.port}`,
      COMBRAY_WEB_DIR: this.paths.web,
      COMBRAY_DATA_DIR: this.paths.data,
      COMBRAY_DB: this.paths.db,
      COMBRAY_STORE_MASTER_KEY_FILE: this.paths.masterKey,
      COMBRAY_CLIENT_IP_HEADER: 'x-forwarded-for',
    });
    if (this.options.research ?? true) {
      Object.assign(env, {
        COMBRAY_PUBLIC_URL: `${scheme}://${this.mainHost}`,
        COMBRAY_KEYS_URL: `${scheme}://${this.keysHost}`,
        COMBRAY_KEYS_PAGE: this.paths.keysPage,
        COMBRAY_DONATION_KEYS_DB: this.paths.donationKeysDb,
        COMBRAY_MAX_DONATION_MB: '1',
      });
      if (this.options.mail ?? true) env.COMBRAY_MAIL_OUTBOX = this.paths.outbox;
    }
    for (const [name, value] of Object.entries(this.options.env ?? {})) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    return env;
  }

  /** Start the server and wait until it answers its health check. */
  async start(): Promise<void> {
    const { command, args } = serverCommand();
    if (!existsSync(args.at(-1) ?? command)) {
      throw new Error(`${args.at(-1) ?? command} does not exist`);
    }
    this.output = '';
    const child = spawn(command, args, { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = child;
    child.stdout?.on('data', (d: Buffer) => (this.output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (this.output += d.toString()));
    for (let i = 0; i < 400; i++) {
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}:\n${this.output}`);
      try {
        const r = await send(this.port, { host: this.mainHost, path: '/api/v1/health' });
        if (r.status === 200) return;
      } catch {
        // not up yet
      }
      await sleep(25);
    }
    throw new Error(`the server did not start:\n${this.output}`);
  }

  /** Stop the server (SIGTERM, then SIGKILL) and wait for it to exit. */
  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** What the server wrote to stdout and stderr (for debugging). */
  logs(): string {
    return this.output;
  }

  /** Run the server's command line with the same environment. */
  cli(...cliArgs: string[]): Promise<CliResult> {
    const { command, args } = serverCommand();
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args, ...cliArgs], { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  /** Run a CLI command that must succeed; returns its stdout. */
  async cliOk(...cliArgs: string[]): Promise<string> {
    const r = await this.cli(...cliArgs);
    if (r.code !== 0) throw new Error(`combray-server ${cliArgs.join(' ')} failed (${r.code}): ${r.stderr}`);
    return r.stdout;
  }

  request(r: RequestOptions): Promise<Response> {
    return send(this.port, r);
  }

  /** The mails in the outbox, oldest first. */
  outbox(): { path: string; text: string }[] {
    if (!existsSync(this.paths.outbox)) return [];
    return readdirSync(this.paths.outbox)
      .sort()
      .map((name) => {
        const path = join(this.paths.outbox, name);
        return { path, text: readFileSync(path, 'utf8') };
      });
  }

  /** Wait for a mail to `to` that contains `marker`, remove it from the outbox and return it. */
  async takeMail(to: string, marker: string): Promise<string> {
    for (let i = 0; i < 300; i++) {
      const mails = this.outbox().filter((m) => m.text.startsWith(`To: ${to}\n`) && m.text.includes(marker));
      const mail = mails.at(-1);
      if (mail) {
        for (const m of mails) rmSync(m.path);
        return mail.text;
      }
      await sleep(10);
    }
    throw new Error(`no mail to ${to} containing "${marker}"`);
  }

  cleanUp(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private site(host: string, origin: string): Site {
    const call = (method: string, path: string, body: unknown, cookie: string | undefined) =>
      this.request({
        method,
        host,
        path,
        body,
        headers: { origin, 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) },
      });
    return {
      host,
      origin,
      get: (path, cookie) => call('GET', path, undefined, cookie),
      post: (path, body, cookie) => call('POST', path, body, cookie),
      put: (path, body, cookie) => call('PUT', path, body, cookie),
      delete: (path, cookie) => call('DELETE', path, undefined, cookie),
    };
  }
}

/**
 * Start a fresh server for the current test; it is stopped and its directory removed when the
 * test finishes. Every test gets its own, because rate limits live in the server's memory.
 */
export async function startServer(options: ServerOptions = {}): Promise<TestServer> {
  const server = new TestServer(await freePort(), options);
  onTestFinished(async () => {
    await server.stop();
    server.cleanUp();
  });
  await server.start();
  return server;
}

/** All `Set-Cookie` headers of a response. */
export function setCookies(r: Response): string[] {
  return r.headers['set-cookie'] ?? [];
}

/**
 * The `Set-Cookie` for cookie `name`, which must be HttpOnly and SameSite=Strict. Returns the
 * `name=value` pair to send back, and the whole header for checking its attributes.
 */
export function cookie(r: Response, name: string): { pair: string; value: string; header: string } {
  const header = setCookies(r).find((c) => c.startsWith(`${name}=`));
  if (!header) throw new Error(`no Set-Cookie for ${name} in ${JSON.stringify(setCookies(r))}`);
  if (!header.includes('HttpOnly') || !header.includes('SameSite=Strict')) {
    throw new Error(`cookie is not HttpOnly and SameSite=Strict: ${header}`);
  }
  const pair = header.split(';')[0]!;
  return { pair, value: pair.slice(name.length + 1), header };
}

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
export const fill = (byte: number, length: number) => Buffer.alloc(length, byte);
