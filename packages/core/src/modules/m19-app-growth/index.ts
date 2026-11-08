import { fetchSalesReport } from '@futuregrow/connectors';
import { appInstalls, appStoreReports, brandApps, consentState, customerEvents, type DbOrTx, evidenceRecords, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, record } from '../../util.js';
import { identityKey, resolveCampaignIdentities } from '../brands/index.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { ingestEventsInTransaction } from '../m02-customers/index.js';
import { appendPoints, upsertSeries } from '../m08-analytics/index.js';

/**
 * Referrer minimisation: only campaign parameters are kept. Click IDs and anything else in the
 * Play install referrer are discarded at the boundary (no fingerprinting, no cross-app joins).
 */
export const REFERRER_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export function parseInstallReferrer(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  } catch {
    return out;
  }
  for (const k of REFERRER_KEYS) {
    const v = params.get(k);
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}

export const InstallSchema = z.object({
  platform: z.enum(['ios', 'android']),
  appId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/)
    .optional(),
  installId: z.string().min(8).max(200),
  userId: z.string().min(1).max(200).optional(),
  installedAt: z.string().datetime({ offset: true }),
  /** Android: raw Play Install Referrer `installReferrer` string. */
  installReferrer: z.string().max(2000).optional(),
  referrerClickAt: z.string().datetime({ offset: true }).optional(),
  /** iOS: in-app "how did you hear about us" answer (self-reported, labelled as such). */
  selfReportedSource: z.string().max(100).optional(),
  consent: z.object({ analytics: z.boolean() }),
  context: z.object({ country: z.string().length(2).optional(), locale: z.string().max(35).optional(), timezone: z.string().max(64).optional() }).default({}),
});

/**
 * Record an install. Without analytics consent the install is counted with no campaign data and
 * no profile link. The method that produced attribution is always stored with the record.
 */
export async function recordInstall(deps: CoreDeps, tenantId: string, source: string, raw: unknown) {
  const i = InstallSchema.parse(raw);
  const now = deps.clock.now();
  if (Date.parse(i.installedAt) > now.getTime() + 300_000) throw invalid('installation timestamp is in the future');
  if (i.referrerClickAt && Date.parse(i.referrerClickAt) > Date.parse(i.installedAt)) throw invalid('referrer click must not follow installation');
  const installHash = sha256Hex(i.appId ? `${tenantId}:${i.platform}:${i.appId}:${i.installId}` : `${tenantId}:${i.installId}`);
  const messageId = i.appId ? `scoped-install:v1:${installHash}` : i.installId.length > 180 ? `legacy-install:v2:${installHash}` : `install:${i.platform}:${i.installId}`;
  const actor = systemActor('app-growth');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    // Serialise retries before identity resolution or evidence creation. Every side effect
    // commits with the install, so a crash cannot leave a partially recorded conversion.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${i.platform}:${installHash}`}, 0))`);
    const [existing] = await tx
      .select()
      .from(appInstalls)
      .where(and(eq(appInstalls.platform, i.platform), eq(appInstalls.installId, installHash)));
    if (existing) return { recorded: false, attributionMethod: existing.attributionMethod, profileLinked: Boolean(existing.profileId) };
    const consented = i.consent.analytics;
    let profileId: string | null = null;
    if (consented) {
      const res = await ingestEventsInTransaction(tx, deps, tenantId, source, [
        {
          messageId,
          event: 'app_installed',
          timestamp: i.installedAt,
          deviceId: i.appId ? `app:${installHash}` : i.installId,
          ...(i.userId ? { userId: i.userId } : {}),
          properties: { platform: i.platform, ...(i.appId ? { appId: i.appId, installHash } : {}) },
          context: { ...i.context, consent: { analytics: true } },
        },
      ]);
      profileId = res.profileIds[0] ?? null;
      if (!profileId) {
        const [ev] = await tx.select({ profileId: customerEvents.profileId }).from(customerEvents).where(eq(customerEvents.messageId, messageId));
        profileId = ev?.profileId ?? null;
      }
      if (!profileId) throw invalid('installation event did not resolve an analytics profile');
      if (!(await analyticsStateAllowsProcessing(tx, profileId, now))) throw invalid('profile analytics consent is withdrawn, denied or expired');
    }
    const referrer = consented && i.platform === 'android' && i.installReferrer ? parseInstallReferrer(i.installReferrer) : {};
    const method = !consented ? 'unattributed' : i.platform === 'android' && Object.keys(referrer).length ? 'play_install_referrer' : i.selfReportedSource ? 'self_reported' : 'unattributed';
    const evidence = consented
      ? await admitInternalEvidence(tx, tenantId, actor, {
          kind: 'observation',
          owner: source,
          uri: `app-install://${i.platform}/${i.appId ?? 'legacy'}/${installHash}`,
          content: { platform: i.platform, appId: i.appId ?? null, installHash, profileId, installedAt: i.installedAt, attributionMethod: method, referrer, source, verification: 'authenticated_backend_report' },
          summary: 'Installation reported by the authenticated application backend; not independent store verification',
          confidence: 0.8,
          license: 'tenant first-party telemetry with analytics consent',
          pii: 'pseudonymous',
          lawfulBasis: 'consent',
          permittedUses: ['analytics'],
          observedAt: new Date(i.installedAt),
          now,
        })
      : null;
    const [row] = await tx
      .insert(appInstalls)
      .values({
        tenantId,
        platform: i.platform,
        appId: i.appId ?? null,
        ingestionSource: source,
        evidenceId: evidence?.evidenceId ?? null,
        installId: installHash,
        profileId,
        installedAt: new Date(i.installedAt),
        referrerClickAt: consented && i.referrerClickAt ? new Date(i.referrerClickAt) : null,
        referrer: method === 'self_reported' ? { self_reported: i.selfReportedSource!.slice(0, 100) } : referrer,
        attributionMethod: method,
        campaignRef: referrer.utm_campaign ?? null,
        sourceRef: referrer.utm_source ?? (method === 'self_reported' ? i.selfReportedSource! : null),
        consentAnalytics: consented,
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      await record(tx, tenantId, actor, 'app.install.recorded', { type: 'app_install', id: row.id }, { platform: i.platform, appId: i.appId ?? null, method, evidenceId: evidence?.evidenceId ?? null });
    }
    return { recorded: Boolean(row), attributionMethod: method, profileLinked: Boolean(profileId) };
  });
}

