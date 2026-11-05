import { sql } from 'drizzle-orm';
import { bigint, date, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dbl, json, oneOf, pk, tenantId, textArray, ts, updatedAt } from './_common.js';
import { connections } from './platform.js';

/* ------------------------------------------------------------------ */
/* Store reporting: developer accounts, apps and official reports      */
/* (M19 app intelligence, D-045)                                       */
/* ------------------------------------------------------------------ */

export const STORE_PROVIDERS = ['google_play', 'app_store_connect'] as const;
export const STORE_ACCOUNT_STATUSES = ['active', 'disabled'] as const;
/** Last observed access state of the account's report source. `unknown` until the first check. */
export const STORE_ACCOUNT_HEALTH = ['unknown', 'ok', 'permission_denied', 'not_found', 'auth_failed', 'rate_limited', 'error'] as const;
export const STORE_APP_PLATFORMS = ['android', 'ios'] as const;
/** `discovered` apps are not reported until an owner confirms them; `conflict` blocks import. */
export const STORE_APP_STATUSES = ['discovered', 'confirmed', 'ignored', 'conflict'] as const;
export const STORE_FILE_STATUSES = ['imported', 'partial', 'failed', 'rejected'] as const;
export const STORE_PARTITION_STATUSES = ['provisional', 'complete'] as const;
export const STORE_COVERAGE_STATUSES = ['pending', 'unavailable', 'permission_denied', 'not_yet_published', 'partial', 'complete', 'revised'] as const;
export const STORE_SYNC_MODES = ['discovery', 'incremental', 'backfill'] as const;
export const STORE_SYNC_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const;

/**
 * A developer account (Play Console developer account or App Store Connect team) whose official
 * reports an organization imports. Credentials stay in the encrypted connection; this row holds
 * the report source, health and the scheduler's lease.
 */
