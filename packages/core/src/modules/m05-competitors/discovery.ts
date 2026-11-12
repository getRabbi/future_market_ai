import { publicFetch } from '@futuregrow/connectors';
import { brandApps, brands, competitorCandidates, competitorDiscoveryRuns, competitorDiscoverySettings, competitorSources, competitors, connections, type DbOrTx, type Tx, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireMfa, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { raiseAlert } from '../m24-governance/index.js';
import { BRAVE_TERMS, braveSearchProvider } from './search-providers.js';

const ACTOR = systemActor('competitor-discovery');
const TERMS = 'https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html';
const DAY = 86_400_000;
const words = (s: string) => [...new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((s) => !['the', 'and', 'for', 'with', 'app', 'apps', 'your'].includes(s));
export const DiscoverySettingsSchema = z.object({
  brandId: z.string().uuid(),
  enabled: z.boolean(),
  country: z.string().regex(/^[A-Z]{2}$/),
  provider: z.enum(['app_store', 'brave_web', 'brave_google_play']).default('app_store'),
  connectionId: z.string().uuid().nullable().default(null),
  intervalHours: z.number().int().min(24).max(720).default(168),
  lawfulBasisNote: z.string().min(20).max(2000),
});

/** Metadata only. No artwork, reviews, ranks, installs, or third-party page fetches. */
export const StoreCandidateSchema = z.object({
  trackId: z.number().int().positive(),
  trackName: z.string().min(1).max(200),
  bundleId: z.string().min(3).max(300),
  sellerName: z.string().min(1).max(300),
  trackViewUrl: z.string().url(),
  description: z.string().max(50_000),
  releaseDate: z.string().optional(),
});
export type StoreCandidate = z.infer<typeof StoreCandidateSchema>;
export interface CompetitorSearchProvider {
  id?: string;
  terms?: string;
  rank?: (query: string, raw: unknown, now: Date) => { item: unknown; identity: string; url: string; score: number; confidence: number; category: string; reasons: string[] } | null;
  search(query: string, country: string): Promise<unknown[]>;
}

/** Official documented endpoint; deliberately no arbitrary URLs or HTML search scraping. */
export const appStoreSearch: CompetitorSearchProvider = {
  async search(query, country) {
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term: query, country, entity: 'software', media: 'software', limit: '25' }).toString();
    const r = await publicFetch(url.toString(), { maxBytes: 2_000_000, timeoutMs: 15_000, maxRedirects: 0, accept: 'application/json' });
    if (r.status !== 200 || new URL(r.finalUrl).hostname !== 'itunes.apple.com') throw invalid(`App Store search unavailable (HTTP ${r.status})`);
    return z.object({ results: z.array(z.unknown()).max(200) }).parse(JSON.parse(r.body)).results;
  },
};

/** Scores are explainable heuristic strengths, never measured market rank or probability. */
export function rankCandidate(query: string, raw: unknown, now: Date) {
  const parsed = StoreCandidateSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const url = new URL(item.trackViewUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'apps.apple.com' || url.username || url.password || !url.pathname.endsWith(`/id${item.trackId}`)) return null;
  url.search = '';
  url.hash = '';
  const terms = words(query);
  const corpus = new Set(words(`${item.trackName} ${item.description}`));
  const matched = terms.filter((t) => corpus.has(t));
  if (!matched.length) return null;
  const ratio = matched.length / Math.max(1, terms.length);
  const score = Math.round(ratio * 100);
  const direct = matched.length >= 2 && ratio >= 0.6;
  const release = item.releaseDate ? new Date(item.releaseDate).getTime() : NaN;
  const emerging = Number.isFinite(release) && release <= now.getTime() && now.getTime() - release < 180 * DAY;
  const confidence = direct && ratio >= 0.8 ? 0.9 : 0.5;
  return {
    item,
    identity: `app_store:${item.trackId}`,
    url: url.toString(),
    score,
    confidence,
    category: emerging ? 'emerging' : direct ? 'direct' : 'indirect',
    reasons: [
      `Official store identity: ${item.trackId}, ${item.bundleId}, seller ${item.sellerName}`,
      `Matched ${matched.length}/${terms.length} query terms: ${matched.join(', ')}`,
      ...(emerging ? ['Store release date is within 180 days; this does not establish market growth.'] : []),
      'Classification and confidence are lexical heuristics, not market measurements.',
    ],
  };
}