/** The event object without cross-field rules (other schemas derive from it with omit/pick). */
export const AppEventBaseSchema = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/),
    platform: z.enum(['ios', 'android']),
    installId: z.string().min(8).max(200),
    eventId: z.string().min(8).max(200),
    event: z.enum(['first_open', 'activation', 'session', 'conversion']),
    occurredAt: z.string().datetime({ offset: true }),
    consent: z.object({ analytics: z.boolean() }),
    /** P3-07: the app version that reported the event (e.g. 2.2.0+7). */
    appVersion: z
      .string()
      .regex(/^[0-9A-Za-z.+_-]{1,40}$/)
      .optional(),
    /** P3-07: an optional in-app conversion (event = conversion only); no free-text or personal data. */
    conversion: z
      .object({ name: z.string().regex(/^[a-z0-9_]{2,40}$/), valueMicros: z.number().int().nonnegative().optional(), currency: z.string().length(3).optional() })
      .strict()
      .optional(),
  })
  .strict();

export const AppEventSchema = AppEventBaseSchema.refine((e) => (e.event === 'conversion') === Boolean(e.conversion), 'a conversion event needs conversion details, other events must not carry them').refine((e) => !e.conversion?.valueMicros || Boolean(e.conversion.currency), 'a conversion value needs its currency');

/** Events older than this are refused: a late batch is fine, a replayed archive is not (P3-07). */
export const MAX_APP_EVENT_AGE_DAYS = 30;

