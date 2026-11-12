import { AbstainError, type ModelGateway, type PlannedCall } from '@futuregrow/agent-kernel';
import {
  aiSpendReservations,
  brands,
  claims,
  communityGroups,
  competitorObservations,
  competitors,
  consentState,
  conversationMessages,
  conversations,
  customerEvents,
  experimentResults,
  experiments,
  growthChannelTasks,
  growthOperations,
  growthOpportunities,
  growthSignals,
  growthStrategyMemory,
  keywordMetrics,
  kgEntities,
  leads,
  organization,
  type Tx,
  withTenant,
} from '@futuregrow/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { createDb } from '../../db/src/client.js';
import { guardAiCall, releaseAiCall } from '../src/ai-budget.js';
import type { Actor } from '../src/deps.js';
import { EXECUTORS, type StepContext } from '../src/modules/autopilot/steps.js';
import * as gw from '../src/modules/growth-warfare/index.js';
import { admitInternalEvidence } from '../src/modules/m01-evidence/index.js';
import { addSuppression, ingestEventsInTransaction, recordConsent } from '../src/modules/m02-customers/index.js';
import { normalizeText } from '../src/util.js';

const { settings, signals, conquest, blitz, capture, rescue, darwin, operations } = gw;
const DAY = 86_400_000;

let h: CoreHarness;
let brandId: string;
let competitorId: string;
let claimId: string;
let evidenceId: string;
const tx = <T>(fn: (t: Tx) => Promise<T>) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test' }, fn);
const noMfa = (a: Actor): Actor => ({ ...a, mfaVerified: false });
const ago = (days: number) => new Date(h.clock.now().getTime() - days * DAY);

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return { code: (e as { details?: { code?: string } }).details?.code ?? (e as { code?: string }).code, message: (e as Error).message };
  }
  throw new Error('expected a rejection');
}

function fakeGoal(id: string) {
  return {
    id,
    tenantId: h.tenantId,
    title: 'More first bookings',
    statement: 'Get more sellers to their first courier booking',
    kpi: { metricKey: 'app.first_booking', label: 'First bookings', direction: 'increase', unit: 'count', target: null, targetChangePct: 20 },
    market: 'BD',
    startsAt: ago(5),
    targetDate: new Date(h.clock.now().getTime() + 60 * DAY),
    channels: ['organic_social'],
    adBudgetMicros: 0,
    currency: 'USD',
    autoSubmit: false,
    limits: {},
    memory: {},
    siteUrl: null,
    status: 'active',
  };
}

beforeAll(async () => {
  h = await createCoreHarness();
  const now = h.clock.now();
  await tx(async (t) => {
    const ev = await admitInternalEvidence(t, h.tenantId, h.users.owner, {
      kind: 'observation',
      sourceType: 'primary',
      owner: 'rivalship.example',
      uri: 'https://rivalship.example/pricing',
      content: { page: 'pricing', insideDhaka: 80, before: 60 },
      summary: 'RivalShip pricing page, captured from an approved competitor source.',
      confidence: 0.9,
      license: 'public web page, approved competitor source',
      permittedUses: ['competitive_analysis', 'analytics', 'creative_generation'],
      freshnessSlaHours: 24 * 30,
      now,
    });
    expect(ev.status).toBe('admitted');
    evidenceId = ev.evidenceId;
    const [entity] = await t.insert(kgEntities).values({ tenantId: h.tenantId, kind: 'product', key: 'ecoms-bd', name: 'Ecoms BD', evidenceId, createdBy: 'test' }).returning();
    const [b] = await t
      .insert(brands)
      .values({ tenantId: h.tenantId, slug: 'ecoms-bd', name: 'Ecoms BD', productEntityIds: [entity!.id], createdBy: 'test' })
      .returning();
    brandId = b!.id;
    const text = 'Book couriers from one dashboard';
    const [c] = await t
      .insert(claims)
      .values({ tenantId: h.tenantId, text, normalizedText: normalizeText(text), claimType: 'product_capability', status: 'approved', evidenceIds: [evidenceId], entityIds: [entity!.id], approvedBy: 'user:legal', approvedAt: now, createdBy: 'test' })
      .returning();
    claimId = c!.id;
    const [comp] = await t
      .insert(competitors)
      .values({ tenantId: h.tenantId, name: 'RivalShip', domains: ['rivalship.example'] })
      .returning();
    competitorId = comp!.id;
    await t
      .insert(competitorObservations)
      .values({ tenantId: h.tenantId, competitorId, kind: 'price_change', summary: 'RivalShip raised its inside-Dhaka delivery fee from 60 to 80 BDT', details: { price: 80, currency: 'BDT', period: 'per parcel' }, evidenceFlag: 'P', evidenceIds: [evidenceId], confidence: 0.9, observedAt: ago(2) });
    // An inference ('I') never becomes a market change.
    await t.insert(competitorObservations).values({ tenantId: h.tenantId, competitorId, kind: 'positioning', summary: 'RivalShip may be losing sellers', details: {}, evidenceFlag: 'I', evidenceIds: [evidenceId], confidence: 0.4, observedAt: ago(1) });
  });
});
afterAll(async () => {
  await h?.close();
});

