/**
 * A small HTTP layer on `node:http`: routing by path template, JSON bodies with size limits, error
 * answers, security headers and static files. Deliberately no framework (ADR 0010: few dependencies).
 *
 * Privacy rule: requests are logged by method, route template, status and duration only. Never the
 * URL, query string, headers or bodies.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

import { log } from './log.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** An error answer: a status, a stable code for the client, maybe a `Retry-After` and more fields. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  readonly extra?: Record<string, unknown>;
  constructor(status: number, code: string, retryAfter?: number, extra?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
    if (extra !== undefined) this.extra = extra;
  }
}

export interface Reply {
  status: number;
  headers?: Record<string, string | string[]>;
  /** JSON (objects), text, or bytes. */
  body?: unknown;
}

export const json = (body: unknown, status = 200, headers: Record<string, string | string[]> = {}): Reply => ({ status, headers, body });
export const empty = (status: number, headers: Record<string, string | string[]> = {}): Reply => ({ status, headers });

/** Key material and session answers must never be cached by the browser or a proxy. */
export function noStore(reply: Reply): Reply {
  return { ...reply, headers: { ...reply.headers, 'cache-control': 'no-store' } };
}

export interface Request {
  method: string;
  headers: IncomingMessage['headers'];
  params: Record<string, string>;
  /** The client address, for rate limiting only. Never stored or logged. */
  ip: string;
  /** The raw body (already size-checked). */
  body: Buffer;
}

export type Handler = (request: Request) => Reply | Promise<Reply>;

interface Route {
  method: Method;
  template: string;
  segments: string[];
  handler: Handler;
  limit: number;
}

/** A router for one site's API, mounted under a prefix such as `/api/v1`. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, template: string, handler: Handler, limit: number): this {
    this.routes.push({ method, template, segments: template.split('/').filter(Boolean), handler, limit });
    return this;
  }

  /** Find the route for a path (segments already split from the raw path, not yet decoded). */
  match(method: string, raw: string[]): { route: Route; params: Record<string, string> } | 'method' | undefined {
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== raw.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < raw.length && ok; i++) {
        const seg = route.segments[i]!;
        let value: string;
        try {
          value = decodeURIComponent(raw[i]!);
        } catch {
          ok = false;
          break;
        }
        if (seg.startsWith('{')) params[seg.slice(1, -1)] = value;
        else ok = seg === value;
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method || (route.method === 'GET' && method === 'HEAD')) return { route, params };
    }
    return pathMatched ? 'method' : undefined;
  }
}

/** Read the body, refusing more than `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) {
      reject(new HttpError(413, 'too_large'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body. Like the earlier server: 415 without a JSON content type, 400 if malformed. */
export function jsonBody(request: Request): Record<string, unknown> {
  const type = String(request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json' && !/^application\/[\w.+-]+\+json$/.test(type)) throw new HttpError(415, 'expected_json');
  let value: unknown;
  try {
    value = JSON.parse(request.body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(422, 'invalid_body');
  return value as Record<string, unknown>;
}

/** A required string field of a JSON body; 422 if missing or not a string. */
export function str(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string') throw new HttpError(422, 'invalid_body');
  return value;
}

/** An optional string field; 422 if present with another type. */
export function optStr(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(422, 'invalid_body');
  return value;
}

export function errorReply(e: unknown): Reply {
  if (e instanceof HttpError) {
    return json({ error: e.code, ...e.extra }, e.status, e.retryAfter !== undefined ? { 'retry-after': String(e.retryAfter) } : {});
  }
  log.error({ error_class: e instanceof Error ? e.name : 'unknown' }, 'unexpected error');
  return json({ error: 'internal' }, 500);
}

export function send(res: ServerResponse, reply: Reply, head: boolean): void {
  const headers = { ...reply.headers };
  let body: Buffer | undefined;
  if (reply.body instanceof Uint8Array) body = Buffer.from(reply.body);
  else if (typeof reply.body === 'string') body = Buffer.from(reply.body);
  else if (reply.body !== undefined) {
    body = Buffer.from(JSON.stringify(reply.body));
    headers['content-type'] ??= 'application/json';
  }
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (body) res.setHeader('content-length', body.length);
  res.statusCode = reply.status;
  res.end(head ? undefined : body);
}

/** Dispatch a request to a router; answers 404 or 405 for unknown paths and methods. */
export async function dispatch(router: Router, req: IncomingMessage, raw: string[], ip: string): Promise<{ reply: Reply; route: string }> {
  const found = router.match(req.method ?? 'GET', raw);
  if (found === undefined) return { reply: json({ error: 'not_found' }, 404), route: 'not_found' };
  if (found === 'method') return { reply: json({ error: 'method_not_allowed' }, 405), route: 'method_not_allowed' };
  const { route, params } = found;
  try {
    const body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, route.limit);
    return { reply: await route.handler({ method: req.method ?? 'GET', headers: req.headers, params, ip, body }), route: route.template };
  } catch (e) {
    return { reply: errorReply(e), route: route.template };
  }
}

export function logRequest(method: string, route: string, status: number, start: number): void {
  log.info({ method, route, status, duration_ms: Math.round(performance.now() - start) }, 'request');
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serve the built web client. Unknown paths get `index.html`, so client-side routes work. Paths are
 * normalised and must stay inside `webDir`.
 */
export async function serveStatic(webDir: string, pathname: string, res: ServerResponse, head: boolean, headers: Record<string, string>): Promise<number> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  const root = normalize(webDir + sep);
  const candidates: string[] = [];
  const target = normalize(join(root, rel));
  if (target.startsWith(root) && !rel.includes('\0')) {
    candidates.push(rel.endsWith('/') ? join(target, 'index.html') : target);
    if (!rel.endsWith('/')) candidates.push(join(target, 'index.html'));
  }
  candidates.push(join(root, 'index.html'));
  for (const file of candidates) {
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) continue;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.setHeader('content-type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('content-length', info.size);
    res.setHeader('last-modified', info.mtime.toUTCString());
    res.statusCode = 200;
    if (head) res.end();
    else createReadStream(file).pipe(res);
    return 200;
  }
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.statusCode = 404;
  res.end();
  return 404;
}