/** Server-authenticated telemetry; a first open is never inferred from an installation. */
export async function recordAppEvent(deps: CoreDeps, tenantId: string, source: string, raw: unknown) {
  const input = AppEventSchema.parse(raw);
  if (!input.consent.analytics) return { recorded: false, reason: 'analytics consent denied' };
  const now = deps.clock.now();
  const occurredAt = new Date(input.occurredAt);
  if (occurredAt.getTime() > now.getTime() + 300_000) throw invalid('event timestamp is in the future');
  if (now.getTime() - occurredAt.getTime() > MAX_APP_EVENT_AGE_DAYS * 86_400_000) throw invalid(`event is older than ${MAX_APP_EVENT_AGE_DAYS} days; it is refused as a possible replay`);
  const installHash = sha256Hex(`${tenantId}:${input.platform}:${input.appId}:${input.installId}`);
  const messageId = `app-event:${installHash}:${sha256Hex(input.eventId)}`;
  const eventName = `app_${input.event}`;
  const actor = systemActor('app-growth');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${input.platform}:${installHash}`}, 0))`);
    const [install] = await tx
      .select()
      .from(appInstalls)
      .where(and(eq(appInstalls.appId, input.appId), eq(appInstalls.platform, input.platform), eq(appInstalls.installId, installHash)))
      .for('update');
    if (!install) throw invalid('record this application installation before its events');
    if (!install.consentAnalytics || !install.profileId) return { recorded: false, reason: 'installation has no analytics consent or profile' };
    if (!(await analyticsStateAllowsProcessing(tx, install.profileId, now))) return { recorded: false, reason: 'profile analytics consent is withdrawn, denied or expired' };
    if (occurredAt < install.installedAt) throw invalid('event precedes installation');
    const [duplicate] = await tx.select().from(customerEvents).where(eq(customerEvents.messageId, messageId));
    if (duplicate) {
      if (duplicate.eventName !== eventName || duplicate.occurredAt.getTime() !== occurredAt.getTime()) throw conflict('app event ID reused with different data');
      return { recorded: false, evidenceId: duplicate.properties.evidenceId ?? null };
    }
    const evidence = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'observation',
      owner: source,
      uri: `app-event://${installHash}/${sha256Hex(input.eventId)}`,
      content: { appId: input.appId, platform: input.platform, installHash, profileId: install.profileId, event: input.event, occurredAt: input.occurredAt, verification: 'authenticated_backend_report' },
      summary: 'Consented application event reported by the authenticated backend',
      confidence: 0.8,
      license: 'tenant first-party telemetry with analytics consent',
      pii: 'pseudonymous',
      lawfulBasis: 'consent',
      permittedUses: ['analytics'],
      observedAt: occurredAt,
      now,
    });
    const result = await ingestEventsInTransaction(tx, deps, tenantId, source, [
      {
        messageId,
        event: eventName,
        timestamp: input.occurredAt,
        deviceId: `app:${installHash}`,
        properties: { appId: input.appId, platform: input.platform, installHash, evidenceId: evidence.evidenceId, ...(input.appVersion ? { appVersion: input.appVersion } : {}), ...(input.conversion ? { conversion: input.conversion.name } : {}) },
        ...(input.conversion?.valueMicros !== undefined ? { revenue: input.conversion.valueMicros / 1_000_000, currency: input.conversion.currency } : {}),
        context: { consent: { analytics: true } },
      },
    ]);
    if (result.accepted !== 1) throw invalid('application event was not accepted');
    // A late event disproves the previous completeness declaration. Keep the real event,
    // invalidate just that outcome, and require the backend to reconcile again.
    const coverage = install.eventCoverage[input.event];
    if (coverage && occurredAt < new Date(coverage.through)) {
      await tx
        .update(appInstalls)
        .set({ eventCoverage: sql`${appInstalls.eventCoverage} - ${input.event}` })
        .where(eq(appInstalls.id, install.id));
      await audit(tx, tenantId, actor, 'app.coverage.invalidated', { type: 'app_install', id: install.id }, { event: input.event, priorEvidenceId: coverage.evidenceId, eventEvidenceId: evidence.evidenceId });
    }
    return { recorded: true, evidenceId: evidence.evidenceId };
  });
}

