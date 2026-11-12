import { createHash } from 'node:crypto';
import { AbstainError, type PromptDefinition, UNTRUSTED_DATA_POLICY, untrustedBlock } from '@futuregrow/agent-kernel';
import { claims, type DbOrTx, growthCampaigns, withTenant } from '@futuregrow/db';
import { conflict, notFound } from '@futuregrow/observability';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runAgent } from '../../agents.js';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { conquestCopyCheck, kindFeature } from './conquest.js';
import { requireFeature } from './settings.js';

/**
 * Optional model-written copy variants for a prepared campaign (F2/F3). Off unless the Growth
 * Warfare daily and monthly AI budgets are above zero; both are checked against the cost ledger
 * before the call, on top of the tenant-wide AI limit the gateway enforces. Every variant must
 * cite only the campaign's approved claims and pass M03 copy lint and the conquest copy guard;
 * failing variants are discarded with their reasons, never "fixed" silently.
 */
const SYSTEM = `You write short marketing copy variants for one brand campaign (FUTUREGROW Growth Warfare).
Rules:
- Use only the approved claims given. Each variant cites the claim IDs it uses; never state anything that is not in those claims.
- Never name, imitate or disparage a competitor, never imply an affiliation, never mention discounts, savings or "free" unless an approved claim states it, and never use superlatives or comparisons unless an approved claim states them.
- No urgency or scarcity that the claims do not state, no fake testimonials, no guaranteed results.
- Return at most the number of variants requested. If the claims are not enough to write honest copy, return no variants and explain in "abstain".`;
const full = `${SYSTEM}\n\n${UNTRUSTED_DATA_POLICY}`;
export const COPY_PROMPT: PromptDefinition = { name: 'growth.copy_variants', version: '1.0.0', system: full, hash: createHash('sha256').update(full).digest('hex') };

const OutputSchema = z.object({
  variants: z.array(z.object({ headline: z.string().min(1).max(120), body: z.string().min(1).max(600), claimIds: z.array(z.string()).min(1).max(5) })).max(5),
  abstain: z.string().max(500).nullable(),
});

/** Growth Warfare model spend today and this month (UTC), from the cost ledger. */
export async function growthAiSpend(t: DbOrTx, now: Date) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await t.execute<{ today: number; month: number; unpriced: number }>(sql`
    select coalesce(sum(c.amount_usd) filter (where c.occurred_at >= ${day}), 0)::float8 as today,
           coalesce(sum(c.amount_usd), 0)::float8 as month,
           count(*) filter (where c.amount_usd is null)::int as unpriced
    from cost_ledger c join agent_runs a on c.ref_type = 'agent_run' and c.ref_id = a.id::text
    where a.kind like 'growth_%' and c.occurred_at >= ${month}`);
  return { todayUsd: r.rows[0]?.today ?? 0, monthUsd: r.rows[0]?.month ?? 0, unpriced: r.rows[0]?.unpriced ?? 0 };
}

export async function aiCopyVariants(deps: CoreDeps, tenantId: string, actor: Actor, campaignId: string, opts: { variants?: number } = {}) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'requesting AI copy variants');
  const prep = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const [c] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, campaignId));
    if (!c) throw notFound('campaign');
    const s = await requireFeature(t, tenantId, kindFeature(c.kind), c.brandId);
    const spend = await growthAiSpend(t, deps.clock.now());
    if (s.controls.dailyAiBudgetUsd <= 0 || s.controls.monthlyAiBudgetUsd <= 0) throw conflict('Growth Warfare AI budgets are 0 (Growth settings); copy stays deterministic from approved claims');
    if (spend.unpriced > 0) throw conflict('unpriced Growth Warfare model calls make the AI budget unmeasurable');
    if (spend.todayUsd >= s.controls.dailyAiBudgetUsd) throw conflict(`daily Growth Warfare AI budget used ($${spend.todayUsd.toFixed(2)} of $${s.controls.dailyAiBudgetUsd.toFixed(2)})`);
    if (spend.monthUsd >= s.controls.monthlyAiBudgetUsd) throw conflict(`monthly Growth Warfare AI budget used ($${spend.monthUsd.toFixed(2)} of $${s.controls.monthlyAiBudgetUsd.toFixed(2)})`);
    const cl = c.claimIds.length ? await t.select().from(claims).where(inArray(claims.id, c.claimIds)) : [];
    const usable = cl.filter((x) => x.status === 'approved' && (!x.expiresAt || x.expiresAt > deps.clock.now()));
    if (!usable.length) throw conflict('the campaign cites no usable approved claim');
    const names = (await t.execute<{ name: string }>(sql`select name from competitors`)).rows.map((r) => r.name);
    return { c, usable, names };
  });
  const out = await runAgent(deps, tenantId, { kind: 'growth_copy', agentId: 'growth-warfare', triggeredBy: actorRef(actor), input: { campaignId } }, async (ctx) => {
    const r = await ctx.think('copy', COPY_PROMPT, {
      purpose: 'generation',
      messages: [{ role: 'user', content: `Write up to ${Math.min(5, opts.variants ?? 3)} variants.\n${untrustedBlock('approved_claims', JSON.stringify(prep.usable.map((x) => ({ id: x.id, text: x.text, type: x.claimType }))))}` }],
      outputSchema: OutputSchema,
      maxTokens: 900,
    });
    if (!r.output.variants.length) throw new AbstainError('INSUFFICIENT_EVIDENCE', r.output.abstain ?? 'no honest variant possible');
    return { variants: r.output.variants, model: r.servedBy };
  });
  if (out.status !== 'completed') return { status: out.status, reason: out.status === 'abstained' ? out.reason : out.error, kept: [], discarded: [] };
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const allowed = new Set(prep.usable.map((x) => x.id));
    const kept: unknown[] = [];
    const discarded: unknown[] = [];
    for (const v of out.result.variants) {
      const text = `${v.headline}\n${v.body}`;
      const foreign = v.claimIds.filter((id) => !allowed.has(id));
      const lint = await lintCopy(t, text, { claimIds: v.claimIds.filter((id) => allowed.has(id)), now: deps.clock.now() });
      const guard = conquestCopyCheck(text, { competitorNames: prep.names, hasApprovedOffer: false, comparativeClaims: [] });
      if (foreign.length || !lint.passed || guard.length) discarded.push({ ...v, reasons: [...(foreign.length ? ['cites claims outside the campaign'] : []), ...lint.violations.filter((x) => x.severity === 'block').map((x) => x.code), ...guard.map((g) => g.code)] });
      else kept.push({ ...v, model: out.result.model, runId: out.runId });
    }
    const pkg = prep.c.package as Record<string, unknown>;
    await t
      .update(growthCampaigns)
      .set({ package: { ...pkg, aiVariants: { generatedAt: deps.clock.now().toISOString(), runId: out.runId, kept, discarded } }, version: prep.c.version + 1, updatedAt: deps.clock.now() })
      .where(eq(growthCampaigns.id, campaignId));
    await audit(t, tenantId, actor, 'growth_warfare.copy.generated', { type: 'growth_campaign', id: campaignId }, { kept: kept.length, discarded: discarded.length, runId: out.runId });
    return { status: 'completed' as const, reason: null, kept, discarded };
  });
}