describe('durable AI budget reservations (D-054)', () => {
  it('two worker processes together cannot exceed the aggregate monthly limit', async () => {
    const other = createDb({ connectionString: h.t.url, max: 4, applicationName: 'futuregrow-test-worker-2' });
    try {
      const config = { aiSpendDefaultMonthlyUsd: 1 };
      const calls: PlannedCall[] = Array.from({ length: 6 }, (_, i) => ({ provider: 'groq', modelId: 'openai/gpt-oss-120b', purpose: `generation-${i}`, maxCostUsd: 0.4 }));
      const results = await Promise.allSettled(calls.map((c, i) => guardAiCall(i % 2 ? other.db : h.deps.db, config, h.tenantId, c)));
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok).toHaveLength(2); // 2 × 0.40 ≤ 1.00 < 3 × 0.40
      for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AbstainError);
      expect((await tx((t) => t.select().from(aiSpendReservations))).length).toBe(2);
      await Promise.all(calls.map((c) => releaseAiCall(c)));
      expect((await tx((t) => t.select().from(aiSpendReservations))).length).toBe(0);
      // A reservation a crashed process left behind stops counting once it expires.
      await tx((t) => t.insert(aiSpendReservations).values({ tenantId: h.tenantId, amountUsd: 5, provider: 'groq', modelId: 'x', purpose: 'crashed', holder: 'dead:1', expiresAt: new Date(Date.now() - 60_000) }));
      const again: PlannedCall = { provider: 'groq', modelId: 'openai/gpt-oss-120b', purpose: 'generation', maxCostUsd: 0.5 };
      await guardAiCall(other.db, config, h.tenantId, again);
      await releaseAiCall(again);
      // Unpriced models stay refused under a limit.
      const err = await errorOf(guardAiCall(h.deps.db, config, h.tenantId, { provider: 'groq', modelId: 'unpriced', purpose: 'x', maxCostUsd: null }));
      expect(err.message).toMatch(/no registry price/);
    } finally {
      await other.close();
    }
  });
});

describe('settings, switches and Autopilot hand-off when OFF', () => {
  it('defaults every feature and every external/paid operation to OFF', async () => {
    const s = await tx((t) => settings.getSettings(t, h.tenantId));
    expect(Object.values(s.features).every((v) => v === false)).toBe(true);
    expect(s.controls).toMatchObject({ externalOperations: false, paidOperations: false, approvalPreference: 'always_human', dailyAiBudgetUsd: 0, adSpendLimitMicros: 0 });
    expect(s.aggression).toBe('balanced');
    expect((await errorOf(tx((t) => settings.requireFeature(t, h.tenantId, 'F1')))).code).toBe('FEATURE_OFF');
    expect(await gw.tick(h.deps, h.tenantId)).toEqual({ skipped: 'all features off' });
    // The Autopilot research step adds nothing while Growth Warfare is off.
    const r = await EXECUTORS.research({ deps: h.deps, tenantId: h.tenantId, goal: fakeGoal('00000000-0000-4000-8000-000000000001'), prior: {}, now: h.clock.now(), aiCallsLeft: 0 } as unknown as StepContext);
    expect(r.output?.growthWarfare).toBeUndefined();
  });

  it('needs an admin, MFA to widen, the current version, and lets anyone switch off without MFA', async () => {
    expect((await errorOf(tx((t) => settings.updateSettings(t, h.tenantId, h.users.operator, { expectedVersion: 1, features: { F1: true } })))).code).toBe('FORBIDDEN');
    expect((await errorOf(tx((t) => settings.updateSettings(t, h.tenantId, noMfa(h.users.owner), { expectedVersion: 1, features: { F1: true } })))).code).toBe('MFA_REQUIRED');
    expect((await errorOf(tx((t) => settings.updateSettings(t, h.tenantId, h.users.owner, { expectedVersion: 7, features: { F1: true } })))).code).toBe('CONFLICT');
    const on = await tx((t) => settings.updateSettings(t, h.tenantId, h.users.owner, { expectedVersion: 1, features: { F1: true, F2: true, F3: true, F4: true, F5: true, F6: true } }));
    expect(on.version).toBe(2);
    const off = await tx((t) => settings.updateSettings(t, h.tenantId, noMfa(h.users.owner), { expectedVersion: 2, features: { F5: false } }));
    expect(off.features.F5).toBe(false);
    expect((await errorOf(tx((t) => settings.requireFeature(t, h.tenantId, 'F5')))).code).toBe('FEATURE_OFF');
    const back = await tx((t) => settings.updateSettings(t, h.tenantId, h.users.owner, { expectedVersion: 3, features: { F5: true }, aggression: 'balanced' }));
    expect(back.version).toBe(4);
    expect(back.effective).toMatchObject({ maxParallelExperiments: 1, monitoringHours: 24 });
  });

  it('saves a brand growth profile with optimistic concurrency', async () => {
    const config = {
      keywords: ['courier', 'delivery', 'dashboard'],
      competitorIds: [competitorId],
      market: 'BD',
      channels: ['facebook', 'owned_site', 'partner', 'community'],
      funnel: [
        { key: 'signup', label: 'Signup', events: ['signup'] },
        { key: 'onboarding', label: 'Completed onboarding', events: ['onboarding_completed'] },
        { key: 'courier', label: 'Courier connected', events: ['courier_connected'] },
        { key: 'booking', label: 'First booking', events: ['first_booking'] },
      ],
      conversionEvents: ['first_booking'],
      landingUrl: 'https://ecoms.example/start',
    };
    const saved = await tx((t) => settings.putBrandConfig(t, h.tenantId, h.users.operator, brandId, { expectedVersion: 0, config }));
    expect(saved.version).toBe(1);
    expect((await errorOf(tx((t) => settings.putBrandConfig(t, h.tenantId, h.users.operator, brandId, { expectedVersion: 0, config })))).code).toBe('CONFLICT');
  });
});

