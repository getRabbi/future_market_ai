import { configuredApiVersion } from '@futuregrow/connectors';
import type { ActionRisk, ActionTypeDefinition, PlatformCapability, TenantPolicy } from '@futuregrow/contracts';
import { actionRequests, assets, budgetReservations, claims, connections, consentState, customerProfiles, evidenceRecords, experiments, messages, platformCapabilities, suppressions, syntheticPersonas, type Tx, tenantSettings } from '@futuregrow/db';
import { identifierHash } from '@futuregrow/observability';
import type { DisclosureFact, MessagingFact, PolicyFacts } from '@futuregrow/policies';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { effectiveSunset } from '../../api-lifecycle.js';
import type { CoreDeps } from '../../deps.js';
import { approvedJurisdictions, engagedKillSwitchesFor, isSystemHalted, senderIdentityComplete } from '../m24-governance/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id-like value in params/target, used to match object-scoped kill switches. */
export function objectRefs(params: Record<string, unknown>, target: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, key: string) => {
    if (typeof v === 'string' && (/(Id|Ref|Code)$/.test(key) || UUID_RE.test(v))) out.add(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(params, '');
  walk(target, '');
  return [...out];
}

export interface FactInput {
  tenantId: string;
  actionId: string | null;
  definition: ActionTypeDefinition | undefined;
  params: Record<string, unknown>;
  target: Record<string, unknown>;
  connectionId: string | null;
  evidenceIds: string[];
  risk: ActionRisk;
  proposer: { type: string; id: string; modelId: string | null };
}

function toCapability(row: typeof platformCapabilities.$inferSelect): PlatformCapability {
  return {
    platform: row.platform as PlatformCapability['platform'],
    apiVersion: row.apiVersion,
    capability: row.capability,
    supported: row.supported,
    requiredScopes: row.requiredScopes,
    requiredAccountType: row.requiredAccountType,
    appReviewRequired: row.appReviewRequired as PlatformCapability['appReviewRequired'],
    rateLimitPolicy: row.rateLimitPolicy as PlatformCapability['rateLimitPolicy'],
    quota: row.quota,
    regionalRestrictions: row.regionalRestrictions,
    termsCheckedAt: row.termsCheckedAt.toISOString(),
    termsVersion: row.termsVersion,
    connectorVersion: row.connectorVersion,
    fallback: row.fallback as PlatformCapability['fallback'],
    sourceUrl: row.sourceUrl,
    notes: row.notes,
  };
}

export async function loadCapability(tx: Tx, deps: CoreDeps, def: ActionTypeDefinition): Promise<{ capability: PlatformCapability | null; configured: string | null }> {
  const configured = configuredApiVersion(def.provider, deps.config.versions);
  if (def.provider === 'internal') return { capability: null, configured: null };
  const rows = await tx
    .select()
    .from(platformCapabilities)
    .where(and(eq(platformCapabilities.platform, def.provider), eq(platformCapabilities.capability, def.capability)));
  const exact = rows.find((r) => r.apiVersion === configured) ?? rows[0] ?? null;
  return { capability: exact ? toCapability(exact) : null, configured };
}

function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now);
  return Number(h);
}

export function inQuietWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

async function messagingFacts(tx: Tx, deps: CoreDeps, input: FactInput, policy: TenantPolicy): Promise<MessagingFact | null> {
  const profileId = input.params.profileId as string | undefined;
  const category = (input.params.category as 'transactional' | 'commercial' | undefined) ?? 'commercial';
  if (!profileId) return null;
  const [profile] = await tx.select().from(customerProfiles).where(eq(customerProfiles.id, profileId));
  if (!profile || profile.deletedAt || !profile.email) {
    return { category, consentGranted: false, suppressed: true, isChild: profile?.isChild ?? null, senderIdentityComplete: false, withinFrequencyCap: false, quietHoursOk: false };
  }
  const hash = identifierHash(deps.config.identifierPepper, 'email', profile.email);
  const sup = await tx
    .select({ reason: suppressions.reason })
    .from(suppressions)
    .where(and(eq(suppressions.identifierHash, hash), inArray(suppressions.channel, ['email', 'all'])));
  // An unsubscribe blocks commercial mail only; bounces, complaints, DSAR and manual blocks stop everything.
  const suppressed = sup.some((r) => r.reason !== 'unsubscribe') || (category === 'commercial' && sup.length > 0);
  const [consent] = await tx
    .select()
    .from(consentState)
    .where(and(eq(consentState.profileId, profileId), eq(consentState.purpose, 'marketing_email')));
  const now = deps.clock.now();
  const consentGranted = consent?.status === 'granted' && (!consent.expiresAt || consent.expiresAt > now);
  const [settings] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, input.tenantId));

  let withinFrequencyCap: boolean | null = null;
  let quietHoursOk: boolean | null = null;
  if (policy.messaging) {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const messageId = input.params.messageId as string | undefined;
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.profileId, profileId), eq(messages.category, 'commercial'), inArray(messages.status, ['submitted', 'sent_unverified', 'delivered']), gte(messages.createdAt, since), ...(messageId ? [ne(messages.id, messageId)] : [])));
    withinFrequencyCap = n < policy.messaging.maxCommercialMessagesPerProfilePerWeek;
    const tz = profile.timezone ?? policy.messaging.quietHours.timezone;
    quietHoursOk = !inQuietWindow(localHour(now, tz), policy.messaging.quietHours.startHour, policy.messaging.quietHours.endHour);
  }
  if (category === 'transactional') {
    withinFrequencyCap = withinFrequencyCap ?? true;
    quietHoursOk = true;
  }
  return {
    category,
    consentGranted,
    suppressed,
    isChild: profile.isChild,
    senderIdentityComplete: senderIdentityComplete(settings?.senderIdentity),
    withinFrequencyCap,
    quietHoursOk,
  };
}

