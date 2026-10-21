import { CAPABILITY_SEEDS } from '@futuregrow/connectors';
import { type KillSwitchScope, type ModelArtifact, ModelArtifactSchema, type TenantPolicy, TenantPolicySchema } from '@futuregrow/contracts';
import { actionRequests, alerts, artifactLicenses, authUser, budgetReservations, costLedger, type Db, type DbOrTx, incidents, jurisdictionRules, killSwitches, modelRegistry, platformCapabilities, setTransitionReason, systemControls, type Tx, tenantSettings, verifyAuditChain, withSystem } from '@futuregrow/db';
import { conflict, FgError, forbidden, invalid, notFound } from '@futuregrow/observability';
import { defaultTenantPolicy } from '@futuregrow/policies';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Actor, actorRef } from '../../deps.js';
import { ADMIN_ROLES, audit, record, requireMfa, requireRole } from '../../util.js';

/* ------------------------------------------------------------------ */
/* Tenant policy                                                       */
/* ------------------------------------------------------------------ */

export async function getTenantPolicy(tx: DbOrTx, tenantId: string): Promise<TenantPolicy> {
  const [row] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  if (!row) return defaultTenantPolicy();
  return TenantPolicySchema.parse(row.policy);
}

export async function setTenantPolicy(tx: Tx, tenantId: string, actor: Actor, input: unknown): Promise<TenantPolicy> {
  requireRole(actor, ADMIN_ROLES, 'changing the autonomy policy');
  requireMfa(actor, 'changing the autonomy policy');
  const current = await getTenantPolicy(tx, tenantId);
  const parsed = TenantPolicySchema.parse({ ...(input as object), version: current.version + 1 });
  if (parsed.configured) {
    for (const [cat, cp] of Object.entries(parsed.categories)) {
      if (cp?.autonomy === 'pre_authorized_within_limits' && (cat === 'SPEND' || cat === 'PRICING') && !parsed.currency) {
        throw invalid(`category ${cat} pre-authorization requires a policy currency`);
      }
    }
  }
  await tx
    .insert(tenantSettings)
    .values({ tenantId, policy: parsed, policyVersion: parsed.version, updatedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { policy: parsed, policyVersion: parsed.version, updatedBy: actorRef(actor), updatedAt: new Date() } });
  await audit(tx, tenantId, actor, 'governance.policy.updated', { type: 'tenant_policy', id: tenantId }, { version: parsed.version, policy: parsed });
  return parsed;
}

export interface SenderIdentity {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  postalAddress: string;
}

export async function getTenantSettingsRow(tx: DbOrTx, tenantId: string) {
  const [row] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  return row ?? null;
}

export async function setSenderIdentity(tx: Tx, tenantId: string, actor: Actor, identity: SenderIdentity): Promise<void> {
  requireRole(actor, ADMIN_ROLES, 'changing the sender identity');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identity.fromEmail)) throw invalid('invalid fromEmail');
  if (identity.postalAddress.trim().length < 10) throw invalid('a valid physical postal address is required (CAN-SPAM)');
  const existing = await getTenantSettingsRow(tx, tenantId);
  if (!existing) {
    await tx.insert(tenantSettings).values({ tenantId, policy: defaultTenantPolicy(), senderIdentity: identity as unknown as Record<string, unknown>, updatedBy: actorRef(actor) });
  } else {
    await tx
      .update(tenantSettings)
      .set({ senderIdentity: identity as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(tenantSettings.tenantId, tenantId));
  }
  await audit(tx, tenantId, actor, 'governance.sender_identity.updated', { type: 'tenant_settings', id: tenantId }, { fromEmail: identity.fromEmail });
}

export function senderIdentityComplete(v: unknown): v is SenderIdentity {
  const s = v as Partial<SenderIdentity> | null;
  return Boolean(s?.fromEmail && s.fromName && s.postalAddress && s.postalAddress.trim().length >= 10);
}

/* ------------------------------------------------------------------ */
/* Kill switches (D-021)                                               */
/* ------------------------------------------------------------------ */