describe('F1 Market Signal Hunter', () => {
  it('turns one verified competitor change into one durable, brand-relevant opportunity — no duplicates', async () => {
    await tx(async (t) => {
      const kw = await admitInternalEvidence(t, h.tenantId, h.users.owner, {
        kind: 'metric',
        sourceType: 'primary',
        owner: 'google_search_console',
        uri: 'sc://ecoms.example/2026-09-16..2026-10-15',
        content: { rows: 2 },
        summary: 'Search Console queries',
        confidence: 0.95,
        license: 'own property data',
        permittedUses: ['analytics', 'competitive_analysis', 'creative_generation'],
        freshnessSlaHours: 24 * 60,
        now: h.clock.now(),
      });
      await t.insert(keywordMetrics).values([
        { tenantId: h.tenantId, query: 'rivalship alternative courier', pageUrl: null, periodStart: '2026-09-16', periodEnd: '2026-10-15', impressions: 320, clicks: 6, position: 7.2, source: 'search_console', evidenceId: kw.evidenceId },
        { tenantId: h.tenantId, query: 'courier price outside dhaka', pageUrl: null, periodStart: '2026-09-16', periodEnd: '2026-10-15', impressions: 150, clicks: 9, position: 5.1, source: 'search_console', evidenceId: kw.evidenceId },
        { tenantId: h.tenantId, query: 'courier', pageUrl: null, periodStart: '2026-09-16', periodEnd: '2026-10-15', impressions: 900, clicks: 40, position: 3, source: 'search_console', evidenceId: kw.evidenceId },
      ]);
      for (let i = 0; i < 6; i++) {
        const [c] = await t.insert(conversations).values({ tenantId: h.tenantId, channel: 'web_chat' }).returning();
        await t.insert(conversationMessages).values({ tenantId: h.tenantId, conversationId: c!.id, role: 'customer', text: 'How do I book courier delivery outside Dhaka?', redactedText: 'How do I book courier delivery outside Dhaka?' });
      }
    });
    const first = await signals.scanTenant(h.deps, h.tenantId, { force: true });
    expect(first.status).toBe('completed');
    const r = first.results[0]!;
    expect(r.sources.competitor).toBe(1);
    expect(r.sources.firstParty).toBeGreaterThanOrEqual(1);
    const opps = await tx((t) => signals.listOpportunities(t, { brandId }));
    const shock = opps.filter((o) => o.kind === 'competitor_price_change');
    expect(shock).toHaveLength(1);
    expect(shock[0]!.reason).toMatch(/RivalShip raised its inside-Dhaka delivery fee/);
    expect(shock[0]!.signal.evidenceIds).toEqual([evidenceId]);
    expect(shock[0]!.nextAction).toMatchObject({ feature: 'F2' });
    expect((shock[0]!.scoreBreakdown as { unknown: string[] }).unknown).toContain('competition');
    expect(opps.some((o) => o.kind === 'switching_intent')).toBe(true);
    // "courier" alone has no intent: it is not a signal.
    expect(opps.some((o) => o.signal.subject === 'courier')).toBe(false);
    const inquiry = await tx((t) => t.select().from(growthSignals).where(eq(growthSignals.sourceTable, 'conversation_messages')));
    expect(inquiry[0]?.metrics).toMatchObject({ people: 6 });

    const second = await signals.scanTenant(h.deps, h.tenantId, { force: true });
    expect(second.results[0]).toMatchObject({ created: 0, opportunities: 0 });
    expect((await tx((t) => signals.listOpportunities(t, { brandId }))).length).toBe(opps.length);
    // The scheduled scan respects the monitoring interval.
    expect((await signals.scanTenant(h.deps, h.tenantId)).status).toBe('skipped');
  });

  it('keeps tenants apart', async () => {
    const other = `org_other_${Date.now()}`;
    await h.t.handle.db.insert(organization).values({ id: other, name: 'Other', slug: other });
    const seen = await withTenant(h.deps.db, { tenantId: other, actor: 'test' }, (t) => t.select().from(growthSignals));
    expect(seen).toHaveLength(0);
    expect((await signals.scanTenant(h.deps, other, { force: true })).status).toBe('skipped');
  });
});

