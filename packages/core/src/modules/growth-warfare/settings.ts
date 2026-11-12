import { type DbOrTx, GW_AGGRESSION, GW_CHANNELS, GW_FEATURES, growthBrandConfigs, growthWarfareSettings, type Tx } from '@futuregrow/db';
import { conflict, FgError, notFound } from '@futuregrow/observability';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef } from '../../deps.js';
import { ADMIN_ROLES, audit, requireMfa, requireRole } from '../../util.js';
import { getBrand } from '../brands/index.js';
import { engageKillSwitch } from '../m24-governance/index.js';

/**
 * Growth Warfare OS (D-054) settings: one row per tenant with the F1–F6 switches, the aggression
 * level and the global controls, plus one config per brand. Every feature and every external or
 * paid operation starts OFF. OFF is enforced server-side by `requireFeature` in every service
 * entry point and by the scheduled jobs, never only in the UI.
 */
export type Feature = (typeof GW_FEATURES)[number];
export type Aggression = (typeof GW_AGGRESSION)[number];
export type Channel = (typeof GW_CHANNELS)[number];

export const FEATURE_INFO: Record<Feature, { name: string; summary: string; external: boolean }> = {
  F1: { name: 'Market Signal Hunter', summary: 'Evidence-backed demand and competitor-change signals scored into one review queue.', external: false },
  F2: { name: 'Competitor Conquest Forge', summary: 'Switching campaign packages built only from verified competitor facts and approved claims.', external: false },
  F3: { name: 'Growth Blitz & Distribution Mesh', summary: 'Coordinated channel tasks, community share kits and creator briefs; every external write goes through M23.', external: true },
  F4: { name: 'Search & Utility Capture Engine', summary: 'Working acquisition tools with real calculations and audited AI-search visibility observations.', external: true },
  F5: { name: 'Conversion Rescue & Viral Loops', summary: 'First-party funnel diagnosis, consent-aware recovery and verified referral loops.', external: true },
  F6: { name: 'Campaign Darwin Engine', summary: 'Experiment factory, validated learning and strategy memory the Growth Brain reads back.', external: false },
};

/** What each aggression level may do. Levels only change capacity and priority, never a gate. */
export const AGGRESSION_PROFILES: Record<Aggression, { maxParallelExperiments: number; campaignCap: number; minMonitoringHours: number; opportunityThreshold: number; channelQuotaCap: number; maxSignalsPerScan: number }> = {
  balanced: { maxParallelExperiments: 1, campaignCap: 2, minMonitoringHours: 24, opportunityThreshold: 0.6, channelQuotaCap: 1, maxSignalsPerScan: 50 },
  aggressive: { maxParallelExperiments: 3, campaignCap: 5, minMonitoringHours: 6, opportunityThreshold: 0.5, channelQuotaCap: 3, maxSignalsPerScan: 150 },
  maximum_authorized: { maxParallelExperiments: 5, campaignCap: 10, minMonitoringHours: 1, opportunityThreshold: 0.4, channelQuotaCap: 10, maxSignalsPerScan: 300 },
};

const ChannelQuotaSchema = z.object(Object.fromEntries(GW_CHANNELS.map((c) => [c, z.number().int().min(0).max(50).default(0)])) as Record<Channel, z.ZodDefault<z.ZodNumber>>);

