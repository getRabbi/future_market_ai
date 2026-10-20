import { randomUUID } from 'node:crypto';
import { competitorSnapshots, conversationMessages, conversations, customerEvents, messages, webhookInbox, withSystem, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { applyRetention, ingestEvents, setRetentionPolicy } from '../src/modules/m02-customers/index.js';
import * as comp from '../src/modules/m05-competitors/index.js';

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);
const daysAgo = (n: number) => new Date(h.clock.now().getTime() - n * 86_400_000);

beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('M02 data retention', () => {
  it('is restricted to privacy roles with MFA and enforces integrity floors', async () => {
    await expect(tx((t) => setRetentionPolicy(t, h.tenantId, h.users.operator, { dataClass: 'customer_events', retainDays: 30 }))).rejects.toThrow(/roles/);
    await expect(tx((t) => setRetentionPolicy(t, h.tenantId, { ...h.users.privacy, mfaVerified: false }, { dataClass: 'customer_events', retainDays: 30 }))).rejects.toThrow(/multi-factor/);
    await expect(tx((t) => setRetentionPolicy(t, h.tenantId, h.users.privacy, { dataClass: 'messages', retainDays: 3 }))).rejects.toThrow(/at least 8 days/);
  });

  it('deletes or erases only data older than the configured period, honours legal hold, keeps the newest snapshot', async () => {
    expect(await applyRetention(h.deps, h.tenantId)).toEqual({}); // no policy, nothing touched

    await ingestEvents(h.deps, h.tenantId, 'test', [
      { messageId: `old-${randomUUID()}`, event: 'page_view', timestamp: daysAgo(40).toISOString(), anonymousId: 'a1' },
      { messageId: `new-${randomUUID()}`, event: 'page_view', timestamp: daysAgo(2).toISOString(), anonymousId: 'a1' },
    ]);
    await tx(async (t) => {
      await t.insert(messages).values([
        { tenantId: h.tenantId, profileId: randomUUID(), channel: 'email', templateId: randomUUID(), category: 'commercial', status: 'delivered', createdAt: daysAgo(60) },
        { tenantId: h.tenantId, profileId: randomUUID(), channel: 'email', templateId: randomUUID(), category: 'commercial', status: 'delivered', createdAt: daysAgo(1) },
      ]);
      const [closed] = await t
        .insert(conversations)
        .values({ tenantId: h.tenantId, channel: 'web_chat', status: 'closed', visitorTokenHash: 'x'.repeat(64), lastMessageAt: daysAgo(100) })
        .returning();
      const [open] = await t
        .insert(conversations)
        .values({ tenantId: h.tenantId, channel: 'web_chat', status: 'open', visitorTokenHash: 'y'.repeat(64), lastMessageAt: daysAgo(100) })
        .returning();
      await t.insert(conversationMessages).values([
        { tenantId: h.tenantId, conversationId: closed!.id, role: 'customer', text: 'my order 1234 is late', redactedText: 'my order 1234 is late' },
        { tenantId: h.tenantId, conversationId: open!.id, role: 'customer', text: 'still waiting', redactedText: 'still waiting' },
      ]);
    });
    await withSystem(h.t.handle.db, 'test', (t) =>
      t.insert(webhookInbox).values({
        provider: 'shopify',
        providerEventId: `wh-${randomUUID()}`,
        resolvedTenantId: h.tenantId,
        topic: 'orders/create',
        signatureValid: true,
        headers: { 'x-shopify-topic': 'orders/create' },
        payload: { email: 'buyer@example.com' },
        payloadSha256: 'a'.repeat(64),
        status: 'processed',
        receivedAt: daysAgo(30),
      }),
    );
    const c = await tx((t) => comp.addCompetitor(t, h.tenantId, h.users.operator, { name: 'Rival', domains: ['rival.example'] }));
    const src = await tx((t) => comp.proposeSource(t, h.tenantId, h.users.operator, { competitorId: c.id, url: 'https://rival.example/pricing', kind: 'pricing', lawfulBasisNote: 'public pricing page, no login required' }));
    const ev = await tx((t) =>
      admitEvidence(
        t,
        h.tenantId,
        h.users.owner,
        {
          sourceType: 'primary',
          sourceOwner: 'rival',
          sourceUriOrObjectId: 'https://rival.example/pricing',
          retrievedAt: h.clock.now().toISOString(),
          licenseOrUsageRights: 'public page',
          schemaVersion: '1',
          piiClassification: 'none',
          confidence: 1,
          permittedUses: ['analytics'],
          kind: 'snapshot',
          content: { n: 1 },
        } as never,
        { now: h.clock.now() },
      ),
    );
    const keys = ['snap-old-1', 'snap-old-2'].map((k) => `${h.tenantId}/competitors/${k}.html`);
    for (const k of keys) await h.deps.store.put(k, '<html>pricing</html>', 'text/html');
    await tx((t) =>
      t.insert(competitorSnapshots).values([
        { tenantId: h.tenantId, sourceId: src.id, fetchedAt: daysAgo(90), httpStatus: 200, contentSha256: 'b'.repeat(64), objectKey: keys[0]!, textExcerpt: 'pricing', evidenceId: ev.evidenceId },
        { tenantId: h.tenantId, sourceId: src.id, fetchedAt: daysAgo(80), httpStatus: 200, contentSha256: 'c'.repeat(64), objectKey: keys[1]!, textExcerpt: 'pricing', evidenceId: ev.evidenceId },
      ]),
    );

    for (const p of [
      { dataClass: 'customer_events', retainDays: 30 },
      { dataClass: 'messages', retainDays: 30 },
      { dataClass: 'conversations', retainDays: 30 },
      { dataClass: 'webhook_payloads', retainDays: 14 },
      { dataClass: 'evidence_snapshots', retainDays: 30 },
      { dataClass: 'referral_clicks', retainDays: 30, legalHold: true },
    ]) {
      await tx((t) => setRetentionPolicy(t, h.tenantId, h.users.privacy, p));
    }
    const r = await applyRetention(h.deps, h.tenantId);
    expect(r).toEqual({ customer_events: 1, messages: 1, conversations: 1, webhook_payloads: 1, evidence_snapshots: 1, referral_clicks: 'legal_hold' });

    expect((await tx((t) => t.select().from(customerEvents))).map((e) => e.messageId)).toEqual([expect.stringMatching(/^new-/)]);
    expect(await tx((t) => t.select().from(messages))).toHaveLength(1);
    const msgs = await tx((t) => t.select().from(conversationMessages));
    expect(msgs.find((m) => m.text.includes('order'))).toBeUndefined();
    expect(msgs.map((m) => m.text).sort()).toEqual(['[erased: retention]', 'still waiting']); // open conversation untouched
    const [inbox] = await withSystem(h.t.handle.db, 'test', (t) => t.select().from(webhookInbox).where(eq(webhookInbox.resolvedTenantId, h.tenantId)));
    expect(JSON.stringify(inbox!.payload)).not.toContain('buyer@example.com');
    const snaps = await tx((t) => t.select().from(competitorSnapshots).orderBy(competitorSnapshots.fetchedAt));
    expect(snaps.map((s) => s.objectKey)).toEqual(['', keys[1]]); // newest kept for diffing
    expect(await h.deps.store.get(keys[0]!)).toBeNull();
    expect(await h.deps.store.get(keys[1]!)).not.toBeNull();

    // Idempotent.
    expect(await applyRetention(h.deps, h.tenantId)).toEqual({ customer_events: 0, messages: 0, conversations: 0, webhook_payloads: 0, evidence_snapshots: 0, referral_clicks: 'legal_hold' });
  });
});
