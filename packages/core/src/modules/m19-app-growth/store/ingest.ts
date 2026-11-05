import { storeMetricObservations, storeReportFiles, storeReportPartitions, type Tx } from '@futuregrow/db';
import { and, eq, sql } from 'drizzle-orm';
import { type Actor, systemActor } from '../../../deps.js';
import { audit } from '../../../util.js';
import { admitInternalEvidence } from '../../m01-evidence/index.js';
import { dayDigest, type ParsedReport } from './parse.js';

export interface ImportTarget {
  tenantId: string;
  storeAccountId: string;
  storeAppId: string;
  platform: 'android' | 'ios';
  appId: string;
  provider: 'google_play' | 'app_store_connect';
}

export interface SourceFile {
  /** Stable provider address (gs://bucket/object, asc://analyticsReportInstances/<id>, …). */
  uri: string;
  /** Generation / checksum set: a new version of the same uri is a possible restatement. */
  version: string;
  /** Larger ranks win per day (GCS generation, Apple processing date). */
  rank: number;
  period: string;
  updatedAt: Date | null;
  checksum: string | null;
  sizeBytes: number;
  sha256: string;
  encoding: string | null;
  objectKey: string | null;
}

export interface ImportResult {
  duplicate: boolean;
  fileId: string;
  status: 'imported' | 'partial' | 'rejected';
  observations: number;
  partitionsChanged: number;
  partitionsRevised: number;
  partitionsSkipped: number;
  days: string[];
}

const BATCH = 500;
const ACTOR: Actor = systemActor('store-reporting');

/**
 * Imports one parsed source inside the caller's transaction (the caller holds the account lease).
 *
 * Per (app, family, dimension, day) the newest source wins and *replaces* that day's rows: Play
 * re-publishes whole monthly files and Apple says newer instances overwrite older ones for the same
 * Date ("don't merge records … to avoid double counting"). A source older than the stored one is
 * skipped for that day; an identical restatement changes nothing; a different one is a revision.
 * Re-importing the same uri+version is a no-op (unique index), so retries never double count.
 */