export const ControlsSchema = z.object({
  /** Brands Growth Warfare works for; empty = every active brand. */
  brandIds: z.array(z.string().uuid()).max(50).default([]),
  /** Autopilot goal the work serves (optional). */
  activeGoalId: z.string().uuid().nullable().default(null),
  acquisitionGoal: z.string().max(500).nullable().default(null),
  maxConcurrentCampaigns: z.number().int().min(1).max(50).default(3),
  monitoringHours: z.number().int().min(1).max(168).default(24),
  /** Model spend Growth Warfare may cause (on top of the tenant's overall AI limit). 0 = no model calls. */
  dailyAiBudgetUsd: z.number().min(0).max(1000).default(0),
  monthlyAiBudgetUsd: z.number().min(0).max(10_000).default(0),
  /** Total advertising spend any Growth Warfare proposal may ask for. 0 = no paid proposals. */
  adSpendLimitMicros: z.number().int().min(0).default(0),
  adCurrency: z.string().length(3).default('USD'),
  channelQuotas: ChannelQuotaSchema.default(ChannelQuotaSchema.parse({})),
  /** always_human: nothing is handed to M23 without a person pressing Submit; policy: M23 policy decides. */
  approvalPreference: z.enum(['always_human', 'policy']).default('always_human'),
  /** Master switch for anything leaving FUTUREGROW (M23 submissions, public tools). */
  externalOperations: z.boolean().default(false),
  /** Master switch for proposals that ask for spend. */
  paidOperations: z.boolean().default(false),
});
export type Controls = z.infer<typeof ControlsSchema>;

export const SettingsPatchSchema = z.object({
  expectedVersion: z.number().int().min(1),
  features: z.partialRecord(z.enum(GW_FEATURES), z.boolean()).optional(),
  aggression: z.enum(GW_AGGRESSION).optional(),
  // Quotas patch per channel: naming one channel never resets the others.
  controls: ControlsSchema.partial()
    .extend({ channelQuotas: z.partialRecord(z.enum(GW_CHANNELS), z.number().int().min(0).max(50)).optional() })
    .optional(),
});

export interface Settings {
  tenantId: string;
  features: Record<Feature, boolean>;
  aggression: Aggression;
  controls: Controls;
  emergencyStop: boolean;
  emergencyReason: string | null;
  lastScanAt: string | null;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
  effective: ReturnType<typeof effectiveLimits>;
}

const OFF: Record<Feature, boolean> = { F1: false, F2: false, F3: false, F4: false, F5: false, F6: false };

export function effectiveLimits(aggression: Aggression, c: Controls) {
  const p = AGGRESSION_PROFILES[aggression];
  return {
    maxConcurrentCampaigns: Math.min(c.maxConcurrentCampaigns, p.campaignCap),
    maxParallelExperiments: p.maxParallelExperiments,
    monitoringHours: Math.max(c.monitoringHours, p.minMonitoringHours),
    opportunityThreshold: p.opportunityThreshold,
    maxSignalsPerScan: p.maxSignalsPerScan,
    channelQuotas: Object.fromEntries(GW_CHANNELS.map((ch) => [ch, Math.min(c.channelQuotas[ch] ?? 0, p.channelQuotaCap)])) as Record<Channel, number>,
  };
}

function view(row: typeof growthWarfareSettings.$inferSelect | undefined, tenantId: string): Settings {
  const features = { ...OFF, ...((row?.features ?? {}) as Partial<Record<Feature, boolean>>) };
  const aggression = (row?.aggression ?? 'balanced') as Aggression;
  const controls = ControlsSchema.parse(row?.controls ?? {});
  return {
    tenantId,
    features,
    aggression,
    controls,
    emergencyStop: row?.emergencyStop ?? false,
    emergencyReason: row?.emergencyReason ?? null,
    lastScanAt: row?.lastScanAt?.toISOString() ?? null,
    version: row?.version ?? 1,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    effective: effectiveLimits(aggression, controls),
  };
}

export async function getSettings(tx: DbOrTx, tenantId: string): Promise<Settings> {
  const [row] = await tx.select().from(growthWarfareSettings).where(eq(growthWarfareSettings.tenantId, tenantId));
  return view(row, tenantId);
}

/** True when a feature may start new work for this tenant (and brand, if given). */
export async function featureActive(tx: DbOrTx, tenantId: string, feature: Feature, brandId?: string | null): Promise<boolean> {
  const s = await getSettings(tx, tenantId);
  if (s.emergencyStop || !s.features[feature]) return false;
  if (brandId) {
    if (s.controls.brandIds.length && !s.controls.brandIds.includes(brandId)) return false;
    const cfg = await getBrandConfig(tx, brandId);
    if (cfg.config.disabledFeatures.includes(feature)) return false;
  }
  return true;
}