export const storeAccounts = pgTable(
  'store_accounts',
  {
    id: pk(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** Play: the Cloud Storage report bucket (pubsite_prod_…). Apple: the API key issuer. */
    accountRef: text('account_ref').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('active'),
    healthStatus: text('health_status').notNull().default('unknown'),
    healthDetail: json<Record<string, unknown>>('health_detail').notNull().default({}),
    healthCheckedAt: ts('health_checked_at'),
    settings: json<Record<string, unknown>>('settings').notNull().default({}),
    lastSyncStartedAt: ts('last_sync_started_at'),
    lastSyncFinishedAt: ts('last_sync_finished_at'),
    lastSuccessAt: ts('last_success_at'),
    nextSyncAt: ts('next_sync_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Earliest month (YYYY-MM) or day still to backfill; null when the backfill is done. */
    backfillCursor: text('backfill_cursor'),
    leaseOwner: text('lease_owner'),
    leaseUntil: ts('lease_until'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('store_accounts_connection_uq').on(t.tenantId, t.connectionId),
    uniqueIndex('store_accounts_ref_uq').on(t.tenantId, t.provider, t.accountRef),
    index('store_accounts_due_idx').on(t.status, t.nextSyncAt),
    oneOf('store_accounts_provider_chk', t.provider, STORE_PROVIDERS),
    oneOf('store_accounts_status_chk', t.status, STORE_ACCOUNT_STATUSES),
    oneOf('store_accounts_health_chk', t.healthStatus, STORE_ACCOUNT_HEALTH),
  ],
);

/**
 * An application seen under a developer account. Only `confirmed` apps are imported; a package
 * that another account of the same organization already reports stays `conflict` until an owner
 * resolves it, so a report is never attached to the wrong account.
 */
export const storeApps = pgTable(
  'store_apps',
  {
    id: pk(),
    tenantId: tenantId(),
    storeAccountId: uuid('store_account_id')
      .notNull()
      .references(() => storeAccounts.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    /** Play package name or App Store bundle ID. */
    appId: text('app_id').notNull(),
    /** App Store Connect app resource ID (numeric Apple ID); null for Play. */
    storeAppId: text('store_app_id'),
    displayName: text('display_name'),
    status: text('status').notNull().default('discovered'),
    discoveredVia: textArray('discovered_via').notNull().default(sql`'{}'::text[]`),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    confirmedBy: text('confirmed_by'),
    confirmedAt: ts('confirmed_at'),
    conflictDetail: json<Record<string, unknown> | null>('conflict_detail'),
    settings: json<Record<string, unknown>>('settings').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('store_apps_account_app_uq').on(t.tenantId, t.storeAccountId, t.platform, t.appId),
    uniqueIndex('store_apps_confirmed_uq').on(t.tenantId, t.platform, t.appId).where(sql`${t.status} = 'confirmed'`),
    oneOf('store_apps_platform_chk', t.platform, STORE_APP_PLATFORMS),
    oneOf('store_apps_status_chk', t.status, STORE_APP_STATUSES),
  ],
);

/**
 * One official source file (a Play Cloud Storage object generation, or an Apple report instance
 * segment) as received. The raw bytes are kept in object storage under `objectKey`.
 */
export const storeReportFiles = pgTable(
  'store_report_files',
  {
    id: pk(),
    tenantId: tenantId(),
    storeAccountId: uuid('store_account_id')
      .notNull()
      .references(() => storeAccounts.id, { onDelete: 'cascade' }),
    storeAppId: uuid('store_app_id').references(() => storeApps.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    family: text('family').notNull(),
    dimension: text('dimension').notNull(),
    /** Play: the report month (YYYY-MM). Apple: the instance processing date (YYYY-MM-DD). */
    period: text('period').notNull(),
    sourceUri: text('source_uri').notNull(),
    /** Play: object generation. Apple: instance id + segment checksum. */
    sourceVersion: text('source_version').notNull(),
    /** Monotonic within (app, family, dimension): newer sources overwrite older ones per day. */
    sourceRank: bigint('source_rank', { mode: 'number' }).notNull(),
    sourceUpdatedAt: ts('source_updated_at'),
    sourceChecksum: text('source_checksum'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    encoding: text('encoding'),
    header: json<string[]>('header').notNull().default([]),
    schemaFingerprint: text('schema_fingerprint'),
    unmappedColumns: json<string[]>('unmapped_columns').notNull().default([]),
    status: text('status').notNull(),
    rowsTotal: integer('rows_total').notNull().default(0),
    rowsRejected: integer('rows_rejected').notNull().default(0),
    observations: integer('observations').notNull().default(0),
    partitionsChanged: integer('partitions_changed').notNull().default(0),
    partitionsRevised: integer('partitions_revised').notNull().default(0),
    partitionsSkipped: integer('partitions_skipped').notNull().default(0),
    error: json<Record<string, unknown> | null>('error'),
    objectKey: text('object_key'),
    evidenceId: uuid('evidence_id'),
    importedAt: ts('imported_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('store_report_files_source_uq').on(t.tenantId, t.storeAccountId, t.sourceUri, t.sourceVersion), index('store_report_files_app_idx').on(t.tenantId, t.storeAppId, t.family, t.period), oneOf('store_report_files_status_chk', t.status, STORE_FILE_STATUSES)],
);

/**
 * The current source of one (app, family, dimension, day). A newer source replaces every
 * observation of the day (providers restate whole days; merging two sources would double count).
 */
export const storeReportPartitions = pgTable(
  'store_report_partitions',
  {
    id: pk(),
    tenantId: tenantId(),
    storeAppId: uuid('store_app_id')
      .notNull()
      .references(() => storeApps.id, { onDelete: 'cascade' }),
    family: text('family').notNull(),
    dimension: text('dimension').notNull(),
    observationDate: date('observation_date', { mode: 'string' }).notNull(),
    reportFileId: uuid('report_file_id')
      .notNull()
      .references(() => storeReportFiles.id),
    sourceRank: bigint('source_rank', { mode: 'number' }).notNull(),
    rows: integer('rows').notNull(),
    digest: text('digest').notNull(),
    revision: integer('revision').notNull().default(1),
    status: text('status').notNull(),
    firstImportedAt: ts('first_imported_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('store_report_partitions_uq').on(t.tenantId, t.storeAppId, t.family, t.dimension, t.observationDate), oneOf('store_report_partitions_status_chk', t.status, STORE_PARTITION_STATUSES)],
);

/** A normalized, source-faithful value from an official report row. `value` null = not reported. */
export const storeMetricObservations = pgTable(
  'store_metric_observations',
  {
    id: pk(),
    tenantId: tenantId(),
    partitionId: uuid('partition_id')
      .notNull()
      .references(() => storeReportPartitions.id, { onDelete: 'cascade' }),
    storeAppId: uuid('store_app_id').notNull(),
    storeAccountId: uuid('store_account_id').notNull(),
    platform: text('platform').notNull(),
    appId: text('app_id').notNull(),
    provider: text('provider').notNull(),
    family: text('family').notNull(),
    dimension: text('dimension').notNull(),
    metricKey: text('metric_key').notNull(),
    /** The report's own column name, kept for provenance. */
    sourceMetric: text('source_metric').notNull(),
    observationDate: date('observation_date', { mode: 'string' }).notNull(),
    /** Null when the provider does not document the report's day boundary. */
    reportingTimezone: text('reporting_timezone'),
    dims: json<Record<string, string>>('dims').notNull().default({}),
    dimsKey: text('dims_key').notNull(),
    value: dbl('value'),
    reportFileId: uuid('report_file_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('store_metric_observations_uq').on(t.tenantId, t.partitionId, t.metricKey, t.dimsKey), index('store_metric_observations_app_idx').on(t.tenantId, t.storeAppId, t.metricKey, t.observationDate)],
);

/** Expected report periods and what was found (missing/late detection for the dashboard). */
export const storeReportCoverage = pgTable(
  'store_report_coverage',
  {
    id: pk(),
    tenantId: tenantId(),
    storeAppId: uuid('store_app_id')
      .notNull()
      .references(() => storeApps.id, { onDelete: 'cascade' }),
    family: text('family').notNull(),
    dimension: text('dimension').notNull(),
    period: text('period').notNull(),
    status: text('status').notNull(),
    detail: json<Record<string, unknown>>('detail').notNull().default({}),
    checkedAt: ts('checked_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('store_report_coverage_uq').on(t.tenantId, t.storeAppId, t.family, t.dimension, t.period), oneOf('store_report_coverage_status_chk', t.status, STORE_COVERAGE_STATUSES)],
);

export const storeSyncRuns = pgTable(
  'store_sync_runs',
  {
    id: pk(),
    tenantId: tenantId(),
    storeAccountId: uuid('store_account_id')
      .notNull()
      .references(() => storeAccounts.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('running'),
    triggeredBy: text('triggered_by').notNull(),
    stats: json<Record<string, unknown>>('stats').notNull().default({}),
    error: json<Record<string, unknown> | null>('error'),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('store_sync_runs_account_idx').on(t.tenantId, t.storeAccountId, t.startedAt), oneOf('store_sync_runs_mode_chk', t.mode, STORE_SYNC_MODES), oneOf('store_sync_runs_status_chk', t.status, STORE_SYNC_STATUSES)],
);