export const AppCoverageSchema = AppEventBaseSchema.omit({ eventId: true, occurredAt: true, appVersion: true, conversion: true }).extend({
  /** Completeness is declared for the funnel events only (not conversions). */
  event: z.enum(['first_open', 'activation', 'session']),
  /** Exclusive end of a complete interval starting at installation. */
  through: z.string().datetime({ offset: true }),
  eventCount: z.number().int().min(0).max(10_000),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Reconcile a backend's explicit completeness declaration; never infer completeness from silence. */
export async function recordAppEventCoverage(deps: CoreDeps, tenantId: string, source: string, raw: unknown) {
  const input = AppCoverageSchema.parse(raw);
  if (!input.consent.analytics) throw invalid('analytics consent is required for coverage');
  const now = deps.clock.now();
  const through = new Date(input.through);
  if (through > now) throw invalid('coverage cannot include future time');
  const installHash = sha256Hex(`${tenantId}:${input.platform}:${input.appId}:${input.installId}`);
  const actor = systemActor('app-growth');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${input.platform}:${installHash}`}, 0))`);
    const [install] = await tx
      .select()
      .from(appInstalls)
      .where(and(eq(appInstalls.appId, input.appId), eq(appInstalls.platform, input.platform), eq(appInstalls.installId, installHash)))
      .for('update');
    if (!install?.consentAnalytics || !install.profileId || !install.evidenceId) throw invalid('coverage requires a consented application installation');
    if (!(await analyticsStateAllowsProcessing(tx, install.profileId, now))) throw invalid('profile analytics consent is withdrawn, denied or expired');
    if (through <= install.installedAt) throw invalid('coverage must end after installation');
    const previous = install.eventCoverage[input.event];
    if (previous && through < new Date(previous.through)) throw conflict('coverage cannot move backwards');
    const events = await tx.execute<{ message_id: string; occurred_at: string }>(sql`
      select e.message_id, e.occurred_at from customer_events e
      join evidence_records ep on ep.id::text = e.properties->>'evidenceId'
      where e.profile_id = ${install.profileId} and e.event_name = ${`app_${input.event}`}
        and e.properties->>'appId' = ${input.appId} and e.properties->>'platform' = ${input.platform}
        and e.properties->>'installHash' = ${installHash}
        and e.message_id like ${`app-event:${installHash}:%`}
        and e.occurred_at >= ${install.installedAt} and e.occurred_at < ${through}
        and ep.status = 'admitted' and ep.content is not null
        and ep.content->>'appId' = ${input.appId} and ep.content->>'installHash' = ${installHash}
        and ep.content->>'event' = ${input.event} and ep.content->>'verification' = 'authenticated_backend_report'
        and ep.observed_at = e.occurred_at and ep.source_owner = e.source
      limit 10001`);
    const digest = sha256Hex(
      events.rows
        .map((e) => `${e.message_id.split(':').at(-1)}:${new Date(e.occurred_at).toISOString()}`)
        .sort()
        .join('\n'),
    );
    if (events.rows.length !== input.eventCount || digest !== input.digest) throw conflict('coverage event count or digest does not match stored observations');
    if (previous?.through === through.toISOString() && previous.eventCount === input.eventCount && previous.digest === digest) {
      const [proof] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, previous.evidenceId));
      if (proof?.status === 'admitted' && proof.content) return { recorded: false, evidenceId: previous.evidenceId };
    }
    const evidence = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'observation',
      owner: source,
      uri: `app-coverage://${installHash}/${input.event}/${through.toISOString()}`,
      content: { appId: input.appId, platform: input.platform, installHash, profileId: install.profileId, event: input.event, from: install.installedAt.toISOString(), through: through.toISOString(), eventCount: input.eventCount, digest, verification: 'reconciled_backend_declaration' },
      summary: 'Backend-declared event completeness reconciled against stored event identities and timestamps; not independent store verification',
      confidence: 0.8,
      license: 'tenant first-party telemetry with analytics consent',
      pii: 'pseudonymous',
      lawfulBasis: 'consent',
      permittedUses: ['analytics'],
      parents: [install.evidenceId],
      observedAt: through,
      now,
    });
    await tx
      .update(appInstalls)
      .set({ eventCoverage: { ...install.eventCoverage, [input.event]: { through: through.toISOString(), eventCount: input.eventCount, digest, evidenceId: evidence.evidenceId } } })
      .where(eq(appInstalls.id, install.id));
    await audit(tx, tenantId, actor, 'app.coverage.reconciled', { type: 'app_install', id: install.id }, { event: input.event, through: through.toISOString(), evidenceId: evidence.evidenceId });
    return { recorded: true, evidenceId: evidence.evidenceId };
  });
}

export const CampaignQuerySchema = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/),
    platform: z.enum(['ios', 'android']),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    /** Only campaigns whose registered identity belongs to this brand (D-041). */
    brandId: z.string().uuid().optional(),
  })
  .strict();

export async function listApplications(tx: DbOrTx) {
  return tx.selectDistinct({ appId: appInstalls.appId, platform: appInstalls.platform }).from(appInstalls).where(isNotNull(appInstalls.appId)).orderBy(appInstalls.appId, appInstalls.platform);
}

