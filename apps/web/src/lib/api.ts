/**
 * Thin client for the FUTUREGROW API. Every /v1 mutation carries a fresh Idempotency-Key
 * (D-010); the selected organization travels in `x-fg-tenant`. Cookies are first-party
 * (same-site API domain or the Pages Functions proxy, D-013), so `credentials: 'include'`.
 */
export const API_BASE = (import.meta.env.PUBLIC_API_BASE ?? '').replace(/\/$/, '');

const TENANT_KEY = 'fg.tenant';

/** Fired on window after any successful change, so progress views can re-check. */
export const CHANGED_EVENT = 'fg:changed';

export function notifyChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function getTenant(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

export function setTenant(id: string | null): void {
  try {
    if (id) localStorage.setItem(TENANT_KEY, id);
    else localStorage.removeItem(TENANT_KEY);
  } catch {
    /* storage unavailable: tenant falls back to the session's active organization */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const tenant = getTenant();
  if (tenant) headers['x-fg-tenant'] = tenant;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && path.startsWith('/v1/')) headers['idempotency-key'] = opts.idempotencyKey ?? newIdempotencyKey();
  const res = await fetch(`${API_BASE}${path}`, { method, headers, credentials: 'include', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const e = (data ?? {}) as { error?: { code?: string; message?: string; details?: unknown }; message?: string; code?: string };
    const message = e.error?.message ?? e.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, e.error?.code ?? e.code ?? null, e.error?.details ?? null);
  }
  if (method !== 'GET') notifyChanged();
  return data as T;
}

/**
 * Downloads a file the API produces (e.g. a CSV export) with the same session and organization
 * header, then hands it to the browser as a file. Nothing is opened in a new window.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<{ filename: string; bytes: number }> {
  const headers: Record<string, string> = { accept: 'text/csv, application/octet-stream' };
  const tenant = getTenant();
  if (tenant) headers['x-fg-tenant'] = tenant;
  const res = await fetch(`${API_BASE}${path}`, { method: 'GET', headers, credentials: 'include' });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(data?.error?.message ?? `${res.status} ${res.statusText}`, res.status, data?.error?.code ?? null, data?.error?.details ?? null);
  }
  const blob = await res.blob();
  const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { filename, bytes: blob.size };
}

/** Upload raw bytes (M14 assets): metadata travels URI-encoded in a header. */
export async function uploadBinary<T = unknown>(path: string, file: File, meta: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': file.type || 'application/octet-stream',
    'x-fg-asset-meta': encodeURIComponent(JSON.stringify(meta)),
    'idempotency-key': newIdempotencyKey(),
  };
  const tenant = getTenant();
  if (tenant) headers['x-fg-tenant'] = tenant;
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, credentials: 'include', body: file });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { error?: { message?: string } } | null)?.error?.message ?? `${res.status}`, res.status, null, data);
  notifyChanged();
  return data as T;
}

export interface Me {
  userId: string;
  email?: string | null;
  tenantId: string;
  roles: string[];
  mfaVerified: boolean;
  passwordChangedAt?: string | null;
  memberships: { organizationId: string; role: string; name: string; slug: string }[];
}
