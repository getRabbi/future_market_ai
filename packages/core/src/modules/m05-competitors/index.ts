import { and, desc, eq, sql } from 'drizzle-orm';
import { PROMPTS, untrustedBlock } from '@futuregrow/agent-kernel';
import { type PublicFetchResult, diffLines, extractPage, parseRobots, publicFetch } from '@futuregrow/connectors';
import {
  type DbOrTx,
  type Tx,
  competitorObservations,
  competitorSnapshots,
  competitorSources,
  competitors,
  kgEntities,
  reaJobs,
  withTenant,
} from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef, systemActor } from '../../deps.js';
import { runAgent } from '../../agents.js';
import { audit, normalizeText, record, requireMfa, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';

const USER_AGENT = 'FUTUREGROW-Collector/0.1 (+https://futuregrow.invalid/bot)';
const LEGAL_ROLES = ['owner', 'legal_approver'] as const;

export type PublicFetcher = (url: string, opts: { maxBytes?: number; timeoutMs?: number; userAgent?: string }) => Promise<PublicFetchResult>;

/* ------------------------------------------------------------------ */
/* Competitors and the lawful-source allowlist (D-019)                 */
/* ------------------------------------------------------------------ */

export async function addCompetitor(tx: Tx, tenantId: string, actor: Actor, input: { name: string; domains: string[]; notes?: string }) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'adding competitors');
  const domains = [...new Set(input.domains.map((d) => d.toLowerCase().trim()))];
  if (!domains.length || domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw invalid('competitor domains must be bare hostnames');
  const [row] = await tx.insert(competitors).values({ tenantId, name: input.name.trim(), domains, notes: input.notes ?? null }).onConflictDoNothing().returning();
  if (!row) throw conflict('competitor already exists');
  await audit(tx, tenantId, actor, 'competitor.competitor.added', { type: 'competitor', id: row.id }, { domains });
  return row;
}

export const SourceSchema = z.object({
  competitorId: z.string().uuid(),
  url: z.string().url(),
  kind: z.enum(['pricing', 'features', 'changelog', 'docs', 'app_listing', 'ad_library', 'press', 'other']),
  lawfulBasisNote: z.string().min(10).max(2000),
  crawlIntervalHours: z.number().int().min(6).max(24 * 30).default(24),
});

export async function proposeSource(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  const input = SourceSchema.parse(raw);
  const [c] = await tx.select().from(competitors).where(eq(competitors.id, input.competitorId));
  if (!c) throw notFound('competitor');
  const u = new URL(input.url);
  if (u.protocol !== 'https:') throw invalid('only https sources are allowed');
  if (u.username || u.password || u.search.includes('token') || u.search.includes('key=')) throw invalid('sources must be public URLs without credentials');
  const host = u.hostname.toLowerCase();
  if (!c.domains.some((d) => host === d || host.endsWith(`.${d}`)) && input.kind !== 'app_listing' && input.kind !== 'ad_library') {
    throw invalid(`URL host ${host} is not one of the competitor's domains`);
  }
  const [row] = await tx.insert(competitorSources).values({ tenantId, ...input, url: u.toString() }).onConflictDoNothing().returning();
  if (!row) throw conflict('source already registered');
  await audit(tx, tenantId, actor, 'competitor.source.proposed', { type: 'competitor_source', id: row.id }, { url: row.url, kind: row.kind });
  return row;
}