export async function configureDiscovery(tx: Tx, tenantId: string, actor: Actor, raw: unknown, now: Date) {
  requireRole(actor, ['owner', 'legal_approver'], 'approving discovery API use');
  requireMfa(actor, 'approving discovery API use');
  const input = DiscoverySettingsSchema.parse(raw);
  if (input.provider !== 'app_store') {
    if (!input.connectionId) throw invalid('Select an approved Brave Search connection');
    const [connection] = await tx.select().from(connections).where(eq(connections.id, input.connectionId));
    if (connection?.provider !== 'brave_search' || !['active', 'read_only'].includes(connection.status)) throw invalid('Brave Search connection unavailable');
  }
  const [b] = await tx.select().from(brands).where(eq(brands.id, input.brandId));
  if (!b) throw notFound('brand');
  const values = { ...input, tenantId, approvedBy: actorRef(actor), approvedAt: now };
  const [row] = await tx
    .insert(competitorDiscoverySettings)
    .values(values)
    .onConflictDoUpdate({ target: [competitorDiscoverySettings.tenantId, competitorDiscoverySettings.brandId], set: values })
    .returning();
  await audit(tx, tenantId, actor, 'competitor.discovery.configured', { type: 'brand', id: b.id }, { enabled: input.enabled, provider: input.provider, terms: input.provider === 'app_store' ? TERMS : BRAVE_TERMS });
  return row!;
}

async function enroll(tx: Tx, tenantId: string, candidate: typeof competitorCandidates.$inferSelect) {
  // Serialize by store identity across brands, and retain manually registered identities by exact listing.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${candidate.identity}`}, 0))`);
  const [source] = await tx.select().from(competitorSources).where(eq(competitorSources.url, candidate.url));
  const name = `${candidate.name} (${candidate.identity})`;
  const [c] = source
    ? await tx.select().from(competitors).where(eq(competitors.id, source.competitorId))
    : await tx
        .insert(competitors)
        .values({ tenantId, name, domains: [new URL(candidate.url).hostname], notes: `Discovered identity; relevance is inferred. Evidence ${candidate.evidenceId}` })
        .onConflictDoUpdate({ target: [competitors.tenantId, competitors.name], set: { name } })
        .returning();
  if (!c) throw notFound('competitor');
  // Never approve a discovered source. Existing revoked sources are left revoked.
  await tx
    .insert(competitorSources)
    .values({ tenantId, competitorId: c.id, url: candidate.url, kind: candidate.identity.startsWith('web:') ? 'other' : 'app_listing', lawfulBasisNote: 'Proposed from discovery evidence. Legal must review page monitoring separately.', status: 'pending' })
    .onConflictDoNothing();
  await tx.update(competitorCandidates).set({ status: 'enrolled', competitorId: c.id }).where(eq(competitorCandidates.id, candidate.id));
  await raiseAlert(tx, tenantId, { kind: 'competitor.discovered', severity: 'info', message: `New competitor candidate enrolled: ${candidate.name}. Monitoring awaits source approval.`, refs: { competitorId: c.id, evidenceId: candidate.evidenceId }, dedupKey: `competitor-discovered:${candidate.identity}` });
}

export async function reviewCandidate(tx: Tx, tenantId: string, actor: Actor, id: string, decision: 'enroll' | 'reject') {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'reviewing competitors');
  const [c] = await tx.select().from(competitorCandidates).where(eq(competitorCandidates.id, id)).for('update');
  if (!c) throw notFound('candidate');
  if (c.status !== 'review') throw invalid('candidate already reviewed');
  if (decision === 'enroll') await enroll(tx, tenantId, c);
  else await tx.update(competitorCandidates).set({ status: 'rejected' }).where(eq(competitorCandidates.id, id));
  await audit(tx, tenantId, actor, 'competitor.candidate.reviewed', { type: 'competitor_candidate', id }, { decision });
  return { id, decision };
}