/** Throws 409 FEATURE_OFF (or EMERGENCY_STOP) unless the feature may start new work. */
export async function requireFeature(tx: DbOrTx, tenantId: string, feature: Feature, brandId?: string | null): Promise<Settings> {
  const s = await getSettings(tx, tenantId);
  if (s.emergencyStop) throw new FgError('EMERGENCY_STOP', `Growth Warfare is stopped: ${s.emergencyReason ?? 'emergency stop engaged'}`, 409);
  if (!s.features[feature]) throw new FgError('FEATURE_OFF', `${FEATURE_INFO[feature].name} (${feature}) is switched off`, 409, { feature });
  if (brandId) {
    if (s.controls.brandIds.length && !s.controls.brandIds.includes(brandId)) throw new FgError('FEATURE_OFF', 'Growth Warfare is not enabled for this brand', 409, { feature, brandId });
    const cfg = await getBrandConfig(tx, brandId);
    if (cfg.config.disabledFeatures.includes(feature)) throw new FgError('FEATURE_OFF', `${feature} is switched off for this brand`, 409, { feature, brandId });
  }
  return s;
}

/** People with an operator role, or the Growth Warfare / Autopilot system actors acting on their schedule. */
export function requireOperator(actor: Actor, what: string): void {
  if (actor.type !== 'user' && (actor.id === 'growth-warfare' || actor.id === 'autopilot')) return;
  requireRole(actor, ['owner', 'admin', 'growth_operator'], what);
}

/** Changes that widen what may happen need a second factor; switching things off never does. */
function widens(before: Settings, after: { features: Record<Feature, boolean>; aggression: Aggression; controls: Controls }): string[] {
  const out: string[] = [];
  for (const f of GW_FEATURES) if (after.features[f] && !before.features[f]) out.push(`turning ${f} on`);
  const rank = (a: Aggression) => GW_AGGRESSION.indexOf(a);
  if (rank(after.aggression) > rank(before.aggression)) out.push(`raising aggression to ${after.aggression}`);
  const b = before.controls;
  const a = after.controls;
  if (a.externalOperations && !b.externalOperations) out.push('allowing external operations');
  if (a.paidOperations && !b.paidOperations) out.push('allowing paid operations');
  if (a.approvalPreference === 'policy' && b.approvalPreference === 'always_human') out.push('letting M23 policy decide approvals');
  if (a.dailyAiBudgetUsd > b.dailyAiBudgetUsd || a.monthlyAiBudgetUsd > b.monthlyAiBudgetUsd) out.push('raising the AI budget');
  if (a.adSpendLimitMicros > b.adSpendLimitMicros) out.push('raising the advertising limit');
  if (a.maxConcurrentCampaigns > b.maxConcurrentCampaigns) out.push('raising campaign concurrency');
  if (GW_CHANNELS.some((c) => (a.channelQuotas[c] ?? 0) > (b.channelQuotas[c] ?? 0))) out.push('raising a channel quota');
  if (b.brandIds.length && (!a.brandIds.length || a.brandIds.some((x) => !b.brandIds.includes(x)))) out.push('adding brands');
  return out;
}

