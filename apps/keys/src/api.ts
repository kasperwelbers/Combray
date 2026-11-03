/** The server's researcher API, as the key page uses it. Same origin, cookies only. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(describe(status, code));
    this.name = 'ApiError';
  }
}

function describe(status: number, code: string): string {
  switch (code) {
    case 'invalid_link':
      return 'This sign-in link has been used or has expired. Ask for a new one.';
    case 'too_many_attempts':
      return 'Too many attempts. Please wait a while and try again.';
    case 'wrong_recovery_code':
      return 'That recovery code does not match your account.';
    case 'passkey_rejected':
      return 'The server did not accept this passkey.';
    case 'not_signed_in':
      return 'Your session has ended. Please sign in again.';
    case 'mail_disabled':
      return 'This server cannot send email yet. Ask the server operator to set it up.';
    case 'conflict':
      return 'This was already done, or conflicts with what is there.';
    default:
      return `The server answered ${status} (${code}).`;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, error.error ?? 'unknown');
  }
  if (response.status === 204 || response.status === 201 || response.status === 202) return undefined as T;
  const type = response.headers.get('content-type') ?? '';
  return (type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer())) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
  bytes: (path: string) => request<Uint8Array<ArrayBuffer>>('GET', path),
};

export interface Site {
  researchers: boolean;
  public_url: string;
  keys_url: string;
}

export interface Passkey {
  id: string;
  name: string;
  created: number;
  last_used: number | null;
  unlocks_key: boolean;
}

export interface Me {
  id: string;
  email: string;
  signed_in: boolean;
  public_key: string | null;
  passkeys: Passkey[];
}

export interface ProjectSummary {
  id: string;
  name: unknown;
  has_access: boolean;
  fingerprint: string | null;
}

export interface Member {
  researcher_id: string;
  email: string;
  public_key: string | null;
  has_access: boolean;
  added: number;
}

export interface SealedJson {
  enc: string;
  ciphertext: string;
}

export interface Project {
  id: string;
  name: unknown;
  key: { public_key: string; fingerprint: string; created: number } | null;
  has_access: boolean;
  sealed_key: SealedJson | null;
  members: Member[];
}

export interface DonationList {
  donations: { id: string; day: string; bytes: number }[];
  withdrawn: { id: string; day: string }[];
}

export interface SealedDonationKey extends SealedJson {
  id: string;
  key: string;
}

/** Project names are plain strings or `{ en, nl }`; researchers read English. */
export function projectName(name: unknown, fallback: string): string {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') {
    const n = name as Record<string, unknown>;
    const first = n.en ?? Object.values(n)[0];
    if (typeof first === 'string') return first;
  }
  return fallback;
}
