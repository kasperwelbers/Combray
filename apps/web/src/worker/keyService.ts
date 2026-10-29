/**
 * Client for the server's store key service. The server holds each store's KEK and releases it
 * only for the store's password; the data and its DEK never leave this device.
 * See docs/security.md#store-keys.
 */
import type { ServerStore } from '@combray/store';

import type { CreateResult, UnlockResult } from './api';

const BASE = '/api/v1/stores';

/** Decode base64url without padding, as the server sends keys. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function post(path: string, body: unknown): Promise<Response | undefined> {
  try {
    return await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    return undefined;
  }
}

function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export async function createServerStore(
  password: string,
): Promise<{ ok: true; store: ServerStore } | { ok: false; result: Exclude<CreateResult, { status: 'ok' }> }> {
  const response = await post('', { password });
  if (!response) return { ok: false, result: { status: 'unreachable' } };
  if (response.status === 201) {
    const body = (await response.json()) as { store_id: string; kek: string; delete_token: string };
    return {
      ok: true,
      store: { storeId: body.store_id, kek: fromBase64Url(body.kek), deleteToken: body.delete_token },
    };
  }
  if (response.status === 400) return { ok: false, result: { status: 'invalid-password' } };
  if (response.status === 429) return { ok: false, result: { status: 'too-many-attempts', retryAfter: retryAfter(response) ?? 60 } };
  return { ok: false, result: { status: 'unreachable' } };
}

export async function fetchKek(
  storeId: string,
  password: string,
): Promise<{ ok: true; kek: Uint8Array<ArrayBuffer> } | { ok: false; result: Exclude<UnlockResult, { status: 'ok' }> }> {
  const response = await post(`/${encodeURIComponent(storeId)}/unlock`, { password });
  if (!response) return { ok: false, result: { status: 'unreachable' } };
  switch (response.status) {
    case 200: {
      const body = (await response.json()) as { kek: string };
      return { ok: true, kek: fromBase64Url(body.kek) };
    }
    case 400:
    case 401: {
      const wait = retryAfter(response);
      return { ok: false, result: wait ? { status: 'wrong-password', retryAfter: wait } : { status: 'wrong-password' } };
    }
    case 404:
      return { ok: false, result: { status: 'store-gone' } };
    case 429:
      return { ok: false, result: { status: 'too-many-attempts', retryAfter: retryAfter(response) ?? 60 } };
    default:
      return { ok: false, result: { status: 'unreachable' } };
  }
}

/** Ask the server to forget the store's KEK (crypto-shredding). Best effort. */
export async function deleteServerStore(storeId: string, deleteToken: string): Promise<boolean> {
  const response = await post(`/${encodeURIComponent(storeId)}/delete`, { delete_token: deleteToken });
  return response?.status === 204 || response?.status === 404;
}
