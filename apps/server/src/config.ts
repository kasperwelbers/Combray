/** Server settings, all from environment variables (docs/deployment.md lists them). */
import { join } from 'node:path';

import { log } from './log.ts';

export const VERSION = '0.1.0';

export interface ResearchConfig {
  /** The main site, e.g. `https://combray.uni.nl` (`COMBRAY_PUBLIC_URL`). */
  publicUrl: URL;
  /** The key page, e.g. `https://keys.combray.uni.nl` (`COMBRAY_KEYS_URL`). Passkeys are bound to its host. */
  keysUrl: URL;
  /** The built key page (`apps/keys/dist/index.html`). */
  keysPage: string;
  /** Sealed donation keys: a database of its own, with short backup retention (ADR 0006). */
  donationKeysDb: string;
  mail: MailConfig;
  maxDonationBytes: number;
  /** How long backups of the donation key database are kept; withdrawals are complete after it. */
  keyBackupRetentionDays: number;
  /** Studio sessions: ended after this long without activity, and at most this long in all. */
  studioIdleSecs: number;
  studioMaxSecs: number;
}

export type MailConfig =
  | { kind: 'smtp'; url: string; from: string }
  | { kind: 'outbox'; dir: string }
  | { kind: 'disabled' };

export interface Argon2Cost {
  mKib: number;
  t: number;
  p: number;
}

export interface Config {
  bind: { host: string; port: number };
  webDir: string;
  dataDir: string;
  /** The main database: store keys, researchers, sessions, projects, the donation index. */
  dbPath: string;
  /** 32 random bytes from which every store's KEK is derived. Kept outside the data directory. */
  storeMasterKeyFile: string;
  /** Header with the client IP behind a reverse proxy (its last entry is used). */
  clientIpHeader?: string;
  argon2: Argon2Cost;
  research?: ResearchConfig;
}

/** The OWASP recommendation for Argon2id: 19 MiB, 2 passes, 1 lane. */
export const DEFAULT_ARGON2: Argon2Cost = { mKib: 19 * 1024, t: 2, p: 1 };

function envUrl(name: string): URL | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return url;
  } catch {
    // Reported below.
  }
  log.error({ variable: name }, 'not a valid http(s) URL');
  return undefined;
}

/** Empty counts as unset, so docker compose can pass `${COMBRAY_SMTP_URL:-}`. */
const setting = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
};

function mailFromEnv(): MailConfig {
  const url = setting('COMBRAY_SMTP_URL');
  const from = setting('COMBRAY_MAIL_FROM');
  const outbox = setting('COMBRAY_MAIL_OUTBOX');
  if (url && from) return { kind: 'smtp', url, from };
  if (outbox) return { kind: 'outbox', dir: outbox };
  return { kind: 'disabled' };
}

const int = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function configFromEnv(): Config {
  const env = process.env;
  const dataDir = env.COMBRAY_DATA_DIR ?? 'combray-data';
  const [host, port] = (env.COMBRAY_BIND ?? '127.0.0.1:8080').split(/:(?=\d+$)/);
  const publicUrl = envUrl('COMBRAY_PUBLIC_URL');
  const keysUrl = envUrl('COMBRAY_KEYS_URL');
  const research: ResearchConfig | undefined =
    publicUrl && keysUrl
      ? {
          publicUrl,
          keysUrl,
          keysPage: env.COMBRAY_KEYS_PAGE ?? 'apps/keys/dist/index.html',
          donationKeysDb: env.COMBRAY_DONATION_KEYS_DB ?? join(dataDir, 'donation-keys.sqlite'),
          mail: mailFromEnv(),
          maxDonationBytes: int('COMBRAY_MAX_DONATION_MB', 64) * 1024 * 1024,
          keyBackupRetentionDays: int('COMBRAY_KEY_BACKUP_RETENTION_DAYS', 30),
          studioIdleSecs: int('COMBRAY_STUDIO_IDLE_SECS', 3600) || 3600,
          studioMaxSecs: int('COMBRAY_STUDIO_MAX_SECS', 12 * 3600) || 12 * 3600,
        }
      : undefined;
  return {
    bind: { host: (host ?? '127.0.0.1').replace(/^\[|\]$/g, ''), port: Number(port ?? 8080) },
    webDir: env.COMBRAY_WEB_DIR ?? 'apps/web/dist',
    dataDir,
    dbPath: env.COMBRAY_DB ?? join(dataDir, 'combray.sqlite'),
    storeMasterKeyFile: env.COMBRAY_STORE_MASTER_KEY_FILE ?? 'combray-store-master.key',
    clientIpHeader: env.COMBRAY_CLIENT_IP_HEADER?.toLowerCase() || undefined,
    argon2: DEFAULT_ARGON2,
    research,
  };
}

/** `Origin` serialisation of a URL: scheme, host and port. */
export const originOf = (url: URL): string => url.origin;

/** The `Host` header value a site is reached at. */
export const hostOf = (url: URL): string => url.host.toLowerCase();

/** A site's address without a trailing slash, for links. */
export const base = (url: URL): string => url.href.replace(/\/+$/, '');
