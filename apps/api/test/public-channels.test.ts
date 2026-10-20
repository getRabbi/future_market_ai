import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversationsModule, creatorsModule, customers, evidence, lifecycle } from '@futuregrow/core';
import { appInstalls, consentState, customerProfiles, messages, suppressions, withTenant } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { loadEnv } from '@futuregrow/runtime';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { buildApp } from '../src/app.js';

let h: CoreHarness;
let app: FastifyInstance;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

beforeAll(async () => {
  h = await createCoreHarness();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url, API_BASE_URL: 'http://localhost:8080', APP_ORIGINS: 'http://localhost:4321' } as NodeJS.ProcessEnv);
  ({ app } = await buildApp({ env, deps: h.deps }));
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('public channel endpoints', () => {
  it('unsubscribe: GET only confirms (scanner-safe); one-click POST suppresses and withdraws consent', async () => {
    const r = await customers.ingestEvents(h.deps, h.tenantId, 'test', [{ messageId: `m-${randomUUID()}`, event: 'identify', timestamp: h.clock.now().toISOString(), userId: 'u-unsub', email: 'unsub@example.com' }]);
    const profileId = r.profileIds[0]!;
    await tx((t) => customers.recordConsent(t, h.tenantId, h.users.owner, { profileId, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', source: 'form', capturedAt: h.clock.now().toISOString() }));
    const messageId = randomUUID();
    const token = lifecycle.unsubscribeToken(h.deps.config.identifierPepper, h.tenantId, messageId);
    await tx((t) => t.insert(messages).values({ id: messageId, tenantId: h.tenantId, profileId, channel: 'email', templateId: randomUUID(), category: 'commercial', status: 'delivered', unsubscribeTokenHash: sha256Hex(token) }));

    const page = await app.inject({ method: 'GET', url: `/u/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('<form method="post"');
    expect(await tx((t) => t.select().from(suppressions))).toHaveLength(0); // GET changed nothing

    const bad = await app.inject({ method: 'POST', url: `/u/${token.slice(0, -2)}zz`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(bad.statusCode).toBe(404);
    const oneClick = await app.inject({ method: 'POST', url: `/u/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(oneClick.statusCode).toBe(200);
    expect(oneClick.json()).toEqual({ ok: true });
    const [sup] = await tx((t) => t.select().from(suppressions));
    expect(sup).toMatchObject({ channel: 'email', reason: 'unsubscribe' });
    const [c] = await tx((t) => t.select().from(consentState).where(eq(consentState.profileId, profileId)));
    expect(c!.status).toBe('withdrawn');
    const form = await app.inject({ method: 'POST', url: `/u/${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'confirm=1' });
    expect(form.body).toContain('You are unsubscribed');
  });

  it('referral redirect: 302 to the destination with fg_ref, 404 for unknown codes', async () => {
    const ev = await tx((t) =>
      evidence.admitEvidence(
        t,
        h.tenantId,
        h.users.owner,
        { sourceType: 'internal', sourceOwner: 'acme', sourceUriOrObjectId: `contract://${randomUUID()}`, retrievedAt: h.clock.now().toISOString(), licenseOrUsageRights: 'signed', schemaVersion: '1', piiClassification: 'none', confidence: 1, permittedUses: ['analytics'], kind: 'contract', content: { ok: true } },
        { now: h.clock.now() },
      ),
    );
    const c = await tx((t) => creatorsModule.createCreator(t, h.tenantId, h.users.operator, { name: 'Sam' }));
    const k = await tx((t) => creatorsModule.createContract(t, h.tenantId, h.users.admin, { creatorId: c.id, materialRelationship: 'paid', currency: 'USD', requiredDisclosures: ['#ad'], startsAt: h.clock.now().toISOString(), signedEvidenceId: ev.evidenceId }));
    const link = await tx((t) => creatorsModule.createReferralLink(t, h.tenantId, h.users.operator, { creatorId: c.id, contractId: k.id, destinationUrl: 'https://shop.acme.test/' }));
    const res = await app.inject({ method: 'GET', url: `/r/${link.code.toLowerCase()}`, headers: { 'user-agent': 'test-agent' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://shop.acme.test/?fg_ref=${link.code}`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect((await app.inject({ method: 'GET', url: '/r/ZZZZZZZZ' })).statusCode).toBe(404);
  });

  it('chat widget: CORS preflight is answered only for the widget’s allow-listed origins', async () => {
    const w = await tx((t) => conversationsModule.createWidget(t, h.tenantId, h.users.admin, { allowedOrigins: ['https://shop.acme.test'] }));
    const ok = await app.inject({ method: 'OPTIONS', url: `/chat/v1/w/${w.publicKey}/conversations`, headers: { origin: 'https://shop.acme.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe('https://shop.acme.test');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const evil = await app.inject({ method: 'OPTIONS', url: `/chat/v1/w/${w.publicKey}/conversations`, headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const start = await app.inject({ method: 'POST', url: `/chat/v1/w/${w.publicKey}/conversations`, headers: { origin: 'https://shop.acme.test', 'content-type': 'application/json' }, payload: '{}' });
    expect(start.statusCode).toBe(201);
    expect(start.json()).toMatchObject({ conversationId: expect.any(String), visitorToken: expect.any(String), disclosure: expect.stringMatching(/AI/) });
    const denied = await app.inject({ method: 'POST', url: `/chat/v1/w/${w.publicKey}/conversations`, headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, payload: '{}' });
    expect(denied.statusCode).toBe(403);
    // Control-plane CORS is unchanged for /v1.
    const v1 = await app.inject({ method: 'OPTIONS', url: '/v1/me', headers: { origin: 'http://localhost:4321', 'access-control-request-method': 'GET' } });
    expect(v1.headers['access-control-allow-origin']).toBe('http://localhost:4321');
    expect(v1.headers['access-control-allow-credentials']).toBe('true');
  });

  it('app installs require a server ingestion key', async () => {
    const browser = await tx((t) => customers.createIngestionKey(t, h.tenantId, h.users.owner, { kind: 'browser', allowedOrigins: ['https://shop.acme.test'] }));
    const server = await tx((t) => customers.createIngestionKey(t, h.tenantId, h.users.owner, { kind: 'server', allowedOrigins: [] }));
    const body = { platform: 'android', installId: 'device-0042', installedAt: h.clock.now().toISOString(), installReferrer: 'utm_source=partner&utm_campaign=q4', consent: { analytics: true } };
    const viaBrowser = await app.inject({ method: 'POST', url: '/ingest/v1/app-installs', headers: { 'x-fg-write-key': browser.key, origin: 'https://shop.acme.test', 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(viaBrowser.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/ingest/v1/app-installs', headers: { authorization: `Bearer ${server.key}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ recorded: true, attributionMethod: 'play_install_referrer' });
    const [row] = await tx((t) => t.select().from(appInstalls));
    expect(row!.campaignRef).toBe('q4');
    const [p] = await tx((t) => t.select().from(customerProfiles).where(eq(customerProfiles.id, row!.profileId!)));
    expect(p).toBeDefined();
  });
});
