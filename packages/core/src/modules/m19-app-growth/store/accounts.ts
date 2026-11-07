import { createAnalyticsReportRequest, listAnalyticsReportRequests, normalizeReportBucket, type ProviderCredentials, parseServiceAccountKey, probePlayAccess, READ_CONNECTORS } from '@futuregrow/connectors';
import { connections, storeAccounts, storeApps, type Tx, withTenant } from '@futuregrow/db';
import { conflict, FgError, invalid, notFound } from '@futuregrow/observability';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../../deps.js';
import { storeCredentials } from '../../../secrets.js';
import { ADMIN_ROLES, audit, requireMfa, requireRole } from '../../../util.js';
import { readContext } from '../../connections.js';
import { connectorContext } from '../../m23-execution/gateway.js';
import { PLAY_FAMILIES } from './definitions.js';

export const STORE_SYNC_TASK = 'store_account_sync';
const SYSTEM = systemActor('store-reporting');
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;

export const AccountSettingsSchema = z
  .object({
    /** Months of Play history to import (Google keeps monthly files for the account's lifetime). */
    backfillMonths: z.number().int().min(1).max(60).default(24),
    /** Play report dimensions to import, per family (defaults from the registry). */
    dimensions: z.record(z.string(), z.array(z.string().regex(/^[a-z_]{2,30}$/)).max(10)).optional(),
    /** Android vitals from the Play Developer Reporting API (crash and ANR rates). */
    vitals: z.boolean().default(true),
    /** Confirm apps found in the account's own report source without an owner click. */
    autoConfirm: z.boolean().default(true),
  })
  .strict();
export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

export const ConnectPlaySchema = z
  .object({
    provider: z.literal('google_play'),
    displayName: z.string().trim().min(1).max(200),
    /** The Play Console "Copy Cloud Storage URI" value (gs://pubsite_prod_…). */
    bucket: z.string().trim().min(10).max(300),
    /** The service account key file (JSON) exactly as downloaded from Google Cloud. */
    serviceAccountKey: z.union([z.string().min(20).max(20_000), z.record(z.string(), z.unknown())]),
    settings: AccountSettingsSchema.partial().default({}),
  })
  .strict();

export const ConnectAppleSchema = z
  .object({
    provider: z.literal('app_store_connect'),
    /** Reuse an existing App Store Connect connection (its key and team). */
    connectionId: z.string().uuid().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    issuerId: z.string().uuid().optional(),
    keyId: z
      .string()
      .regex(/^[A-Z0-9]{8,12}$/)
      .optional(),
    privateKeyPem: z.string().min(100).max(10_000).optional(),
    vendorNumber: z
      .string()
      .regex(/^\d{5,12}$/)
      .optional(),
    settings: AccountSettingsSchema.partial().default({}),
  })
  .strict();

export const ConnectAccountSchema = z.discriminatedUnion('provider', [ConnectPlaySchema, ConnectAppleSchema]);

type AccountRow = typeof storeAccounts.$inferSelect;
type AppRow = typeof storeApps.$inferSelect;

export interface AccountWarning {
  code: 'PLAY_REPORTING_API_DISABLED' | 'PLAY_REPORTING_API_PERMISSION_DENIED' | 'PLAY_REPORTING_API_UNAVAILABLE';
  severity: 'warning';
  /** The account keeps importing bulk reports; only the optional surface is missing. */
  blocking: false;
  title: string;
  detail: string;
  action: string;
}

/**
 * Non-blocking problems of the optional Play Developer Reporting API (B-023), from the last
 * sync's health detail (or the connect-time probe before the first sync). Bulk reports keep
 * importing; app names and vitals (crash and ANR rates) stay unavailable and are never estimated.
 */