/** Counts genuine backend observations, not total store acquisitions or causal effects. */
export async function campaignConversions(tx: DbOrTx, raw: unknown, now: Date) {
  const query = CampaignQuerySchema.parse(raw);
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (to <= from || to.getTime() - from.getTime() > 366 * 86_400_000) throw invalid('campaign interval must be positive and at most 366 days');
  const result = await tx.execute<{
    campaign: string | null;
    source: string | null;
    medium: string | null;
    content: string | null;
    method: string;
    installs: number;
    first_opens: number;
    activations: number;
    retained_w1: number;
    mature_w1: number;
    mature_7d: number;
    covered_open: number;
    covered_activation: number;
    covered_retention: number;
    complete_open: number;
    complete_activation: number;
    complete_retention: number;
    proofs: { install: string; events: string[] }[];
  }>(sql`
    with installs as (
      select i.* from app_installs i join evidence_records proof on proof.id = i.evidence_id
      where i.app_id = ${query.appId} and i.platform = ${query.platform}
        and i.installed_at >= ${from} and i.installed_at < ${to} and i.installed_at <= ${now}
        and i.consent_analytics and i.profile_id is not null and proof.status = 'admitted' and proof.content is not null
        and not exists (select 1 from consent_state cs where cs.profile_id = i.profile_id and cs.purpose = 'analytics'
          and (cs.status <> 'granted' or cs.expires_at <= ${now}))
    ), observed as (
      select i.*, events.first_open, events.activation, events.retained, events.first_open_7d, events.activation_7d,
        coverage.open and events.open_count = (i.event_coverage->'first_open'->>'eventCount')::int as open_complete,
        coverage.activation and events.activation_count = (i.event_coverage->'activation'->>'eventCount')::int as activation_complete,
        coverage.retention and events.session_count = (i.event_coverage->'session'->>'eventCount')::int as retention_complete,
        events.event_evidence_ids || coverage.evidence_ids as event_evidence_ids
      from installs i left join lateral (
        select bool_or(e.event_name = 'app_first_open') as first_open,
          bool_or(e.event_name = 'app_activation') as activation,
          bool_or(e.event_name = 'app_first_open' and e.occurred_at < i.installed_at + interval '7 days') as first_open_7d,
          bool_or(e.event_name = 'app_activation' and e.occurred_at < i.installed_at + interval '7 days') as activation_7d,
          bool_or(e.event_name = 'app_session' and e.occurred_at >= i.installed_at + interval '7 days' and e.occurred_at < i.installed_at + interval '14 days') as retained,
          count(*) filter (where e.event_name = 'app_first_open' and e.occurred_at < (i.event_coverage->'first_open'->>'through')::timestamptz) as open_count,
          count(*) filter (where e.event_name = 'app_activation' and e.occurred_at < (i.event_coverage->'activation'->>'through')::timestamptz) as activation_count,
          count(*) filter (where e.event_name = 'app_session' and e.occurred_at < (i.event_coverage->'session'->>'through')::timestamptz) as session_count,
          array_remove(ARRAY[
            min(ep.id::text) filter (where e.event_name = 'app_first_open'),
            min(ep.id::text) filter (where e.event_name = 'app_activation'),
            min(ep.id::text) filter (where e.event_name = 'app_session' and e.occurred_at >= i.installed_at + interval '7 days' and e.occurred_at < i.installed_at + interval '14 days')
          ], NULL) as event_evidence_ids
        from customer_events e join evidence_records ep on ep.id::text = e.properties->>'evidenceId'
        where e.profile_id = i.profile_id and e.properties->>'installHash' = i.install_id
          and e.properties->>'appId' = i.app_id and e.properties->>'platform' = i.platform
          and e.occurred_at >= i.installed_at and e.occurred_at <= ${now}
          and ep.status = 'admitted' and ep.content is not null
          and ep.content->>'installHash' = i.install_id and ep.content->>'appId' = i.app_id
          and ep.content->>'event' = substring(e.event_name from 5)
          and ep.content->>'verification' = 'authenticated_backend_report'
          and ep.observed_at = e.occurred_at
          and ep.source_owner = e.source
      ) events on true
      left join lateral (
        select bool_or(c.key = 'first_open' and p.observed_at >= i.installed_at + interval '7 days') as open,
          bool_or(c.key = 'activation' and p.observed_at >= i.installed_at + interval '7 days') as activation,
          bool_or(c.key = 'session' and p.observed_at >= i.installed_at + interval '14 days') as retention,
          coalesce(array_agg(p.id::text), ARRAY[]::text[]) as evidence_ids
        from jsonb_each(i.event_coverage) c join evidence_records p on p.id::text = c.value->>'evidenceId'
        where p.status = 'admitted' and p.content is not null
          and p.content->>'appId' = i.app_id and p.content->>'installHash' = i.install_id
          and p.content->>'event' = c.key and p.content->>'verification' = 'reconciled_backend_declaration'
          and p.content->>'digest' = c.value->>'digest' and p.content->>'eventCount' = c.value->>'eventCount'
          and p.observed_at = (c.value->>'through')::timestamptz and p.observed_at <= ${now}
      ) coverage on true
    ), ranked as (
      select *, row_number() over (partition by campaign_ref, source_ref, referrer->>'utm_medium', referrer->>'utm_content', attribution_method order by installed_at, id) as proof_rank from observed
    )
    select campaign_ref as campaign, source_ref as source, referrer->>'utm_medium' as medium,
      referrer->>'utm_content' as content, attribution_method as method,
      count(*)::int as installs, count(*) filter (where first_open)::int as first_opens,
      count(*) filter (where activation)::int as activations,
      count(*) filter (where installed_at + interval '14 days' <= ${now})::int as mature_w1,
      count(*) filter (where retained and installed_at + interval '14 days' <= ${now})::int as retained_w1,
      count(*) filter (where installed_at + interval '7 days' <= ${now})::int as mature_7d,
      count(*) filter (where open_complete and installed_at + interval '7 days' <= ${now})::int as covered_open,
      count(*) filter (where activation_complete and installed_at + interval '7 days' <= ${now})::int as covered_activation,
      count(*) filter (where retention_complete and installed_at + interval '14 days' <= ${now})::int as covered_retention,
      count(*) filter (where open_complete and first_open_7d and installed_at + interval '7 days' <= ${now})::int as complete_open,
      count(*) filter (where activation_complete and activation_7d and installed_at + interval '7 days' <= ${now})::int as complete_activation,
      count(*) filter (where retention_complete and retained and installed_at + interval '14 days' <= ${now})::int as complete_retention,
      jsonb_agg(jsonb_build_object('install', evidence_id, 'events', coalesce(event_evidence_ids, ARRAY[]::text[]))) filter (where proof_rank <= 50) as proofs
    from ranked group by 1,2,3,4,5 order by 1,2,3,4,5`);
  if (query.brandId) {
    const [owner] = await tx
      .select({ brandId: brandApps.brandId })
      .from(brandApps)
      .where(and(eq(brandApps.platform, query.platform), eq(brandApps.appId, query.appId)));
    if (!owner || owner.brandId !== query.brandId) throw invalid('this application is not linked to that brand');
  }
  const identities = await resolveCampaignIdentities(tx, query.platform, query.appId, result.rows);
  const rows = result.rows.filter((r) => !query.brandId || (identities.get(identityKey(r.campaign, r.content))?.status === 'registered' && identities.get(identityKey(r.campaign, r.content))?.brandId === query.brandId));
  return {
    appId: query.appId,
    platform: query.platform,
    from: query.from,
    to: query.to,
    asOf: now.toISOString(),
    ...(query.brandId ? { brandId: query.brandId } : {}),
    campaigns: rows.map((r) => ({
      campaign: r.campaign,
      /** Which brand/program/plan item/post/channel produced this link, from the campaign registry only. */
      identity: identities.get(identityKey(r.campaign, r.content))!,
      source: r.source,
      medium: r.medium,
      content: r.content,
      attributionMethod: r.method,
      metrics: { linkClicks: null, installs: r.installs, firstOpens: r.first_opens || null, activations: r.activations || null, retainedWeek1: r.retained_w1 || null },
      matureWeek1Installs: r.mature_w1,
      reconciledWindows: {
        firstOpens7d: reconciledWindow(r.mature_7d, r.covered_open, r.complete_open),
        activations7d: reconciledWindow(r.mature_7d, r.covered_activation, r.complete_activation),
        retainedWeek1: reconciledWindow(r.mature_w1, r.covered_retention, r.complete_retention),
      },
      evidenceIds: [...new Set(r.proofs.flatMap((proof) => [proof.install, ...proof.events]))],
      evidenceReferencesTruncated: r.installs > 50,
      coverage: 'observed_events_only',
    })),
    notes: [
      'Counts are consented, evidence-backed backend observations. An authenticated sender is not independent Google Play verification. Attribution describes the supplied campaign, not causal impact.',
      'Unobserved outcomes are unavailable, not zero. Reconciled windows report a value only when every mature install has a matching backend completeness declaration; these declarations do not prove device instrumentation or total store coverage. Late events invalidate affected declarations. No conversion rates or statistical winners are inferred.',
      'Clicks, unscoped legacy installs, non-consented records and other applications are excluded. Empty campaigns mean no supported observations, not zero store acquisitions.',
      'Content identity comes only from the campaign registry (links the studio registered for a brand-linked application). Unregistered campaigns are not assigned to a Page or post from their UTM labels.',
    ],
  };
}

