import { alerts, auditLog, connections, withTenant } from '@futuregrow/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { checkConnectionHealth, createConnection, listConnections, TESTABLE_PROVIDERS, testConnectionCredentials, tokenLifecycleAlerts } from '../src/modules/connections.js';

const server = new FixtureServer();
let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
});
afterAll(async () => {
  await h?.close();
  await server.stop();
});
beforeEach(() => server.reset());

const meta = { provider: 'meta', externalAccountId: '1234567890', metadata: {}, credentials: { accessToken: 'EAAG-test-token' } };

describe('connection setup from the control plane', () => {
  it('tests credentials with the provider before anything is stored', async () => {
    server.on('GET', '/v26.0/me', { json: { id: '1234567890', name: 'Acme Page' } });
    server.on('GET', '/v26.0/me/permissions', {
      json: {
        data: [
          { permission: 'pages_manage_posts', status: 'granted' },
          { permission: 'ads_read', status: 'declined' },
        ],
      },
    });
    const ok = await testConnectionCredentials(h.deps, h.tenantId, h.users.owner, meta);
    expect(ok).toMatchObject({ healthy: true, status: 'healthy', grantedScopes: ['pages_manage_posts'], details: { id: '1234567890' } });
    expect(server.requests[0]!.query.get('access_token') ?? server.requests[0]!.headers.authorization).toBeTruthy();

    server.on('GET', '/v26.0/me', { status: 401, json: { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } } });
    const bad = await testConnectionCredentials(h.deps, h.tenantId, h.users.owner, meta);
    expect(bad).toMatchObject({ healthy: false, status: 'failing' });

    // Nothing persisted; the attempts are audited without the token.
    expect(await tx((t) => listConnections(t))).toEqual([]);
    const log = await tx((t) => t.select().from(auditLog).where(eq(auditLog.action, 'connector.connection.tested')));
    expect(log.map((l) => (l.payload as { status: string }).status)).toEqual(['healthy', 'failing']);
    expect(JSON.stringify(log)).not.toContain('EAAG-test-token');
  });

  it('refuses non-admins, unknown providers and invalid Shopify domains without calling out', async () => {
    await expect(testConnectionCredentials(h.deps, h.tenantId, h.users.analyst, meta)).rejects.toThrow(/roles/);
    await expect(testConnectionCredentials(h.deps, h.tenantId, h.users.owner, { ...meta, provider: 'chatwoot' })).rejects.toThrow(/no connection test/);
    // As in production (no test host override), the shop domain must be a *.myshopify.com host.
    const prod = { ...h.deps, config: { ...h.deps.config, endpoints: { ...h.deps.config.endpoints, shopifyOverride: null } } };
    const shop = await testConnectionCredentials(prod, h.tenantId, h.users.owner, { provider: 'shopify', externalAccountId: 'evil', metadata: {}, credentials: { shopDomain: '169.254.169.254', accessToken: 'shpat_x' } });
    expect(shop.healthy).toBe(false);
    expect(JSON.stringify(shop.details)).toMatch(/invalid shop domain/);
    expect(server.requests).toHaveLength(0);
    expect(TESTABLE_PROVIDERS).toEqual(expect.arrayContaining(['meta', 'google_ads', 'tiktok', 'youtube', 'shopify', 'app_store_connect', 'resend']));
  });

  it('a saved connection is health-checked; a rejected token moves it to reauth_required', async () => {
    server.on('GET', '/v26.0/me', { json: { id: '555', name: 'Saved Page' } });
    server.on('GET', '/v26.0/me/permissions', { json: { data: [{ permission: 'pages_read_engagement', status: 'granted' }] } });
    const c = await createConnection(h.deps, h.tenantId, h.users.owner, { ...meta, externalAccountId: '555', displayName: 'Saved Page', grantedScopes: ['pages_manage_posts'] });
    const first = await checkConnectionHealth(h.deps, h.tenantId, c.id);
    expect(first.connection).toMatchObject({ status: 'active', healthStatus: 'healthy', grantedScopes: ['pages_read_engagement'] });
    expect(first.connection.lastHealthCheckAt).not.toBeNull();

    server.on('GET', '/v26.0/me', { status: 401, json: { error: { message: 'Session has expired', type: 'OAuthException', code: 190 } } });
    const second = await checkConnectionHealth(h.deps, h.tenantId, c.id);
    expect(second.connection).toMatchObject({ status: 'reauth_required', healthStatus: 'failing' });
    const [row] = await tx((t) => t.select().from(connections).where(eq(connections.id, c.id)));
    expect(row!.status).toBe('reauth_required');
    // P1-07: the stop is announced as a critical alert (critical tenant alerts also reach the operator webhook).
    const raised = await tx((t) =>
      t
        .select()
        .from(alerts)
        .where(and(eq(alerts.kind, 'connector.reauth_required'), eq(alerts.dedupKey, `reauth:${c.id}`))),
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: 'critical', message: expect.stringMatching(/Saved Page.*queued actions wait, they are not retried/) });
    expect(raised[0]!.message).not.toMatch(/EAAG/);
  });
});