export function accountWarnings(a: Pick<AccountRow, 'provider' | 'healthDetail'>): AccountWarning[] {
  const d = (a.healthDetail ?? {}) as { reporting?: string; reportingReason?: string | null; reportingError?: string | null; reportingHttpStatus?: number | null };
  const state = d.reporting ?? (d.reportingError ? (d.reportingHttpStatus === 403 ? 'permission_denied' : 'error') : 'ok');
  if (a.provider !== 'google_play' || state === 'ok') return [];
  const detail = 'Bulk reports (installs, uninstalls, store listing visitors and acquisitions, sources, campaigns, ratings) import normally. App names and crash and ANR rates come only from this API, so they stay unavailable: never estimated and never shown as zero.';
  const next = 'The next daily sync picks the change up; no new key or role is needed.';
  if (d.reportingReason === 'SERVICE_DISABLED' || d.reportingReason === 'accessNotConfigured')
    return [{ code: 'PLAY_REPORTING_API_DISABLED', severity: 'warning', blocking: false, title: 'Optional Google Play Developer Reporting API is not enabled', detail, action: `In Google Cloud, enable the "Google Play Developer Reporting API" in the service account's project. ${next}` }];
  if (state === 'permission_denied')
    return [
      {
        code: 'PLAY_REPORTING_API_PERMISSION_DENIED',
        severity: 'warning',
        blocking: false,
        title: 'Optional Google Play Developer Reporting API: permission denied',
        detail,
        action: `In Google Cloud, enable the "Google Play Developer Reporting API" in the service account's project, and in Play Console › Users and permissions confirm the service account has "View app information" for these apps. ${next}`,
      },
    ];
  return [{ code: 'PLAY_REPORTING_API_UNAVAILABLE', severity: 'warning', blocking: false, title: 'Optional Google Play Developer Reporting API was unavailable at the last sync', detail, action: 'Nothing to do now: the next daily sync tries again.' }];
}

/** Public view: never includes credentials or raw provider errors with secrets. */
export function accountView(a: AccountRow) {
  return {
    id: a.id,
    connectionId: a.connectionId,
    provider: a.provider,
    accountRef: a.accountRef,
    displayName: a.displayName,
    status: a.status,
    health: a.healthStatus,
    healthDetail: a.healthDetail,
    healthCheckedAt: a.healthCheckedAt?.toISOString() ?? null,
    warnings: accountWarnings(a),
    settings: AccountSettingsSchema.parse(a.settings ?? {}),
    lastSyncStartedAt: a.lastSyncStartedAt?.toISOString() ?? null,
    lastSyncFinishedAt: a.lastSyncFinishedAt?.toISOString() ?? null,
    lastSuccessAt: a.lastSuccessAt?.toISOString() ?? null,
    nextSyncAt: a.nextSyncAt?.toISOString() ?? null,
    consecutiveFailures: a.consecutiveFailures,
    backfillPending: a.backfillCursor !== null,
    syncing: Boolean(a.leaseUntil && a.leaseOwner),
    createdAt: a.createdAt.toISOString(),
  };
}

export function appView(a: AppRow) {
  return {
    id: a.id,
    storeAccountId: a.storeAccountId,
    platform: a.platform,
    appId: a.appId,
    storeAppId: a.storeAppId,
    displayName: a.displayName,
    status: a.status,
    discoveredVia: a.discoveredVia,
    firstSeenAt: a.firstSeenAt.toISOString(),
    lastSeenAt: a.lastSeenAt.toISOString(),
    confirmedAt: a.confirmedAt?.toISOString() ?? null,
    conflict: a.conflictDetail,
    analytics: (a.settings as { analytics?: unknown }).analytics ?? null,
  };
}

type PlayProbe = Awaited<ReturnType<typeof probePlayAccess>>;

/**
 * A distinct, actionable error per bulk-report failure (key rejected, bucket missing, permission,
 * rate limit, Google unreachable) instead of one generic message. Details carry only the access
 * state, HTTP status and the Reporting API state; never key material.
 */