function reconciledWindow(eligibleInstalls: number, reconciledInstalls: number, positives: number) {
  const complete = eligibleInstalls > 0 && reconciledInstalls === eligibleInstalls;
  return { eligibleInstalls, reconciledInstalls, complete, value: complete ? positives : null, basis: 'reconciled_backend_declaration' };
}

/** Payload consent cannot override a recorded withdrawal or expired grant. */
async function analyticsStateAllowsProcessing(tx: Tx, profileId: string, now: Date) {
  const [state] = await tx
    .select()
    .from(consentState)
    .where(and(eq(consentState.profileId, profileId), eq(consentState.purpose, 'analytics')))
    .for('share');
  return !state || (state.status === 'granted' && (!state.expiresAt || state.expiresAt > now));
}

/* ------------------------------------------------------------------ */
/* App Store Connect sales reports                                     */
/* ------------------------------------------------------------------ */

/** Product Type Identifiers that are first-time downloads in Apple Sales reports. */
export const FIRST_TIME_DOWNLOAD_TYPES = new Set(['1', '1F', '1T', 'F1', '1E', '1EP', '1EU']);

export function summarizeSalesReport(header: string[], rows: string[][]) {
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const iType = col('Product Type Identifier');
  const iUnits = col('Units');
  const iCountry = col('Country Code');
  const iSku = col('SKU');
  if (iType < 0 || iUnits < 0) throw invalid('sales report is missing Product Type Identifier / Units columns');
  let downloads = 0;
  const byCountry: Record<string, number> = {};
  const bySku: Record<string, number> = {};
  for (const r of rows) {
    if (!FIRST_TIME_DOWNLOAD_TYPES.has((r[iType] ?? '').trim())) continue;
    const u = Number(r[iUnits] ?? 0);
    if (!Number.isFinite(u)) continue;
    downloads += u;
    const c = iCountry >= 0 ? (r[iCountry] ?? '??') : '??';
    byCountry[c] = (byCountry[c] ?? 0) + u;
    const s = iSku >= 0 ? (r[iSku] ?? '?') : '?';
    bySku[s] = (bySku[s] ?? 0) + u;
  }
  return { firstTimeDownloads: downloads, byCountry, bySku, rows: rows.length };
}

