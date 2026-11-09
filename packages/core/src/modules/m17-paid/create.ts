import { getActionType } from '@futuregrow/contracts';
import { actionRequests, assets, brands, connections, type DbOrTx, executions, paidCampaignDrafts, platformCapabilities, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, requireRole } from '../../util.js';
import { BrandProfileSchema } from '../brands/index.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { proposeAction } from '../m23-execution/gateway.js';

/**
 * Full paid campaign creation (P3-06). A draft holds the exact payload of
 * `ads.meta.create_campaign` / `ads.google.create_campaign`; saving it runs the business checks
 * (landing page is the brand's, copy lint, creative rights, budget within the brand's monthly ad
 * budget, adults only, tracking parameters); submitting proposes the action through M23, where
 * the SPEND policy requires a finance approver with two-factor, the capability registry must
 * allow creation (disabled by default, B-026), and kill switches apply. The campaign is created
 * PAUSED and verified by read-back; turning it on is a separate approved status change.
 */

const EDIT_ROLES = ['owner', 'admin', 'growth_operator'] as const;
const ACTION: Record<'meta' | 'google_ads', string> = { meta: 'ads.meta.create_campaign', google_ads: 'ads.google.create_campaign' };
const DAY = 86_400_000;

export const DraftInputSchema = z
  .object({
    platform: z.enum(['meta', 'google_ads']),
    connectionId: z.string().uuid(),
    brandId: z.string().uuid().nullable().default(null),
    name: z.string().trim().min(1).max(150),
    brief: z
      .object({ goal: z.string().trim().max(1000).default(''), audience: z.string().trim().max(1000).default(''), notes: z.string().trim().max(2000).default('') })
      .strict()
      .default({ goal: '', audience: '', notes: '' }),
    /** ISO countries the ads run in (policy and legal review use these). */
    geographies: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(25),
    evidenceIds: z.array(z.string().uuid()).max(20).default([]),
    /** The platform payload without draftId (added here). */
    spec: z.record(z.string(), z.unknown()),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

type Draft = typeof paidCampaignDrafts.$inferSelect;

/** Days the campaign can run (inclusive), from the platform's own date fields. */
export function campaignDays(platform: 'meta' | 'google_ads', spec: Record<string, unknown>): number {
  if (platform === 'meta') return Math.max(1, Math.ceil((Date.parse(String(spec.endTime)) - Date.parse(String(spec.startTime))) / DAY));
  return Math.max(1, Math.round((Date.parse(`${spec.endDate}T00:00:00Z`) - Date.parse(`${spec.startDate}T00:00:00Z`)) / DAY) + 1);
}

/** Business checks before anything reaches M23; every problem is stated so the draft can be fixed. */
async function draftProblems(t: DbOrTx, deps: CoreDeps, d: { platform: 'meta' | 'google_ads'; brandId: string | null; geographies: string[]; spec: Record<string, unknown> }): Promise<string[]> {
  const problems: string[] = [];
  const def = getActionType(ACTION[d.platform])!;
  const parsed = def.paramsSchema.safeParse(d.spec);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 12)) problems.push(`${i.path.join('.') || 'spec'}: ${i.message}`);
    return problems;
  }
  const s = parsed.data as Record<string, any>;
  const daily = s.dailyBudget as { amountMicros: number; currency: string };
  const cap = s.lifetimeCap as { amountMicros: number; currency: string };
  const days = campaignDays(d.platform, s);
  if (cap.amountMicros < daily.amountMicros * days) problems.push(`the lifetime cap (${cap.amountMicros / 1e6} ${cap.currency}) is below daily budget × ${days} days (${(daily.amountMicros * days) / 1e6} ${daily.currency}); raise the cap or shorten the campaign`);
  if (daily.amountMicros <= 0) problems.push('the daily budget must be above zero');
  const landing = d.platform === 'meta' ? String(s.creative.link) : String(s.ad.finalUrl);
  const copy = d.platform === 'meta' ? [s.creative.message, s.creative.headline].join('\n') : [...s.ad.headlines, ...s.ad.descriptions].join('\n');
  const tracking = d.platform === 'meta' ? String(s.urlTags ?? '') : String(s.ad.finalUrlSuffix ?? '');
  if (!/(^|&)utm_campaign=[^&]+/.test(tracking)) problems.push('tracking parameters must include utm_campaign so results can be attributed');
  if (d.brandId) {
    const [b] = await t.select().from(brands).where(eq(brands.id, d.brandId));
    if (!b) problems.push('brand not found');
    else {
      const profile = BrandProfileSchema.parse(b.profile ?? {});
      const origin = (u: string) => {
        try {
          return new URL(u).origin;
        } catch {
          return null;
        }
      };
      if (!profile.destinations.some((x) => origin(x.url) === origin(landing))) problems.push("the landing page is not one of the brand's destinations");
      if (profile.limits.monthlyAdBudgetUsd <= 0) problems.push('paid media is off for this brand (monthly ad budget is 0 in the brand profile)');
      else if (cap.currency === 'USD' && cap.amountMicros / 1e6 > profile.limits.monthlyAdBudgetUsd) problems.push(`the lifetime cap exceeds the brand's monthly ad budget of $${profile.limits.monthlyAdBudgetUsd}`);
    }
  } else problems.push('choose the brand the campaign advertises');
  const lint = await lintCopy(t, copy, { claimIds: (s.claimIds as string[]) ?? [], channel: d.platform === 'meta' ? 'facebook' : 'google_ads', now: deps.clock.now() });
  for (const v of lint.violations.filter((x) => x.severity === 'block')) problems.push(`${v.code}: ${v.message}${v.excerpt ? ` (“${clipText(v.excerpt, 60)}”)` : ''}`);
  if (d.platform === 'meta') {
    const [img] = await t.select().from(assets).where(eq(assets.id, s.creative.image.assetId));
    if (!img) problems.push('the creative image does not exist');
    else {
      if (img.sha256 !== s.creative.image.sha256) problems.push('the creative image changed since it was chosen; choose it again');
      if (!img.publishEligible) problems.push(`the creative image is not publish-eligible: ${img.eligibilityReasons.join('; ')}`);
    }
    const countries = (s.targeting.countries as string[]).slice().sort();
    if (countries.join(',') !== d.geographies.slice().sort().join(',')) problems.push('the targeted countries must equal the draft geographies');
  }
  return problems;
}