export async function gatherPolicyFacts(tx: Tx, deps: CoreDeps, input: FactInput, policy: TenantPolicy): Promise<PolicyFacts> {
  const now = deps.clock.now();
  const def = input.definition;
  const { capability, configured } = def ? await loadCapability(tx, deps, def) : { capability: null, configured: null };

  let connection: PolicyFacts['connection'] = null;
  if (input.connectionId) {
    const [c] = await tx.select().from(connections).where(eq(connections.id, input.connectionId));
    if (c) connection = { provider: c.provider, status: c.status as never, grantedScopes: c.grantedScopes, appAudited: c.appAudited, accessLevel: c.accessLevel };
  }

  const evRows = input.evidenceIds.length ? await tx.select().from(evidenceRecords).where(inArray(evidenceRecords.id, input.evidenceIds)) : [];
  const evidence = evRows.map((e) => ({
    id: e.id,
    status: e.status as 'admitted',
    freshnessStatus: effectiveFreshness(e, now),
    permittedUses: e.permittedUses,
    prohibitedUses: e.prohibitedUses,
    ageHours: (now.getTime() - (e.observedAt ?? e.retrievedAt).getTime()) / 3_600_000,
  }));

  const claimIds = Array.isArray(input.params.claimIds) ? (input.params.claimIds as string[]) : [];
  const claimRows = claimIds.length ? await tx.select().from(claims).where(inArray(claims.id, claimIds)) : [];

  const assetIds = Array.isArray(input.params.assetIds) ? (input.params.assetIds as string[]) : [];
  const assetRows = assetIds.length ? await tx.select().from(assets).where(inArray(assets.id, assetIds)) : [];

  const disclosure = (input.params.disclosure as DisclosureFact | undefined) ?? null;
  const personaId = input.risk.syntheticPersonaId ?? disclosure?.syntheticPersonaId ?? null;
  const [persona] = personaId ? await tx.select().from(syntheticPersonas).where(eq(syntheticPersonas.id, personaId)) : [];

  const since = new Date(now.getTime() - 86_400_000);
  const [{ total } = { total: 0 }] = await tx
    .select({ total: sql<number>`coalesce(sum(${budgetReservations.amountMicros}), 0)::float8` })
    .from(budgetReservations)
    .innerJoin(actionRequests, eq(actionRequests.id, budgetReservations.actionId))
    .where(and(inArray(budgetReservations.status, ['held', 'committed']), gte(budgetReservations.createdAt, since), sql`${actionRequests.policyDecision}->>'outcome' = 'PRE_AUTHORIZED'`, ...(input.actionId ? [ne(budgetReservations.actionId, input.actionId)] : [])));

  return {
    systemHalted: await isSystemHalted(tx),
    engagedKillSwitches: await engagedKillSwitchesFor(tx, {
      provider: def?.provider ?? 'internal',
      connectionId: input.connectionId,
      objectRefs: objectRefs(input.params, input.target),
      proposer: input.proposer,
    }),
    capability,
    configuredApiVersion: configured,
    apiVersionSunset: def && def.provider !== 'internal' ? await effectiveSunset(tx, def.provider, deps.config.versions, now) : null,
    connection,
    evidence,
    missingEvidenceIds: input.evidenceIds.filter((id) => !evRows.some((e) => e.id === id)),
    claims: claimRows.map((c) => ({ id: c.id, status: c.status as 'approved', expiresAt: c.expiresAt, regulated: c.regulated })),
    missingClaimIds: claimIds.filter((id) => !claimRows.some((c) => c.id === id)),
    approvedJurisdictions: await approvedJurisdictions(tx, policy),
    rollingPreAuthorizedSpendMicros: Number(total),
    messaging: def?.category === 'MESSAGING' ? await messagingFacts(tx, deps, input, policy) : null,
    persona: persona ? { id: persona.id, status: persona.status as 'approved' } : null,
    assets: assetRows.map((a) => ({ id: a.id, publishEligible: a.publishEligible, reasons: a.eligibilityReasons })),
    missingAssetIds: assetIds.filter((id) => !assetRows.some((a) => a.id === id)),
    disclosure,
    experiment: def?.type === 'experiment.start' ? await experimentFact(tx, input.params.experimentId as string) : null,
  };
}

async function experimentFact(tx: Tx, id: string | undefined) {
  if (!id) return null;
  const [e] = await tx.select({ riskTier: experiments.riskTier, status: experiments.status }).from(experiments).where(eq(experiments.id, id));
  return e ? { riskTier: e.riskTier as 'low' | 'medium' | 'high', status: e.status } : null;
}

/** Freshness is re-derived at read time from the SLA rather than trusted from insertion time. */
export function effectiveFreshness(e: { freshnessStatus: string; freshnessSlaHours: number | null; observedAt: Date | null; retrievedAt: Date; expiresAt: Date | null }, now: Date): 'current' | 'stale' | 'unknown' {
  if (e.expiresAt && e.expiresAt <= now) return 'stale';
  if (e.freshnessSlaHours === null) return e.freshnessStatus === 'stale' ? 'stale' : (e.freshnessStatus as 'current' | 'unknown');
  const age = (now.getTime() - (e.observedAt ?? e.retrievedAt).getTime()) / 3_600_000;
  return age <= e.freshnessSlaHours ? 'current' : 'stale';
}
