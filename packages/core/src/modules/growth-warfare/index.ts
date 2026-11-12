import { acquisitionTools, auditLog, connections, type DbOrTx, growthCampaigns, growthChannelTasks, growthExperimentPlans, growthOpportunities, growthSignals, growthStrategyMemory, modelRegistry, type Tx, withTenant } from '@futuregrow/db';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { getAiBudget } from '../../ai-budget.js';
import type { Actor, CoreDeps } from '../../deps.js';
import { cancelQueuedWork, planChannelTasks, prepareBlitz, syncCampaignOutcomes } from './blitz.js';
import { channelReadiness } from './channels.js';
import { prepareConquest } from './conquest.js';
import { growthAiSpend } from './copy.js';
import { brainContext, recommendFollowUps, syncLearning, tacticPriorities } from './darwin.js';
import { listOperations, runOperation } from './operations.js';
import { AGGRESSION_PROFILES, engageEmergencyStop, FEATURE_INFO, featureActive, getBrandConfig, getSettings, workingBrandIds } from './settings.js';
import { GW_ACTOR, listOpportunities, scanTenant } from './signals.js';

/**
 * Growth Warfare OS (D-054): F1–F6 as one policy-bounded layer over the existing modules. It adds
 * no second brain, gateway or website: market signals come from M04/M05/M18/M02, campaigns reuse
 * M03 claims and lint, M16/M20/M22 channels and the M23 execution gateway, experiments are M10
 * experiments, and the Autopilot reads its findings inside its existing research/ideas/learn steps.
 */
export * as blitz from './blitz.js';
export * as capture from './capture.js';
export * as channels from './channels.js';
export * as conquest from './conquest.js';
export * as copy from './copy.js';
export * as darwin from './darwin.js';
export * as operations from './operations.js';
export * as rescue from './rescue.js';
export * as settings from './settings.js';
export * as signals from './signals.js';