export async function syncAppStoreSales(deps: CoreDeps, tenantId: string, connectionId: string, reportDate: string) {
  const { ctx } = await readContext(deps, tenantId, connectionId, 'app_store_connect');
  const report = await fetchSalesReport(ctx, reportDate);
  const summary = summarizeSalesReport(report.header, report.rows);
  const sha = sha256Hex(report.bytes);
  const key = tenantKey(tenantId, 'reports', 'app-store', `${reportDate}-${sha.slice(0, 12)}.tsv.gz`);
  await deps.store.put(key, report.bytes, 'application/gzip');
  const actor = systemActor('app-store-sync');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'metric',
      sourceType: 'primary',
      owner: 'app_store_connect',
      uri: `asc://sales/DAILY/SUMMARY/${reportDate}#${sha}`,
      content: { reportDate, objectKey: key, sha256: sha, ...summary },
      summary: `App Store sales ${reportDate}: ${summary.firstTimeDownloads} first-time downloads`,
      confidence: 1,
      license: 'App Store Connect API terms (account holder data)',
      permittedUses: ['analytics', 'forecasting', 'causal_measurement'],
      externalPlatformTerms: 'app_store_connect',
      observedAt: new Date(`${reportDate}T23:59:59Z`),
      freshnessSlaHours: 72,
      now: deps.clock.now(),
    });
    const [row] = await tx
      .insert(appStoreReports)
      .values({ tenantId, connectionId, reportType: 'SALES_SUMMARY_DAILY', period: reportDate, objectKey: key, sha256: sha, rowCount: report.rows.length, evidenceId: ev.evidenceId })
      .onConflictDoUpdate({ target: [appStoreReports.tenantId, appStoreReports.connectionId, appStoreReports.reportType, appStoreReports.period], set: { objectKey: key, sha256: sha, rowCount: report.rows.length, evidenceId: ev.evidenceId, fetchedAt: deps.clock.now() } })
      .returning();
    return { report: row!, summary, evidenceId: ev.evidenceId };
  });
}

/* ------------------------------------------------------------------ */
/* Cohorts                                                             */
/* ------------------------------------------------------------------ */

/**
 * Weekly install cohorts by attribution method and source, with activation within 7 days and
 * week-1..4 retention (any first-party event in that week). Profiles without analytics consent
 * appear in install counts only.
 */