async function load(t: DbOrTx, id: string): Promise<Draft> {
  const [d] = await t.select().from(paidCampaignDrafts).where(eq(paidCampaignDrafts.id, id));
  if (!d) throw notFound('campaign draft');
  return d;
}

export async function saveCampaignDraft(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown, id?: string): Promise<Draft> {
  requireRole(actor, [...EDIT_ROLES], 'preparing a paid campaign');
  const input = DraftInputSchema.parse(raw);
  const [conn] = await t.select().from(connections).where(eq(connections.id, input.connectionId));
  if (!conn || conn.provider !== input.platform) throw invalid(`choose a connected ${input.platform === 'meta' ? 'Meta ad account' : 'Google Ads account'}`);
  const current = id ? await load(t, id) : null;
  if (current && current.status !== 'draft' && current.status !== 'failed') throw conflict(`the draft is ${current.status}; it can no longer be edited`);
  if (current && input.expectedVersion !== undefined && input.expectedVersion !== current.version) throw conflict('the draft changed in the meantime; reload and try again');
  const draftId = current?.id ?? crypto.randomUUID();
  const account = input.platform === 'meta' ? { adAccountId: `act_${String(conn.metadata.adAccountId ?? conn.externalAccountId).replace(/^act_/, '')}` } : { customerId: conn.externalAccountId.replaceAll('-', '') };
  const spec = { ...input.spec, ...account, draftId, name: input.name, disclosure: (input.spec.disclosure as object | undefined) ?? { isAiGenerated: false, paidPartnership: false, syntheticPersonaId: null, disclosureText: null } };
  const problems = await draftProblems(t, deps, { platform: input.platform, brandId: input.brandId, geographies: input.geographies, spec });
  const values = { platform: input.platform, connectionId: input.connectionId, brandId: input.brandId, name: input.name, brief: input.brief, geographies: input.geographies, evidenceIds: input.evidenceIds, spec, problems, status: 'draft', statusReason: null, updatedBy: actorRef(actor), updatedAt: deps.clock.now() };
  const [row] = current
    ? await t
        .update(paidCampaignDrafts)
        .set({ ...values, version: current.version + 1 })
        .where(and(eq(paidCampaignDrafts.id, current.id), eq(paidCampaignDrafts.version, current.version)))
        .returning()
    : await t
        .insert(paidCampaignDrafts)
        .values({ id: draftId, tenantId, ...values, createdBy: actorRef(actor) })
        .returning();
  if (!row) throw conflict('the draft changed in the meantime; reload and try again');
  await audit(t, tenantId, actor, current ? 'ads.campaign_draft.updated' : 'ads.campaign_draft.created', { type: 'paid_campaign_draft', id: row.id }, { platform: input.platform, problems: problems.length });
  return row;
}

/** Whether creation is enabled at all on this platform (capability registry, B-026). */
export async function creationEnabled(t: DbOrTx, platform: 'meta' | 'google_ads'): Promise<{ enabled: boolean; reason: string }> {
  const capability = getActionType(ACTION[platform])!.capability;
  const [cap] = await t.select().from(platformCapabilities).where(eq(platformCapabilities.capability, capability));
  return cap?.supported
    ? { enabled: true, reason: 'creation is enabled; every campaign still needs finance approval with two-factor' }
    : { enabled: false, reason: 'paid campaign creation is disabled until the owner authorizes it (B-026): payment method, spend limits, an ads token with ads_management or a Google Ads developer token with Basic access, then a platform operator enables the capability' };
}