export async function reviewSource(tx: Tx, tenantId: string, actor: Actor, id: string, decision: 'approved' | 'revoked') {
  requireRole(actor, LEGAL_ROLES, 'approving competitor sources');
  requireMfa(actor, 'approving competitor sources');
  const [row] = await tx
    .update(competitorSources)
    .set({ status: decision, approvedBy: decision === 'approved' ? actorRef(actor) : null, approvedAt: decision === 'approved' ? new Date() : null })
    .where(eq(competitorSources.id, id))
    .returning();
  if (!row) throw notFound('source');
  await audit(tx, tenantId, actor, `competitor.source.${decision}`, { type: 'competitor_source', id }, {});
  return row;
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

export interface CrawlResult {
  status: 'captured' | 'unchanged' | 'robots_disallowed' | 'too_soon' | 'not_approved' | 'fetch_failed';
  snapshotId?: string;
  observations?: number;
  detail?: string;
}

const priceSet = (p: string[]) => new Set(p.map((x) => x.replace(/\s+/g, '').toLowerCase()));

/**
 * Fetch an approved public source: robots.txt is honoured, the SSRF guard applies, the raw page is
 * archived with its SHA-256 as primary evidence, and successive snapshots are diffed. Only literal
 * differences become [P] observations.
 */
export async function crawlSource(deps: CoreDeps & { fetchPublic?: PublicFetcher }, tenantId: string, sourceId: string): Promise<CrawlResult> {
  const actor = systemActor('competitor-collector');
  const fetcher: PublicFetcher = deps.fetchPublic ?? ((u, o) => publicFetch(u, o));
  const src = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [s] = await tx.select().from(competitorSources).where(eq(competitorSources.id, sourceId));
    return s ?? null;
  });
  if (!src) throw notFound('source');
  if (src.status !== 'approved') return { status: 'not_approved' };
  const now = deps.clock.now();
  if (src.lastFetchedAt && now.getTime() - src.lastFetchedAt.getTime() < src.crawlIntervalHours * 3_600_000 * 0.9) return { status: 'too_soon' };

  const url = new URL(src.url);
  let robotsOk = true;
  try {
    const robots = await fetcher(`${url.origin}/robots.txt`, { maxBytes: 512 * 1024, userAgent: USER_AGENT });
    if (robots.status >= 200 && robots.status < 300) robotsOk = parseRobots(robots.body, USER_AGENT).isAllowed(`${url.pathname}${url.search}`);
    else if (robots.status >= 500) return { status: 'fetch_failed', detail: `robots.txt returned ${robots.status}; not crawling` };
    // 4xx => no robots policy => allowed (RFC 9309 §2.3.1.3)
  } catch (err) {
    return { status: 'fetch_failed', detail: `robots.txt unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!robotsOk) {
    await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => tx.update(competitorSources).set({ lastRobotsAllowed: false, lastFetchedAt: now }).where(eq(competitorSources.id, src.id)));
    return { status: 'robots_disallowed' };
  }
  let page: PublicFetchResult;
  try {
    page = await fetcher(src.url, { userAgent: USER_AGENT });
  } catch (err) {
    return { status: 'fetch_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (page.status >= 400) return { status: 'fetch_failed', detail: `HTTP ${page.status}` };
  const extracted = extractPage(page.body);

  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    await tx.update(competitorSources).set({ lastRobotsAllowed: true, lastFetchedAt: now }).where(eq(competitorSources.id, src.id));
    const [prev] = await tx.select().from(competitorSnapshots).where(eq(competitorSnapshots.sourceId, src.id)).orderBy(desc(competitorSnapshots.fetchedAt)).limit(1);
    if (prev && prev.contentSha256 === page.sha256) return { status: 'unchanged' as const, snapshotId: prev.id };
    const key = tenantKey(tenantId, 'competitors', src.id, `${page.sha256}.html`);
    await deps.store.put(key, page.body, page.contentType || 'text/html');
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'snapshot',
      sourceType: 'primary',
      owner: url.hostname,
      uri: page.finalUrl,
      content: { title: extracted.title, headings: extracted.headings.slice(0, 50), prices: extracted.prices, sha256: page.sha256, objectKey: key },
      summary: `Public page snapshot of ${page.finalUrl}`,
      confidence: 1,
      license: 'publicly accessible page captured under the tenant-approved lawful-source allowlist (competitive analysis only)',
      permittedUses: ['competitive_analysis', 'analytics', 'creative_generation'],
      externalPlatformTerms: `robots.txt allowed at ${now.toISOString()}`,
      observedAt: page.fetchedAt,
      freshnessSlaHours: src.crawlIntervalHours * 2,
      parents: prev ? [prev.evidenceId] : [],
      now,
    });
    const diff = prev ? diffLines(prev.textExcerpt, extracted.text.slice(0, 50_000)) : null;
    const prevPrices = priceSet(((prev?.extracted as { prices?: string[] }) ?? {}).prices ?? []);
    const curPrices = priceSet(extracted.prices);
    const [snap] = await tx
      .insert(competitorSnapshots)
      .values({
        tenantId,
        sourceId: src.id,
        fetchedAt: page.fetchedAt,
        httpStatus: page.status,
        contentSha256: page.sha256,
        objectKey: key,
        textExcerpt: extracted.text.slice(0, 50_000),
        extracted: { title: extracted.title, metaDescription: extracted.metaDescription, headings: extracted.headings, prices: extracted.prices },
        evidenceId: ev.evidenceId,
        diffFromPrevious: diff ? { added: diff.added.slice(0, 200), removed: diff.removed.slice(0, 200) } : null,
      })
      .returning();
    let observations = 0;
    if (prev) {
      const added = [...curPrices].filter((p) => !prevPrices.has(p));
      const removed = [...prevPrices].filter((p) => !curPrices.has(p));
      if (added.length || removed.length) {
        await tx.insert(competitorObservations).values({
          tenantId,
          competitorId: src.competitorId,
          kind: 'price_change',
          summary: `Prices changed on ${url.pathname}: added ${added.join(', ') || 'none'}; removed ${removed.join(', ') || 'none'}`,
          details: { added, removed, url: page.finalUrl },
          evidenceFlag: 'P',
          evidenceIds: [prev.evidenceId, ev.evidenceId],
          confidence: 1,
          observedAt: page.fetchedAt,
        });
        observations++;
      }
      const prevHeads = new Set(((prev.extracted as { headings?: { text: string }[] }).headings ?? []).map((h) => h.text));
      const newHeads = extracted.headings.filter((h) => !prevHeads.has(h.text)).map((h) => h.text);
      if (newHeads.length) {
        await tx.insert(competitorObservations).values({
          tenantId,
          competitorId: src.competitorId,
          kind: src.kind === 'changelog' ? 'release' : 'content_change',
          summary: `New sections on ${url.pathname}: ${newHeads.slice(0, 5).join(' | ')}`,
          details: { headings: newHeads, url: page.finalUrl },
          evidenceFlag: 'P',
          evidenceIds: [prev.evidenceId, ev.evidenceId],
          confidence: 1,
          observedAt: page.fetchedAt,
        });
        observations++;
      }
    }
    await record(tx, tenantId, actor, 'competitor.snapshot.captured', { type: 'competitor_snapshot', id: snap!.id }, { sourceId: src.id, sha256: page.sha256, observations });
    return { status: 'captured' as const, snapshotId: snap!.id, observations };
  });
}

/* ------------------------------------------------------------------ */
/* Model-assisted extraction ([I], snippet-verified)                   */
/* ------------------------------------------------------------------ */

const ExtractionSchema = z.object({
  abstain: z.boolean(),
  observations: z
    .array(
      z.object({
        kind: z.enum(['price_change', 'feature_added', 'feature_removed', 'positioning', 'release']),
        summary: z.string().max(500),
        snippet: z.string().max(500),
      }),
    )
    .max(10),
});

export async function extractObservationsWithModel(deps: CoreDeps, tenantId: string, snapshotId: string) {
  return runAgent(deps, tenantId, { kind: 'competitor_extraction', agentId: 'competitor-analyst', triggeredBy: 'system', input: { snapshotId } }, async (ctx) => {
    const snap = await withTenant(deps.db, { tenantId, actor: 'system:competitor-analyst' }, async (tx) => {
      const [s] = await tx.select().from(competitorSnapshots).where(eq(competitorSnapshots.id, snapshotId));
      const [src] = s ? await tx.select().from(competitorSources).where(eq(competitorSources.id, s.sourceId)) : [];
      return s && src ? { s, src } : null;
    });
    if (!snap) throw notFound('snapshot');
    const diff = (snap.s.diffFromPrevious as { added: string[]; removed: string[] } | null) ?? { added: [], removed: [] };
    if (!diff.added.length && !diff.removed.length) {
      ctx.note('skip', { reason: 'no textual change' });
      return { created: 0 };
    }
    const r = await ctx.think('extract', PROMPTS.competitorExtraction, {
      purpose: 'extraction',
      outputSchema: ExtractionSchema,
      messages: [
        {
          role: 'user',
          content: `Competitor page ${snap.src.url} (${snap.src.kind}).\nRemoved text:\n${untrustedBlock('competitor:removed', diff.removed.join('\n').slice(0, 20_000))}\nAdded text:\n${untrustedBlock('competitor:added', diff.added.join('\n').slice(0, 20_000))}\nReturn observations; quote the exact supporting snippet from the added or removed text.`,
        },
      ],
    });
    if (r.output.abstain) return { created: 0 };
    const corpus = normalizeText([...diff.added, ...diff.removed].join(' '));
    let created = 0;
    await withTenant(deps.db, { tenantId, actor: 'system:competitor-analyst' }, async (tx) => {
      for (const o of r.output.observations) {
        // Hallucination guard: an observation must quote text that literally exists in the diff.
        if (!o.snippet.trim() || !corpus.includes(normalizeText(o.snippet))) continue;
        await tx.insert(competitorObservations).values({
          tenantId,
          competitorId: snap.src.competitorId,
          kind: o.kind,
          summary: o.summary,
          details: { snippet: o.snippet, model: r.servedBy, agentRunId: ctx.runId },
          evidenceFlag: 'I',
          evidenceIds: [snap.s.evidenceId],
          confidence: 0.5,
          observedAt: snap.s.fetchedAt,
        });
        created++;
      }
    });
    ctx.note('verify_snippets', { proposed: r.output.observations.length, kept: created });
    return { created };
  });
}

/* ------------------------------------------------------------------ */
/* Gap analysis and REA                                                */
/* ------------------------------------------------------------------ */

/** Features competitors publicly list that do not match an active fact about our own product. [I] */
export async function featureGaps(tx: DbOrTx, competitorId?: string) {
  const ours = await tx.select({ name: kgEntities.name }).from(kgEntities).where(and(eq(kgEntities.status, 'active'), sql`${kgEntities.kind} in ('feature','integration')`));
  const ourTokens = ours.map((o) => new Set(normalizeText(o.name).split(' ')));
  const snaps = await tx.execute<{ competitor_id: string; name: string; headings: { text: string }[]; evidence_id: string }>(sql`
    select distinct on (s.source_id) cs.competitor_id, c.name, s.extracted->'headings' as headings, s.evidence_id
    from competitor_snapshots s join competitor_sources cs on cs.id = s.source_id join competitors c on c.id = cs.competitor_id
    where cs.kind in ('features','pricing','changelog') ${competitorId ? sql`and cs.competitor_id = ${competitorId}` : sql``}
    order by s.source_id, s.fetched_at desc`);
  const gaps: { competitorId: string; competitor: string; feature: string; evidenceId: string; flag: 'I' }[] = [];
  for (const row of snaps.rows) {
    for (const h of row.headings ?? []) {
      const t = new Set(normalizeText(h.text).split(' ').filter((w) => w.length > 2));
      if (t.size === 0) continue;
      const covered = ourTokens.some((o) => [...t].filter((w) => o.has(w)).length / t.size >= 0.6);
      if (!covered) gaps.push({ competitorId: row.competitor_id, competitor: row.name, feature: h.text, evidenceId: row.evidence_id, flag: 'I' });
    }
  }
  return gaps.slice(0, 200);
}

export const ReaJobSchema = z.object({
  targetDescription: z.string().min(10).max(2000),
  artifactRef: z.string().min(3).max(500),
  ownershipOrLicence: z.enum(['owned_by_tenant', 'licensed_with_analysis_rights', 'explicit_written_authorization']),
  authorizationEvidenceId: z.string().uuid(),
  legalApproved: z.literal(true),
});

/**
 * REA reverse-engineering jobs (OS-REA) require an authorization record with legal approval.
 * Execution is blocked: no isolated, malware-safe sandbox exists in the Sandbox tier (B-012).
 */
export async function registerReaJob(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, LEGAL_ROLES, 'authorizing reverse-engineering analysis');
  requireMfa(actor, 'authorizing reverse-engineering analysis');
  const input = ReaJobSchema.parse(raw);
  const [row] = await tx
    .insert(reaJobs)
    .values({
      tenantId,
      targetDescription: input.targetDescription,
      artifactRef: input.artifactRef,
      authorization: { ownershipOrLicence: input.ownershipOrLicence, authorizationEvidenceId: input.authorizationEvidenceId, approvedBy: actorRef(actor), approvedAt: new Date().toISOString() },
      legalApproved: true,
      status: 'blocked_no_sandbox',
      statusReason: 'No isolated analysis sandbox is available in this deployment (BLOCKERS B-012).',
      createdBy: actorRef(actor),
    })
    .returning();
  await audit(tx, tenantId, actor, 'competitor.rea_job.registered', { type: 'rea_job', id: row!.id }, { status: row!.status });
  return row!;
}

export async function listObservations(tx: DbOrTx, competitorId?: string) {
  return tx
    .select()
    .from(competitorObservations)
    .where(competitorId ? eq(competitorObservations.competitorId, competitorId) : undefined)
    .orderBy(desc(competitorObservations.observedAt))
    .limit(500);
}

export async function listCompetitors(tx: DbOrTx) {
  const [cs, sources] = await Promise.all([tx.select().from(competitors).orderBy(competitors.name), tx.select().from(competitorSources)]);
  return cs.map((c) => ({ ...c, sources: sources.filter((s) => s.competitorId === c.id) }));
}