function playAccessError(probe: PlayProbe, serviceAccount: string): FgError {
  const details = { provider: 'google_play', reports: probe.reports, httpStatus: probe.details.reportsHttpStatus ?? null, reporting: probe.reporting, reportingError: probe.details.reportingError ?? null, reportingReason: probe.details.reportingReason ?? null };
  switch (probe.reports) {
    case 'auth_failed':
      return new FgError('PROVIDER_AUTH_FAILED', 'Google rejected this service account key (deleted, disabled or rotated). Create a new JSON key for the service account and try again.', 422, details);
    case 'not_found':
      return new FgError('PROVIDER_NOT_FOUND', 'The report bucket was not found. In Play Console open Download reports › Statistics and use "Copy Cloud Storage URI".', 422, details);
    case 'permission_denied':
      return new FgError('PROVIDER_PERMISSION_DENIED', `The service account ${serviceAccount} cannot read this bucket. In Play Console › Users and permissions, invite it with "View app information" (Global), then wait up to 24 hours for access to apply.`, 422, details);
    case 'rate_limited':
      return new FgError('PROVIDER_RATE_LIMITED', 'Google is rate-limiting this service account. Nothing was saved; try again in a few minutes.', 429, details);
    default:
      return new FgError('PROVIDER_UNAVAILABLE', `Google could not be reached or failed (${String(probe.details.reportsError ?? 'unknown error')}). Nothing was saved; try again shortly.`, 502, details);
  }
}

async function enqueueSync(deps: CoreDeps, tenantId: string, accountId: string, mode: 'discovery' | 'incremental' | 'backfill', runAt?: Date) {
  await deps.jobs.add(STORE_SYNC_TASK, { tenantId, accountId, mode }, { jobKey: `store-sync:${accountId}`, maxAttempts: 3, ...(runAt ? { runAt } : {}) });
}

/**
 * Connects a developer account. Credentials are checked with read-only calls *before* anything is
 * stored, so a wrong key or missing Play permission fails here with the setup step to fix.
 */
