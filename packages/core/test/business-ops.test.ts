import { randomUUID } from 'node:crypto';
import { auditLog, conversationMessages, conversations, customerProfiles, growthIdeas, kgEntities, payoutRequests, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { distinctIdFor, forwardableProperties, forwardEvents, setForwarding } from '../src/modules/m02-customers/forwarding.js';
import { ingestEventsInTransaction, recordConsent } from '../src/modules/m02-customers/index.js';
import { syncShopifyCatalog } from '../src/modules/m12-offers/catalog.js';
import { groundedSeoOpportunities, proposeSeoIdeas, uploadKeywordMetrics } from '../src/modules/m18-discovery/index.js';
import * as conv from '../src/modules/m21-conversations/index.js';
import { createCreator } from '../src/modules/m22-creators/index.js';
import * as payouts from '../src/modules/m22-creators/payouts.js';
import { ingestWebhook, processWebhook } from '../src/modules/webhooks.js';

const server = new FixtureServer();
let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);
const ORIGIN = 'https://shop.acme.test';

async function evidenceId(kind = 'document') {
  const e = await tx((t) =>
    admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'internal',
        sourceOwner: 'acme',
        sourceUriOrObjectId: `doc://${randomUUID()}`,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'first-party',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 1,
        freshnessSlaHours: 24 * 90,
        permittedUses: ['analytics', 'creative_generation', 'autonomous_execution'],
        kind,
        summary: 'record',
        content: { n: randomUUID() },
      } as never,
      { now: h.clock.now() },
    ),
  );
  return e.evidenceId;
}

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
}, 180_000);
afterAll(async () => {
  await h?.close();
  await server.stop();
});
beforeEach(() => server.reset());

describe('PostHog forwarding (P2-11)', () => {
  it('keeps PII-like properties out and hashes the identity', () => {
    expect(forwardableProperties({ plan: 'pro', email: 'a@b.c', phone_number: '1', amount: 3, nested: { x: 1 }, ok: true, firstName: 'A' })).toEqual({ plan: 'pro', amount: 3, ok: true });
    const id = distinctIdFor('pepper', 't1', 'p1');
    expect(id).toMatch(/^fg_[0-9a-f]{32}$/);
    expect(distinctIdFor('pepper', 't2', 'p1')).not.toBe(id);
  });

  it('is off by default; forwards only consented events, once, and keeps the cursor on failure', async () => {
    const conn = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'posthog', externalAccountId: '12345', displayName: 'PostHog', credentials: { projectApiKey: 'phc_x', host: server.baseUrl } })).id;
    const at = h.clock.now().toISOString();
    const ingest = await tx((t) =>
      ingestEventsInTransaction(t, h.deps, h.tenantId, 'server', [
        { messageId: 'msg-consented-1', event: 'signup', timestamp: at, userId: 'u-1', properties: { plan: 'pro', email: 'alex@example.com' } },
        { messageId: 'msg-noconsent-1', event: 'signup', timestamp: at, userId: 'u-2', properties: { plan: 'free' } },
        { messageId: 'msg-anon-1', event: 'page_view', timestamp: at, anonymousId: 'anon-9' },
      ]),
    );
    expect(ingest.accepted).toBe(3);
    const [p1] = await tx((t) => t.select().from(customerProfiles).where(eq(customerProfiles.id, ingest.profileIds[0]!)));
    await tx((t) => recordConsent(t, h.tenantId, h.users.privacy, { profileId: p1!.id, purpose: 'analytics', status: 'granted', lawfulBasis: 'consent', source: 'cookie banner', capturedAt: at }));
    await expect(tx((t) => setForwarding(t, h.tenantId, h.users.operator, conn, true))).rejects.toThrow(/roles/);
    await tx((t) => setForwarding(t, h.tenantId, h.users.admin, conn, false));
    expect(await forwardEvents(h.deps, h.tenantId, conn)).toMatchObject({ status: 'disabled' });
    await tx((t) => setForwarding(t, h.tenantId, h.users.admin, conn, true));

    server.on('POST', '/batch/', { status: 503, json: { error: 'down' } });
    expect(await forwardEvents(h.deps, h.tenantId, conn)).toMatchObject({ status: 'failed', forwarded: 0 });
    server.reset();
    server.on('POST', '/batch/', { json: { status: 1 } });
    const ok = await forwardEvents(h.deps, h.tenantId, conn);
    expect(ok).toMatchObject({ status: 'forwarded', forwarded: 1, skippedNoConsent: 2 });
    const body = server.find('POST', '/batch/')[0]!.json as { api_key: string; batch: { event: string; distinct_id: string; uuid: string; properties: Record<string, unknown> }[] };
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]).toMatchObject({ event: 'signup', distinct_id: distinctIdFor(h.deps.config.identifierPepper, h.tenantId, p1!.id), properties: { plan: 'pro', $lib: 'futuregrow-server' } });
    expect(JSON.stringify(body)).not.toContain('alex@example.com');
    expect(body.batch[0]!.uuid).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing new: the cursor moved, so nothing is sent twice.
    expect(await forwardEvents(h.deps, h.tenantId, conn)).toMatchObject({ status: 'idle', forwarded: 0 });
    expect(server.find('POST', '/batch/')).toHaveLength(1);
  });
});