const PRE_EXECUTION_STATES = ['PROPOSED', 'EVIDENCE_READY', 'POLICY_CHECKED', 'APPROVAL_REQUIRED', 'APPROVED', 'PREFLIGHT_VERIFIED'];

export async function isSystemHalted(tx: DbOrTx): Promise<boolean> {
  const [row] = await tx.select().from(systemControls).where(eq(systemControls.key, 'kill_switch'));
  return row?.engaged === true;
}

export async function setSystemHalt(db: Db, actor: { userId: string }, engaged: boolean, reason: string): Promise<void> {
  await withSystem(db, `user:${actor.userId}`, async (tx) => {
    const [u] = await tx.select().from(authUser).where(eq(authUser.id, actor.userId));
    if (!u?.isPlatformAdmin) throw forbidden('system kill switch requires a platform administrator');
    await tx
      .insert(systemControls)
      .values({ key: 'kill_switch', engaged, reason, changedBy: actor.userId })
      .onConflictDoUpdate({ target: systemControls.key, set: { engaged, reason, changedBy: actor.userId, changedAt: new Date() } });
    if (engaged) {
      await setTransitionReason(tx, `system kill switch: ${reason}`);
      const cancelled = await tx
        .update(actionRequests)
        .set({ status: 'CANCELLED', statusReason: `system kill switch: ${reason}` })
        .where(inArray(actionRequests.status, PRE_EXECUTION_STATES))
        .returning({ id: actionRequests.id });
      if (cancelled.length) {
        await tx
          .update(budgetReservations)
          .set({ status: 'released', settledAt: new Date() })
          .where(
            and(
              inArray(
                budgetReservations.actionId,
                cancelled.map((c) => c.id),
              ),
              eq(budgetReservations.status, 'held'),
            ),
          );
      }
    }
  });
}

export interface KillSwitchMatchInput {
  provider: string;
  connectionId: string | null;
  objectRefs: string[];
  proposer: { type: string; id: string; modelId: string | null };
}

export async function engagedKillSwitchesFor(tx: DbOrTx, input: KillSwitchMatchInput) {
  const rows = await tx.select().from(killSwitches).where(eq(killSwitches.engaged, true));
  return rows
    .filter((k) => {
      switch (k.scope as KillSwitchScope) {
        case 'tenant':
          return true;
        case 'connector':
          return k.targetRef === input.provider || (input.connectionId !== null && k.targetRef === input.connectionId);
        case 'object':
          return k.targetRef !== null && input.objectRefs.includes(k.targetRef);
        case 'agent':
          return input.proposer.type === 'agent' && (k.targetRef === null || k.targetRef === input.proposer.id);
        case 'model':
          return input.proposer.modelId !== null && (k.targetRef === null || k.targetRef === input.proposer.modelId);
        default:
          return false;
      }
    })
    .map((k) => ({ scope: k.scope, targetRef: k.targetRef, reason: k.reason }));
}

export async function engageKillSwitch(tx: Tx, tenantId: string, actor: Actor, input: { scope: Exclude<KillSwitchScope, 'system'>; targetRef: string | null; reason: string }) {
  // Stopping must be easy: any operator role may engage; releasing requires an admin.
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'approver', 'finance_approver', 'legal_approver', 'privacy_officer'], 'engaging a kill switch');
  if (input.scope !== 'tenant' && input.scope !== 'agent' && input.scope !== 'model' && !input.targetRef) {
    throw invalid(`${input.scope} kill switch requires a targetRef`);
  }
  const [row] = await tx
    .insert(killSwitches)
    .values({ tenantId, scope: input.scope, targetRef: input.targetRef, reason: input.reason, engagedBy: actorRef(actor) })
    .returning();
  const cancelled = await cancelActionsInScope(tx, tenantId, row!.scope as KillSwitchScope, row!.targetRef, `kill switch ${row!.id}: ${input.reason}`);
  await record(tx, tenantId, actor, 'governance.kill_switch.engaged', { type: 'kill_switch', id: row!.id }, { ...input, cancelledActions: cancelled });
  return { killSwitch: row!, cancelledActions: cancelled };
}

