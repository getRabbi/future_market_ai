import { auditLog, connections, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { checkConnectionHealth, createConnection, listConnections, TESTABLE_PROVIDERS, testConnectionCredentials } from '../src/modules/connections.js';

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
  });
});