export async function importParsedReport(t: Tx, target: ImportTarget, source: SourceFile, parsed: ParsedReport, opts: { now: Date; completeAfterDays: number; evidence: { uri: string; license: string; freshnessSlaHours: number } }): Promise<ImportResult> {
  const [file] = await t
    .insert(storeReportFiles)
    .values({
      tenantId: target.tenantId,
      storeAccountId: target.storeAccountId,
      storeAppId: target.storeAppId,
      provider: target.provider,
      family: parsed.family,
      dimension: parsed.dimension,
      period: source.period,
      sourceUri: source.uri,
      sourceVersion: source.version,
      sourceRank: source.rank,
      sourceUpdatedAt: source.updatedAt,
      sourceChecksum: source.checksum,
      sizeBytes: source.sizeBytes,
      sha256: source.sha256,
      encoding: source.encoding,
      header: parsed.header,
      schemaFingerprint: parsed.schemaFingerprint,
      unmappedColumns: parsed.unmappedColumns,
      status: 'imported',
      rowsTotal: parsed.rowsTotal,
      rowsRejected: parsed.rowsRejected,
      objectKey: source.objectKey,
      importedAt: opts.now,
    })
    .onConflictDoNothing()
    .returning({ id: storeReportFiles.id });
  if (!file) {
    const [prior] = await t
      .select()
      .from(storeReportFiles)
      .where(and(eq(storeReportFiles.storeAccountId, target.storeAccountId), eq(storeReportFiles.sourceUri, source.uri), eq(storeReportFiles.sourceVersion, source.version)));
    return { duplicate: true, fileId: prior!.id, status: prior!.status as ImportResult['status'], observations: 0, partitionsChanged: 0, partitionsRevised: 0, partitionsSkipped: 0, days: [] };
  }
  let observations = 0;
  let changed = 0;
  let revised = 0;
  let skipped = 0;
  const touched: string[] = [];
  const days = [...parsed.days.keys()].sort();
  for (const day of days) {
    const rows = parsed.days.get(day)!;
    const digest = dayDigest(rows);
    const ageDays = Math.floor(((source.updatedAt ?? opts.now).getTime() - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
    const status = ageDays >= opts.completeAfterDays ? 'complete' : 'provisional';
    await t
      .insert(storeReportPartitions)
      .values({ tenantId: target.tenantId, storeAppId: target.storeAppId, family: parsed.family, dimension: parsed.dimension, observationDate: day, reportFileId: file.id, sourceRank: -1, rows: 0, digest: '', status, firstImportedAt: opts.now, updatedAt: opts.now })
      .onConflictDoNothing();
    const [part] = await t
      .select()
      .from(storeReportPartitions)
      .where(and(eq(storeReportPartitions.storeAppId, target.storeAppId), eq(storeReportPartitions.family, parsed.family), eq(storeReportPartitions.dimension, parsed.dimension), eq(storeReportPartitions.observationDate, day)))
      .for('update');
    if (!part) throw new Error('partition row vanished');
    if (part.sourceRank > source.rank) {
      skipped++;
      continue;
    }
    if (part.digest === digest) {
      // Same content: keep the rows, record the newer source and any completeness upgrade.
      await t
        .update(storeReportPartitions)
        .set({ reportFileId: file.id, sourceRank: source.rank, status: part.status === 'complete' ? 'complete' : status, updatedAt: opts.now })
        .where(eq(storeReportPartitions.id, part.id));
      continue;
    }
    const isRevision = part.sourceRank >= 0;
    await t.delete(storeMetricObservations).where(eq(storeMetricObservations.partitionId, part.id));
    for (let i = 0; i < rows.length; i += BATCH) {
      await t.insert(storeMetricObservations).values(
        rows.slice(i, i + BATCH).map((r) => ({
          tenantId: target.tenantId,
          partitionId: part.id,
          storeAppId: target.storeAppId,
          storeAccountId: target.storeAccountId,
          platform: target.platform,
          appId: target.appId,
          provider: target.provider,
          family: parsed.family,
          dimension: parsed.dimension,
          metricKey: r.metricKey,
          sourceMetric: r.sourceMetric,
          observationDate: day,
          reportingTimezone: parsed.timezone,
          dims: r.dims,
          dimsKey: r.dimsKey,
          value: r.value,
          reportFileId: file.id,
          createdAt: opts.now,
        })),
      );
    }
    await t
      .update(storeReportPartitions)
      .set({ reportFileId: file.id, sourceRank: source.rank, rows: rows.length, digest, revision: isRevision ? sql`${storeReportPartitions.revision} + 1` : 1, status, updatedAt: opts.now })
      .where(eq(storeReportPartitions.id, part.id));
    observations += rows.length;
    changed++;
    if (isRevision) revised++;
    touched.push(day);
  }
  const fileStatus: ImportResult['status'] = parsed.rowsTotal > 0 && parsed.rowsRejected === parsed.rowsTotal ? 'rejected' : parsed.rowsRejected > 0 ? 'partial' : 'imported';
  const ev = await admitInternalEvidence(t, target.tenantId, ACTOR, {
    kind: 'metric',
    sourceType: 'primary',
    owner: target.provider,
    uri: opts.evidence.uri,
    content: {
      family: parsed.family,
      dimension: parsed.dimension,
      period: source.period,
      appId: target.appId,
      platform: target.platform,
      sha256: source.sha256,
      rows: parsed.rowsTotal,
      rejected: parsed.rowsRejected,
      rejectReasons: parsed.rejectReasons,
      days: days.length,
      firstDay: days[0] ?? null,
      lastDay: days.at(-1) ?? null,
      changedDays: touched.length,
      revisedDays: revised,
    },
    summary: `${target.platform === 'android' ? 'Google Play' : 'App Store'} ${parsed.family} ${parsed.dimension} ${source.period} for ${target.appId}: ${days.length} day(s), ${parsed.rowsRejected} rejected row(s)`,
    confidence: 1,
    license: opts.evidence.license,
    permittedUses: ['analytics', 'forecasting', 'causal_measurement'],
    externalPlatformTerms: target.provider,
    // Observed when FUTUREGROW read it (a backfilled month is a current observation of history).
    observedAt: opts.now,
    freshnessSlaHours: opts.evidence.freshnessSlaHours,
    now: opts.now,
  });
  await t
    .update(storeReportFiles)
    .set({
      status: fileStatus,
      observations,
      partitionsChanged: changed,
      partitionsRevised: revised,
      partitionsSkipped: skipped,
      evidenceId: ev.evidenceId,
      error: parsed.rowsRejected ? { rejectReasons: parsed.rejectReasons, skippedValues: parsed.skippedValues } : parsed.skippedValues.length ? { skippedValues: parsed.skippedValues } : null,
    })
    .where(eq(storeReportFiles.id, file.id));
  if (revised) await audit(t, target.tenantId, ACTOR, 'store.report.revised', { type: 'store_report_file', id: file.id }, { appId: target.appId, family: parsed.family, dimension: parsed.dimension, period: source.period, revisedDays: revised });
  return { duplicate: false, fileId: file.id, status: fileStatus, observations, partitionsChanged: changed, partitionsRevised: revised, partitionsSkipped: skipped, days: touched };
}

/** Records a source that could not be parsed at all (schema change, bad encoding) once per version. */
export async function recordRejectedFile(t: Tx, target: ImportTarget, source: SourceFile, meta: { family: string; dimension: string; error: string; code: string; header?: string[] }, now: Date) {
  const [row] = await t
    .insert(storeReportFiles)
    .values({
      tenantId: target.tenantId,
      storeAccountId: target.storeAccountId,
      storeAppId: target.storeAppId,
      provider: target.provider,
      family: meta.family,
      dimension: meta.dimension,
      period: source.period,
      sourceUri: source.uri,
      sourceVersion: source.version,
      sourceRank: source.rank,
      sourceUpdatedAt: source.updatedAt,
      sourceChecksum: source.checksum,
      sizeBytes: source.sizeBytes,
      sha256: source.sha256,
      encoding: source.encoding,
      header: meta.header ?? [],
      status: 'rejected',
      error: { code: meta.code, message: meta.error.slice(0, 500) },
      objectKey: source.objectKey,
      importedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: storeReportFiles.id });
  if (row) await audit(t, target.tenantId, ACTOR, 'store.report.rejected', { type: 'store_report_file', id: row.id }, { appId: target.appId, family: meta.family, dimension: meta.dimension, period: source.period, code: meta.code });
  return row?.id ?? null;
}