describe('F2 Competitor Conquest Forge', () => {
  it('builds a complete campaign package from one verified opportunity, once', async () => {
    const [opp] = await tx((t) => signals.listOpportunities(t, { brandId })).then((x) => x.filter((o) => o.kind === 'competitor_price_change'));
    const made = await tx((t) => conquest.prepareConquest(t, h.deps, h.tenantId, h.users.operator, opp!.id));
    expect(made.created).toBe(true);
    const c = made.campaign;
    expect(c.status).toBe('ready_for_review');
    const pkg = c.package as Record<string, any>;
    expect(pkg.approvedClaims.map((x: { claimId: string }) => x.claimId)).toEqual([claimId]);
    expect(pkg.verifiedCompetitorFacts).toHaveLength(1);
    expect(pkg.comparisonPage.markdown).toMatch(/not affiliated with or endorsed by RivalShip/);
    expect(pkg.costSavingCalculator.inputs[0]).toMatchObject({ key: 'competitor_price', value: 80, currency: 'BDT' });
    expect(pkg.costSavingCalculator.ready).toBe(false);
    expect(pkg.adProposals[0]).toMatchObject({ competitorNameInAdText: false, trademarkReview: 'required', executable: false, budgetMicros: 0 });
    expect(pkg.compliance.copyLint.passed).toBe(true);
    expect((c.approval as { required: { code: string }[] }).required.map((r) => r.code)).toEqual(expect.arrayContaining(['campaign_review', 'legal_trademark_review', 'm23_per_action']));
    expect(c.goals).toEqual([expect.objectContaining({ event: 'first_booking' })]);
    const again = await tx((t) => conquest.prepareConquest(t, h.deps, h.tenantId, h.users.operator, opp!.id));
    expect(again).toMatchObject({ created: false, campaign: { id: c.id } });

    expect((await errorOf(tx((t) => conquest.approveCampaign(t, h.tenantId, h.users.operator, c.id, { expectedVersion: 1 }, h.clock.now())))).code).toBe('FORBIDDEN');
    expect((await errorOf(tx((t) => conquest.approveCampaign(t, h.tenantId, noMfa(h.users.approver), c.id, { expectedVersion: 1 }, h.clock.now())))).code).toBe('MFA_REQUIRED');
    expect((await errorOf(tx((t) => conquest.approveCampaign(t, h.tenantId, h.users.approver, c.id, { expectedVersion: 1 }, h.clock.now())))).message).toMatch(/legal_trademark_review/);
    const ok = await tx((t) => conquest.approveCampaign(t, h.tenantId, h.users.approver, c.id, { expectedVersion: 1, acknowledge: ['legal_trademark_review'] }, h.clock.now()));
    expect(ok.status).toBe('approved');
  });

  it('rejects impersonation, disparagement and unbacked offers in copy', () => {
    const ctx = { competitorNames: ['RivalShip'], hasApprovedOffer: false, comparativeClaims: [] };
    expect(conquest.conquestCopyCheck('Official RivalShip partner deals', ctx).map((f) => f.code)).toContain('IMPERSONATION');
    expect(conquest.conquestCopyCheck('RivalShip is a scam', ctx).map((f) => f.code)).toContain('DISPARAGEMENT');
    expect(conquest.conquestCopyCheck('Get 20% off today', ctx).map((f) => f.code)).toContain('UNBACKED_OFFER');
    expect(conquest.conquestCopyCheck('Book couriers from one dashboard', ctx)).toEqual([]);
  });
});