export async function acquisitionCohorts(tx: DbOrTx, args: { from: Date; to: Date; activationEvent: string }) {
  if (!/^[A-Za-z0-9_.:\- ]{1,200}$/.test(args.activationEvent)) throw invalid('invalid activation event name');
  const r = await tx.execute<{
    cohort_week: string;
    platform: string;
    attribution_method: string;
    source_ref: string | null;
    installs: number;
    linked: number;
    activated_7d: number;
    retained_w1: number;
    retained_w2: number;
    retained_w4: number;
  }>(sql`
    with i as (
      select date_trunc('week', installed_at) as cohort_week, platform, attribution_method, source_ref, profile_id, installed_at
      from app_installs where installed_at >= ${args.from} and installed_at < ${args.to}
    )
    select to_char(cohort_week, 'YYYY-MM-DD') as cohort_week, platform, attribution_method, source_ref,
      count(*)::int as installs,
      count(profile_id)::int as linked,
      count(*) filter (where exists (select 1 from customer_events e where e.profile_id = i.profile_id and e.event_name = ${args.activationEvent}
        and e.occurred_at >= i.installed_at and e.occurred_at < i.installed_at + interval '7 days'))::int as activated_7d,
      count(*) filter (where exists (select 1 from customer_events e where e.profile_id = i.profile_id and e.event_name <> 'app_installed'
        and e.occurred_at >= i.installed_at + interval '7 days' and e.occurred_at < i.installed_at + interval '14 days'))::int as retained_w1,
      count(*) filter (where exists (select 1 from customer_events e where e.profile_id = i.profile_id and e.event_name <> 'app_installed'
        and e.occurred_at >= i.installed_at + interval '14 days' and e.occurred_at < i.installed_at + interval '21 days'))::int as retained_w2,
      count(*) filter (where exists (select 1 from customer_events e where e.profile_id = i.profile_id and e.event_name <> 'app_installed'
        and e.occurred_at >= i.installed_at + interval '28 days' and e.occurred_at < i.installed_at + interval '35 days'))::int as retained_w4
    from i group by 1, 2, 3, 4 order by 1, 2, 3, 4`);
  return {
    cohorts: r.rows.map((c) => ({ ...c, activationRate: c.linked ? c.activated_7d / c.linked : null, w1Retention: c.linked ? c.retained_w1 / c.linked : null })),
    note: 'Attribution labels describe how an install was attributed (referrer, self-report, none). They are not causal effects; use experiments or MMM for incrementality. Rates use consented, profile-linked installs as the denominator.',
  };
}

export async function installStats(tx: DbOrTx) {
  const r = await tx.execute<{ platform: string; attribution_method: string; n: number }>(sql`select platform, attribution_method, count(*)::int as n from app_installs group by 1, 2 order by 1, 2`);
  return r.rows;
}

export async function listReports(tx: DbOrTx) {
  return tx.select().from(appStoreReports).orderBy(desc(appStoreReports.period)).limit(400);
}

/** M08 series key for App Store first-time downloads, fed from the daily sales reports. */
export const DOWNLOADS_SERIES_KEY = 'app.downloads.first_time';

/**
 * Bridge App Store sales reports into an M08 KPI series (one point per report day, each backed by
 * the report's evidence), so forecasts and the Growth Brain can use downloads. Idempotent: points
 * are upserted by day. Returns null when no report has been synced yet.
 */
export async function syncDownloadsSeries(tx: Tx, tenantId: string): Promise<{ seriesId: string; points: number } | null> {
  const rows = await tx
    .select({ period: appStoreReports.period, evidenceId: appStoreReports.evidenceId, content: evidenceRecords.content })
    .from(appStoreReports)
    .innerJoin(evidenceRecords, eq(evidenceRecords.id, appStoreReports.evidenceId))
    .where(eq(appStoreReports.reportType, 'SALES_SUMMARY_DAILY'))
    .orderBy(asc(appStoreReports.period));
  const pts = rows.map((r) => ({ ts: `${r.period}T00:00:00Z`, value: Number((r.content as { firstTimeDownloads?: unknown } | null)?.firstTimeDownloads), evidenceId: r.evidenceId })).filter((p) => /^\d{4}-\d{2}-\d{2}T/.test(p.ts) && Number.isFinite(p.value));
  if (!pts.length) return null;
  const actor = systemActor('app-store-sync');
  const series = await upsertSeries(tx, tenantId, actor, { key: DOWNLOADS_SERIES_KEY, name: 'App Store first-time downloads', unit: 'downloads', granularity: 'day', kind: 'kpi', channel: 'app_store', sourceEvidenceId: pts[pts.length - 1]!.evidenceId });
  await appendPoints(tx, tenantId, series.id, pts);
  return { seriesId: series.id, points: pts.length };
}

export * as attribution from './attribution.js';
