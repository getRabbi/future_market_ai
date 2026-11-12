import { APPLE_ADS_REPORT_URL, type AppleAdsCampaignReport, fetchAppleAdsReport } from '@futuregrow/connectors';
import { canonicalJson } from '@futuregrow/contracts';
import { connections, type DbOrTx, evidenceRecords, withTenant } from '@futuregrow/db';
import { invalid, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';

export const AppleAdsReportRequest = z.object({ connectionId: z.string().uuid(), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
export async function syncAppleAdsReport(deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'reading Apple Ads reports');
  const input = AppleAdsReportRequest.parse(raw);
  const { connection, ctx } = await readContext(deps, tenantId, input.connectionId, 'apple_ads');
  if (connection.metadata.reportingTermsApproved !== true) throw invalid('An owner must approve Apple Ads reporting terms on the connection');
  const campaigns = await fetchAppleAdsReport(ctx, input.start, input.end);
  const content = { ...input, orgId: connection.externalAccountId, timeZone: 'UTC', campaigns, note: 'Provider-reported ad metrics; not individual attribution, organic store acquisitions or causal lift. Missing metrics remain null.' };
  const uri = `apple-ads-report://${input.connectionId}/${input.start}/${input.end}`;
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${uri}`}, 0))`);
    const [current] = await tx.select().from(connections).where(eq(connections.id, input.connectionId)).for('update');
    if (!current || !['active', 'read_only'].includes(current.status) || current.metadata.reportingTermsApproved !== true) throw invalid('Reporting approval or connection changed during fetch');
    const contentHash = sha256Hex(canonicalJson(content));
    const [same] = await tx
      .select()
      .from(evidenceRecords)
      .where(and(eq(evidenceRecords.sourceUriOrObjectId, uri), eq(evidenceRecords.contentSha256, contentHash), eq(evidenceRecords.status, 'admitted')))
      .limit(1);
    if (same) return { evidenceId: same.id, unchanged: true, campaigns: campaigns.length };
    const evidence = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'observation',
      sourceType: 'primary',
      owner: 'Apple Ads',
      uri,
      content,
      summary: `Apple Ads campaign report ${input.start} through ${input.end} UTC`,
      confidence: 1,
      license: 'Authorized Apple Ads account reporting',
      externalPlatformTerms: APPLE_ADS_REPORT_URL,
      permittedUses: ['analytics'],
      freshnessSlaHours: 48,
      now: deps.clock.now(),
    });
    await audit(tx, tenantId, actor, 'apple_ads.report.synced', { type: 'connection', id: input.connectionId }, { evidenceId: evidence.evidenceId, campaigns: campaigns.length, start: input.start, end: input.end });
    return { evidenceId: evidence.evidenceId, unchanged: false, campaigns: campaigns.length };
  });
}

/** Latest revision per exact report interval. Overlapping intervals are never summed. */
export async function appleAdsReports(tx: DbOrTx) {
  const rows = await tx
    .select()
    .from(evidenceRecords)
    .where(and(like(evidenceRecords.sourceUriOrObjectId, 'apple-ads-report://%'), eq(evidenceRecords.status, 'admitted')))
    .orderBy(desc(evidenceRecords.retrievedAt))
    .limit(100);
  const seen = new Set<string>();
  return rows
    .filter((r) => {
      if (seen.has(r.sourceUriOrObjectId)) return false;
      seen.add(r.sourceUriOrObjectId);
      return true;
    })
    .map((r) => ({ evidenceId: r.id, retrievedAt: r.retrievedAt, ...(r.content as { connectionId: string; start: string; end: string; campaigns: AppleAdsCampaignReport[]; note: string }) }));
}
