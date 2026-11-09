import { searchConsoleSites } from '@futuregrow/connectors';
import { connections, type DbOrTx, evidenceRecords, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { ADMIN_ROLES, audit, clipText, requireRole } from '../../util.js';
import { readContext } from '../connections.js';

/**
 * Google Search Console workspace (P2-13): which property each connection reads, the property
 * list of the authorized user, sync outcomes, and search performance for one reported period at
 * a time. Search Console rows are period aggregates (query × page); overlapping periods are never
 * added together, and anonymized queries are not part of the rows, so totals here are below the
 * site total in Search Console's own Performance report.
 */

export const SEARCH_CONSOLE_FRESHNESS_HOURS = 72;
const READ_ROLES = ['owner', 'admin', 'growth_operator', 'analyst'] as const;

interface ConnectionLike {
  externalAccountId: string;
  metadata: Record<string, unknown>;
}

export interface SyncOutcome {
  status: 'ok' | 'failed';
  at: string;
  rows?: number;
  period?: { start: string; end: string };
  error?: string;
  trigger: 'manual' | 'scheduled';
}

/** The property a connection reads: the chosen one, else the account id it was connected with. */
export const propertyOf = (c: ConnectionLike): string => (typeof c.metadata.siteUrl === 'string' && c.metadata.siteUrl ? c.metadata.siteUrl : c.externalAccountId);

/** The authorized user's properties (one read-only Google call); the selected one is marked. */
export async function listProperties(deps: CoreDeps, tenantId: string, actor: Actor, connectionId: string) {
  requireRole(actor, [...READ_ROLES], 'listing Search Console properties');
  const { ctx, connection } = await readContext(deps, tenantId, connectionId, 'search_console');
  const sites = await searchConsoleSites(ctx);
  const selected = propertyOf(connection);
  return {
    connectionId,
    selected,
    explicitlySelected: typeof connection.metadata.siteUrl === 'string',
    properties: sites
      .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel, verified: s.permissionLevel !== 'siteUnverifiedUser', selected: s.siteUrl === selected, kind: s.siteUrl.startsWith('sc-domain:') ? ('domain' as const) : ('url_prefix' as const) }))
      .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl)),
  };
}

/** Chooses the property a connection reads. Only a property the authorized user is verified for is accepted. */
export async function selectProperty(deps: CoreDeps, tenantId: string, actor: Actor, connectionId: string, siteUrl: string) {
  requireRole(actor, ADMIN_ROLES, 'choosing the Search Console property');
  const { ctx } = await readContext(deps, tenantId, connectionId, 'search_console');
  const site = (await searchConsoleSites(ctx)).find((s) => s.siteUrl === siteUrl);
  if (!site) throw invalid('this property is not in the authorized account’s Search Console list (use the exact URL-prefix or sc-domain: form)');
  if (site.permissionLevel === 'siteUnverifiedUser') throw invalid('the authorized account is not a verified user of this property');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const [c] = await t.select().from(connections).where(eq(connections.id, connectionId));
    if (!c) throw notFound('connection');
    await t
      .update(connections)
      .set({ metadata: { ...c.metadata, siteUrl, permissionLevel: site.permissionLevel }, updatedAt: new Date() })
      .where(eq(connections.id, connectionId));
    await audit(t, tenantId, actor, 'seo.search_console.property_selected', { type: 'connection', id: connectionId }, { siteUrl, permissionLevel: site.permissionLevel, previous: propertyOf(c) });
    return { connectionId, siteUrl, permissionLevel: site.permissionLevel };
  });
}