export async function updateSettings(tx: Tx, tenantId: string, actor: Actor, raw: unknown): Promise<Settings> {
  requireRole(actor, ADMIN_ROLES, 'changing Growth Warfare settings');
  const p = SettingsPatchSchema.parse(raw);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fg:gw-settings'), hashtext(${tenantId}))`);
  const before = await getSettings(tx, tenantId);
  if (p.expectedVersion !== before.version) throw conflict(`settings changed since you loaded them (version ${before.version}, you had ${p.expectedVersion}); reload and try again`);
  const next = {
    features: { ...before.features, ...(p.features ?? {}) },
    aggression: p.aggression ?? before.aggression,
    controls: ControlsSchema.parse({ ...before.controls, ...(p.controls ?? {}), channelQuotas: { ...before.controls.channelQuotas, ...(p.controls?.channelQuotas ?? {}) } }),
  };
  const widening = widens(before, next);
  if (widening.length) requireMfa(actor, widening.join(', '));
  if (before.emergencyStop && GW_FEATURES.some((f) => next.features[f] && !before.features[f])) throw conflict('release the emergency stop before switching features on');
  for (const id of next.controls.brandIds) await getBrand(tx, id);
  const values = { tenantId, features: next.features, aggression: next.aggression, controls: next.controls as unknown as Record<string, unknown>, version: before.version + 1, updatedBy: actorRef(actor), updatedAt: new Date() };
  await tx
    .insert(growthWarfareSettings)
    .values(values)
    .onConflictDoUpdate({ target: growthWarfareSettings.tenantId, set: { features: values.features, aggression: values.aggression, controls: values.controls, version: values.version, updatedBy: values.updatedBy, updatedAt: values.updatedAt } });
  await audit(tx, tenantId, actor, 'growth_warfare.settings.changed', { type: 'growth_warfare_settings', id: tenantId }, { version: values.version, features: next.features, aggression: next.aggression, widening });
  return getSettings(tx, tenantId);
}

/** Stop everything: no MFA needed to stop. Cancels queued Growth Warfare work (see callers). */
export async function engageEmergencyStop(tx: Tx, tenantId: string, actor: Actor, reason: string) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'approver'], 'stopping Growth Warfare');
  const before = await getSettings(tx, tenantId);
  await tx
    .insert(growthWarfareSettings)
    .values({ tenantId, features: before.features, aggression: before.aggression, controls: before.controls as unknown as Record<string, unknown>, emergencyStop: true, emergencyReason: reason, version: before.version + 1, updatedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: growthWarfareSettings.tenantId, set: { emergencyStop: true, emergencyReason: reason, version: sql`${growthWarfareSettings.version} + 1`, updatedBy: actorRef(actor), updatedAt: new Date() } });
  // Agent-proposed Growth Warfare actions are cancelled by the M24 agent kill switch as well.
  const ks = await engageKillSwitch(tx, tenantId, actor, { scope: 'agent', targetRef: 'growth-warfare', reason: `Growth Warfare emergency stop: ${reason}` });
  await audit(tx, tenantId, actor, 'growth_warfare.emergency_stop.engaged', { type: 'growth_warfare_settings', id: tenantId }, { reason, killSwitchId: ks.killSwitch.id });
  return { settings: await getSettings(tx, tenantId), killSwitchId: ks.killSwitch.id, cancelledActions: ks.cancelledActions };
}

/** Releasing needs an admin with a second factor; features stay as they were (still gated). */
export async function releaseEmergencyStop(tx: Tx, tenantId: string, actor: Actor, expectedVersion: number) {
  requireRole(actor, ADMIN_ROLES, 'releasing the Growth Warfare emergency stop');
  requireMfa(actor, 'releasing the Growth Warfare emergency stop');
  const before = await getSettings(tx, tenantId);
  if (!before.emergencyStop) throw conflict('the emergency stop is not engaged');
  if (before.version !== expectedVersion) throw conflict('settings changed since you loaded them; reload and try again');
  await tx
    .update(growthWarfareSettings)
    .set({ emergencyStop: false, emergencyReason: null, version: before.version + 1, updatedBy: actorRef(actor), updatedAt: new Date() })
    .where(and(eq(growthWarfareSettings.tenantId, tenantId), eq(growthWarfareSettings.version, expectedVersion)));
  await tx.execute(sql`update kill_switches set engaged = false, released_by = ${actorRef(actor)}, released_at = now() where engaged and scope = 'agent' and target_ref = 'growth-warfare'`);
  await audit(tx, tenantId, actor, 'growth_warfare.emergency_stop.released', { type: 'growth_warfare_settings', id: tenantId }, {});
  return getSettings(tx, tenantId);
}

