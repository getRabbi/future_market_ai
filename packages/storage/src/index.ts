import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '@futuregrow/observability';
import { AwsClient } from 'aws4fetch';

export interface PutResult {
  key: string;
  sha256: string;
  bytes: number;
}

export interface ObjectStore {
  readonly kind: 'r2' | 'filesystem';
  put(key: string, body: Uint8Array | string, contentType: string): Promise<PutResult>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Time-limited URL for direct upload/download. Filesystem backend returns null. */
  presign(key: string, method: 'GET' | 'PUT', expiresSeconds: number, contentType?: string): Promise<string | null>;
}

const KEY_RE = /^[A-Za-z0-9!_.*'()/-]{1,900}$/;

export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.startsWith('/')) throw new Error(`unsafe object key: ${key}`);
}

/** Tenant-prefixed key, so objects of different tenants can never collide or be guessed. */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  const key = ['t', tenantId, ...parts].join('/');
  assertSafeKey(key);
  return key;
}

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

export class FilesystemStore implements ObjectStore {
  readonly kind = 'filesystem' as const;
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root))) throw new Error('path escapes storage root');
    return p;
  }

  async put(key: string, body: Uint8Array | string): Promise<PutResult> {
    const bytes = toBytes(body);
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, bytes);
    return { key, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.resolve(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async presign(): Promise<string | null> {
    return null;
  }
}

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Override for tests or S3-compatible endpoints. */
  endpoint?: string;
}

/** Cloudflare R2 through its S3-compatible API, signed with SigV4 (region `auto`). */
export class R2Store implements ObjectStore {
  readonly kind = 'r2' as const;
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(private readonly cfg: R2Config) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    const endpoint = cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`;
    this.base = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(cfg.bucket)}`;
  }

  private url(key: string): string {
    assertSafeKey(key);
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<PutResult> {
    const bytes = toBytes(body);
    const sha256 = sha256Hex(bytes);
    const res = await this.client.fetch(this.url(key), {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers: { 'content-type': contentType, 'x-amz-meta-sha256': sha256 },
    });
    if (!res.ok) throw new Error(`R2 put failed: ${res.status} ${await res.text()}`);
    return { key, sha256, bytes: bytes.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.client.fetch(this.url(key), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 get failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: ${res.status}`);
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.client.fetch(this.url(key), { method: 'HEAD' });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`R2 head failed: ${res.status}`);
    return true;
  }

  async presign(key: string, method: 'GET' | 'PUT', expiresSeconds: number, contentType?: string): Promise<string> {
    const u = new URL(this.url(key));
    u.searchParams.set('X-Amz-Expires', String(Math.min(Math.max(expiresSeconds, 60), 3600)));
    const signed = await this.client.sign(new Request(u, { method, headers: contentType ? { 'content-type': contentType } : {} }), {
      aws: { signQuery: true },
    });
    return signed.url;
  }
}

export interface StorageEnv {
  NODE_ENV?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  FG_LOCAL_STORAGE_DIR?: string;
}

/** D-022: production refuses the filesystem backend. */
export function createObjectStore(env: StorageEnv): ObjectStore {
  if (env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    return new R2Store({
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      ...(env.R2_ENDPOINT ? { endpoint: env.R2_ENDPOINT } : {}),
    });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('R2 credentials are required in production (filesystem storage is development-only, D-022)');
  }
  return new FilesystemStore(env.FG_LOCAL_STORAGE_DIR ?? path.resolve('.data', 'objects'));
}