const count = async (t: DbOrTx, table: typeof growthSignals | typeof growthOpportunities | typeof growthCampaigns | typeof growthChannelTasks | typeof growthExperimentPlans, brandId?: string) => {
  const rows = await t
    .select({ status: table.status, n: sql<number>`count(*)::int` })
    .from(table)
    .where(brandId ? eq(table.brandId, brandId) : undefined)
    .groupBy(table.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
};

/** Everything the Control Room shows, read in one tenant transaction. */
export async function controlRoom(t: DbOrTx, deps: Pick<CoreDeps, 'clock' | 'config' | 'models'>, tenantId: string, brandId?: string | null) {
  const now = deps.clock.now();
  const s = await getSettings(t, tenantId);
  const brandRows = await t.execute<{ id: string; name: string; slug: string; status: string }>(sql`select id, name, slug, status from brands where status <> 'archived' order by name`);
  const working = new Set(await workingBrandIds(t, s));
  const selected = brandId ?? brandRows.rows.find((b) => working.has(b.id))?.id ?? null;
  const [models] = await t
    .select({ n: sql<number>`count(*)::int` })
    .from(modelRegistry)
    .where(and(eq(modelRegistry.approvedForProduction, true), eq(modelRegistry.status, 'active')));
  const [sc] = await t
    .select({ n: sql<number>`count(*)::int` })
    .from(connections)
    .where(and(eq(connections.provider, 'search_console'), eq(connections.status, 'active')));
  const spend = await growthAiSpend(t, now);
  const ai = await getAiBudget(t, tenantId, deps.config, now);
  const verified = await t.execute<{ verified: number; conversions: number }>(sql`
    select count(*) filter (where status in ('verified', 'done_by_human', 'executed'))::int as verified, coalesce(sum((outcome->>'conversions')::int), 0)::int as conversions
    from growth_channel_tasks ${selected ? sql`where brand_id = ${selected}` : sql``}`);
  return {
    settings: s,
    features: Object.fromEntries(Object.entries(FEATURE_INFO).map(([k, v]) => [k, { ...v, on: s.features[k as keyof typeof s.features] }])),
    aggressionProfiles: AGGRESSION_PROFILES,
    brands: brandRows.rows.map((b) => ({ ...b, working: working.has(b.id) })),
    brandId: selected,
    brandConfig: selected ? await getBrandConfig(t, selected) : null,
    counts: {
      signals: await count(t, growthSignals, selected ?? undefined),
      opportunities: await count(t, growthOpportunities, selected ?? undefined),
      campaigns: await count(t, growthCampaigns, selected ?? undefined),
      tasks: await count(t, growthChannelTasks, selected ?? undefined),
      plans: await count(t, growthExperimentPlans, selected ?? undefined),
      tools: Object.fromEntries(
        (
          await t
            .select({ status: acquisitionTools.status, n: sql<number>`count(*)::int` })
            .from(acquisitionTools)
            .where(selected ? eq(acquisitionTools.brandId, selected) : undefined)
            .groupBy(acquisitionTools.status)
        ).map((r) => [r.status, r.n]),
      ),
      memory:
        (
          await t
            .select({ n: sql<number>`count(*)::int` })
            .from(growthStrategyMemory)
            .where(selected ? eq(growthStrategyMemory.brandId, selected) : undefined)
        )[0]?.n ?? 0,
    },
    outcomes: { verifiedTasks: verified.rows[0]?.verified ?? 0, attributedConversions: verified.rows[0]?.conversions ?? 0, note: 'Counts of verified executions and first-party conversions carrying a campaign code. Attribution is observational; only Darwin experiments measure lift.' },
    readiness: {
      modelGateway: Boolean(deps.models),
      approvedModels: models?.n ?? 0,
      searchConsole: (sc?.n ?? 0) > 0,
      aiVisibilityProvider: 'manual_import_only',
      channels: selected ? await channelReadiness(t, deps, selected, s) : [],
      aiBudget: { tenant: ai, growthWarfare: { ...spend, dailyLimitUsd: s.controls.dailyAiBudgetUsd, monthlyLimitUsd: s.controls.monthlyAiBudgetUsd } },
      externalOperations: s.controls.externalOperations,
      paidOperations: s.controls.paidOperations,
    },
    priorities: selected ? await tacticPriorities(t, selected) : [],
    followUps: selected ? await recommendFollowUps(t, selected) : [],
    generatedAt: now.toISOString(),
  };
}

/** Execution history: Growth Warfare audit trail, M23 actions behind its tasks, operations. */
export async function executionHistory(t: DbOrTx, limit = 100) {
  const audit = await t
    .select()
    .from(auditLog)
    .where(or(like(auditLog.action, 'growth_warfare.%'), like(auditLog.action, 'growth.%')))
    .orderBy(desc(auditLog.occurredAt))
    .limit(limit);
  const tasks = await t.select({ refs: growthChannelTasks.refs }).from(growthChannelTasks).limit(500);
  const postIds = tasks.map((x) => (x.refs as { postId?: string }).postId).filter((x): x is string => Boolean(x));
  const actions = postIds.length
    ? await t.execute<{ id: string; action_type: string; status: string; created_at: string }>(
        sql`select id, action_type, status, created_at from action_requests where params->>'postId' in (${sql.join(
          postIds.map((p) => sql`${p}`),
          sql`, `,
        )}) order by created_at desc limit 100`,
      )
    : { rows: [] };
  return { audit, actions: actions.rows, operations: await listOperations(t, 50) };
}

/** Emergency stop: settings flag + M24 agent kill switch + cancel queued Growth Warfare work. */
export async function emergencyStop(t: Tx, tenantId: string, actor: Actor, reason: string) {
  const r = await engageEmergencyStop(t, tenantId, actor, reason);
  const cancelled = await cancelQueuedWork(t, tenantId, reason);
  return { ...r, cancelled };
}

/**
 * Scheduled tick (worker, every 15 min): F1 scans when due, F3 prepares (never submits) a blitz
 * for new high-urgency opportunities within the campaign cap, campaigns refresh their outcomes,
 * and F6 turns finished experiments into memory. Each switch is checked per tenant and brand.
 */
export async function tick(deps: CoreDeps, tenantId: string) {
  const s = await withTenant(deps.db, { tenantId, actor: 'system:growth-warfare' }, (t) => getSettings(t, tenantId));
  if (s.emergencyStop || !Object.values(s.features).some(Boolean)) return { skipped: s.emergencyStop ? 'emergency stop' : 'all features off' };
  const scan = s.features.F1 ? await scanTenant(deps, tenantId) : null;
  const prepared: string[] = [];
  if (s.features.F3) {
    const candidates = await withTenant(deps.db, { tenantId, actor: 'system:growth-warfare' }, async (t) => {
      const brands = await workingBrandIds(t, s);
      const rows = brands.length
        ? await t
            .select()
            .from(growthOpportunities)
            .where(and(inArray(growthOpportunities.brandId, brands), eq(growthOpportunities.status, 'new'), eq(growthOpportunities.urgency, 'high')))
            .orderBy(desc(growthOpportunities.score))
            .limit(5)
        : [];
      const out = [];
      for (const o of rows) if (await featureActive(t, tenantId, 'F3', o.brandId)) out.push(o);
      return out;
    });
    for (const o of candidates) {
      const r = await runOperation(deps, tenantId, { kind: 'blitz_prepare', idempotencyKey: `blitz:${o.id}`, brandId: o.brandId }, () =>
        withTenant(deps.db, { tenantId, actor: 'system:growth-warfare' }, async (t) => {
          const b = await prepareBlitz(t, deps, tenantId, GW_ACTOR, o.id);
          return { campaignId: b.campaign.id, created: b.created };
        }),
      );
      if (r.result?.campaignId) prepared.push(String(r.result.campaignId));
    }
  }
  const open = await withTenant(deps.db, { tenantId, actor: 'system:growth-warfare' }, (t) =>
    t
      .select({ id: growthCampaigns.id })
      .from(growthCampaigns)
      .where(inArray(growthCampaigns.status, ['approved', 'in_flight', 'ready_for_review']))
      .limit(50),
  );
  for (const c of open) await syncCampaignOutcomes(deps, tenantId, c.id);
  const learning = s.features.F6 ? await syncLearning(deps, tenantId) : null;
  return { skipped: null, scan, prepared, synced: open.length, learning };
}

/* ------------------------------------------------------------------ */
/* Autopilot integration (used by the existing cycle's steps)          */
/* ------------------------------------------------------------------ */

/**
 * What the Autopilot's research step adds for a brand: open opportunities (F1) and validated
 * findings (F6), only for features that are on. Read-only; nothing is prepared or sent here.
 */
export async function autopilotContext(t: DbOrTx, tenantId: string, brandId: string | null) {
  if (!brandId) return { active: false, opportunities: [], memory: [], lines: [] as string[] };
  const f1 = await featureActive(t, tenantId, 'F1', brandId);
  const f6 = await featureActive(t, tenantId, 'F6', brandId);
  const opps = f1 ? await listOpportunities(t, { brandId, status: ['new', 'reviewing', 'accepted'], limit: 5 }) : [];
  const memory = f6 ? await brainContext(t, brandId) : [];
  const lines = [...opps.map((o) => `[market signal, evidence ${o.signal.evidenceIds.slice(0, 2).join(', ')}] ${o.title} — ${o.reason} Suggested next step: ${(o.nextAction as { label?: string }).label ?? 'review'} (score ${o.score}, prioritisation aid only).`), ...memory];
  return { active: f1 || f6, opportunities: opps.map((o) => ({ id: o.id, title: o.title, score: o.score, urgency: o.urgency, nextAction: o.nextAction })), memory, lines };
}

/**
 * The learn step: refresh F6 memory, and for the top accepted opportunity prepare (never submit)
 * the package its next action calls for, within the feature switches and campaign cap.
 */
export async function autopilotLearn(deps: CoreDeps, tenantId: string, brandId: string | null): Promise<string[]> {
  if (!brandId) return [];
  const notes: string[] = [];
  const s = await withTenant(deps.db, { tenantId, actor: 'system:autopilot' }, (t) => getSettings(t, tenantId));
  if (s.features.F6 && !s.emergencyStop) {
    const r = await syncLearning(deps, tenantId, brandId);
    if (r.recorded) notes.push(`Growth Warfare recorded ${r.recorded} finding(s) in strategy memory (F6).`);
  }
  const [top] = await withTenant(deps.db, { tenantId, actor: 'system:autopilot' }, (t) =>
    t
      .select()
      .from(growthOpportunities)
      .where(and(eq(growthOpportunities.brandId, brandId), eq(growthOpportunities.status, 'accepted')))
      .orderBy(desc(growthOpportunities.score))
      .limit(1),
  );
  if (!top) return notes;
  const feature = (top.nextAction as { feature?: string }).feature;
  const r = await runOperation(deps, tenantId, { kind: 'autopilot_prepare', idempotencyKey: `autopilot-prepare:${top.id}`, brandId }, () =>
    withTenant(deps.db, { tenantId, actor: 'system:autopilot' }, async (t) => {
      if (feature === 'F2' && (await featureActive(t, tenantId, 'F2', brandId))) return { campaignId: (await prepareConquest(t, deps, tenantId, GW_ACTOR, top.id)).campaign.id, kind: 'conquest' };
      if (feature === 'F3' && (await featureActive(t, tenantId, 'F3', brandId))) return { campaignId: (await prepareBlitz(t, deps, tenantId, GW_ACTOR, top.id)).campaign.id, kind: 'blitz' };
      return { campaignId: null, kind: null };
    }),
  );
  if (r.result?.campaignId) notes.push(`Growth Warfare prepared a ${String(r.result.kind)} package for the accepted opportunity “${top.title}”; it waits for a person's approval in the Growth Warfare Control Room.`);
  else if (r.status === 'failed') notes.push(`Growth Warfare could not prepare a package for “${top.title}”: ${r.error}`);
  return notes;
}

export { cancelQueuedWork, planChannelTasks, prepareBlitz, prepareConquest, syncCampaignOutcomes };

/** The brand behind an Autopilot goal: the brand its Page belongs to, or the only active brand. */
export async function brandForGoal(t: DbOrTx, pageIds: string[]): Promise<string | null> {
  if (pageIds.length) {
    const r = await t.execute<{ brand_id: string }>(
      sql`select bc.brand_id from brand_channels bc join connections c on c.id = bc.connection_id where c.external_account_id in (${sql.join(
        pageIds.map((p) => sql`${p}`),
        sql`, `,
      )}) limit 1`,
    );
    if (r.rows[0]) return r.rows[0].brand_id;
  }
  const all = await t.execute<{ id: string }>(sql`select id from brands where status = 'active' limit 2`);
  return all.rows.length === 1 ? all.rows[0]!.id : null;
}

/** Context lines for prompts, from the research step's output (empty when features are off). */
export function contextLines(research: { output?: Record<string, unknown> } | undefined): string {
  const lines = ((research?.output?.growthWarfare as { lines?: string[] } | undefined)?.lines ?? []).slice(0, 12);
  return lines.length ? `\nGrowth Warfare context (market signals and recorded findings; prioritisation aids, not forecasts or guarantees):\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}