export async function connectStoreAccount(deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ADMIN_ROLES, 'connecting a developer account');
  requireMfa(actor, 'connecting a developer account');
  const input = ConnectAccountSchema.parse(raw);
  const settings = AccountSettingsSchema.parse(input.settings ?? {});
  if (input.provider === 'google_play') {
    const key = (() => {
      try {
        return parseServiceAccountKey(input.serviceAccountKey);
      } catch (err) {
        throw invalid((err as Error).message);
      }
    })();
    const bucket = (() => {
      try {
        return normalizeReportBucket(input.bucket);
      } catch (err) {
        throw invalid((err as Error).message);
      }
    })();
    const creds: ProviderCredentials = { provider: 'google_play', clientEmail: key.clientEmail, privateKeyPem: key.privateKeyPem, privateKeyId: key.privateKeyId, projectId: key.projectId };
    const probeConn = { id: 'store-account-test', provider: 'google_play', externalAccountId: bucket, metadata: { bucket }, appAudited: null } as unknown as typeof connections.$inferSelect;
    const probe = await probePlayAccess(connectorContext(deps, tenantId, creds, probeConn), bucket);
    await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (t) => audit(t, tenantId, actor, 'store.account.tested', { type: 'store_account', id: `google_play:${bucket}` }, { reports: probe.reports, reporting: probe.reporting }));
    if (probe.reports !== 'ok') throw playAccessError(probe, key.clientEmail);
    return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
      const [conn] = await t
        .insert(connections)
        .values({
          tenantId,
          provider: 'google_play',
          externalAccountId: bucket,
          displayName: input.displayName,
          grantedScopes: ['https://www.googleapis.com/auth/devstorage.read_only', ...(probe.reporting === 'ok' ? ['https://www.googleapis.com/auth/playdeveloperreporting'] : [])],
          accessLevel: 'read_only',
          appAudited: null,
          apiVersion: null,
          metadata: { bucket, serviceAccount: key.clientEmail, projectId: key.projectId },
          createdBy: actorRef(actor),
          healthStatus: probe.reporting === 'ok' ? 'healthy' : 'degraded',
          lastHealthCheckAt: deps.clock.now(),
        })
        .onConflictDoNothing()
        .returning();
      if (!conn) throw conflict('this report bucket is already connected; use Reconnect to replace its key');
      await storeCredentials(t, deps.config, tenantId, conn.id, creds, null);
      await audit(t, tenantId, actor, 'connector.connection.created', { type: 'connection', id: conn.id }, { provider: 'google_play', externalAccountId: bucket, scopes: conn.grantedScopes });
      const [acct] = await t
        .insert(storeAccounts)
        .values({ tenantId, connectionId: conn.id, provider: 'google_play', accountRef: bucket, displayName: input.displayName, settings, healthStatus: 'ok', healthDetail: probe.details, healthCheckedAt: deps.clock.now(), nextSyncAt: deps.clock.now(), backfillCursor: 'pending', createdBy: actorRef(actor) })
        .returning();
      await audit(t, tenantId, actor, 'store.account.connected', { type: 'store_account', id: acct!.id }, { provider: 'google_play', bucket, serviceAccount: key.clientEmail, reporting: probe.reporting });
      await enqueueSync(deps, tenantId, acct!.id, 'discovery');
      return accountView(acct!);
    });
  }
  // App Store Connect: reuse a connection or create one from a key.
  let connectionId = input.connectionId;
  if (!connectionId) {
    if (!input.issuerId || !input.keyId || !input.privateKeyPem) throw invalid('provide connectionId, or issuerId + keyId + privateKeyPem of an App Store Connect API key');
    const creds: ProviderCredentials = { provider: 'app_store_connect', issuerId: input.issuerId, keyId: input.keyId, privateKeyPem: input.privateKeyPem, ...(input.vendorNumber ? { vendorNumber: input.vendorNumber } : {}) };
    const probeConn = { id: 'store-account-test', provider: 'app_store_connect', externalAccountId: input.issuerId, metadata: {}, appAudited: null } as unknown as typeof connections.$inferSelect;
    const health = await READ_CONNECTORS.app_store_connect!.healthCheck(connectorContext(deps, tenantId, creds, probeConn));
    if (!health.healthy) throw invalid('App Store Connect rejected this API key. Check the issuer ID, key ID and the .p8 file, and that the key is active.');
    connectionId = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
      const [conn] = await t
        .insert(connections)
        .values({
          tenantId,
          provider: 'app_store_connect',
          externalAccountId: input.issuerId!,
          displayName: input.displayName ?? 'App Store Connect',
          grantedScopes: [],
          accessLevel: null,
          appAudited: null,
          apiVersion: null,
          metadata: { keyId: input.keyId },
          createdBy: actorRef(actor),
          healthStatus: 'healthy',
          lastHealthCheckAt: deps.clock.now(),
        })
        .onConflictDoNothing()
        .returning();
      if (!conn) throw conflict('this App Store Connect issuer is already connected; reuse that connection');
      await storeCredentials(t, deps.config, tenantId, conn.id, creds, null);
      await audit(t, tenantId, actor, 'connector.connection.created', { type: 'connection', id: conn.id }, { provider: 'app_store_connect', externalAccountId: input.issuerId });
      return conn.id;
    });
  }
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const [conn] = await t.select().from(connections).where(eq(connections.id, connectionId!));
    if (!conn) throw notFound('connection');
    if (conn.provider !== 'app_store_connect') throw invalid(`connection is ${conn.provider}, expected app_store_connect`);
    const [acct] = await t
      .insert(storeAccounts)
      .values({ tenantId, connectionId: conn.id, provider: 'app_store_connect', accountRef: conn.externalAccountId, displayName: input.displayName ?? conn.displayName, settings, nextSyncAt: deps.clock.now(), backfillCursor: 'pending', createdBy: actorRef(actor) })
      .onConflictDoNothing()
      .returning();
    if (!acct) throw conflict('this App Store Connect account is already set up for reporting');
    await audit(t, tenantId, actor, 'store.account.connected', { type: 'store_account', id: acct.id }, { provider: 'app_store_connect', connectionId: conn.id });
    await enqueueSync(deps, tenantId, acct.id, 'discovery');
    return accountView(acct);
  });
}

export async function listStoreAccounts(t: Tx) {
  return (await t.select().from(storeAccounts).orderBy(storeAccounts.createdAt)).map(accountView);
}

async function account(t: Tx, id: string) {
  const [a] = await t.select().from(storeAccounts).where(eq(storeAccounts.id, id));
  if (!a) throw notFound('developer account');
  return a;
}

export const AccountUpdateSchema = z.object({ status: z.enum(['active', 'disabled']).optional(), displayName: z.string().trim().min(1).max(200).optional(), settings: AccountSettingsSchema.partial().optional() }).strict();

