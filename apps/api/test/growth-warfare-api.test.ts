import { createHmac, randomUUID } from 'node:crypto';
import { governance } from '@futuregrow/core';
import { loadEnv } from '@futuregrow/runtime';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

function totp(secretB32: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const off = mac[mac.length - 1]! & 0xf;
  return ((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

class Client {
  cookies = new Map<string, string>();
  constructor(private readonly app: FastifyInstance) {}
  async req(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers: { origin: ORIGIN, ...(this.cookies.size ? { cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
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
    return { status: res.statusCode, json };
  }
}

let owner: Client;
let tenantId: string;
const t = (extra: Record<string, string> = {}) => ({ 'x-fg-tenant': tenantId, ...extra });
const key = () => ({ 'idempotency-key': `gw-${randomUUID()}` });

beforeAll(async () => {
  h = await createCoreHarness();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url, FG_ALLOW_SIGNUP: 'true', API_BASE_URL: 'http://localhost:8080', APP_ORIGINS: ORIGIN } as NodeJS.ProcessEnv);
  ({ app } = await buildApp({ env, deps: h.deps }));
  await governance.seedModelRegistry(h.t.handle.db);
  owner = new Client(app);
  expect((await owner.req('POST', '/api/auth/sign-up/email', { body: { email: `gw-owner-${randomUUID().slice(0, 6)}@acme.test`, password: 'correct-horse-battery-staple', name: 'owner' } })).status).toBe(200);
  const org = await owner.req('POST', '/api/auth/organization/create', { body: { name: 'Growth Org', slug: `gw-${randomUUID().slice(0, 6)}` } });
  tenantId = org.json.id;
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('Growth Warfare API (D-054)', () => {
  it('requires a session and returns production-safe defaults', async () => {
    expect((await new Client(app).req('GET', '/v1/growth-warfare/settings', { headers: t() })).status).toBe(401);
    const s = await owner.req('GET', '/v1/growth-warfare/settings', { headers: t() });
    expect(s.status).toBe(200);
    expect(s.json.features).toEqual({ F1: false, F2: false, F3: false, F4: false, F5: false, F6: false });
    expect(s.json.controls).toMatchObject({ externalOperations: false, paidOperations: false, approvalPreference: 'always_human' });
    const room = await owner.req('GET', '/v1/growth-warfare/overview', { headers: t() });
    expect(room.status).toBe(200);
    expect(room.json.readiness).toMatchObject({ aiVisibilityProvider: 'manual_import_only', externalOperations: false });
  });

  it('keeps OFF features off server-side and blocks widening without two-factor', async () => {
    const scan = await owner.req('POST', '/v1/growth-warfare/scan', { body: {}, headers: t(key()) });
    expect(scan.status).toBe(409);
    expect(scan.json.error.code).toBe('FEATURE_OFF');
    const noKey = await owner.req('PUT', '/v1/growth-warfare/settings', { body: { expectedVersion: 1, features: { F1: true } }, headers: t() });
    expect(noKey.status).toBe(400);
    const noMfa = await owner.req('PUT', '/v1/growth-warfare/settings', { body: { expectedVersion: 1, features: { F1: true } }, headers: t(key()) });
    expect(noMfa.status).toBe(403);

    const enable = await owner.req('POST', '/api/auth/two-factor/enable', { body: { password: 'correct-horse-battery-staple' } });
    const secret = new URL(enable.json.totpURI).searchParams.get('secret')!;
    expect((await owner.req('POST', '/api/auth/two-factor/verify-totp', { body: { code: totp(secret) } })).status).toBe(200);
    const ok = await owner.req('PUT', '/v1/growth-warfare/settings', { body: { expectedVersion: 1, features: { F1: true } }, headers: t(key()) });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ version: 2, features: { F1: true, F2: false } });
    const stale = await owner.req('PUT', '/v1/growth-warfare/settings', { body: { expectedVersion: 1, features: { F2: true } }, headers: t(key()) });
    expect(stale.status).toBe(409);
    const scanned = await owner.req('POST', '/v1/growth-warfare/scan', { body: {}, headers: t(key()) });
    expect(scanned.status).toBe(200);
  });

  it('stops everything with an emergency stop and refuses new work until released', async () => {
    const stop = await owner.req('POST', '/v1/growth-warfare/emergency-stop', { body: { reason: 'drill' }, headers: t(key()) });
    expect(stop.status).toBe(200);
    const blocked = await owner.req('POST', '/v1/growth-warfare/scan', { body: {}, headers: t(key()) });
    expect(blocked.json.error.code).toBe('EMERGENCY_STOP');
    const rel = await owner.req('POST', '/v1/growth-warfare/emergency-stop/release', { body: { expectedVersion: stop.json.settings.version }, headers: t(key()) });
    expect(rel.status).toBe(200);
    expect(rel.json.emergencyStop).toBe(false);
  });

  it('serves the public tool runtime without a session and without leaking unpublished tools', async () => {
    const anon = new Client(app);
    expect((await anon.req('GET', '/v1/public/tools/aaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    expect((await anon.req('POST', '/v1/public/tools/aaaaaaaaaaaaaaaaaaaa/evaluate', { body: { anonymousId: 'visitor-0001', inputs: {} } })).status).toBe(404);
    expect((await anon.req('GET', '/v1/public/tools/not-valid!')).status).toBe(422);
  });

  it('documents every route in OpenAPI and keeps tenants apart', async () => {
    const spec = await new Client(app).req('GET', '/v1/openapi.json');
    expect(Object.keys(spec.json.paths)).toEqual(
      expect.arrayContaining(['/v1/growth-warfare/overview', '/v1/growth-warfare/settings', '/v1/growth-warfare/opportunities', '/v1/growth-warfare/campaigns/{id}/approve', '/v1/growth-warfare/tasks/{id}/submit', '/v1/growth-warfare/experiments', '/v1/public/tools/{publicId}']),
    );
    const stranger = new Client(app);
    await stranger.req('POST', '/api/auth/sign-up/email', { body: { email: `gw-x-${randomUUID().slice(0, 6)}@evil.test`, password: 'correct-horse-battery-staple', name: 'x' } });
    expect((await stranger.req('GET', '/v1/growth-warfare/overview', { headers: t() })).status).toBe(403);
  });
});