describe('F3 Growth Blitz & Distribution Mesh', () => {
  it('plans channel tasks, enforces gates, quotas and duplicate protection', async () => {
    const c = (await tx((t) => t.execute<{ id: string }>(sql`select id from growth_campaigns where kind = 'conquest' limit 1`))).rows[0]!;
    const s = await tx((t) => settings.getSettings(t, h.tenantId));
    const tasks = await tx((t) => blitz.planChannelTasks(t, h.deps, h.tenantId, c.id, s));
    const by = Object.fromEntries(tasks.map((x) => [x.channel, x]));
    expect(by.facebook?.status).toBe('blocked'); // no Page is bound to the brand
    expect(by.owned_site?.status).toBe('planned');
    expect(by.community?.status).toBe('blocked');
    expect((await tx((t) => blitz.planChannelTasks(t, h.deps, h.tenantId, c.id, s))).length).toBe(0); // idempotent

    expect((await errorOf(blitz.submitTask(h.deps, h.tenantId, h.users.operator, by.owned_site!.id))).message).toMatch(/external operations are off/);
    const cur = await tx((t) => settings.getSettings(t, h.tenantId));
    await tx((t) => settings.updateSettings(t, h.tenantId, h.users.owner, { expectedVersion: cur.version, controls: { externalOperations: true, channelQuotas: { owned_site: 1, partner: 1, community: 1 } } }));
    const sub = await blitz.submitTask(h.deps, h.tenantId, h.users.operator, by.owned_site!.id);
    expect(sub.status).toBe('ready');
    expect((await errorOf(tx((t) => blitz.confirmHumanTask(t, h.tenantId, h.users.operator, by.owned_site!.id, { url: 'http://insecure' })))).message).toMatch(/https/);
    const done = await tx((t) => blitz.confirmHumanTask(t, h.tenantId, h.users.operator, by.owned_site!.id, { url: 'https://ecoms.example/compare' }));
    expect(done.status).toBe('done_by_human');
    expect((await blitz.submitTask(h.deps, h.tenantId, h.users.operator, by.partner!.id)).status).toBe('ready');
    // Paid campaigns are never created from here.
    const paid = await tx((t) => blitz.planChannelTasks(t, h.deps, h.tenantId, c.id, s, { channels: ['paid_ads'] }));
    expect(paid[0]?.status).toBe('blocked');
  });

  it('prepares a blitz once per opportunity and enforces the daily channel quota', async () => {
    const [opp] = await tx((t) => signals.listOpportunities(t, { brandId })).then((x) => x.filter((o) => o.kind === 'switching_intent'));
    const b = await tx((t) => blitz.prepareBlitz(t, h.deps, h.tenantId, h.users.operator, opp!.id));
    expect(b.created).toBe(true);
    expect((await tx((t) => blitz.prepareBlitz(t, h.deps, h.tenantId, h.users.operator, opp!.id))).created).toBe(false);
    await tx((t) => conquest.approveCampaign(t, h.tenantId, h.users.approver, b.campaign.id, { expectedVersion: 1 }, h.clock.now()));
    const partner = b.tasks.find((x) => x.channel === 'partner')!;
    expect((await errorOf(blitz.submitTask(h.deps, h.tenantId, h.users.operator, partner.id))).message).toMatch(/quota reached/);
  });

  it('drafts a disclosed community reply that follows the group rules', async () => {
    const [g] = await tx((t) => t.insert(communityGroups).values({ tenantId: h.tenantId, url: 'https://facebook.com/groups/bd-sellers', name: 'BD Sellers', rules: 'No self-promotion or links.', permission: 'members_may_post', status: 'member', createdBy: 'test' }).returning());
    const c = (await tx((t) => t.execute<{ id: string }>(sql`select id from growth_campaigns where kind = 'conquest' limit 1`))).rows[0]!;
    const task = await tx((t) => blitz.draftCommunityReply(t, h.deps, h.tenantId, h.users.operator, { campaignId: c.id, discussionUrl: 'https://facebook.com/groups/bd-sellers/posts/1', question: 'Which dashboard lets me book couriers?', groupId: g!.id }));
    const content = task.content as { reply: string; rulesCheck: { promotionAllowed: boolean } };
    expect(content.reply).toMatch(/^Disclosure: I work with Ecoms BD\./);
    expect(content.reply).not.toMatch(/https:\/\//);
    expect(content.rulesCheck.promotionAllowed).toBe(false);
    expect((await errorOf(tx((t) => blitz.draftCommunityReply(t, h.deps, h.tenantId, h.users.operator, { campaignId: c.id, discussionUrl: 'https://facebook.com/groups/bd-sellers/posts/1', question: 'again', groupId: g!.id })))).code).toBe('CONFLICT');
  });
});

describe('F4 Search & Utility Capture Engine', () => {
  const courierConfig = {
    currency: 'BDT',
    zones: ['inside_dhaka', 'outside_dhaka'],
    couriers: [
      {
        name: 'Courier A',
        sourceUrl: 'https://a.example/rates',
        verifiedAt: '2026-10-10',
        rates: [
          { zone: 'inside_dhaka', maxWeightKg: 1, price: 60 },
          { zone: 'inside_dhaka', maxWeightKg: 2, price: 80 },
        ],
        codFeePct: 1,
        returnFee: 30,
      },
      { name: 'Courier B', sourceUrl: 'https://b.example/rates', verifiedAt: '2026-10-12', rates: [{ zone: 'inside_dhaka', maxWeightKg: 1, price: 50 }], codFeePct: null, returnFee: null },
    ],
  };

  it('calculates with real inputs and never fills a missing published rate', () => {
    const r = capture.evaluateTool('courier_comparison', courierConfig, { zone: 'inside_dhaka', weightKg: 1.5, codAmount: 1000 }) as { couriers: { courier: string; total: number | null; missing: string[] }[]; cheapestKnown: string };
    expect(r.couriers[0]).toMatchObject({ courier: 'Courier A', total: 90 });
    expect(r.couriers[1]).toMatchObject({ courier: 'Courier B', total: null });
    expect(r.couriers[1]!.missing.length).toBeGreaterThan(0);
    expect(r.cheapestKnown).toBe('Courier A');
    expect(capture.evaluateTool('cod_reconciliation', {}, { orders: 100, avgCodAmount: 1000, deliveryFee: 60, codFeePct: 1, returnRatePct: 10, returnFee: 30, alreadyReceived: 50000 })).toMatchObject({ deliveredOrders: 90, courierCharges: 6600, expectedPayout: 83400, outstanding: 33400 });
    expect(capture.evaluateTool('seller_cost_calculator', {}, { sellingPrice: 1000, unitCost: 500, shipping: 60, packaging: 20, platformFeePct: 5, paymentFeePct: 2, adSpendPerOrder: 100, returnRatePct: 10, returnCost: 100 })).toMatchObject({ marginPerOrder: 240, breakEvenAdSpend: 340 });
    const def = capture.publicDefinition('practice_quiz', { questions: 5 }) as { questions: { id: string; options: string[] }[] };
    expect(JSON.stringify(def)).not.toMatch(/"answer"/);
    const qs = capture.curriculumQuestions('eps-topik-bn', { seed: 'v1', total: 5 });
    const graded = capture.evaluateTool('practice_quiz', { questions: 5 }, { answers: Object.fromEntries(qs.map((q) => [q.id, q.answer])) }) as { correct: number; total: number };
    expect(graded).toMatchObject({ correct: 5, total: 5 });
    expect(() => capture.evaluateTool('courier_comparison', courierConfig, { zone: 'mars', weightKg: 1 })).toThrow(/zone must be one of/);
  });

  it('publishes only with MFA and external operations on; leads only with explicit consent', async () => {
    const tool = await tx((t) =>
      capture.createTool(t, h.deps, h.tenantId, h.users.operator, {
        brandId,
        template: 'courier_comparison',
        title: 'Courier fee comparison',
        config: courierConfig,
        cta: { label: 'Try Ecoms BD', url: 'https://ecoms.example/start' },
        consent: { leadCapture: true, text: 'Send me Ecoms BD seller tips by e-mail. Unsubscribe any time.' },
      }),
    );
    expect((await errorOf(capture.publicView(h.deps, tool.publicId, null))).code).toBe('NOT_FOUND');
    expect((await errorOf(tx((t) => capture.publishTool(t, h.deps, h.tenantId, h.users.operator, tool.id, 'publish')))).code).toBe('FORBIDDEN');
    expect((await errorOf(tx((t) => capture.publishTool(t, h.deps, h.tenantId, noMfa(h.users.owner), tool.id, 'publish')))).code).toBe('MFA_REQUIRED');
    await tx((t) => capture.publishTool(t, h.deps, h.tenantId, h.users.owner, tool.id, 'publish'));
    const view = await capture.publicView(h.deps, tool.publicId, 'anon-visitor-0001');
    expect(view).toMatchObject({ brand: 'Ecoms BD', consent: { leadCapture: true } });
    expect(JSON.stringify(view.definition)).not.toMatch(/price/);
    await capture.publicEvaluate(h.deps, tool.publicId, { anonymousId: 'anon-visitor-0001', analyticsConsent: false, inputs: { zone: 'inside_dhaka', weightKg: 1, codAmount: 0 } });
    await capture.publicEvaluate(h.deps, tool.publicId, { anonymousId: 'anon-visitor-0002', analyticsConsent: true, inputs: { zone: 'inside_dhaka', weightKg: 1, codAmount: 0 } });
    const stored = await tx((t) => t.execute<{ n: number }>(sql`select count(*)::int as n from customer_events where event_name = 'acquisition_tool_completed' and properties->>'toolId' = ${tool.id}`));
    expect(stored.rows[0]!.n).toBe(1); // the unconsented one is not stored
    expect((await errorOf(capture.publicLead(h.deps, tool.publicId, { anonymousId: 'anon-visitor-0002', email: 'seller@example.com', marketingConsent: false, consentText: 'x' }))).message).toBeTruthy();
    const lead = await capture.publicLead(h.deps, tool.publicId, { anonymousId: 'anon-visitor-0002', email: 'seller@example.com', marketingConsent: true, consentText: 'Send me Ecoms BD seller tips by e-mail. Unsubscribe any time.' });
    expect(lead).toEqual({ ok: true, duplicate: false });
    expect(await capture.publicLead(h.deps, tool.publicId, { anonymousId: 'anon-visitor-0002', email: 'seller@example.com', marketingConsent: true, consentText: 'Send me Ecoms BD seller tips by e-mail. Unsubscribe any time.' })).toEqual({ ok: true, duplicate: true });
    expect((await tx((t) => t.select().from(leads))).length).toBe(1);
    const granted = await tx((t) => t.select().from(consentState).where(eq(consentState.purpose, 'marketing_email')));
    expect(granted).toHaveLength(1);
  });

  it('reports a missing-data state, then evidence-backed visibility recommendations', async () => {
    const before = await tx((t) => capture.visibilityReport(t, brandId, h.clock.now()));
    expect(before.missing.join(' ')).toMatch(/No AI\/search answer observations/);
    expect(before.providerStatus).toBe('manual_import_only');
    const batch = {
      brandId,
      engine: 'assistant-x',
      sourceNote: 'Asked by hand from a clean browser profile',
      observations: [{ query: 'best courier booking dashboard in Bangladesh', observedAt: ago(1).toISOString(), brandMentioned: false, competitorsMentioned: ['RivalShip'], citedSources: ['https://rivalship.example/blog'] }],
    };
    expect((await tx((t) => capture.importVisibility(t, h.deps, h.tenantId, h.users.operator, batch))).inserted).toBe(1);
    expect((await tx((t) => capture.importVisibility(t, h.deps, h.tenantId, h.users.operator, batch))).duplicates).toBe(1);
    const rep = await tx((t) => capture.visibilityReport(t, brandId, h.clock.now()));
    expect(rep.gaps[0]).toMatchObject({ gap: 'competitor_visible' });
    const rec = rep.recommendations.find((r) => r.query.startsWith('best courier'))!;
    expect(rec.comparisonPage?.competitors).toEqual(['RivalShip']);
    expect(rec.faq?.claimIds).toEqual([claimId]);
    expect(rec.measurement.guarantee).toMatch(/none/);
  });
});

describe('F5 Conversion Rescue & Viral Loops', () => {
  it('finds the measurable bottleneck and counts only consented, unsuppressed people as contactable', async () => {
    await tx(async (t) => {
      const ev = (unit: number, name: string, daysAgo: number, email?: string) => ({ messageId: `fn-${unit}-${name}`, event: name, timestamp: ago(daysAgo).toISOString(), anonymousId: `unit-${unit}`, ...(email ? { email } : {}) });
      const batch = [];
      for (let u = 0; u < 40; u++) {
        const email = u < 3 ? `stalled${u}@example.com` : undefined;
        batch.push(ev(u, 'signup', 10, email));
        if (u < 35) batch.push(ev(u, 'onboarding_completed', 9, email));
        if (u >= 25 && u < 35) batch.push(ev(u, 'courier_connected', 5));
        if (u >= 27 && u < 35) batch.push(ev(u, 'first_booking', 4));
      }
      const r = await ingestEventsInTransaction(t, h.deps, h.tenantId, 'test', batch);
      expect(r.accepted).toBe(batch.length);
      const profiles = await t.execute<{ id: string; email: string }>(sql`select id, email from customer_profiles where email like 'stalled%'`);
      for (const p of profiles.rows.filter((x) => x.email !== 'stalled2@example.com')) await recordConsent(t, h.tenantId, h.users.privacy, { profileId: p.id, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', source: 'test', capturedAt: ago(20).toISOString() });
      await addSuppression(t, h.deps, h.tenantId, h.users.privacy, { channel: 'email', identifier: { kind: 'email', value: 'stalled1@example.com' }, reason: 'unsubscribe', source: 'test' });
    });
    const d = await tx((t) => rescue.diagnoseFunnel(t, brandId, { now: h.clock.now() }));
    expect(d.status).toBe('diagnosed');
    expect(d.bottleneck).toMatchObject({ from: 'onboarding', to: 'courier' });
    expect(d.counts.map((c) => c.reached)).toEqual([40, 35, 10, 8]);
    expect(d.counts[3]!.sufficient).toBe(false); // 10 people entering is below the minimum
    expect(d.abandoned).toMatchObject({ stalled: 25, contactable: 1 });
    const plan = await tx((t) => rescue.recoveryPlan(t, h.deps, h.tenantId, brandId, d));
    expect(plan.actions.find((a) => a.kind === 'email_journey')?.available).toBe(false); // no Resend connection
    const made = await tx((t) => rescue.prepareRescue(t, h.deps, h.tenantId, h.users.operator, brandId));
    expect(made.created).toBe(true);
    expect((await tx((t) => rescue.prepareRescue(t, h.deps, h.tenantId, h.users.operator, brandId))).created).toBe(false);
  });

  it('reports the referral loop without self-referrals and checks reward eligibility only', async () => {
    await tx(async (t) => {
      const evs = [];
      for (let i = 0; i < 4; i++) evs.push({ messageId: `invite-000${i}`, event: 'referral_invite_sent', timestamp: ago(3).toISOString(), anonymousId: `inviter-${i % 2}` });
      evs.push({ messageId: 'ref-signup-1', event: 'referral_signup', timestamp: ago(2).toISOString(), anonymousId: 'friend-1', properties: { inviterId: 'inviter-0' } });
      evs.push({ messageId: 'ref-signup-2', event: 'referral_signup', timestamp: ago(2).toISOString(), anonymousId: 'inviter-1', properties: { inviterId: 'inviter-1' } });
      await ingestEventsInTransaction(t, h.deps, h.tenantId, 'test', evs);
    });
    const loop = await tx((t) => rescue.referralLoop(t, { now: h.clock.now(), pepper: h.deps.config.identifierPepper }));
    expect(loop).toMatchObject({ inviters: 2, invites: 4, invitedSignups: 1, selfReferralsExcluded: 1, sufficient: false });
    expect(rescue.wilson(5, 10)).toEqual([0.237, 0.763]);
  });
});

describe('F6 Campaign Darwin Engine and the Growth Brain', () => {
  let planId: string;
  it('checks sufficiency, deduplicates plans and approves into an M10 experiment with four eyes', async () => {
    const base = {
      brandId,
      area: 'onboarding',
      hypothesis: 'Showing the courier comparison right after onboarding raises courier connections.',
      control: { description: 'Current onboarding end screen' },
      variant: { description: 'End screen links the courier comparison tool' },
      primaryKpi: { metric: 'courier_connected', exposureEvent: 'onboarding_completed' },
      tactic: 'onboarding_tool_prompt',
    };
    const unknown = await tx((t) => darwin.proposePlan(t, h.deps, h.tenantId, h.users.operator, base));
    expect(unknown.plan.status).toBe('proposed');
    expect((unknown.plan.sufficiency as { status: string }).status).toBe('unknown');
    expect((await tx((t) => darwin.proposePlan(t, h.deps, h.tenantId, h.users.operator, base))).created).toBe(false);
    const slow = await tx((t) => darwin.proposePlan(t, h.deps, h.tenantId, h.users.operator, { ...base, variant: { description: 'Tooltip on the courier step' }, baselineRate: 0.3, minDetectableEffect: 0.1 }));
    expect(slow.plan.status).toBe('insufficient_data');
    planId = unknown.plan.id;
    expect((await errorOf(tx((t) => darwin.approvePlan(t, h.tenantId, noMfa(h.users.admin), planId)))).code).toBe('MFA_REQUIRED');
    expect((await errorOf(tx((t) => darwin.approvePlan(t, h.tenantId, h.users.admin, slow.plan.id)))).code).toBe('CONFLICT');
    const own = await tx((t) => darwin.proposePlan(t, h.deps, h.tenantId, h.users.owner, { ...base, hypothesis: 'A shorter onboarding checklist raises courier connections for new sellers.' }));
    expect((await errorOf(tx((t) => darwin.approvePlan(t, h.tenantId, h.users.owner, own.plan.id)))).code).toBe('FORBIDDEN');
    const approved = await tx((t) => darwin.approvePlan(t, h.tenantId, h.users.admin, planId));
    expect(approved.plan.status).toBe('approved');
    expect(approved.experimentId).toBeTruthy();
    // Balanced allows one approved or running experiment per brand.
    expect((await errorOf(tx((t) => darwin.approvePlan(t, h.tenantId, h.users.admin, own.plan.id)))).message).toMatch(/already approved or running/);
  });

  it('records only randomized, SRM-clean results as wins and feeds them to the next Brain cycle', async () => {
    const [p] = await tx((t) => t.execute<{ id: string; experiment_id: string | null; status: string }>(sql`select id, experiment_id, status from growth_experiment_plans where id = ${planId}`)).then((r) => r.rows);
    expect(p!.status).toBe('approved');
    await tx(async (t) => {
      await t
        .update(experiments)
        .set({ status: 'completed', startedAt: ago(14), endedAt: ago(0) })
        .where(eq(experiments.id, p!.experiment_id!));
      await t.insert(experimentResults).values({
        tenantId: h.tenantId,
        experimentId: p!.experiment_id!,
        perVariant: [
          { key: 'control', n: 600, successes: 60 },
          { key: 'variant', n: 610, successes: 92 },
        ],
        probBest: { control: 0.01, variant: 0.99 },
        expectedLoss: { control: 0.03, variant: 0.0002 },
        srm: { mismatch: false, pValue: 0.77 },
        guardrails: [],
        recommendation: 'ship_candidate',
        recommendationReason: 'P(best) 0.99 ≥ 0.95 and expected loss below threshold',
      });
    });
    expect((await darwin.syncLearning(h.deps, h.tenantId)).recorded).toBeGreaterThanOrEqual(1);
    const second = await darwin.syncLearning(h.deps, h.tenantId);
    const rows = await tx((t) => t.select().from(growthStrategyMemory).where(eq(growthStrategyMemory.inferenceKind, 'randomized_test')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'supported_winner', tactic: 'onboarding', area: 'onboarding' });
    expect(second.recorded).toBe(0);
    // Attribution can never be stored as a randomized win.
    const bad = await errorOf(tx((t) => t.insert(growthStrategyMemory).values({ tenantId: h.tenantId, brandId, tactic: 'x', area: 'onboarding', hypothesis: 'x', outcome: 'supported_winner', inferenceKind: 'observational', effect: {}, summary: 'x' })));
    expect(bad.message).toMatch(/growth_strategy_memory_causal_chk|check constraint/);
    expect(darwin.classifyResult({ recommendation: 'ship_candidate', srm: { mismatch: true }, probBest: { variant: 0.99 } }, true)).toBe('invalid');
    expect(darwin.classifyResult({ recommendation: 'continue', srm: {}, probBest: {} }, false)).toBeNull();

    const follow = await tx((t) => darwin.recommendFollowUps(t, brandId));
    expect(follow[0]).toMatchObject({ kind: 'extend_winner', experimentId: p!.experiment_id });
    const prio = await tx((t) => darwin.tacticPriorities(t, brandId));
    expect(prio.find((x) => x.tactic === 'onboarding')!.posteriorMean).toBeGreaterThan(0.5);

    // The next Autopilot cycle's research step reads the finding; the Idea Lab and Brain get it as context.
    const goal = fakeGoal('00000000-0000-4000-8000-000000000002');
    const research = await EXECUTORS.research({ deps: h.deps, tenantId: h.tenantId, goal, prior: {}, now: h.clock.now(), aiCallsLeft: 0 } as unknown as StepContext);
    const lines = (research.output?.growthWarfare as { lines: string[] } | undefined)?.lines ?? [];
    expect(lines.some((l) => l.startsWith('[validated, randomized test]'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[follow-up]'))).toBe(true);
    let prompt = '';
    const models = {
      generate: async (req: { messages: { content: string }[] }) => {
        prompt = req.messages.map((m) => m.content).join('\n');
        return { output: { ideas: [], abstain: 'test double' }, provider: 'fake', modelId: 'fake', servedBy: 'fake', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, attempts: 1, costUsd: 0, failedOver: [] };
      },
    } as unknown as ModelGateway;
    await EXECUTORS.ideas({ deps: { ...h.deps, models }, tenantId: h.tenantId, goal, prior: { observe: { output: { evidence: 1 } }, research } as never, now: h.clock.now(), aiCallsLeft: 5 } as unknown as StepContext);
    expect(prompt).toMatch(/\[validated, randomized test\] onboarding/);
    expect(prompt).toMatch(/not a guarantee/);
  });
});

describe('durable operations and the emergency stop', () => {
  it('returns a completed run, skips a live lease and takes over an expired one', async () => {
    let calls = 0;
    const fn = async () => ({ n: ++calls });
    const a = await operations.runOperation(h.deps, h.tenantId, { kind: 't', idempotencyKey: 'op-1' }, fn);
    const b = await operations.runOperation(h.deps, h.tenantId, { kind: 't', idempotencyKey: 'op-1' }, fn);
    expect(a).toMatchObject({ status: 'completed', reused: false });
    expect(b).toMatchObject({ status: 'completed', reused: true, result: { n: 1 } });
    await tx((t) => t.insert(growthOperations).values({ tenantId: h.tenantId, kind: 't', idempotencyKey: 'op-live', status: 'running', leaseUntil: new Date(h.clock.now().getTime() + 60_000) }));
    expect((await operations.runOperation(h.deps, h.tenantId, { kind: 't', idempotencyKey: 'op-live' }, fn)).status).toBe('skipped');
    await tx((t) => t.insert(growthOperations).values({ tenantId: h.tenantId, kind: 't', idempotencyKey: 'op-dead', status: 'running', leaseUntil: new Date(h.clock.now().getTime() - 60_000) }));
    expect(await operations.runOperation(h.deps, h.tenantId, { kind: 't', idempotencyKey: 'op-dead' }, fn)).toMatchObject({ status: 'completed', reused: false });
    expect(calls).toBe(2);
  });

  it('stops all new work, cancels queued tasks and needs an admin with MFA to release', async () => {
    const stop = await tx((t) => gw.emergencyStop(t, h.tenantId, h.users.operator, 'incident drill'));
    expect(stop.cancelled.tasks).toBeGreaterThan(0);
    expect((await errorOf(tx((t) => settings.requireFeature(t, h.tenantId, 'F1')))).code).toBe('EMERGENCY_STOP');
    expect(await gw.tick(h.deps, h.tenantId)).toEqual({ skipped: 'emergency stop' });
    const open = await tx((t) => t.execute<{ n: number }>(sql`select count(*)::int as n from growth_channel_tasks where status in ('planned','ready','submitted','awaiting_approval')`));
    expect(open.rows[0]!.n).toBe(0);
    const s = stop.settings;
    expect((await errorOf(tx((t) => settings.releaseEmergencyStop(t, h.tenantId, noMfa(h.users.admin), s.version)))).code).toBe('MFA_REQUIRED');
    const released = await tx((t) => settings.releaseEmergencyStop(t, h.tenantId, h.users.admin, s.version));
    expect(released.emergencyStop).toBe(false);
    expect((await tx((t) => t.execute<{ n: number }>(sql`select count(*)::int as n from kill_switches where engaged and target_ref = 'growth-warfare'`))).rows[0]!.n).toBe(0);
    const room = await tx((t) => gw.controlRoom(t, h.deps, h.tenantId, brandId));
    expect(room.readiness.aiVisibilityProvider).toBe('manual_import_only');
    expect(room.counts.memory).toBeGreaterThan(0);
    void growthChannelTasks;
    void growthOpportunities;
    void customerEvents;
  });
});