/** Disable/enable, rename or change import settings. Disabling stops syncs; data stays. */
export async function updateStoreAccount(deps: CoreDeps, tenantId: string, actor: Actor, id: string, raw: unknown) {
  requireRole(actor, ADMIN_ROLES, 'changing a developer account');
  const input = AccountUpdateSchema.parse(raw);
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const a = await account(t, id);
    const settings = input.settings ? AccountSettingsSchema.parse({ ...a.settings, ...input.settings }) : a.settings;
    const [u] = await t
      .update(storeAccounts)
      .set({ ...(input.status ? { status: input.status } : {}), ...(input.displayName ? { displayName: input.displayName } : {}), settings, ...(input.status === 'active' && a.status !== 'active' ? { nextSyncAt: deps.clock.now(), consecutiveFailures: 0 } : {}), updatedAt: deps.clock.now() })
      .where(eq(storeAccounts.id, id))
      .returning();
    await audit(t, tenantId, actor, 'store.account.updated', { type: 'store_account', id }, { status: input.status ?? null, settingsChanged: Boolean(input.settings), renamed: Boolean(input.displayName) });
    if (input.status === 'active' && a.status !== 'active') await enqueueSync(deps, tenantId, id, 'incremental');
    return accountView(u!);
  });
}

export const SyncRequestSchema = z.object({ mode: z.enum(['discovery', 'incremental', 'backfill']).default('incremental') }).strict();

/** Manual "sync now" / "backfill": queued (deduplicated per account), never run inline. */
export async function requestStoreSync(deps: CoreDeps, tenantId: string, actor: Actor, id: string, raw: unknown) {
  requireRole(actor, [...ADMIN_ROLES, 'growth_operator'], 'syncing store reports');
  const { mode } = SyncRequestSchema.parse(raw ?? {});
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const a = await account(t, id);
    if (a.status !== 'active') throw invalid('the developer account is disabled; enable it first');
    await t
      .update(storeAccounts)
      .set({ nextSyncAt: deps.clock.now(), ...(mode === 'backfill' ? { backfillCursor: 'pending' } : {}), updatedAt: deps.clock.now() })
      .where(eq(storeAccounts.id, id));
    await audit(t, tenantId, actor, 'store.sync.requested', { type: 'store_account', id }, { mode });
    await enqueueSync(deps, tenantId, id, mode);
    return { queued: true, mode };
  });
}

export const RotatePlayKeySchema = z.object({ serviceAccountKey: z.union([z.string().min(20).max(20_000), z.record(z.string(), z.unknown())]) }).strict();

/**
 * Replaces the service-account key of a Google Play developer account in place. The new key is
 * tested read-only against the account's own report bucket before anything is stored, then saved
 * encrypted on the same connection: the account, its apps, imported reports and KPI history keep
 * their identity (no second account, nothing re-imported). Admin with two-factor only.
 */