describe('credential lifecycle alerts (P1-07)', () => {
  const at = (now: Date, days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();
  it('warns a month ahead and is critical in the last week; access-token expiry and data-access lapse are separate', () => {
    const now = new Date('2026-12-20T00:00:00Z');
    const c = { id: 'c1', displayName: 'EPS Page' };
    expect(tokenLifecycleAlerts(c, { tokenExpiresAt: 'never', tokenDataAccessUntil: at(now, 40) }, now)).toEqual([]);
    const month = tokenLifecycleAlerts(c, { tokenExpiresAt: 'never', tokenDataAccessUntil: at(now, 30) }, now);
    expect(month).toEqual([expect.objectContaining({ kind: 'connector.token_expiring', severity: 'warning', dedupKey: 'token:c1:tokenDataAccessUntil:2027-01-19:warning', message: expect.stringMatching(/loses data access on 2027-01-19 \(in 30 days\).*authorize the app again/) })]);
    const week = tokenLifecycleAlerts(c, { tokenExpiresAt: at(now, 3), adsTokenDataAccessUntil: at(now, 7) }, now);
    expect(week.map((a) => [a.refs.field, a.severity])).toEqual([
      ['tokenExpiresAt', 'critical'],
      ['adsTokenDataAccessUntil', 'critical'],
    ]);
    expect(tokenLifecycleAlerts(c, { tokenDataAccessUntil: at(now, -1) }, now)[0]!.message).toMatch(/already passed/);
    expect(tokenLifecycleAlerts(c, { tokenDataAccessUntil: 'garbage', error: 'x' }, now)).toEqual([]);
  });

  it('a health check raises each alert once, also after acknowledgement, and escalates in the last week', async () => {
    const now = h.clock.now();
    const unix = (days: number) => Math.floor((now.getTime() + days * 86_400_000) / 1000);
    const token = (days: number) => ({ json: { data: { type: 'PAGE', app_id: 'app-1', is_valid: true, expires_at: 0, data_access_expires_at: unix(days), scopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement', 'pages_read_user_content'] } } });
    server.on('GET', '/v26.0/me', { json: { id: '777', name: 'Lifecycle Page' } });
    server.on('GET', '/v26.0/debug_token', token(20));
    const c = await createConnection(h.deps, h.tenantId, h.users.owner, { ...meta, externalAccountId: '777', displayName: 'Lifecycle Page' });
    const mine = () =>
      tx((t) =>
        t
          .select()
          .from(alerts)
          .where(like(alerts.dedupKey, `token:${c.id}:%`)),
      );
    const first = await checkConnectionHealth(h.deps, h.tenantId, c.id);
    // Twenty days ahead: an in-app warning only; the connection stays healthy and keeps posting.
    expect(first.connection.healthStatus).toBe('healthy');
    expect(first.result.details).toMatchObject({ tokenType: 'PAGE', tokenExpiresAt: 'never', tokenDataAccessUntil: expect.any(String) });
    expect((await mine()).map((a) => a.severity)).toEqual(['warning']);
    await tx((t) =>
      t
        .update(alerts)
        .set({ acknowledgedAt: new Date(), acknowledgedBy: 'user:test' })
        .where(like(alerts.dedupKey, `token:${c.id}:%`)),
    );
    await checkConnectionHealth(h.deps, h.tenantId, c.id);
    expect(await mine()).toHaveLength(1);
    // Five days left: critical alert, and the connector itself now reports the connection degraded (posting is not blocked).
    server.on('GET', '/v26.0/debug_token', token(5));
    const late = await checkConnectionHealth(h.deps, h.tenantId, c.id);
    expect(late.connection).toMatchObject({ status: 'active', healthStatus: 'degraded' });
    await checkConnectionHealth(h.deps, h.tenantId, c.id);
    expect((await mine()).map((a) => a.severity).sort()).toEqual(['critical', 'warning']);
    expect(JSON.stringify(await mine())).not.toMatch(/EAAG/);
  });
});
