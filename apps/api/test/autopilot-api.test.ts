import { randomUUID } from 'node:crypto';
import { loadEnv } from '@futuregrow/runtime';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { buildApp } from '../src/app.js';

let h: CoreHarness;
let app: FastifyInstance;
const ORIGIN = 'http://localhost:4321';

class Client {
  cookies = new Map<string, string>();
  tenant: string | null = null;
  async req(method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (this.cookies.size) headers.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.tenant) headers['x-fg-tenant'] = this.tenant;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && url.startsWith('/v1/')) headers['idempotency-key'] = randomUUID();
    const res = await app.inject({ method: method as 'GET', url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const set = res.headers['set-cookie'];
    for (const c of Array.isArray(set) ? set : set ? [set] : []) {
      const [pair] = c.split(';');
      const [k, ...v] = pair!.split('=');
      if (k) this.cookies.set(k.trim(), v.join('='));
    }
    let json: unknown = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json: json as Record<string, never> & Record<string, unknown> };
  }
}

async function owner(): Promise<Client> {
  const c = new Client();
  const email = `o-${randomUUID().slice(0, 6)}@acme.test`;
  expect((await c.req('POST', '/api/auth/sign-up/email', { email, password: 'correct-horse-battery-staple', name: 'o' })).status).toBe(200);
  const org = await c.req('POST', '/api/auth/organization/create', { name: 'Acme', slug: `acme-${randomUUID().slice(0, 6)}` });
  expect(org.status).toBe(200);
  c.tenant = String(org.json.id);
  return c;
}

let a: Client;
let b: Client;

beforeAll(async () => {
  h = await createCoreHarness();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url, FG_ALLOW_SIGNUP: 'true', API_BASE_URL: 'http://localhost:8080', APP_ORIGINS: ORIGIN } as NodeJS.ProcessEnv);
  ({ app } = await buildApp({ env, deps: h.deps }));
  a = await owner();
  b = await owner();
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('Autopilot API', () => {
  it('is off per organization until an owner turns it on (controlled rollout)', async () => {
    expect((await a.req('GET', '/v1/autopilot/status')).json).toMatchObject({ available: true, enabled: false, stopped: null });
    expect((await a.req('PUT', '/v1/autopilot/settings', { enabled: true })).status).toBe(200);
    expect((await a.req('GET', '/v1/autopilot/status')).json).toMatchObject({ enabled: true });
    expect((await b.req('GET', '/v1/autopilot/status')).json).toMatchObject({ enabled: false });
  });

  it('turns the owner sentence into a conservative, editable plan and starts the goal', async () => {
    const r = await a.req('POST', '/v1/autopilot/interpret', { text: "Grow my app's organic downloads over the next 30 days with a $0 advertising budget." });
    expect(r.status).toBe(200);
    const d = r.json.draft as unknown as { kpi: { metricKey: string }; adBudget: { amountMicros: number }; channels: string[]; targetDate: string };
    expect(d.kpi.metricKey).toBe('app.downloads.first_time');
    expect(d.adBudget.amountMicros).toBe(0);
    expect(d.channels).not.toContain('paid_ads');
    expect(Math.round((Date.parse(d.targetDate) - h.clock.now().getTime()) / 86_400_000)).toBe(30);
    expect(r.json.understood).toEqual(expect.arrayContaining([expect.stringMatching(/\$0/)]));

    const created = await a.req('POST', '/v1/autopilot/goals', r.json.draft);
    expect(created.status).toBe(201);
    const id = String(created.json.id);
    expect(created.json).toMatchObject({ status: 'active', adBudgetMicros: 0 });
    const list = await a.req('GET', '/v1/autopilot/goals');
    expect((list.json as unknown as { id: string }[]).map((g) => g.id)).toEqual([id]);
    const detail = await a.req('GET', `/v1/autopilot/goals/${id}`);
    expect(detail.json).toMatchObject({ goal: { id }, cycles: [], actions: [] });

    expect((await a.req('POST', `/v1/autopilot/goals/${id}/pause`)).json).toMatchObject({ status: 'paused' });
    expect((await a.req('POST', `/v1/autopilot/goals/${id}/run_now`)).status).toBe(409);
    expect((await a.req('POST', `/v1/autopilot/goals/${id}/resume`)).json).toMatchObject({ status: 'active' });
    expect((await a.req('POST', `/v1/autopilot/goals/${id}/run_now`)).status).toBe(200);
    // Run now / resume queue an advance job right away (the worker picks it up).
    expect(h.jobs.take('autopilot_advance').map((j) => j.payload.goalId)).toContain(id);

    // Another organization can neither see nor control it.
    expect((await b.req('GET', `/v1/autopilot/goals/${id}`)).status).toBe(404);
    expect((await b.req('POST', `/v1/autopilot/goals/${id}/pause`)).status).toBe(404);
    expect((await b.req('GET', '/v1/autopilot/goals')).json).toEqual([]);
    const foreign = new Client();
    foreign.cookies = b.cookies;
    foreign.tenant = a.tenant;
    expect((await foreign.req('GET', '/v1/autopilot/goals')).status).toBe(403);
  });

  it('refuses paid ads on a $0 budget and serves readiness, activity and the inbox', async () => {
    const bad = await a.req('POST', '/v1/autopilot/goals', { title: 'Ads', statement: 'Buy ads', kpi: { metricKey: 'kpi.signups', label: 'Sign-ups' }, market: 'US', targetDate: new Date(h.clock.now().getTime() + 10 * 86_400_000).toISOString(), channels: ['paid_ads'] });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.json)).toMatch(/budget above zero/);
    const ready = await a.req('GET', '/v1/autopilot/readiness');
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({ policyConfigured: false, evidence: 0, approvedClaims: 0, mfaVerified: false });
    expect((await a.req('GET', '/v1/autopilot/activity')).status).toBe(200);
    expect((await a.req('GET', '/v1/autopilot/inbox')).json).toMatchObject({ approvals: [], decisions: [], drafts: [], otherApprovals: 0 });
  });
});
