import { randomBytes } from 'node:crypto';
import { claims, competitorObservations, competitors, type DbOrTx, evidenceRecords, growthCampaigns, growthOpportunities, growthSignals, offers, type Tx } from '@futuregrow/db';
import { conflict, forbidden, invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { type Actor, actorRef } from '../../deps.js';
import { record, requireMfa, requireRole } from '../../util.js';
import { getBrand } from '../brands/index.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { effectiveFreshness } from '../m23-execution/facts.js';
import { channelReadiness } from './channels.js';
import { getBrandConfig, requireFeature, requireOperator, type Settings } from './settings.js';

/**
 * F2 Competitor Conquest Forge (D-054). Turns one verified competitor (or switching-intent)
 * opportunity into a complete, reviewable campaign package. Composition is deterministic: every
 * statement about the brand is an approved, unexpired claim; every statement about a competitor
 * is a primary ('P') observation with current evidence and an as-of date. Unknowns stay unknown.
 * Nothing here publishes or spends: channel execution happens per task through M23 (F3).
 */
const DAY = 86_400_000;
const F2_KINDS = ['competitor_price_change', 'competitor_feature_change', 'competitor_packaging_change', 'competitor_positioning_change', 'competitor_availability_change', 'competitor_policy_change', 'switching_intent'];

export interface CopyFinding {
  code: string;
  detail: string;
}

/** Conquest-specific guards on top of M03 copy lint: impersonation, disparagement, unbacked discounts or comparatives. */
export function conquestCopyCheck(text: string, ctx: { competitorNames: string[]; hasApprovedOffer: boolean; comparativeClaims: string[] }): CopyFinding[] {
  const out: CopyFinding[] = [];
  const lower = text.toLowerCase();
  for (const name of ctx.competitorNames) {
    const n = name.toLowerCase();
    if (!n || !lower.includes(n)) continue;
    if (new RegExp(`(official|authori[sz]ed|partner|endorsed|certified|approved)\\s+(by\\s+)?${escapeRe(n)}|${escapeRe(n)}\\s+(official|team|support|partner)|from\\s+${escapeRe(n)}`, 'i').test(text)) out.push({ code: 'IMPERSONATION', detail: `copy implies an affiliation with ${name}` });
  }
  if (/\b(scam|fraud|fake|worst|useless|rip-?off|cheat(ing)?|unreliable|terrible|garbage|dying|bankrupt)\b/i.test(text)) out.push({ code: 'DISPARAGEMENT', detail: 'copy disparages instead of stating verified facts' });
  if (/\b(\d+\s?%\s?off|discount|free|save\s+\d|cheaper|lowest price|half price|deal)\b/i.test(text) && !ctx.hasApprovedOffer) out.push({ code: 'UNBACKED_OFFER', detail: 'copy mentions a discount, saving or free offer, but there is no approved offer' });
  if (/\b(better than|faster than|cheaper than|more than|#\s?1|number one|best|leading)\b/i.test(text) && !ctx.comparativeClaims.some((c) => lower.includes(c.toLowerCase().slice(0, 40)))) out.push({ code: 'UNBACKED_COMPARATIVE', detail: 'comparative or superlative wording without an approved comparative claim' });
  return out;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Fact {
  observationId: string;
  competitorId: string;
  competitor: string;
  kind: string;
  summary: string;
  details: Record<string, unknown>;
  observedAt: string;
  evidenceIds: string[];
}

async function verifiedFacts(t: DbOrTx, competitorIds: string[], now: Date): Promise<Fact[]> {
  if (!competitorIds.length) return [];
  const rows = await t
    .select({ o: competitorObservations, name: competitors.name })
    .from(competitorObservations)
    .innerJoin(competitors, eq(competitors.id, competitorObservations.competitorId))
    .where(and(inArray(competitorObservations.competitorId, competitorIds), eq(competitorObservations.evidenceFlag, 'P'), gte(competitorObservations.observedAt, new Date(now.getTime() - 90 * DAY))))
    .orderBy(desc(competitorObservations.observedAt))
    .limit(60);
  const evIds = [...new Set(rows.flatMap((r) => r.o.evidenceIds))];
  const ev = evIds.length ? await t.select().from(evidenceRecords).where(inArray(evidenceRecords.id, evIds)) : [];
  const current = new Set(ev.filter((e) => e.status === 'admitted' && (!e.expiresAt || e.expiresAt > now) && effectiveFreshness(e, now) !== 'stale').map((e) => e.id));
  return rows
    .map(({ o, name }) => ({ observationId: o.id, competitorId: o.competitorId, competitor: name, kind: o.kind, summary: o.summary, details: o.details, observedAt: o.observedAt.toISOString(), evidenceIds: o.evidenceIds.filter((x) => current.has(x)) }))
    .filter((f) => f.evidenceIds.length > 0 && f.kind !== 'gap');
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );
const overlap = (a: string, b: string) => {
  const wa = words(a);
  return [...words(b)].filter((w) => wa.has(w)).length;
};

function priceOf(details: Record<string, unknown>): { amount: number; currency: string | null; period: string | null } | null {
  const v = details.price ?? details.newPrice ?? details.after;
  const amount = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  if (amount === null) return null;
  return { amount, currency: typeof details.currency === 'string' ? details.currency : null, period: typeof details.period === 'string' ? details.period : null };
}

export async function buildConquestPackage(t: Tx, deps: { clock: { now(): Date } }, _tenantId: string, opportunityId: string, s: Settings) {
  const now = deps.clock.now();
  const [opp] = await t.select().from(growthOpportunities).where(eq(growthOpportunities.id, opportunityId));
  if (!opp) throw notFound('opportunity');
  const [signal] = await t.select().from(growthSignals).where(eq(growthSignals.id, opp.signalId));
  if (!signal) throw notFound('signal');
  if (!F2_KINDS.includes(opp.kind)) throw invalid(`a conquest campaign needs a competitor change or switching-intent opportunity (this one is ${opp.kind.replaceAll('_', ' ')})`);
  if (!['new', 'reviewing', 'accepted', 'converted'].includes(opp.status)) throw invalid(`the opportunity is ${opp.status}`);
  if (signal.status !== 'active') throw invalid(`the signal is ${signal.status}; stale or rejected evidence cannot back a campaign`);
  const b = await getBrand(t, opp.brandId);
  const { config } = await getBrandConfig(t, opp.brandId);
  const competitorId = typeof signal.metrics.competitorId === 'string' ? signal.metrics.competitorId : null;
  const names = config.competitorIds.length ? await t.select({ id: competitors.id, name: competitors.name }).from(competitors).where(inArray(competitors.id, config.competitorIds)) : [];
  const target = competitorId ? names.filter((n) => n.id === competitorId) : names.filter((n) => signal.subject.toLowerCase().includes(n.name.toLowerCase()));
  const facts = await verifiedFacts(
    t,
    (target.length ? target : names).map((n) => n.id),
    now,
  );
  const claimRows = b.approvedClaims.length
    ? await t
        .select()
        .from(claims)
        .where(
          and(
            inArray(
              claims.id,
              b.approvedClaims.map((c) => c.id),
            ),
            eq(claims.status, 'approved'),
          ),
        )
    : [];
  const usable = claimRows.filter((c) => !c.expiresAt || c.expiresAt > now);
  const blockers: string[] = [];
  if (!usable.length) blockers.push('The brand has no approved, unexpired claims (Knowledge › Claims). Without them no own-brand statement can be made.');
  if (!facts.length) blockers.push('No competitor observation with current primary evidence; comparison content needs current evidence.');
  const comparative = usable.filter((c) => c.claimType === 'comparative').map((c) => c.text);
  const offerRows = await t.select().from(offers).where(eq(offers.status, 'approved'));
  const liveOffers = offerRows.filter((o) => (!o.endsAt || o.endsAt > now) && (!o.startsAt || o.startsAt <= now));
  const audience = typeof b.profile.audience === 'object' && b.profile.audience ? (b.profile.audience as Record<string, unknown>) : {};
  const competitorNames = names.map((n) => n.name);
  const primary = target[0]?.name ?? facts[0]?.competitor ?? 'the alternative';
  const code = `gw${randomBytes(4).toString('hex')}`;

  // Differentiation: pair each verified competitor fact with the approved claim that addresses it.
  const differentiation = facts.slice(0, 8).flatMap((f) => {
    const best = usable.map((c) => ({ c, score: overlap(f.summary, c.text) + (f.kind === 'price_change' && c.claimType === 'price' ? 3 : 0) + (f.kind.startsWith('feature') && c.claimType === 'product_capability' ? 1 : 0) })).sort((a, b) => b.score - a.score)[0];
    if (!best) return [];
    return [
      {
        competitorFact: { observationId: f.observationId, summary: f.summary, observedAt: f.observedAt, evidenceIds: f.evidenceIds },
        ownClaim: { claimId: best.c.id, text: best.c.text, evidenceIds: best.c.evidenceIds },
        angle: f.kind === 'price_change' ? 'value' : f.kind.startsWith('feature') ? 'capability' : 'positioning',
        fit: best.score > 0 ? 'topic overlap' : 'general (no topic overlap; a person should confirm relevance)',
      },
    ];
  });
  const valueProps = usable.slice(0, 6).map((c) => ({ claimId: c.id, text: c.text, claimType: c.claimType, evidenceIds: c.evidenceIds, expiresAt: c.expiresAt?.toISOString() ?? null }));
  const headline = valueProps[0]?.text ?? null;
  const landingUrl = config.landingUrl ? `${config.landingUrl}${config.landingUrl.includes('?') ? '&' : '?'}utm_source=futuregrow&utm_medium=landing&utm_campaign=${code}` : null;

  // Comparison page: only verified rows; our cell is an approved claim, theirs a dated observation.
  const rows = differentiation.map((d) => ({ attribute: d.angle, ours: d.ownClaim.text, oursEvidence: d.ownClaim.evidenceIds, theirs: d.competitorFact.summary, theirsAsOf: d.competitorFact.observedAt.slice(0, 10), theirsEvidence: d.competitorFact.evidenceIds }));
  const comparisonMarkdown = [
    `# ${b.brand.name} and ${primary}: a factual comparison`,
    `_As of ${now.toISOString().slice(0, 10)}. Competitor details come from ${primary}'s own public pages on the dates shown; ${b.brand.name} statements are approved claims with evidence._`,
    '',
    '| Topic | ' + b.brand.name + ' | ' + primary + ' (as observed) |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.attribute} | ${r.ours} | ${r.theirs} (${r.theirsAsOf}) |`),
    '',
    '## Methodology',
    `Each ${primary} entry is a primary observation of an approved public source; entries older than 90 days or with expired evidence are left out. ${primary} may have changed since. ${b.brand.name} entries are claims approved in Knowledge and expire with their evidence.`,
    '',
    `${primary} is a trademark of its owner. This page is not affiliated with or endorsed by ${primary}.`,
  ].join('\n');

  const capability = usable.filter((c) => c.claimType === 'product_capability');
  const switchingGuide = capability.length
    ? { steps: capability.slice(0, 5).map((c, i) => ({ step: i + 1, text: c.text, claimId: c.id })), note: 'Steps are approved capability claims; a person adds screenshots and links before publishing.' }
    : { steps: [], note: 'No approved capability claim describes moving over. Add an approved claim (e.g. how a new customer starts) before a switching guide can be published.' };

  const price = facts.map((f) => ({ f, p: priceOf(f.details) })).find((x) => x.p);
  // The own list price is not stored as a verified fact anywhere; the operator enters it with its source.
  const ownPrice = null;
  const calculator = {
    template: 'cost_saving',
    formula: 'saving_per_period = competitor_price − own_price (same billing period and currency)',
    inputs: [
      { key: 'competitor_price', value: price?.p?.amount ?? null, currency: price?.p?.currency ?? null, period: price?.p?.period ?? null, source: price ? { observationId: price.f.observationId, observedAt: price.f.observedAt, evidenceIds: price.f.evidenceIds } : null },
      { key: 'own_price', value: ownPrice, source: null },
    ],
    missingInputs: [...(price ? [] : ['competitor_price (no observed price with evidence)']), 'own_price (enter the current list price with its source on the acquisition tool)'],
    ready: false,
    note: 'Specification only. It becomes a live tool (F4) once both prices are entered with sources and a person publishes it.',
  };

  const adProposals = [
    {
      channel: 'paid_ads',
      kind: 'competitor_keyword',
      keywords: target.length ? [`${primary} alternative`, `${primary} vs ${b.brand.name}`] : [],
      matchType: 'phrase',
      adText: { headline: headline ? headline.slice(0, 30) : null, description: valueProps[1]?.text?.slice(0, 90) ?? null },
      competitorNameInAdText: false,
      trademarkReview: 'required',
      policyNotes: ['Bidding on a competitor term is a keyword choice; the trademark is never used in ad text without the owner’s authorization.', 'Google Ads and Meta trademark policies apply; legal reviews the keyword list before any spend.'],
      budgetMicros: 0,
      requiresApproval: true,
      executable: s.controls.paidOperations && s.controls.adSpendLimitMicros > 0,
      executionPath: 'Ads › Campaign creation (M17) creates PAUSED campaigns only, each approved by a person via M23.',
    },
  ];

  const copyText = [headline, ...valueProps.map((v) => v.text)].filter(Boolean).join('\n');
  const guard = conquestCopyCheck(copyText, { competitorNames, hasApprovedOffer: liveOffers.length > 0, comparativeClaims: comparative });
  const lint = await lintCopy(t, copyText || '-', { claimIds: valueProps.map((v) => v.claimId), now });
  const readiness = await channelReadiness(t, deps, opp.brandId, s);
  const conversionGoals = (config.conversionEvents.length ? config.conversionEvents : []).map((ev) => ({
    event: ev,
    metric: `count of ${ev} events carrying utm_campaign=${code}`,
    attribution: 'first-party events (M02) tagged with the campaign code; observational unless a Darwin experiment randomizes exposure',
    target: null,
  }));
  const approvalRequirements = [
    { code: 'campaign_review', who: ['owner', 'admin', 'approver'], why: 'A person other than the author signs off the package.' },
    ...(rows.length ? [{ code: 'legal_trademark_review', who: ['legal_approver', 'owner'], why: `The comparison page names ${primary}.` }] : []),
    { code: 'm23_per_action', who: ['M23 policy'], why: 'Each external action (post, email, ad) is approved and verified separately by the execution gateway.' },
    ...(adProposals[0]!.keywords.length ? [{ code: 'paid_authorization', who: ['finance_approver', 'owner'], why: 'Competitor-keyword ads would spend money; nothing is created without explicit paid authorization.' }] : []),
  ];
  const pkg = {
    schema: 'conquest/1',
    generatedAt: now.toISOString(),
    campaignCode: code,
    opportunity: { id: opp.id, title: opp.title, reason: opp.reason, score: opp.score },
    competitor: target[0] ? { id: target[0].id, name: target[0].name } : null,
    verifiedCompetitorFacts: facts,
    approvedClaims: valueProps,
    differentiation,
    switchingConcepts: differentiation.slice(0, 3).map((d, i) => ({ name: `Switch concept ${i + 1}: ${d.angle}`, message: d.ownClaim.text, respondsTo: d.competitorFact.summary, claimIds: [d.ownClaim.claimId], observationIds: [d.competitorFact.observationId] })),
    alternativePositioning: { statement: headline ? `${b.brand.name}: ${headline}` : null, basis: 'first approved claim; positions the brand on its own strengths without naming the competitor' },
    targetAudience: { brandAudience: audience, intent: opp.kind === 'switching_intent' ? `people searching “${signal.subject}”` : `people evaluating ${primary} after: ${signal.subject}`, market: config.market },
    landingPage: {
      url: landingUrl,
      headline,
      subhead: valueProps[1]?.text ?? null,
      sections: [
        { title: 'Why people choose us', items: valueProps.map((v) => v.text) },
        { title: 'How to get started', items: switchingGuide.steps.map((x) => x.text) },
      ],
      cta: { label: 'Get started', url: landingUrl },
    },
    comparisonPage: { markdown: rows.length ? comparisonMarkdown : null, rows, asOf: now.toISOString().slice(0, 10) },
    switchingGuide,
    costSavingCalculator: calculator,
    adProposals,
    conversionExperiments: [{ area: 'landing_page', hypothesis: `Leading with “${headline ?? 'the strongest approved claim'}” converts more ${primary}-intent visitors than the current page.`, kpi: config.conversionEvents[0] ?? null }],
    channelReadiness: readiness,
    compliance: { copyGuard: guard, copyLint: { passed: lint.passed, violations: lint.violations } },
    blockers,
  };
  return { opp, brand: b.brand, pkg, code, evidenceIds: [...new Set([...signal.evidenceIds, ...facts.flatMap((f) => f.evidenceIds)])], claimIds: valueProps.map((v) => v.claimId), approvalRequirements, conversionGoals, ready: blockers.length === 0 && guard.length === 0 && lint.passed };
}

/** Create (or return the existing) conquest campaign for an opportunity. Idempotent per opportunity. */
export async function prepareConquest(t: Tx, deps: { clock: { now(): Date } }, tenantId: string, actor: Actor, opportunityId: string) {
  requireOperator(actor, 'preparing conquest campaigns');
  const [o] = await t.select({ brandId: growthOpportunities.brandId }).from(growthOpportunities).where(eq(growthOpportunities.id, opportunityId));
  if (!o) throw notFound('opportunity');
  const s = await requireFeature(t, tenantId, 'F2', o.brandId);
  const [existing] = await t
    .select()
    .from(growthCampaigns)
    .where(and(eq(growthCampaigns.opportunityId, opportunityId), eq(growthCampaigns.kind, 'conquest')));
  if (existing) return { campaign: existing, created: false };
  const open = await t.execute<{ n: number }>(sql`select count(*)::int as n from growth_campaigns where brand_id = ${o.brandId} and status in ('draft','ready_for_review','approved','in_flight')`);
  if ((open.rows[0]?.n ?? 0) >= s.effective.maxConcurrentCampaigns) throw conflict(`${open.rows[0]?.n} campaigns are already open for this brand (limit ${s.effective.maxConcurrentCampaigns} at ${s.aggression})`);
  const built = await buildConquestPackage(t, deps, tenantId, opportunityId, s);
  const [row] = await t
    .insert(growthCampaigns)
    .values({
      tenantId,
      brandId: o.brandId,
      opportunityId,
      kind: 'conquest',
      title: `Conquest: ${built.opp.title}`.slice(0, 300),
      status: built.ready ? 'ready_for_review' : 'blocked',
      package: built.pkg as unknown as Record<string, unknown>,
      evidenceIds: built.evidenceIds,
      claimIds: built.claimIds,
      approval: { required: built.approvalRequirements, acknowledged: [], approvedBy: null, approvedAt: null },
      goals: built.conversionGoals,
      expiresAt: built.opp.expiresAt,
      createdBy: actorRef(actor),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [again] = await t
      .select()
      .from(growthCampaigns)
      .where(and(eq(growthCampaigns.opportunityId, opportunityId), eq(growthCampaigns.kind, 'conquest')));
    return { campaign: again!, created: false };
  }
  await t.update(growthOpportunities).set({ status: 'converted', campaignId: row.id, updatedAt: new Date() }).where(eq(growthOpportunities.id, opportunityId));
  await record(t, tenantId, actor, 'growth.campaign.prepared', { type: 'growth_campaign', id: row.id }, { kind: 'conquest', opportunityId, ready: built.ready, blockers: built.pkg.blockers });
  return { campaign: row, created: true };
}

/**
 * Approve a campaign package: a different person than its author, with a second factor, after
 * re-checking that every cited fact is still backed by current evidence and every claim is still
 * approved. Approval never publishes; it only lets channel tasks be submitted to M23.
 */
export async function approveCampaign(t: Tx, tenantId: string, actor: Actor, id: string, input: { expectedVersion: number; acknowledge?: string[] }, now: Date) {
  requireRole(actor, ['owner', 'admin', 'approver'], 'approving growth campaigns');
  requireMfa(actor, 'approving growth campaigns');
  const [c] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, id)).for('update');
  if (!c) throw notFound('campaign');
  await requireFeature(t, tenantId, kindFeature(c.kind), c.brandId);
  if (c.version !== input.expectedVersion) throw conflict('the campaign changed since you loaded it; reload and review again');
  if (c.status !== 'ready_for_review') throw invalid(`the campaign is ${c.status.replaceAll('_', ' ')}`);
  if (c.createdBy === actorRef(actor)) throw forbidden('the author of a campaign cannot approve it');
  const required = ((c.approval as { required?: { code: string }[] }).required ?? []).map((r) => r.code);
  if (required.includes('legal_trademark_review') && !(input.acknowledge ?? []).includes('legal_trademark_review')) throw invalid('confirm the trademark/legal review of the comparison content (acknowledge legal_trademark_review)');
  const ev = c.evidenceIds.length ? await t.select().from(evidenceRecords).where(inArray(evidenceRecords.id, c.evidenceIds)) : [];
  const stale = ev.filter((e) => e.status !== 'admitted' || (e.expiresAt && e.expiresAt <= now) || effectiveFreshness(e, now) === 'stale');
  const cl = c.claimIds.length ? await t.select().from(claims).where(inArray(claims.id, c.claimIds)) : [];
  const unusable = cl.filter((x) => x.status !== 'approved' || (x.expiresAt && x.expiresAt <= now));
  if (stale.length || unusable.length) {
    await t
      .update(growthCampaigns)
      .set({ status: 'blocked', version: c.version + 1, approval: { ...c.approval, blockedAt: now.toISOString(), staleEvidence: stale.map((e) => e.id), unusableClaims: unusable.map((x) => x.id) }, updatedAt: now })
      .where(eq(growthCampaigns.id, id));
    throw conflict(`evidence or claims are no longer current (${stale.length} evidence, ${unusable.length} claims); rebuild the package`);
  }
  await t
    .update(growthCampaigns)
    .set({ status: 'approved', version: c.version + 1, approval: { ...c.approval, acknowledged: input.acknowledge ?? [], approvedBy: actorRef(actor), approvedAt: now.toISOString() }, updatedAt: now })
    .where(eq(growthCampaigns.id, id));
  await record(t, tenantId, actor, 'growth.campaign.approved', { type: 'growth_campaign', id }, { kind: c.kind, acknowledged: input.acknowledge ?? [] });
  const [row] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, id));
  return row!;
}

export function kindFeature(kind: string): 'F2' | 'F3' | 'F4' | 'F5' {
  return kind === 'conquest' ? 'F2' : kind === 'capture' ? 'F4' : kind === 'rescue' || kind === 'referral' ? 'F5' : 'F3';
}