export async function rotateStoreAccountKey(deps: CoreDeps, tenantId: string, actor: Actor, id: string, raw: unknown) {
  requireRole(actor, ADMIN_ROLES, 'replacing a developer account key');
  requireMfa(actor, 'replacing a developer account key');
  const input = RotatePlayKeySchema.parse(raw);
  const { a, conn } = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const a = await account(t, id);
    const [conn] = await t.select().from(connections).where(eq(connections.id, a.connectionId));
    return { a, conn };
  });
  if (a.provider !== 'google_play' || !conn) throw invalid('only a Google Play developer account key is replaced here; replace an App Store Connect key in Connections');
  const key = (() => {
    try {
      return parseServiceAccountKey(input.serviceAccountKey);
    } catch (err) {
      throw invalid((err as Error).message);
    }
  })();
  const creds: ProviderCredentials = { provider: 'google_play', clientEmail: key.clientEmail, privateKeyPem: key.privateKeyPem, privateKeyId: key.privateKeyId, projectId: key.projectId };
  const probe = await probePlayAccess(connectorContext(deps, tenantId, creds, conn), a.accountRef);
  await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (t) => audit(t, tenantId, actor, 'store.account.tested', { type: 'store_account', id }, { reports: probe.reports, reporting: probe.reporting, rotation: true }));
  if (probe.reports !== 'ok') throw playAccessError(probe, key.clientEmail);
  const now = deps.clock.now();
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    await storeCredentials(t, deps.config, tenantId, conn.id, creds, null);
    await t
      .update(connections)
      .set({
        status: 'active',
        metadata: { ...conn.metadata, serviceAccount: key.clientEmail, projectId: key.projectId },
        grantedScopes: ['https://www.googleapis.com/auth/devstorage.read_only', ...(probe.reporting === 'ok' ? ['https://www.googleapis.com/auth/playdeveloperreporting'] : [])],
        healthStatus: probe.reporting === 'ok' ? 'healthy' : 'degraded',
        lastHealthCheckAt: now,
        updatedAt: now,
      })
      .where(eq(connections.id, conn.id));
    const [u] = await t.update(storeAccounts).set({ healthStatus: 'ok', healthDetail: probe.details, healthCheckedAt: now, consecutiveFailures: 0, nextSyncAt: now, updatedAt: now }).where(eq(storeAccounts.id, id)).returning();
    await audit(t, tenantId, actor, 'connector.connection.credentials_rotated', { type: 'connection', id: conn.id }, { provider: 'google_play', serviceAccount: key.clientEmail });
    await audit(t, tenantId, actor, 'store.account.key_rotated', { type: 'store_account', id }, { previousServiceAccount: (conn.metadata as { serviceAccount?: string }).serviceAccount ?? null, serviceAccount: key.clientEmail, reporting: probe.reporting });
    if (a.status === 'active') await enqueueSync(deps, tenantId, id, 'incremental');
    return accountView(u!);
  });
}

/* ------------------------------------------------------------------ */
/* Apps                                                                */
/* ------------------------------------------------------------------ */

export async function listStoreApps(t: Tx, filter: { accountId?: string } = {}) {
  const rows = await t
    .select()
    .from(storeApps)
    .where(filter.accountId ? eq(storeApps.storeAccountId, filter.accountId) : undefined)
    .orderBy(storeApps.platform, storeApps.appId);
  return rows.map(appView);
}

/**
 * Upserts an app seen in an account's reports or API. Apps found in the account's own report
 * source are confirmed automatically (when allowed) unless another account of this organization
 * already reports the same app; that case becomes a `conflict` for the owner to resolve.
 */
export async function upsertDiscoveredApp(t: Tx, tenantId: string, a: AccountRow, app: { platform: 'android' | 'ios'; appId: string; storeAppId?: string | null; displayName?: string | null; via: string; reliable: boolean }, now: Date) {
  const valid = app.platform === 'android' ? PACKAGE_NAME.test(app.appId) : BUNDLE_ID.test(app.appId);
  if (!valid) return null;
  await t
    .insert(storeApps)
    .values({ tenantId, storeAccountId: a.id, platform: app.platform, appId: app.appId, storeAppId: app.storeAppId ?? null, displayName: app.displayName ?? null, status: 'discovered', discoveredVia: [app.via], firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [storeApps.tenantId, storeApps.storeAccountId, storeApps.platform, storeApps.appId],
      set: {
        lastSeenAt: now,
        displayName: sql`coalesce(${storeApps.displayName}, excluded.display_name)`,
        storeAppId: sql`coalesce(${storeApps.storeAppId}, excluded.store_app_id)`,
        discoveredVia: sql`(select array_agg(distinct v order by v) from unnest(${storeApps.discoveredVia} || excluded.discovered_via) v)`,
        updatedAt: now,
      },
    });
  const [row] = await t
    .select()
    .from(storeApps)
    .where(and(eq(storeApps.storeAccountId, a.id), eq(storeApps.platform, app.platform), eq(storeApps.appId, app.appId)))
    .for('update');
  if (row?.status !== 'discovered') return row ?? null;
  const [owner] = await t
    .select({ id: storeApps.id, storeAccountId: storeApps.storeAccountId })
    .from(storeApps)
    .where(and(eq(storeApps.platform, app.platform), eq(storeApps.appId, app.appId), eq(storeApps.status, 'confirmed'), ne(storeApps.id, row.id)));
  if (owner) {
    const [u] = await t
      .update(storeApps)
      .set({ status: 'conflict', conflictDetail: { reason: 'already reported by another developer account', confirmedUnderAccountId: owner.storeAccountId, detectedAt: now.toISOString() }, updatedAt: now })
      .where(eq(storeApps.id, row.id))
      .returning();
    await audit(t, tenantId, SYSTEM, 'store.app.conflict', { type: 'store_app', id: row.id }, { appId: app.appId, platform: app.platform, otherAccountId: owner.storeAccountId });
    return u!;
  }
  const settings = AccountSettingsSchema.parse(a.settings ?? {});
  if (app.reliable && settings.autoConfirm) {
    const [u] = await t
      .update(storeApps)
      .set({ status: 'confirmed', confirmedBy: `system:discovery:${app.via}`, confirmedAt: now, updatedAt: now })
      .where(eq(storeApps.id, row.id))
      .returning();
    await audit(t, tenantId, SYSTEM, 'store.app.confirmed', { type: 'store_app', id: row.id }, { appId: app.appId, platform: app.platform, via: app.via, automatic: true });
    return u!;
  }
  return row;
}

