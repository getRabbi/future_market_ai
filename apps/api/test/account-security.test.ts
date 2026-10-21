import { randomUUID } from 'node:crypto';
import { auditLog, verifyAuditChain, withTenant } from '@futuregrow/db';
import { loadEnv } from '@futuregrow/runtime';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { AttemptLimiter, PASSWORD_CHANGE_MAX_ATTEMPTS, passwordPolicyIssue } from '../src/account-security.js';
import { buildApp } from '../src/app.js';

const ORIGIN = 'http://localhost:4321';
const OLD = 'correct-horse-battery-staple';
const NEW = 'violet-otter-quantum-lantern-42';

class Client {
  cookies = new Map<string, string>();
  constructor(
    private readonly app: FastifyInstance,
    /** Distinct client addresses keep Better Auth's per-IP buckets apart. */
    readonly ip: string,
  ) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers: { origin: ORIGIN, 'x-forwarded-for': this.ip, ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
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
let app: FastifyInstance;
let ipSeq = 10;
const nextIp = () => `198.51.100.${ipSeq++}`;

beforeAll(async () => {
  h = await createCoreHarness();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url, FG_ALLOW_SIGNUP: 'true', API_BASE_URL: 'http://localhost:8080', APP_ORIGINS: ORIGIN } as NodeJS.ProcessEnv);
  ({ app } = await buildApp({ env, deps: h.deps }));
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('password policy and attempt limiter', () => {
  it('refuses unchanged, low-variety and email-derived passwords', () => {
    expect(passwordPolicyIssue({ newPassword: OLD, currentPassword: OLD })).toMatch(/different/);
    expect(passwordPolicyIssue({ newPassword: 'aaaaaaaaaaaaaaaa' })).toMatch(/5 different/);
    expect(passwordPolicyIssue({ newPassword: 'abababababcdcdcd' })).toMatch(/5 different/);
    expect(passwordPolicyIssue({ newPassword: 'Jordan.Lee-2026-secure', email: 'jordan.lee@acme.test' })).toMatch(/email/);
    expect(passwordPolicyIssue({ newPassword: NEW, currentPassword: OLD, email: 'jordan.lee@acme.test' })).toBeNull();
    // Very short local parts are not treated as identifying.
    expect(passwordPolicyIssue({ newPassword: 'the-joy-of-quiet-rivers', email: 'joy@acme.test' })).toBeNull();
  });

  it('allows max attempts per window, then reports the wait', () => {
    let now = 1_000_000;
    const l = new AttemptLimiter(3, 60_000, () => now);
    expect([l.hit('u'), l.hit('u'), l.hit('u')]).toEqual([0, 0, 0]);
    expect(l.hit('u')).toBe(60);
    expect(l.hit('other')).toBe(0);
    now += 30_000;
    expect(l.hit('u')).toBe(30);
    now += 30_001;
    expect(l.hit('u')).toBe(0);
  });
});

describe('change password', () => {
  it('requires the current password, revokes every other session, audits, and limits attempts per user', async () => {
    const email = `owner-${randomUUID().slice(0, 6)}@acme.test`;
    const a = new Client(app, nextIp());
    expect((await a.req('POST', '/api/auth/sign-up/email', { email, password: OLD, name: 'Owner' })).status).toBe(200);
    const org = await a.req('POST', '/api/auth/organization/create', { name: 'Acme', slug: `acme-${randomUUID().slice(0, 6)}` });
    expect(org.status).toBe(200);
    const tenantId = org.json.id as string;

    // A second session (another device) that must not survive the change.
    const b = new Client(app, nextIp());
    expect((await b.req('POST', '/api/auth/sign-in/email', { email, password: OLD })).status).toBe(200);
    expect((await b.req('GET', '/api/auth/get-session')).json?.user?.email).toBe(email);

    // No session: refused.
    const anon = new Client(app, nextIp());
    expect((await anon.req('POST', '/api/auth/change-password', { currentPassword: OLD, newPassword: NEW })).status).toBe(401);

    // Each attempt below comes from a new address, as an attacker rotating X-Forwarded-For would:
    // the per-user limit applies regardless of the IP buckets.
    const attempt = (body: Record<string, unknown>) => {
      const c = new Client(app, nextIp());
      c.cookies = new Map(a.cookies);
      return c.req('POST', '/api/auth/change-password', body).then((r) => ({ ...r, cookies: c.cookies }));
    };
    const wrong = await attempt({ currentPassword: 'not-the-password-at-all', newPassword: NEW });
    expect(wrong.status).toBe(400);
    const same = await attempt({ currentPassword: OLD, newPassword: OLD });
    expect(same.status).toBe(400);
    expect(same.json.code).toBe('PASSWORD_POLICY');
    expect((await attempt({ currentPassword: OLD, newPassword: 'short-pw' })).status).toBe(400);
    const derived = await attempt({ currentPassword: OLD, newPassword: `${email.split('@')[0]}-extra-words` });
    expect(derived.status).toBe(400);
    expect(derived.json.code).toBe('PASSWORD_POLICY');
    // The old password still works after the refused attempts.
    expect((await new Client(app, nextIp()).req('POST', '/api/auth/sign-in/email', { email, password: OLD })).status).toBe(200);

    // Success even though the client asked to keep other sessions: revocation is forced.
    const ok = await attempt({ currentPassword: OLD, newPassword: NEW, revokeOtherSessions: false });
    expect(ok.status).toBe(200);
    expect(typeof ok.json.token).toBe('string');
    a.cookies = ok.cookies;

    // The caller keeps a (new) session; the other device and the earlier sessions are signed out.
    const me = await a.req('GET', '/v1/me', undefined, { 'x-fg-tenant': tenantId });
    expect(me.status).toBe(200);
    expect(me.json.email).toBe(email);
    expect(Date.now() - Date.parse(me.json.passwordChangedAt)).toBeLessThan(60_000);
    expect((await b.req('GET', '/api/auth/get-session')).json).toBeNull();
    expect((await b.req('GET', '/v1/me', undefined, { 'x-fg-tenant': tenantId })).status).toBe(401);

    // Old password refused, new one accepted.
    expect((await new Client(app, nextIp()).req('POST', '/api/auth/sign-in/email', { email, password: OLD })).status).toBe(401);
    expect((await new Client(app, nextIp()).req('POST', '/api/auth/sign-in/email', { email, password: NEW })).status).toBe(200);

    // Audited in the organization's hash-chained log.
    const userId = me.json.userId as string;
    const rows = await withTenant(h.t.handle.db, { tenantId, actor: 'test' }, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'auth.password_changed'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(userId);
    expect(rows[0]!.payload).toMatchObject({ otherSessionsRevoked: true });
    const chain = await withTenant(h.t.handle.db, { tenantId, actor: 'test' }, (tx) => verifyAuditChain(tx, tenantId));
    expect(chain.valid).toBe(true);

    // PASSWORD_CHANGE_MAX_ATTEMPTS (5) attempts were used in this window: the next is refused.
    expect(PASSWORD_CHANGE_MAX_ATTEMPTS).toBe(5);
    const limited = await attempt({ currentPassword: NEW, newPassword: 'another-long-passphrase-77' });
    expect(limited.status).toBe(429);
    expect(limited.json.code).toBe('PASSWORD_CHANGE_RATE_LIMITED');
    expect((await new Client(app, nextIp()).req('POST', '/api/auth/sign-in/email', { email, password: NEW })).status).toBe(200);
  });

  it('applies the password policy at sign-up', async () => {
    const r = await new Client(app, nextIp()).req('POST', '/api/auth/sign-up/email', { email: `morgan.kai-${randomUUID().slice(0, 4)}@acme.test`, password: 'zzzzzzzzzzzzzzzz', name: 'Morgan' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('PASSWORD_POLICY');
  });
});