describe('Chatwoot handoff and agent replies (P2-12)', () => {
  let chatwoot: string;
  let conversationId: string;
  it('hands an AI conversation over and records the Chatwoot conversation only when Chatwoot accepted it', async () => {
    chatwoot = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'chatwoot', externalAccountId: '7', displayName: 'Support', metadata: { inboxId: '3' }, credentials: { baseUrl: server.baseUrl, apiAccessToken: 'CW', accountId: '7' } })).id;
    const w = await tx((t) => conv.createWidget(t, h.tenantId, h.users.admin, { allowedOrigins: [ORIGIN] }));
    // Chatwoot is down for the first handoff: the conversation is marked forward_failed, never "handed over".
    server.on('POST', '/api/v1/accounts/7/contacts', { status: 500, json: {} });
    const s1 = await conv.startConversation(h.deps, w.publicKey, ORIGIN);
    const r1 = await conv.postCustomerMessage(h.deps, { publicKey: w.publicKey, origin: ORIGIN, conversationId: s1.conversationId, visitorToken: s1.visitorToken, text: 'I need to talk to a person about my order' });
    expect(r1.handoff).toBe(true);
    const [c1] = await tx((t) => t.select().from(conversations).where(eq(conversations.id, s1.conversationId)));
    expect(c1).toMatchObject({ handoffStatus: 'forward_failed', chatwootConversationId: null });

    server.reset();
    server.on('POST', '/api/v1/accounts/7/contacts', { json: { payload: { contact: { id: 55, contact_inboxes: [{ source_id: 'src-1' }] } } } });
    server.on('POST', '/api/v1/accounts/7/conversations', { json: { id: 321 } });
    const s2 = await conv.startConversation(h.deps, w.publicKey, ORIGIN);
    await conv.postCustomerMessage(h.deps, { publicKey: w.publicKey, origin: ORIGIN, conversationId: s2.conversationId, visitorToken: s2.visitorToken, text: 'Please connect me with your team' });
    const [c2] = await tx((t) => t.select().from(conversations).where(eq(conversations.id, s2.conversationId)));
    expect(c2).toMatchObject({ handoffStatus: 'forwarded', chatwootConversationId: 321 });
    conversationId = s2.conversationId;
  });

  it('mirrors a public agent reply once (duplicates ignored), skips private notes, closes on resolve', async () => {
    const deliver = async (payload: Record<string, unknown>, token = conv.chatwootWebhookToken(h.deps.config.identifierPepper, chatwoot)) => {
      const valid = token === conv.chatwootWebhookToken(h.deps.config.identifierPepper, chatwoot);
      const stored = await ingestWebhook(h.t.handle.db, { provider: 'chatwoot', providerEventId: `chatwoot:${chatwoot}:${payload.event}:${payload.id}`, topic: String(payload.event), signatureValid: valid, headers: {}, rawBody: JSON.stringify(payload), payload, accountRef: null, connectionId: valid ? chatwoot : null });
      return stored.duplicate || !valid ? (stored.duplicate ? 'duplicate' : 'rejected') : processWebhook(h.deps, stored.id);
    };
    expect(await deliver({ event: 'message_created', id: 900, content: 'Hi, this is Sam from support. Your order ships today.', message_type: 'outgoing', private: false, sender: { type: 'user', name: 'Sam' }, conversation: { id: 321 } })).toBe('processed');
    expect(await deliver({ event: 'message_created', id: 900, content: 'Hi, this is Sam from support. Your order ships today.', message_type: 'outgoing', private: false, sender: { type: 'user' }, conversation: { id: 321 } })).toBe('duplicate');
    expect(await deliver({ event: 'message_created', id: 901, content: 'internal note', message_type: 'outgoing', private: true, sender: { type: 'user' }, conversation: { id: 321 } })).toBe('ignored');
    expect(await deliver({ event: 'message_created', id: 902, content: 'customer echo', message_type: 'incoming', private: false, sender: { type: 'contact' }, conversation: { id: 321 } })).toBe('ignored');
    expect(await deliver({ event: 'message_created', id: 903, content: 'forged', message_type: 'outgoing', private: false, sender: { type: 'user' }, conversation: { id: 321 } }, 'wrong-token')).toBe('rejected');
    const msgs = await tx((t) => t.select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId)));
    expect(msgs.filter((m) => m.role === 'human_agent').map((m) => m.externalId)).toEqual(['chatwoot:900']);
    expect(await deliver({ event: 'conversation_status_changed', id: 321, status: 'resolved' })).toBe('processed');
    const [c] = await tx((t) => t.select().from(conversations).where(eq(conversations.id, conversationId)));
    expect(c).toMatchObject({ status: 'closed', handoffStatus: 'resolved' });
  });
});

