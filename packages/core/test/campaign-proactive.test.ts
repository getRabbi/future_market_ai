import { randomUUID } from 'node:crypto';
import { actionRequests, adCampaigns, adDailyMetrics, connections, tenantSettings, withTenant } from '@futuregrow/db';
import { defaultTenantPolicy } from '@futuregrow/policies';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { campaignSignals, evaluateCampaigns, listOptimizationReviews, submitOptimizationReview } from '../src/modules/m17-paid/proactive.js';

const now = new Date('2026-11-09T12:00:00Z');
const campaign = { id: randomUUID(), status: 'ACTIVE', dailyBudgetMicros: 10_000_000, lastSyncedAt: now };
const rows = Array.from({ length: 14 }, (_, i) => ({ date: new Date(now.getTime() - (i + 1) * 86_400_000).toISOString().slice(0, 10), impressions: 1000, clicks: 0, conversions: i < 7 ? 0 : 2, costMicros: 1_000_000, evidenceId: randomUUID(), fetchedAt: now }));

it('uses complete fresh evidence and detects decline without inventing outcomes', () => {
  expect(campaignSignals(campaign, rows, now).signals.map((s) => s.key)).toEqual(['no_clicks', 'declining_outcomes']);
  expect(campaignSignals(campaign, rows.slice(1), now).signals).toEqual([]);
  expect(campaignSignals({ ...campaign, lastSyncedAt: new Date('2026-01-01') }, rows, now).signals).toEqual([]);
  expect(
    campaignSignals(
      campaign,
      rows.map((r) => ({ ...r, evidenceId: null })),
      now,
    ).signals,
  ).toEqual([]);
  expect(
    campaignSignals(
      campaign,
      rows.map((r) => ({ ...r, fetchedAt: new Date('2026-01-01') })),
      now,
    ).signals,
  ).toEqual([]);
  const opportunity = campaignSignals(
    campaign,
    rows.map((r, i) => ({ ...r, clicks: 50, conversions: i < 7 ? 10 : 2 })),
    now,
  ).signals;
  expect(opportunity).toHaveLength(1);
  expect(opportunity[0]).toMatchObject({ key: 'efficiency_opportunity', suggestedStatus: null });
});

let h: CoreHarness;
beforeAll(async () => {
  h = await createCoreHarness();
  h.clock.current = now;
});
afterAll(async () => {
  await h?.close();
});
it('honors Autopilot opt-in, deduplicates concurrent evaluations, and uses M23 only on review', async () => {
  const tx = <T>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'user:test' }, f);
  const [connection] = await tx((t) => t.insert(connections).values({ tenantId: h.tenantId, provider: 'meta', externalAccountId: 'act_test', displayName: 'Test', createdBy: 'test' }).returning());
  await tx((t) => t.insert(adCampaigns).values({ ...campaign, tenantId: h.tenantId, platform: 'meta', connectionId: connection!.id, externalCampaignId: '12345', name: 'Test', currency: 'USD' }));
  await tx((t) => t.insert(adDailyMetrics).values(rows.map((r) => ({ ...r, tenantId: h.tenantId, campaignId: campaign.id, conversionValueMicros: 0 }))));
  expect(await evaluateCampaigns(h.deps, h.tenantId)).toEqual({ evaluated: 0, proposed: 0 });
  await tx((t) =>
    t
      .insert(tenantSettings)
      .values({ tenantId: h.tenantId, policy: defaultTenantPolicy(), autopilotEnabled: true })
      .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { autopilotEnabled: true } }),
  );
  await Promise.all([evaluateCampaigns(h.deps, h.tenantId), evaluateCampaigns(h.deps, h.tenantId)]);
  const reviews = await tx(listOptimizationReviews);
  expect(reviews).toHaveLength(2);
  expect(reviews[0]!.refs).toHaveProperty('evidenceIds');
  expect(await tx((t) => t.select().from(actionRequests))).toHaveLength(0);
  await expect(submitOptimizationReview(h.deps, h.tenantId, h.users.analyst, reviews[0]!.id, ['US'])).rejects.toThrow();
  // Unknown/missing evidence fails closed in policy; a review still records a normal M23 request.
  const first = await submitOptimizationReview(h.deps, h.tenantId, h.users.operator, reviews[0]!.id, ['US']);
  expect(first.status).not.toMatch(/APPROVED|EXECUT|VERIFIED/);
  expect((await submitOptimizationReview(h.deps, h.tenantId, h.users.operator, reviews[0]!.id, ['US'])).id).toBe(first.id);
  expect(await tx((t) => t.select().from(actionRequests))).toHaveLength(1);
  h.clock.advance(4 * 86_400_000);
  await expect(submitOptimizationReview(h.deps, h.tenantId, h.users.operator, reviews[0]!.id, ['US'])).rejects.toThrow(/no longer applies/);
  await tx((t) => t.update(tenantSettings).set({ autopilotEnabled: false }).where(eq(tenantSettings.tenantId, h.tenantId)));
  expect(await evaluateCampaigns(h.deps, h.tenantId)).toEqual({ evaluated: 0, proposed: 0 });
});
