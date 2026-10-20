import { setTimeout as sleep } from 'node:timers/promises';
import { sha256Hex } from '@futuregrow/observability';

/**
 * Where a failure happened relative to the provider receiving the request. This decides whether a
 * write may be retried (`before_send`, or a rejection with no side effect) or is *ambiguous*
 * (the provider may have applied it) and must be verified/escalated rather than blindly retried.
 */
export type FailurePhase = 'before_send' | 'rejected' | 'ambiguous';

export class ProviderHttpError extends Error {
  readonly status: number | null;
  readonly phase: FailurePhase;
  readonly body: unknown;
  readonly retryAfterMs: number | null;
  readonly providerRequestId: string | null;

  constructor(message: string, opts: { status: number | null; phase: FailurePhase; body?: unknown; retryAfterMs?: number | null; providerRequestId?: string | null }) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = opts.status;
    this.phase = opts.phase;
    this.body = opts.body;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.providerRequestId = opts.providerRequestId ?? null;
  }

  get isRateLimited() {
    return this.status === 429;
  }
  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: Uint8Array | string;
  /** Reads may be retried on 5xx/timeouts; writes only when the provider guarantees idempotency. */
  idempotent?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Return the body as bytes (`bytes`) instead of decoding text/JSON. */
  binary?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  rawText: string;
  bytes: Uint8Array;
  sha256: string;
  requestId: string | null;
}

export interface HttpClientOptions {
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  baseBackoffMs?: number;
  userAgent?: string;
  requestIdHeaders?: string[];
}

const DEFAULT_REQUEST_ID_HEADERS = ['x-request-id', 'x-fb-trace-id', 'request-id', 'x-goog-request-id', 'x-tt-logid', 'x-shopify-request-id'];

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.min(s * 1000, 300_000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, Math.min(d - Date.now(), 300_000)) : null;
}

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly userAgent: string;
  private readonly requestIdHeaders: string[];

  constructor(opts: HttpClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 250;
    this.userAgent = opts.userAgent ?? 'FUTUREGROW/0.1 (+https://futuregrow.invalid/bot)';
    this.requestIdHeaders = opts.requestIdHeaders ?? DEFAULT_REQUEST_ID_HEADERS;
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.once<T>(req);
      } catch (err) {
        if (!(err instanceof ProviderHttpError)) throw err;
        const retryable = err.phase === 'before_send' || err.isRateLimited || (req.idempotent === true && err.phase === 'ambiguous');
        if (!retryable || attempt >= this.maxRetries) throw err;
        const backoff = err.retryAfterMs ?? this.baseBackoffMs * 2 ** attempt + Math.floor(Math.random() * this.baseBackoffMs);
        await sleep(backoff);
        attempt += 1;
      }
    }
  }

  private async once<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { 'user-agent': this.userAgent, accept: 'application/json', ...(req.headers ?? {}) };
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    } else if (req.body !== undefined) {
      body = req.body as BodyInit;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(req.url, { method: req.method, headers, body, signal: controller.signal, redirect: 'manual' });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const causeObj = (err as { cause?: { code?: string; message?: string; errors?: { code?: string }[] } }).cause;
      const codes = [causeObj?.code, ...(causeObj?.errors ?? []).map((e) => e.code)].filter(Boolean) as string[];
      const cause = codes[0] ?? '';
      // Connection never established (or refused by fetch itself) => provider never saw the request.
      const neverSent = codes.some((c) => ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(c)) || causeObj?.message === 'bad port';
      throw new ProviderHttpError(`network error: ${msg}${cause ? ` (${cause})` : ''}`, {
        status: null,
        phase: neverSent ? 'before_send' : 'ambiguous',
      });
    }

    let raw: Buffer;
    try {
      raw = await readLimited(res, req.maxResponseBytes ?? 5 * 1024 * 1024);
    } finally {
      clearTimeout(timer);
    }
    const rawText = req.binary && res.status < 400 ? '' : raw.toString('utf8');
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const requestId = this.requestIdHeaders.map((h) => res.headers.get(h)).find((v) => v) ?? null;
    let data: unknown = req.binary && res.status < 400 ? null : rawText;
    if (!req.binary && rawText && (res.headers.get('content-type') ?? '').includes('json')) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = rawText;
      }
    }
    if (res.status >= 400) {
      const phase: FailurePhase = res.status >= 500 || res.status === 408 ? 'ambiguous' : 'rejected';
      throw new ProviderHttpError(`provider responded ${res.status}`, {
        status: res.status,
        phase,
        body: data,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        providerRequestId: requestId,
      });
    }
    return { status: res.status, headers: resHeaders, data: data as T, rawText, bytes: new Uint8Array(raw), sha256: sha256Hex(raw), requestId };
  }
}

async function readLimited(res: Response, limit: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ProviderHttpError(`response exceeded ${limit} bytes`, { status: res.status, phase: res.status < 400 ? 'ambiguous' : 'rejected' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Wrap reads/validation that happen before the mutating request. Any failure here means the
 * write was never sent, so it is re-classified as `before_send` (safe, nothing applied).
 */
export async function preWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      if (err.phase === 'rejected' && err.status === null) throw err; // explicit precondition failure
      throw new ProviderHttpError(`pre-write step failed: ${err.message}`, {
        status: err.status,
        phase: 'before_send',
        body: err.body,
        retryAfterMs: err.retryAfterMs,
        providerRequestId: err.providerRequestId,
      });
    }
    throw new ProviderHttpError(`pre-write step failed: ${err instanceof Error ? err.message : String(err)}`, { status: null, phase: 'before_send' });
  }
}