describe('creator payouts are refused until every condition holds (P2-14)', () => {
  it('records a blocked request with every reason, proposes nothing and never logs the receiver', async () => {
    const creator = await tx((t) => createCreator(t, h.tenantId, h.users.operator, { name: 'Riley' }));
    await expect(payouts.requestPayout(h.deps, h.tenantId, h.users.analyst, creator.id)).rejects.toThrow(/roles/);
    await expect(tx((t) => payouts.setPayoutProfile(t, h.tenantId, { ...h.users.finance, mfaVerified: false }, creator.id, { provider: 'paypal', receiver: 'riley@pay.example' }))).rejects.toThrow();
    await expect(tx((t) => payouts.setPayoutProfile(t, h.tenantId, h.users.finance, creator.id, { provider: 'paypal', receiver: 'riley@pay.example', kycStatus: 'verified' }))).rejects.toThrow(/KYC evidence/);
    const kyc = await evidenceId('contract');
    const view = await tx((t) => payouts.setPayoutProfile(t, h.tenantId, h.users.finance, creator.id, { provider: 'paypal', receiver: 'riley@pay.example', kycStatus: 'verified', kycEvidenceId: kyc, taxFormEvidenceId: kyc, country: 'US' }));
    expect(view.receiver).toBe('ri…');
    const out = await payouts.requestPayout(h.deps, h.tenantId, h.users.finance, creator.id);
    expect(out.action).toBeNull();
    expect(out.request.status).toBe('blocked');
    const blockers = out.request.blockers.join(' | ');
    for (const re of [/payable_balance: nothing payable yet/, /contract: no creator contract/, /legal_approval: no counsel-approved record/, /provider: no payout provider connected/, /execution_enabled: payout execution disabled \(B-015\)/]) expect(blockers).toMatch(re);
    expect(blockers).not.toMatch(/identity:|tax_form:|destination:/);
    const [row] = await tx((t) => t.select().from(payoutRequests).where(eq(payoutRequests.id, out.request.id)));
    expect(row!.status).not.toBe('paid');
    const logs = await tx((t) => t.select().from(auditLog));
    expect(JSON.stringify(logs)).not.toContain('riley@pay.example');
  });
});