/** Stores the latest sync outcome on the connection (no secrets: provider error text is clipped). */
export async function recordSyncOutcome(deps: CoreDeps, tenantId: string, connectionId: string, outcome: SyncOutcome) {
  await withTenant(deps.db, { tenantId, actor: actorRef(systemActor('search-console-sync')) }, async (t) => {
    await t
      .update(connections)
      .set({ metadata: sql`${connections.metadata} || ${JSON.stringify({ searchConsoleSync: { ...outcome, ...(outcome.error ? { error: clipText(outcome.error.replace(/(token|secret|authorization)[^\s]*/gi, '[redacted]'), 300) } : {}) } })}::jsonb` })
      .where(eq(connections.id, connectionId));
  });
}

type PeriodRow = {
  period_start: string;
  period_end: string;
  rows: number;
  evidence_at: string | null;
};

async function periodsFor(t: DbOrTx, siteUrl: string) {
  const r = await t.execute<PeriodRow>(sql`
    select k.period_start, k.period_end, count(*)::int as rows, max(e.retrieved_at)::text as evidence_at
    from keyword_metrics k join evidence_records e on e.id = k.evidence_id
    where k.source = 'search_console' and e.content ->> 'siteUrl' = ${siteUrl}
    group by 1, 2 order by k.period_end desc, k.period_start asc limit 30`);
  return r.rows.map((p) => ({ start: p.period_start, end: p.period_end, rows: p.rows, importedAt: p.evidence_at ? new Date(p.evidence_at).toISOString() : null }));
}

/** Connections, chosen properties, last sync outcome, data freshness and available periods. Reads only. */
export async function searchConsoleOverview(t: DbOrTx, now: Date) {
  const conns = await t.select().from(connections).where(eq(connections.provider, 'search_console')).orderBy(asc(connections.displayName));
  const out = [];
  for (const c of conns) {
    const property = propertyOf(c);
    const [ev] = await t
      .select({ id: evidenceRecords.id, retrievedAt: evidenceRecords.retrievedAt, summary: evidenceRecords.summary })
      .from(evidenceRecords)
      .where(and(eq(evidenceRecords.sourceOwner, 'google_search_console'), sql`${evidenceRecords.content} ->> 'siteUrl' = ${property}`))
      .orderBy(desc(evidenceRecords.retrievedAt))
      .limit(1);
    const periods = await periodsFor(t, property);
    out.push({
      id: c.id,
      displayName: c.displayName,
      status: c.status,
      healthStatus: c.healthStatus,
      lastHealthCheckAt: c.lastHealthCheckAt?.toISOString() ?? null,
      property,
      propertySelected: typeof c.metadata.siteUrl === 'string',
      permissionLevel: typeof c.metadata.permissionLevel === 'string' ? c.metadata.permissionLevel : null,
      lastSync: (c.metadata.searchConsoleSync as SyncOutcome | undefined) ?? null,
      lastData: ev ? { at: ev.retrievedAt.toISOString(), evidenceId: ev.id, summary: ev.summary, stale: now.getTime() - ev.retrievedAt.getTime() > SEARCH_CONSOLE_FRESHNESS_HOURS * 3_600_000 } : null,
      periods,
    });
  }
  const uploads = await t.execute<PeriodRow>(sql`
    select period_start, period_end, count(*)::int as rows, null::text as evidence_at from keyword_metrics where source = 'upload'
    group by 1, 2 order by period_end desc, period_start asc limit 30`);
  return {
    asOf: now.toISOString(),
    freshnessHours: SEARCH_CONSOLE_FRESHNESS_HOURS,
    connections: out,
    uploads: uploads.rows.map((p) => ({ start: p.period_start, end: p.period_end, rows: p.rows })),
    schedule: 'Daily at 05:45 UTC: the 7 days ending 3 days ago (Search Console data arrives about 2 days late).',
  };
}

export const PerformanceQuerySchema = z
  .object({
    siteUrl: z.string().min(4).max(500).optional(),
    source: z.enum(['search_console', 'upload']).default('search_console'),
    periodStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    periodEnd: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.coerce.number().int().min(5).max(200).default(50),
  })
  .strict();

/**
 * Search performance for ONE period of one property (or one uploaded period): totals, top queries
 * and top pages. CTR is clicks ÷ impressions of the same rows; position is impression-weighted.
 */