export async function releaseKillSwitch(tx: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ADMIN_ROLES, 'releasing a kill switch');
  requireMfa(actor, 'releasing a kill switch');
  const [row] = await tx
    .update(killSwitches)
    .set({ engaged: false, releasedBy: actorRef(actor), releasedAt: new Date() })
    .where(and(eq(killSwitches.id, id), eq(killSwitches.engaged, true)))
    .returning();
  if (!row) throw notFound('engaged kill switch');
  await record(tx, tenantId, actor, 'governance.kill_switch.released', { type: 'kill_switch', id }, {});
  return row;
}

/** Cancel queued (not yet executing) actions matching a kill switch scope. */
export async function cancelActionsInScope(tx: Tx, tenantId: string, scope: KillSwitchScope, targetRef: string | null, reason: string): Promise<string[]> {
  const candidates = await tx
    .select()
    .from(actionRequests)
    .where(and(eq(actionRequests.tenantId, tenantId), inArray(actionRequests.status, PRE_EXECUTION_STATES)));
  const ids = candidates
    .filter((a) => {
      if (scope === 'tenant') return true;
      if (scope === 'connector') return a.provider === targetRef || a.connectionId === targetRef;
      if (scope === 'object') return targetRef !== null && JSON.stringify(a.params).includes(`"${targetRef}"`);
      if (scope === 'agent') return a.proposedByType === 'agent' && (targetRef === null || a.proposedById === targetRef);
      if (scope === 'model') return a.proposerModelId !== null && (targetRef === null || a.proposerModelId === targetRef);
      return false;
    })
    .map((a) => a.id);
  if (ids.length === 0) return [];
  await setTransitionReason(tx, reason);
  await tx.update(actionRequests).set({ status: 'CANCELLED', statusReason: reason }).where(inArray(actionRequests.id, ids));
  await tx
    .update(budgetReservations)
    .set({ status: 'released', settledAt: new Date() })
    .where(and(inArray(budgetReservations.actionId, ids), eq(budgetReservations.status, 'held')));
  return ids;
}

/* ------------------------------------------------------------------ */
/* Registries                                                          */
/* ------------------------------------------------------------------ */

/** Upsert the platform capability registry from the connector seed (run at deploy). */
export async function syncCapabilityRegistry(db: Db): Promise<number> {
  await withSystem(db, 'system:capability-sync', async (tx) => {
    for (const c of CAPABILITY_SEEDS) {
      const values = {
        platform: c.platform,
        apiVersion: c.apiVersion,
        capability: c.capability,
        supported: c.supported,
        requiredScopes: c.requiredScopes,
        requiredAccountType: c.requiredAccountType,
        appReviewRequired: c.appReviewRequired,
        rateLimitPolicy: c.rateLimitPolicy as unknown as Record<string, unknown>,
        quota: c.quota,
        regionalRestrictions: c.regionalRestrictions,
        termsCheckedAt: new Date(c.termsCheckedAt),
        termsVersion: c.termsVersion,
        connectorVersion: c.connectorVersion,
        fallback: c.fallback,
        sourceUrl: c.sourceUrl,
        notes: c.notes,
      };
      await tx
        .insert(platformCapabilities)
        .values(values)
        .onConflictDoUpdate({
          target: [platformCapabilities.platform, platformCapabilities.capability, platformCapabilities.apiVersion],
          set: { ...values, updatedAt: new Date() },
        });
    }
  });
  return CAPABILITY_SEEDS.length;
}

const REASONING = ['planning', 'critic', 'generation', 'extraction', 'classification'] as const;
const ANTHROPIC_TERMS = 'Anthropic Commercial Terms of Service (vendor review required)';

