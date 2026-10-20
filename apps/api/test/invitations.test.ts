import { randomUUID } from 'node:crypto';
import { loadEnv } from '@futuregrow/runtime';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { buildApp } from '../src/app.js';

const ORIGIN = 'http://localhost:4321';
const PASSWORD = 'correct-horse-battery-staple';

class Client {
  cookies = new Map<string, string>();
  constructor(private readonly app: FastifyInstance) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers: { origin: ORIGIN, ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
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

let h: CoreHarness;
let open: FastifyInstance;
let closed: FastifyInstance;

const env = (allowSignup: boolean) => loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url, FG_ALLOW_SIGNUP: String(allowSignup), API_BASE_URL: 'http://localhost:8080', APP_ORIGINS: ORIGIN } as NodeJS.ProcessEnv);

beforeAll(async () => {
  h = await createCoreHarness();
  ({ app: open } = await buildApp({ env: env(true), deps: h.deps }));
  ({ app: closed } = await buildApp({ env: env(false), deps: h.deps }));
});

afterAll(async () => {
  await open?.close();
  await closed?.close();
  await h?.close();
});

describe('invite-only onboarding', () => {
  it('only invited addresses can create accounts, and they join with the invited role', async () => {
    const ownerEmail = `owner-${randomUUID().slice(0, 6)}@acme.test`;
    const owner = new Client(open);
    expect((await owner.req('POST', '/api/auth/sign-up/email', { email: ownerEmail, password: PASSWORD, name: 'Owner' })).status).toBe(200);
    const org = await owner.req('POST', '/api/auth/organization/create', { name: 'Acme', slug: `acme-${randomUUID().slice(0, 6)}` });
    expect(org.status).toBe(200);

    // Sign-up closed: an uninvited address is refused.
    const stranger = new Client(closed);
    const refused = await stranger.req('POST', '/api/auth/sign-up/email', { email: `stranger-${randomUUID().slice(0, 6)}@evil.test`, password: PASSWORD, name: 'Stranger' });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.json)).toMatch(/invitation/i);

    // The owner (on the closed app) invites an approver.
    const ownerClosed = new Client(closed);
    expect((await ownerClosed.req('POST', '/api/auth/sign-in/email', { email: ownerEmail, password: PASSWORD })).status).toBe(200);
    const inviteeEmail = `Approver-${randomUUID().slice(0, 6)}@acme.test`;
    const inv = await ownerClosed.req('POST', '/api/auth/organization/invite-member', { email: inviteeEmail, role: 'approver', organizationId: org.json.id });
    expect(inv.status).toBe(200);
    const invitationId = inv.json.id as string;

    // The invitee can now sign up (address matched case-insensitively) and accept.
    const invitee = new Client(closed);
    expect((await invitee.req('POST', '/api/auth/sign-up/email', { email: inviteeEmail.toLowerCase(), password: PASSWORD, name: 'Approver' })).status).toBe(200);
    const accepted = await invitee.req('POST', '/api/auth/organization/accept-invitation', { invitationId });
    expect(accepted.status).toBe(200);
    const me = await invitee.req('GET', '/v1/me', undefined, { 'x-fg-tenant': org.json.id });
    expect(me.status).toBe(200);
    expect(me.json.roles).toEqual(['approver']);

    // Once accepted, the invitation no longer opens sign-up for anyone else.
    // (A different client address: Better Auth throttles repeated sign-ups per IP.)
    const after = await new Client(closed).req('POST', '/api/auth/sign-up/email', { email: `late-${randomUUID().slice(0, 6)}@evil.test`, password: PASSWORD, name: 'Late' }, { 'x-forwarded-for': '203.0.113.50' });
    expect(after.status).toBe(403);
  });
});