export const AppDecisionSchema = z.object({ decision: z.enum(['confirm', 'ignore', 'take_over']) }).strict();

/**
 * Owner decision on an app. `take_over` resolves a conflict in favour of this account: the other
 * account's app is set to ignored (its imported history stays with it; nothing is reassigned).
 */
export async function decideStoreApp(deps: CoreDeps, tenantId: string, actor: Actor, appRowId: string, raw: unknown) {
  requireRole(actor, ADMIN_ROLES, 'confirming store apps');
  const { decision } = AppDecisionSchema.parse(raw);
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const [row] = await t.select().from(storeApps).where(eq(storeApps.id, appRowId)).for('update');
    if (!row) throw notFound('store app');
    const now = deps.clock.now();
    if (decision === 'ignore') {
      const [u] = await t.update(storeApps).set({ status: 'ignored', updatedAt: now }).where(eq(storeApps.id, row.id)).returning();
      await audit(t, tenantId, actor, 'store.app.ignored', { type: 'store_app', id: row.id }, { appId: row.appId, platform: row.platform });
      // The follow-up sync reconciles the KPI series (an ignored app's values leave the all-apps totals).
      await enqueueSync(deps, tenantId, row.storeAccountId, 'incremental');
      return appView(u!);
    }
    const others = await t
      .select()
      .from(storeApps)
      .where(and(eq(storeApps.platform, row.platform), eq(storeApps.appId, row.appId), eq(storeApps.status, 'confirmed'), ne(storeApps.id, row.id)));
    if (others.length && decision !== 'take_over') throw conflict(`${row.appId} is already reported by another developer account; choose "take over" to move reporting here`);
    for (const o of others) {
      await t
        .update(storeApps)
        .set({ status: 'ignored', conflictDetail: { reason: 'reporting moved to another developer account', movedToAccountId: row.storeAccountId, at: now.toISOString() }, updatedAt: now })
        .where(eq(storeApps.id, o.id));
      await audit(t, tenantId, actor, 'store.app.ownership_moved', { type: 'store_app', id: o.id }, { appId: row.appId, from: o.storeAccountId, to: row.storeAccountId });
    }
    const [u] = await t
      .update(storeApps)
      .set({ status: 'confirmed', conflictDetail: null, confirmedBy: actorRef(actor), confirmedAt: now, updatedAt: now })
      .where(eq(storeApps.id, row.id))
      .returning();
    await audit(t, tenantId, actor, 'store.app.confirmed', { type: 'store_app', id: row.id }, { appId: row.appId, platform: row.platform, automatic: false });
    await enqueueSync(deps, tenantId, row.storeAccountId, 'incremental');
    return appView(u!);
  });
}