/** Seed default models as NOT approved (D-002): approval requires vendor review. */
/**
 * D-024: the current Opus serves every reasoning purpose (direct, or through OpenRouter restricted
 * to upstreams that do not collect data); Opus 4.8 is a refusal-fallback candidate. The hosted
 * OpenAI-compatible models are failover candidates (FG-P2-001). Prices are list prices per million
 * tokens as published on 2026-10-21 and are re-confirmed at approval time.
 */
export const DEFAULT_MODELS = [
  { provider: 'anthropic', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', purposes: REASONING, inputUsdPerMtok: 4, outputUsdPerMtok: 20, terms: ANTHROPIC_TERMS },
  { provider: 'anthropic', modelId: 'claude-opus-4-8', displayName: 'Claude Opus 4.8 (refusal fallback)', purposes: ['fallback'], inputUsdPerMtok: 5, outputUsdPerMtok: 25, terms: ANTHROPIC_TERMS },
  { provider: 'openrouter', modelId: 'anthropic/claude-opus-5.5', displayName: 'Claude Opus 5.5 via OpenRouter', purposes: REASONING, inputUsdPerMtok: 4, outputUsdPerMtok: 20, terms: 'OpenRouter Terms of Service and Anthropic Commercial Terms; requests restricted to upstreams with data_collection=deny' },
  { provider: 'openai', modelId: 'gpt-5.5', displayName: 'GPT-5.5', purposes: REASONING, inputUsdPerMtok: 5, outputUsdPerMtok: 30, terms: 'OpenAI Services Agreement (API data not used for training by default)' },
  { provider: 'openai', modelId: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', purposes: REASONING, inputUsdPerMtok: 0.75, outputUsdPerMtok: 4.5, terms: 'OpenAI Services Agreement (API data not used for training by default)' },
  { provider: 'gemini', modelId: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', purposes: REASONING, inputUsdPerMtok: 1.5, outputUsdPerMtok: 9, terms: 'Gemini API Additional Terms: paid tier only (the unpaid tier may use prompts to improve Google products)' },
  { provider: 'groq', modelId: 'openai/gpt-oss-120b', displayName: 'gpt-oss-120b on Groq', purposes: REASONING, inputUsdPerMtok: 0.15, outputUsdPerMtok: 0.6, terms: 'Groq Services Agreement (no training on inputs/outputs, no retention by default); weights Apache-2.0' },
] as const;

export async function seedModelRegistry(db: Db): Promise<void> {
  await withSystem(db, 'system:model-seed', async (tx) => {
    for (const m of DEFAULT_MODELS) {
      await tx
        .insert(modelRegistry)
        .values({
          provider: m.provider,
          modelId: m.modelId,
          displayName: m.displayName,
          purposes: [...m.purposes],
          licenseOrTerms: m.terms,
          commercialUse: 'unknown',
          trainingOnCustomerData: 'unknown',
          approvedForProduction: false,
          inputUsdPerMtok: m.inputUsdPerMtok,
          outputUsdPerMtok: m.outputUsdPerMtok,
        })
        .onConflictDoNothing();
    }
  });
}

export async function approveModel(db: Db, actor: { userId: string }, input: { provider: string; modelId: string; trainingOnCustomerData: 'no' | 'yes' | 'unknown'; dataRetentionTerms: string; inputUsdPerMtok: number | null; outputUsdPerMtok: number | null }): Promise<void> {
  await withSystem(db, `user:${actor.userId}`, async (tx) => {
    const [u] = await tx.select().from(authUser).where(eq(authUser.id, actor.userId));
    if (!u?.isPlatformAdmin) throw forbidden('model approval requires a platform administrator');
    if (!u.twoFactorEnabled) throw forbidden('model approval requires an MFA-enabled account');
    if (input.trainingOnCustomerData !== 'no') throw invalid('models that may train on customer data (or unknown) cannot be approved for production');
    const updated = await tx
      .update(modelRegistry)
      .set({
        approvedForProduction: true,
        approvedBy: actor.userId,
        approvedAt: new Date(),
        commercialUse: 'allowed',
        trainingOnCustomerData: input.trainingOnCustomerData,
        dataRetentionTerms: input.dataRetentionTerms,
        inputUsdPerMtok: input.inputUsdPerMtok,
        outputUsdPerMtok: input.outputUsdPerMtok,
      })
      .where(and(eq(modelRegistry.provider, input.provider), eq(modelRegistry.modelId, input.modelId)))
      .returning({ id: modelRegistry.id });
    if (!updated.length) throw notFound('model');
  });
}

export async function listModels(db: DbOrTx) {
  return db.select().from(modelRegistry).orderBy(modelRegistry.provider, modelRegistry.modelId);
}

export async function registerArtifact(tx: Tx, tenantId: string, actor: Actor, input: unknown) {
  const a: ModelArtifact = ModelArtifactSchema.parse({ ...(input as object), approvedForProduction: false, approvedBy: null, approvedAt: null });
  const [row] = await tx
    .insert(artifactLicenses)
    .values({
      tenantId,
      exactName: a.exactName,
      versionOrCommit: a.versionOrCommit,
      sha256: a.sha256,
      artifactType: a.artifactType,
      copyrightOwner: a.copyrightOwner,
      licenseIdOrCustomTerms: a.licenseIdOrCustomTerms,
      commercialUse: a.commercialUse,
      redistribution: a.redistribution,
      derivativeUse: a.derivativeUse,
      attributionRequired: a.attributionRequired,
      geographicOrUseRestrictions: a.geographicOrUseRestrictions,
      sourceDataRightsStatus: a.sourceDataRightsStatus,
      sourceUrl: a.sourceUrl,
    })
    .returning();
  await audit(tx, tenantId, actor, 'governance.artifact.registered', { type: 'artifact_license', id: row!.id }, { name: a.exactName, sha256: a.sha256 });
  return row!;
}

export async function approveArtifact(tx: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ['owner', 'legal_approver'], 'approving an artifact licence');
  requireMfa(actor, 'approving an artifact licence');
  const [a] = await tx.select().from(artifactLicenses).where(eq(artifactLicenses.id, id));
  if (!a) throw notFound('artifact');
  if (a.commercialUse !== 'allowed') throw invalid(`commercial_use is ${a.commercialUse}; only 'allowed' artifacts can enter production`);
  if (a.sourceDataRightsStatus !== 'known') throw invalid('source data rights are unknown');
  const [row] = await tx
    .update(artifactLicenses)
    .set({ approvedForProduction: true, approvedBy: actorRef(actor), approvedAt: new Date() })
    .where(eq(artifactLicenses.id, id))
    .returning();
  await audit(tx, tenantId, actor, 'governance.artifact.approved', { type: 'artifact_license', id }, {});
  return row!;
}

export async function approvedJurisdictions(tx: DbOrTx, tenantPolicy: TenantPolicy): Promise<string[]> {
  if (tenantPolicy.approvedJurisdictions.length === 0) return [];
  const rows = await tx
    .select({ j: jurisdictionRules.jurisdiction })
    .from(jurisdictionRules)
    .where(and(eq(jurisdictionRules.approvedByLegal, true), inArray(jurisdictionRules.jurisdiction, tenantPolicy.approvedJurisdictions)));
  return [...new Set(rows.map((r) => r.j))];
}

export async function upsertJurisdictionRules(db: Db, actor: { userId: string }, input: { jurisdiction: string; domain: string; rules: Record<string, unknown>; sourceRefs: string[]; approve: boolean }) {
  return withSystem(db, `user:${actor.userId}`, async (tx) => {
    const [u] = await tx.select().from(authUser).where(eq(authUser.id, actor.userId));
    if (!u?.isPlatformAdmin) throw forbidden('jurisdiction rule packs are managed by a platform administrator with legal sign-off');
    const [latest] = await tx
      .select()
      .from(jurisdictionRules)
      .where(and(eq(jurisdictionRules.jurisdiction, input.jurisdiction), eq(jurisdictionRules.domain, input.domain)))
      .orderBy(desc(jurisdictionRules.version))
      .limit(1);
    const [row] = await tx
      .insert(jurisdictionRules)
      .values({
        jurisdiction: input.jurisdiction,
        domain: input.domain,
        version: (latest?.version ?? 0) + 1,
        rules: input.rules,
        sourceRefs: input.sourceRefs,
        approvedByLegal: input.approve,
        approvedBy: input.approve ? actor.userId : null,
        approvedAt: input.approve ? new Date() : null,
        effectiveFrom: new Date(),
      })
      .returning();
    return row!;
  });
}

/* ------------------------------------------------------------------ */
/* Incidents, alerts, cost                                             */
/* ------------------------------------------------------------------ */

export async function openIncident(tx: Tx, tenantId: string, actor: Actor, input: { severity: 'sev1' | 'sev2' | 'sev3' | 'sev4'; title: string; description: string; refs: Record<string, unknown> }) {
  const [row] = await tx
    .insert(incidents)
    .values({ tenantId, ...input, openedBy: actorRef(actor) })
    .returning();
  await record(tx, tenantId, actor, 'governance.incident.opened', { type: 'incident', id: row!.id }, { severity: input.severity, title: input.title, refs: input.refs });
  return row!;
}

export async function resolveIncident(tx: Tx, tenantId: string, actor: Actor, id: string, resolution: string) {
  requireRole(actor, ADMIN_ROLES, 'resolving an incident');
  const [row] = await tx
    .update(incidents)
    .set({ status: 'resolved', resolvedAt: new Date(), resolution })
    .where(and(eq(incidents.id, id), sql`${incidents.status} <> 'resolved'`))
    .returning();
  if (!row) throw notFound('open incident');
  await audit(tx, tenantId, actor, 'governance.incident.resolved', { type: 'incident', id }, { resolution });
  return row;
}

export async function raiseAlert(tx: Tx, tenantId: string, input: { kind: string; severity: 'info' | 'warning' | 'critical'; message: string; refs?: Record<string, unknown>; dedupKey?: string }) {
  const inserted = await tx
    .insert(alerts)
    .values({ tenantId, kind: input.kind, severity: input.severity, message: input.message, refs: input.refs ?? {}, dedupKey: input.dedupKey ?? null })
    .onConflictDoNothing()
    .returning();
  return inserted[0] ?? null;
}

export async function acknowledgeAlert(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx
    .update(alerts)
    .set({ acknowledgedBy: actorRef(actor), acknowledgedAt: new Date() })
    .where(and(eq(alerts.id, id), isNull(alerts.acknowledgedAt)))
    .returning();
  if (!row) throw notFound('unacknowledged alert');
  return row;
}

export async function recordCost(tx: Tx, tenantId: string, input: { category: 'llm' | 'embedding' | 'media_render' | 'api' | 'analytics' | 'storage'; provider: string; unit: string; quantity: number; unitCostUsd: number | null; refType?: string; refId?: string; metadata?: Record<string, unknown> }) {
  await tx.insert(costLedger).values({
    tenantId,
    category: input.category,
    provider: input.provider,
    unit: input.unit,
    quantity: input.quantity,
    unitCostUsd: input.unitCostUsd,
    // [U] when the unit price is unknown the amount stays null rather than being estimated.
    amountUsd: input.unitCostUsd === null ? null : input.unitCostUsd * input.quantity,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    metadata: input.metadata ?? {},
  });
}

export async function costSummary(tx: DbOrTx, tenantId: string, since: Date) {
  const res = await tx.execute<{ category: string; provider: string; quantity: number; known_usd: number | null; unpriced_rows: number }>(sql`
    select category, provider, sum(quantity)::float8 as quantity,
           sum(amount_usd)::float8 as known_usd,
           count(*) filter (where amount_usd is null)::int as unpriced_rows
    from cost_ledger where tenant_id = ${tenantId} and occurred_at >= ${since}
    group by category, provider order by category, provider`);
  return res.rows;
}

export async function verifyTenantAudit(tx: DbOrTx, tenantId: string) {
  return verifyAuditChain(tx, tenantId);
}

export { conflict, FgError };