/** One bounded search per brand per interval. The worker uses one global queue for provider rate control. */
export async function runDiscovery(deps: CoreDeps, tenantId: string, brandId: string, provider?: CompetitorSearchProvider) {
  const now = deps.clock.now();
  const claim = await withTenant(deps.db, { tenantId, actor: actorRef(ACTOR) }, async (tx) => {
    const [s] = await tx.select().from(competitorDiscoverySettings).where(eq(competitorDiscoverySettings.brandId, brandId)).for('update');
    if (!s?.enabled || (s.lastAttemptAt && now.getTime() - s.lastAttemptAt.getTime() < s.intervalHours * 3_600_000)) return null;
    const [b] = await tx
      .select()
      .from(brands)
      .where(and(eq(brands.id, brandId), eq(brands.status, 'active')));
    if (!b) return null;
    const apps = await tx.select().from(brandApps).where(eq(brandApps.brandId, brandId));
    // Brand name is bounded owner-authored product context; connected apps exclude our own identities.
    const query = b.name;
    await tx.update(competitorDiscoverySettings).set({ lastAttemptAt: now }).where(eq(competitorDiscoverySettings.id, s.id));
    const [run] = await tx.insert(competitorDiscoveryRuns).values({ tenantId, brandId, query, provider: s.provider, status: 'running' }).returning();
    return { s, query, apps, run: run! };
  });
  if (!claim) return { status: 'skipped' };
  try {
    if (!provider) {
      if (claim.s.provider === 'app_store') provider = appStoreSearch;
      else {
        if (!['brave_web', 'brave_google_play'].includes(claim.s.provider) || !claim.s.connectionId) throw invalid('Discovery provider unavailable');
        const { ctx } = await readContext(deps, tenantId, claim.s.connectionId, 'brave_search');
        if (ctx.credentials.provider !== 'brave_search') throw invalid('Brave credentials unavailable');
        provider = braveSearchProvider(deps.http, ctx.credentials.apiKey, claim.s.provider === 'brave_google_play', deps.sleep);
      }
    }
    const activeProvider = provider;
    const results = (await provider.search(claim.query, claim.s.country)).slice(0, 25);
    return await withTenant(deps.db, { tenantId, actor: actorRef(ACTOR) }, async (tx) => {
      const [current] = await tx.select().from(competitorDiscoverySettings).where(eq(competitorDiscoverySettings.id, claim.s.id)).for('update');
      if (!current?.enabled || current.approvedAt.getTime() !== claim.s.approvedAt.getTime()) {
        await tx.update(competitorDiscoveryRuns).set({ status: 'cancelled', note: 'Approval changed during search', finishedAt: now }).where(eq(competitorDiscoveryRuns.id, claim.run.id));
        return { status: 'cancelled' };
      }
      let count = 0;
      const seen = new Set<string>();
      for (const raw of results) {
        const ranked = activeProvider.rank ? activeProvider.rank(claim.query, raw, now) : rankCandidate(claim.query, raw, now);
        if (!ranked || seen.has(ranked.identity) || claim.apps.some((a) => ranked.identity === `google_play:${a.appId}` || ranked.identity === `app_store:${a.appId}` || (ranked.item as { bundleId?: string }).bundleId === a.appId || a.listingUrl === ranked.url)) continue;
        const name = String((ranked.item as { trackName?: string; title?: string }).trackName ?? (ranked.item as { title?: string }).title ?? '').slice(0, 200);
        seen.add(ranked.identity);
        const ev = await admitInternalEvidence(tx, tenantId, ACTOR, {
          kind: 'snapshot',
          sourceType: activeProvider.rank ? 'secondary' : 'primary',
          owner: activeProvider.id ?? 'Apple App Store',
          uri: ranked.url,
          content: ranked.item,
          summary: `Discovery result for ${name}; ${activeProvider.rank ? 'unverified search index evidence' : 'official store metadata'}`,
          confidence: activeProvider.rank ? 0.5 : 1,
          license: claim.s.lawfulBasisNote,
          externalPlatformTerms: activeProvider.terms ?? TERMS,
          permittedUses: ['competitive_analysis', 'analytics'],
          freshnessSlaHours: claim.s.intervalHours * 2,
          now,
        });
        const values = { tenantId, brandId, identity: ranked.identity, name, url: ranked.url, category: ranked.category, score: ranked.score, confidence: ranked.confidence, reasons: ranked.reasons, evidenceId: ev.evidenceId, runId: claim.run.id, lastSeenAt: now };
        const [c] = await tx
          .insert(competitorCandidates)
          .values(values)
          .onConflictDoUpdate({ target: [competitorCandidates.tenantId, competitorCandidates.brandId, competitorCandidates.identity], set: values })
          .returning();
        if (c!.status === 'review' && ranked.confidence >= 0.9) await enroll(tx, tenantId, c!);
        count++;
      }
      await tx.update(competitorDiscoveryRuns).set({ status: 'succeeded', resultCount: count, finishedAt: now }).where(eq(competitorDiscoveryRuns.id, claim.run.id));
      return { status: 'succeeded', count };
    });
  } catch (err) {
    await withTenant(deps.db, { tenantId, actor: actorRef(ACTOR) }, (tx) =>
      tx
        .update(competitorDiscoveryRuns)
        .set({ status: 'failed', note: (err instanceof Error ? err.message : String(err)).slice(0, 500), finishedAt: deps.clock.now() })
        .where(eq(competitorDiscoveryRuns.id, claim.run.id)),
    );
    return { status: 'failed' };
  }
}

export async function discoveryOverview(tx: DbOrTx) {
  return {
    settings: await tx.select().from(competitorDiscoverySettings),
    candidates: await tx.select().from(competitorCandidates).orderBy(desc(competitorCandidates.score)).limit(200),
    runs: await tx.select().from(competitorDiscoveryRuns).orderBy(desc(competitorDiscoveryRuns.createdAt)).limit(50),
    availability: {
      app_store: 'Requires tenant legal approval of API metadata use',
      google_play: 'Brave index discovery only; not a Google Play catalogue API. Requires connection and storage/use approval.',
      web: 'Brave adapter available; requires owner-provisioned plan/key and legal approval. Search results always need review.',
    },
  };
}