export const ManualAppSchema = z
  .object({
    appId: z.string().trim().min(3).max(155),
    /** App Store Connect app ID (numeric Apple ID), required for iOS. */
    storeAppId: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Adds an app the discovery has not seen yet (e.g. a new app with no report files so far). */
export async function addStoreAppManually(deps: CoreDeps, tenantId: string, actor: Actor, accountId: string, raw: unknown) {
  requireRole(actor, ADMIN_ROLES, 'adding store apps');
  const input = ManualAppSchema.parse(raw);
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const a = await account(t, accountId);
    const platform = a.provider === 'google_play' ? 'android' : 'ios';
    if (platform === 'android' && !PACKAGE_NAME.test(input.appId)) throw invalid('enter the Android package name, e.g. com.example.app');
    if (platform === 'ios' && (!BUNDLE_ID.test(input.appId) || !input.storeAppId)) throw invalid('enter the bundle ID and the numeric Apple ID shown in App Store Connect › App Information');
    const row = await upsertDiscoveredApp(t, tenantId, a, { platform, appId: input.appId, storeAppId: input.storeAppId ?? null, displayName: input.displayName ?? null, via: 'manual', reliable: false }, deps.clock.now());
    if (!row) throw invalid('invalid app identifier');
    await audit(t, tenantId, actor, 'store.app.added', { type: 'store_app', id: row.id }, { appId: input.appId, platform });
    return appView(row);
  });
}

export const AppleAnalyticsRequestSchema = z.object({ accessType: z.enum(['ONGOING', 'ONE_TIME_SNAPSHOT']).default('ONGOING') }).strict();

/**
 * Asks Apple to start generating Analytics Reports for one app (an Admin API key is required by
 * Apple). Reuses an active request of the same type instead of creating a duplicate. One-time
 * snapshots (history from 2024-01-01) are limited by Apple to one per month.
 */
export async function requestAppleAnalytics(deps: CoreDeps, tenantId: string, actor: Actor, appRowId: string, raw: unknown) {
  requireRole(actor, ADMIN_ROLES, 'requesting App Store analytics reports');
  requireMfa(actor, 'requesting App Store analytics reports');
  const { accessType } = AppleAnalyticsRequestSchema.parse(raw ?? {});
  const { app, acct } = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const [app] = await t.select().from(storeApps).where(eq(storeApps.id, appRowId));
    if (!app) throw notFound('store app');
    if (app.platform !== 'ios' || !app.storeAppId) throw invalid('analytics report requests apply to iOS apps with an Apple ID');
    if (app.status !== 'confirmed') throw invalid('confirm the app first');
    return { app, acct: await account(t, app.storeAccountId) };
  });
  const { ctx } = await readContext(deps, tenantId, acct.connectionId, 'app_store_connect');
  let request: Awaited<ReturnType<typeof createAnalyticsReportRequest>>;
  let created = false;
  try {
    const existing = (await listAnalyticsReportRequests(ctx, app.storeAppId!)).find((r) => r.accessType === accessType && !r.stoppedDueToInactivity);
    if (existing) request = existing;
    else {
      request = await createAnalyticsReportRequest(ctx, app.storeAppId!, accessType);
      created = true;
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) throw invalid('Apple refused: creating analytics report requests needs an App Store Connect API key with the Admin role. Reading reports works with Sales and Reports.');
    throw err;
  }
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const settings = (app.settings ?? {}) as { analytics?: Record<string, unknown> };
    const analytics = { ...(settings.analytics ?? {}), [accessType]: { requestId: request.id, requestedAt: deps.clock.now().toISOString(), created } };
    const [u] = await t
      .update(storeApps)
      .set({ settings: { ...settings, analytics }, updatedAt: deps.clock.now() })
      .where(eq(storeApps.id, app.id))
      .returning();
    await audit(t, tenantId, actor, 'store.apple.analytics_requested', { type: 'store_app', id: app.id }, { accessType, requestId: request.id, created });
    await enqueueSync(deps, tenantId, app.storeAccountId, 'incremental', new Date(deps.clock.now().getTime() + 60_000));
    return appView(u!);
  });
}

/** Default Play dimensions per family (registry `defaultOn`), overridable per account. */
export function enabledPlayDimensions(settings: AccountSettings): Record<string, string[]> {
  return Object.fromEntries(PLAY_FAMILIES.map((f) => [f.family, settings.dimensions?.[f.family] ?? f.dimensions.filter((d) => d.defaultOn).map((d) => d.suffix)]));
}
