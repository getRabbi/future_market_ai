/**
 * Thin client for the FUTUREGROW API. Every /v1 mutation carries a fresh Idempotency-Key
 * (D-010); the selected organization travels in `x-fg-tenant`. Cookies are first-party
 * (same-site API domain or the Pages Functions proxy, D-013), so `credentials: 'include'`.
 */
export const API_BASE = (import.meta.env.PUBLIC_API_BASE ?? '').replace(/\/$/, '');

const TENANT_KEY = 'fg.tenant';

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
  return data as T;
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