export async function searchPerformance(t: DbOrTx, raw: unknown) {
  const q = PerformanceQuerySchema.parse(raw ?? {});
  if (q.source === 'search_console' && !q.siteUrl) throw invalid('choose a property (siteUrl)');
  const scope = q.source === 'search_console' ? sql`k.source = 'search_console' and e.content ->> 'siteUrl' = ${q.siteUrl!}` : sql`k.source = 'upload'`;
  let period = q.periodStart && q.periodEnd ? { start: q.periodStart, end: q.periodEnd } : null;
  if (!period) {
    const [latest] = (
      await t.execute<{ period_start: string; period_end: string }>(sql`
        select k.period_start, k.period_end from keyword_metrics k join evidence_records e on e.id = k.evidence_id
        where ${scope} order by k.period_end desc, k.period_start asc limit 1`)
    ).rows;
    if (!latest) return { siteUrl: q.siteUrl ?? null, source: q.source, period: null, totals: null, queries: [], pages: [], notes: ['No Search Console data has been imported for this property yet.'] };
    period = { start: latest.period_start, end: latest.period_end };
  }
  const inPeriod = sql`${scope} and k.period_start = ${period.start} and k.period_end = ${period.end}`;
  const [totals] = (
    await t.execute<{ rows: number; clicks: number; impressions: number; position: number | null; queries: number; pages: number; evidence_ids: string[] }>(sql`
      select count(*)::int as rows, coalesce(sum(k.clicks), 0)::int as clicks, coalesce(sum(k.impressions), 0)::int as impressions,
        sum(k.position * k.impressions) / nullif(sum(k.impressions) filter (where k.position is not null), 0) as position,
        count(distinct k.query)::int as queries, count(distinct k.page_url)::int as pages,
        array_agg(distinct k.evidence_id::text) as evidence_ids
      from keyword_metrics k join evidence_records e on e.id = k.evidence_id where ${inPeriod}`)
  ).rows;
  const group = (col: 'query' | 'page_url') =>
    t.execute<{ key: string | null; clicks: number; impressions: number; position: number | null }>(sql`
      select ${sql.raw(`k.${col}`)} as key, sum(k.clicks)::int as clicks, sum(k.impressions)::int as impressions,
        sum(k.position * k.impressions) / nullif(sum(k.impressions) filter (where k.position is not null), 0) as position
      from keyword_metrics k join evidence_records e on e.id = k.evidence_id where ${inPeriod}
      group by 1 order by 2 desc, 3 desc limit ${q.limit}`);
  const [queries, pages] = [await group('query'), await group('page_url')];
  const shape = (r: { key: string | null; clicks: number; impressions: number; position: number | null }) => ({
    key: r.key,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    ctr: Number(r.impressions) ? Number(r.clicks) / Number(r.impressions) : null,
    position: r.position === null ? null : Number(r.position),
  });
  const tot = totals!;
  return {
    siteUrl: q.siteUrl ?? null,
    source: q.source,
    period,
    totals: {
      rows: tot.rows,
      clicks: Number(tot.clicks),
      impressions: Number(tot.impressions),
      ctr: Number(tot.impressions) ? Number(tot.clicks) / Number(tot.impressions) : null,
      position: tot.position === null ? null : Number(tot.position),
      queries: tot.queries,
      pages: tot.pages,
      evidenceIds: (tot.evidence_ids ?? []).filter(Boolean),
    },
    queries: queries.rows.map(shape),
    pages: pages.rows.map(shape),
    notes: [
      'One reported period at a time: periods overlap (each daily import covers 7 days), so they are never added together.',
      'Rows are query × page, as Search Console reports them; anonymized queries are not included, so totals are lower than the site total in Search Console’s Performance report.',
      'Search Console data is about 2 days late and positions are averages; nothing here predicts rankings or traffic.',
    ],
  };
}
