import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Base64 } from '@futuregrow/observability';
import { loadEnv } from '@futuregrow/runtime';
import { governance } from '@futuregrow/core';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { buildApp } from '../src/app.js';

let h: CoreHarness;
let app: FastifyInstance;
const ORIGIN = 'http://localhost:4321';

function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what an authenticator app computes. */
function totp(secretB32: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const off = mac[mac.length - 1]! & 0xf;
  const code = ((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

class Client {
  cookies = new Map<string, string>();
  constructor(private readonly app: FastifyInstance) {}
  private cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers: { origin: ORIGIN, ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
    const set = res.headers['set-cookie'];
    for (const c of Array.isArray(set) ? set : set ? [set] : []) {
      const [pair] = c.split(';');
      const [k, ...v] = pair!.split('=');
      if (k) this.cookies.set(k.trim(), v.join('='));
    }
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, headers: res.headers, body: res.body };
  }
}

async function signUp(email: string): Promise<Client> {
  const c = new Client(app);
  const r = await c.req('POST', '/api/auth/sign-up/email', { body: { email, password: 'correct-horse-battery-staple', name: email.split('@')[0] } });
  expect(r.status).toBe(200);
  return c;
}

let owner: Client;
let tenantId: string;

beforeAll(async () => {
  h = await createCoreHarness();
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: h.t.url,
    FG_ALLOW_SIGNUP: 'true',
    API_BASE_URL: 'http://localhost:8080',
    APP_ORIGINS: ORIGIN,
    SHOPIFY_WEBHOOK_SECRET: 'shpss_test_secret',
  } as NodeJS.ProcessEnv);
  ({ app } = await buildApp({ env, deps: h.deps }));
  await governance.seedModelRegistry(h.t.handle.db);
  owner = await signUp(`owner-${randomUUID().slice(0, 6)}@acme.test`);
  const org = await owner.req('POST', '/api/auth/organization/create', { body: { name: 'Acme Growth', slug: `acme-${randomUUID().slice(0, 6)}` } });
  expect(org.status).toBe(200);
  tenantId = org.json.id;
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('authentication and tenancy', () => {
  it('rejects unauthenticated /v1 calls and resolves the owner role', async () => {
    const anon = await new Client(app).req('GET', '/v1/me', { headers: { 'x-fg-tenant': tenantId } });
    expect(anon.status).toBe(401);
    const me = await owner.req('GET', '/v1/me', { headers: { 'x-fg-tenant': tenantId } });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ tenantId, roles: ['owner'], mfaVerified: false });
  });

  it('a user cannot act in an organization they do not belong to', async () => {
    const other = await signUp(`other-${randomUUID().slice(0, 6)}@evil.test`);
    const res = await other.req('GET', '/v1/governance/kill-switches', { headers: { 'x-fg-tenant': tenantId } });
    expect(res.status).toBe(403);
  });
});

describe('Idempotency-Key contract (D-010)', () => {
  it('requires the header, replays responses and rejects reuse with a different body', async () => {
    const body = { scope: 'agent', targetRef: null, reason: 'pause all agents for review' };
    const missing = await owner.req('POST', '/v1/governance/kill-switches', { body, headers: { 'x-fg-tenant': tenantId } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = `ks-${randomUUID()}`;
    const first = await owner.req('POST', '/v1/governance/kill-switches', { body, headers: { 'x-fg-tenant': tenantId, 'idempotency-key': key } });
    expect(first.status).toBe(201);
    const replay = await owner.req('POST', '/v1/governance/kill-switches', { body, headers: { 'x-fg-tenant': tenantId, 'idempotency-key': key } });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json.killSwitch.id).toBe(first.json.killSwitch.id);
    const list = await owner.req('GET', '/v1/governance/kill-switches', { headers: { 'x-fg-tenant': tenantId } });
    expect(list.json.filter((k: { id: string }) => k.id === first.json.killSwitch.id)).toHaveLength(1);

    const reused = await owner.req('POST', '/v1/governance/kill-switches', { body: { ...body, reason: 'different' }, headers: { 'x-fg-tenant': tenantId, 'idempotency-key': key } });
    expect(reused.status).toBe(422);
  });
});

describe('MFA-gated operations', () => {
  it('blocks policy changes until TOTP two-factor is enrolled', async () => {
    const policy = { configured: true, currency: 'USD', approvedJurisdictions: [], categories: {} };
    const before = await owner.req('PUT', '/v1/governance/policy', { body: policy, headers: { 'x-fg-tenant': tenantId, 'idempotency-key': `p-${randomUUID()}` } });
    expect(before.status).toBe(403);

    const enable = await owner.req('POST', '/api/auth/two-factor/enable', { body: { password: 'correct-horse-battery-staple' } });
    expect(enable.status).toBe(200);
    const secret = new URL(enable.json.totpURI).searchParams.get('secret')!;
    const verify = await owner.req('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(secret) } });
    expect(verify.status).toBe(200);

    const me = await owner.req('GET', '/v1/me', { headers: { 'x-fg-tenant': tenantId } });
    expect(me.json.mfaVerified).toBe(true);
    const after = await owner.req('PUT', '/v1/governance/policy', { body: policy, headers: { 'x-fg-tenant': tenantId, 'idempotency-key': `p-${randomUUID()}` } });
    expect(after.status).toBe(200);
    expect(after.json).toMatchObject({ configured: true, version: 2 });
  });
});

describe('platform surfaces', () => {
  it('serves OpenAPI 3.1 and health probes', async () => {
    const spec = await new Client(app).req('GET', '/v1/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.json.openapi).toBe('3.1.0');
    expect(Object.keys(spec.json.paths)).toEqual(expect.arrayContaining(['/v1/actions', '/v1/evidence', '/v1/governance/kill-switches']));
    expect((await new Client(app).req('GET', '/readyz')).status).toBe(200);
  });

  it('lists the 24 modules and the action allowlist', async () => {
    const m = await owner.req('GET', '/v1/modules', { headers: { 'x-fg-tenant': tenantId } });
    expect(m.json.modules).toHaveLength(24);
    const a = await owner.req('GET', '/v1/action-types', { headers: { 'x-fg-tenant': tenantId } });
    expect(a.json.actionTypes.some((t: { type: string }) => t.type === 'email.send')).toBe(true);
  });

  it('maps validation failures to 422 and never leaks internals', async () => {
    const r = await owner.req('POST', '/v1/actions', { body: { actionType: 'email.send' }, headers: { 'x-fg-tenant': tenantId, 'idempotency-key': `a-${randomUUID()}` } });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('webhooks', () => {
  it('verifies Shopify HMAC over the raw body, deduplicates and records bad signatures', async () => {
    const raw = JSON.stringify({ id: 1001, total_price: '25.00' });
    const sig = hmacSha256Base64('shpss_test_secret', raw);
    const send = (signature: string, id: string) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/shopify',
        headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': signature, 'x-shopify-topic': 'orders/create', 'x-shopify-shop-domain': 'demo.myshopify.com', 'x-shopify-webhook-id': id },
        payload: raw,
      });
    const id = randomUUID();
    const ok = await send(sig, id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ received: true, duplicate: false });
    expect((await send(sig, id)).json()).toEqual({ received: true, duplicate: true });
    const bad = await send(hmacSha256Base64('wrong', raw), randomUUID());
    expect(bad.statusCode).toBe(401);
    expect(h.jobs.take('process_webhook')).toHaveLength(1);
  });

  it('refuses deliveries for providers whose secret is not configured', async () => {
    const r = await app.inject({ method: 'POST', url: '/webhooks/meta', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(503);
  });
});