/** Proposes the creation through M23. The draft's payload is what the approver signs (action hash). */
export async function submitCampaignDraft(deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, [...EDIT_ROLES], 'submitting a paid campaign');
  const d = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const d = await load(t, id);
    if (d.status !== 'draft' && d.status !== 'failed') throw conflict(`the draft is ${d.status}`);
    const problems = await draftProblems(t, deps, { platform: d.platform as 'meta' | 'google_ads', brandId: d.brandId, geographies: d.geographies, spec: d.spec });
    if (problems.length) throw invalid(`fix the draft first: ${problems.join('; ')}`);
    return d;
  });
  const cap = d.spec.lifetimeCap as { amountMicros: number; currency: string };
  // The full lifetime cap is the spend at risk, so no pre-authorization ceiling can let creation through unapproved.
  const action = await proposeAction(deps, tenantId, actor, {
    actionType: ACTION[d.platform as 'meta' | 'google_ads'],
    connectionId: d.connectionId,
    target: { draftId: d.id, name: d.name, brandId: d.brandId },
    params: d.spec,
    risk: { spendDeltaMicros: cap.amountMicros, currency: cap.currency, audienceSize: null, geographies: d.geographies, usesSensitiveAttributes: false, involvesChildren: false, syntheticPersonaId: null, materialConnection: false, regulatedClaim: false },
    evidenceIds: d.evidenceIds,
    // A resubmission after a refusal or failure is a new request (chained to the previous action); a double submit is the same one.
    idempotencyKey: `campaign-create:${d.id}:v${d.version}:${d.actionId ?? 'first'}`,
  });
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const denied = action.status === 'DENIED';
    const [row] = await t
      .update(paidCampaignDrafts)
      .set({ status: denied ? 'failed' : 'submitted', statusReason: denied ? `refused by policy: ${action.statusReason ?? ''}` : `waiting for ${action.status === 'APPROVAL_REQUIRED' ? 'finance approval with two-factor' : action.status}`, actionId: action.id, updatedAt: deps.clock.now() })
      .where(eq(paidCampaignDrafts.id, id))
      .returning();
    await audit(t, tenantId, actor, 'ads.campaign_draft.submitted', { type: 'paid_campaign_draft', id }, { actionId: action.id, status: action.status });
    return { draft: row!, action };
  });
}

/** Follows each submitted draft's action: VERIFIED → created (with the provider campaign id); refused, failed or cancelled → failed with the reason. */
export async function syncCampaignDrafts(t: Tx, tenantId: string): Promise<number> {
  const open = await t.select().from(paidCampaignDrafts).where(eq(paidCampaignDrafts.status, 'submitted'));
  if (!open.length) return 0;
  const actions = await t
    .select()
    .from(actionRequests)
    .where(inArray(actionRequests.id, open.map((d) => d.actionId!).filter(Boolean)));
  let n = 0;
  for (const d of open) {
    const a = actions.find((x) => x.id === d.actionId);
    if (!a) continue;
    if (a.status === 'VERIFIED') {
      const [ex] = await t.select().from(executions).where(eq(executions.actionId, a.id)).orderBy(desc(executions.attempt)).limit(1);
      await t
        .update(paidCampaignDrafts)
        .set({ status: 'created', statusReason: 'created PAUSED and verified by read-back; turn it on with an approved status change', externalCampaignId: ex?.providerObjectId ?? null, updatedAt: new Date() })
        .where(eq(paidCampaignDrafts.id, d.id));
      n++;
    } else if (['DENIED', 'FAILED', 'CANCELLED', 'REJECTED', 'ROLLED_BACK'].includes(a.status)) {
      await t
        .update(paidCampaignDrafts)
        .set({ status: 'failed', statusReason: `${a.status.toLowerCase()}: ${a.statusReason ?? ''}`.trim(), updatedAt: new Date() })
        .where(eq(paidCampaignDrafts.id, d.id));
      n++;
    } else if (a.status === 'ESCALATED' || a.status === 'EXECUTED_UNVERIFIED') {
      await t
        .update(paidCampaignDrafts)
        .set({ statusReason: `${a.status.toLowerCase().replaceAll('_', ' ')}: the provider state is being checked; nothing is retried blindly` })
        .where(eq(paidCampaignDrafts.id, d.id));
    }
  }
  if (n) await audit(t, tenantId, { type: 'system', id: 'paid-media', roles: [], mfaVerified: false }, 'ads.campaign_drafts.synced', { type: 'tenant', id: tenantId }, { moved: n });
  return n;
}

export async function cancelCampaignDraft(t: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, [...EDIT_ROLES], 'cancelling a campaign draft');
  const d = await load(t, id);
  if (d.status !== 'draft' && d.status !== 'failed') throw conflict(`the draft is ${d.status}; cancel its action in Approvals instead`);
  const [row] = await t
    .update(paidCampaignDrafts)
    .set({ status: 'cancelled', updatedBy: actorRef(actor), updatedAt: new Date() })
    .where(eq(paidCampaignDrafts.id, id))
    .returning();
  await audit(t, tenantId, actor, 'ads.campaign_draft.cancelled', { type: 'paid_campaign_draft', id }, {});
  return row!;
}

export async function listCampaignDrafts(t: Tx, tenantId: string) {
  await syncCampaignDrafts(t, tenantId);
  return t.select().from(paidCampaignDrafts).orderBy(desc(paidCampaignDrafts.updatedAt)).limit(200);
}