describe('Shopify catalog and grounded SEO opportunities (P2-09, P2-13)', () => {
  it('turns active Shopify products into product facts with price and stock from one evidence snapshot', async () => {
    const shop = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'shopify', externalAccountId: 'acme.myshopify.com', displayName: 'Shop', credentials: { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' } })).id;
    let page = 0;
    server.on('POST', '/admin/api/2026-10/graphql.json', () => {
      page++;
      return {
        json: {
          data: {
            shop: { currencyCode: 'USD' },
            products:
              page === 1
                ? {
                    pageInfo: { hasNextPage: true, endCursor: 'c1' },
                    nodes: [
                      {
                        id: 'gid://shopify/Product/1001',
                        title: 'House Blend',
                        handle: 'house-blend',
                        status: 'ACTIVE',
                        totalInventory: 42,
                        onlineStoreUrl: 'https://acme.example/products/house-blend',
                        variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1', sku: 'HB-250', price: '14.00', inventoryQuantity: 42 }] },
                      },
                    ],
                  }
                : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'gid://shopify/Product/1002', title: 'Decaf', handle: 'decaf', status: 'ACTIVE', totalInventory: 0, onlineStoreUrl: null, variants: { nodes: [] } }] },
          },
        },
      };
    });
    const r = await syncShopifyCatalog(h.deps, h.tenantId, shop, { actor: h.users.operator });
    expect(r).toMatchObject({ products: 2, facts: 2, currency: 'USD' });
    const facts = await tx((t) => t.select().from(kgEntities).where(eq(kgEntities.kind, 'product')));
    expect(facts.find((f) => f.key === 'shopify:product:1001')).toMatchObject({ name: 'House Blend', attributes: { prices: ['14.00'], totalInventory: 42, inStock: true } });
    expect(facts.find((f) => f.key === 'shopify:product:1002')!.attributes).toMatchObject({ inStock: false });
    expect(server.find('POST', '/admin/api/2026-10/graphql.json')[1]!.json).toMatchObject({ variables: { after: 'c1' } });
  });

  it('lists only opportunities backed by Search Console evidence and turns them into cited ideas', async () => {
    const ev = await evidenceId('metric');
    await tx((t) =>
      uploadKeywordMetrics(t, h.tenantId, h.users.analyst, {
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        evidenceId: ev,
        rows: [
          { query: 'best pour over ratio', pageUrl: 'https://acme.example/guide', impressions: 900, clicks: 9, position: 7.2 },
          { query: 'acme coffee', pageUrl: 'https://acme.example/', impressions: 2000, clicks: 600, position: 1.1 },
          { query: 'cold brew at home', pageUrl: 'https://acme.example/cold-brew', impressions: 400, clicks: 30, position: 12 },
        ],
      }),
    );
    const g = await tx((t) => groundedSeoOpportunities(t, { minImpressions: 100 }));
    // Position 4–20 with CTR at or below the median: the brand query at position 1 is not an opportunity.
    expect(g.rows.map((r) => r.query)).toEqual(['best pour over ratio', 'cold brew at home']);
    expect(g.rows[0]!.evidenceIds).toEqual([ev]);
    expect(g.note).toMatch(/no ranking or traffic outcome is promised/);
    const out = await tx((t) => proposeSeoIdeas(t, h.deps, h.tenantId, h.users.operator, { limit: 3 }));
    expect(out.created).toBe(2);
    const ideas = await tx((t) => t.select().from(growthIdeas).where(eq(growthIdeas.targetMetric, 'search_console.ctr')));
    const idea = ideas.find((i) => i.hypothesis.includes('pour over'));
    expect(idea).toMatchObject({ source: 'agent', evidenceIds: [ev] });
    expect(idea!.hypothesis).toMatch(/900 impressions at an average position of 7\.2/);
  });
});