/* ------------------------------------------------------------------ */
/* Per-brand configuration                                             */
/* ------------------------------------------------------------------ */

const EventName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:\- ]+$/);

export const FunnelStageSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/),
  label: z.string().min(1).max(120),
  /** First-party event names (M02 customer events) that mark reaching this stage. */
  events: z.array(EventName).min(1).max(10),
});

export const BrandConfigSchema = z.object({
  /** Words that make a search query, trend or discussion relevant to this brand. */
  keywords: z.array(z.string().min(2).max(80)).max(100).default([]),
  /** M05 competitors this brand competes with. */
  competitorIds: z.array(z.string().uuid()).max(50).default([]),
  businessGoal: z.string().max(500).nullable().default(null),
  /** Market (jurisdiction) the brand sells in, e.g. BD. */
  market: z.string().min(2).max(10).nullable().default(null),
  channels: z.array(z.enum(GW_CHANNELS)).default([]),
  /** Ordered acquisition/activation funnel (F5). */
  funnel: z.array(FunnelStageSchema).max(10).default([]),
  /** Events that count as a verified conversion for campaign goals. */
  conversionEvents: z.array(EventName).max(20).default([]),
  landingUrl: z.string().url().startsWith('https://').nullable().default(null),
  monthlyBudgetMicros: z.number().int().min(0).default(0),
  /** Features switched off for this brand only (a brand can never turn on what the tenant has off). */
  disabledFeatures: z.array(z.enum(GW_FEATURES)).default([]),
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

export async function getBrandConfig(tx: DbOrTx, brandId: string): Promise<{ brandId: string; config: BrandConfig; version: number; updatedAt: string | null }> {
  const [row] = await tx.select().from(growthBrandConfigs).where(eq(growthBrandConfigs.brandId, brandId));
  return { brandId, config: BrandConfigSchema.parse(row?.config ?? {}), version: row?.version ?? 0, updatedAt: row?.updatedAt?.toISOString() ?? null };
}

export async function putBrandConfig(tx: Tx, tenantId: string, actor: Actor, brandId: string, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'changing a brand growth profile');
  const p = z.object({ expectedVersion: z.number().int().min(0), config: BrandConfigSchema }).parse(raw);
  const brand = await getBrand(tx, brandId);
  if (!brand) throw notFound('brand');
  const current = await getBrandConfig(tx, brandId);
  if (current.version !== p.expectedVersion) throw conflict(`the brand profile changed since you loaded it (version ${current.version}); reload and try again`);
  if (p.config.competitorIds.length) {
    const found = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from competitors where id in (${sql.join(
        p.config.competitorIds.map((x) => sql`${x}`),
        sql`, `,
      )})`,
    );
    if ((found.rows[0]?.n ?? 0) !== new Set(p.config.competitorIds).size) throw notFound('competitor');
  }
  const config = p.config as unknown as Record<string, unknown>;
  if (current.version === 0) await tx.insert(growthBrandConfigs).values({ tenantId, brandId, config, version: 1, updatedBy: actorRef(actor) });
  else
    await tx
      .update(growthBrandConfigs)
      .set({ config, version: current.version + 1, updatedBy: actorRef(actor), updatedAt: new Date() })
      .where(and(eq(growthBrandConfigs.brandId, brandId), eq(growthBrandConfigs.version, current.version)));
  await audit(tx, tenantId, actor, 'growth_warfare.brand_config.changed', { type: 'brand', id: brandId }, { version: current.version + 1 });
  return getBrandConfig(tx, brandId);
}

/** Active brands Growth Warfare works for under the current controls. */
export async function workingBrandIds(tx: DbOrTx, s: Settings): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`select id from brands where status = 'active' order by created_at`);
  const ids = rows.rows.map((r) => r.id);
  return s.controls.brandIds.length ? ids.filter((x) => s.controls.brandIds.includes(x)) : ids;
}
