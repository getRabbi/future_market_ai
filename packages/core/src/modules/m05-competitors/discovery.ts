import { PROMPTS, untrustedBlock } from '@futuregrow/agent-kernel';
import { publicFetch } from '@futuregrow/connectors';
import { brandApps, brands, competitorCandidates, competitorDiscoveryRuns, competitorDiscoverySettings, competitorSources, competitors, connections, type DbOrTx, growthBrandConfigs, type Tx, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runAgent } from '../../agents.js';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, normalizeText, requireMfa, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { raiseAlert } from '../m24-governance/index.js';
import { BRAVE_TERMS, braveSearchProvider, countryName, TAVILY_TERMS, tavilySearchProvider, webIdentity } from './search-providers.js';

const ACTOR = systemActor('competitor-discovery');
const TERMS = 'https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html';
const DAY = 86_400_000;
const words = (s: string) => [...new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((s) => !['the', 'and', 'for', 'with', 'app', 'apps', 'your'].includes(s));

/** Web-index providers and the connection each one reads its key from. */
const WEB_PROVIDERS = { brave_web: 'brave_search', brave_google_play: 'brave_search', tavily_web: 'tavily' } as const;
type WebProvider = keyof typeof WEB_PROVIDERS;
const isWeb = (p: string): p is WebProvider => p in WEB_PROVIDERS;

export const DEFAULT_QUERY_TEMPLATES = ['{keyword}', '{keyword} app', '{keyword} {country}'];
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/**
 * D-055 tuning, stored as data (`competitor_discovery_settings.options`) so discovery is adjusted
 * from the settings form, never by changing code.
 */
export const DiscoveryOptionsSchema = z.object({
  /** Also search the free Apple App Store when the main provider is a web index. */
  includeAppStore: z.boolean().default(true),
  /** Web query patterns: {keyword} = each brand keyword (Growth Warfare brand profile, else the brand name), {brand}, {country}. */
  queryTemplates: z.array(z.string().trim().min(3).max(120)).min(1).max(10).default(DEFAULT_QUERY_TEMPLATES),
  /** Queries per run per provider; successive runs rotate through all keywords. */
  maxQueriesPerRun: z.number().int().min(1).max(10).default(4),
  /** Web-index requests per tenant per calendar month (UTC), to stay inside a free allowance. */
  monthlySearchLimit: z.number().int().min(10).max(5000).default(300),
  /** Let the approved model judge each result (direct / indirect / not a competitor). */
  aiJudge: z.boolean().default(true),
  /** Candidates at or above this confidence are enrolled without review (an AI "direct" verdict is 0.85). */
  autoEnrollConfidence: z.number().min(0.6).max(1).default(0.8),
  /** One-time approval: sources of enrolled competitors (store listings, home pages) are approved for robots.txt-respecting monitoring. */
  standingSourceApproval: z.boolean().default(false),
  /** Hosts never treated as competitors (besides the brand's own apps and landing page). */
  excludeDomains: z.array(z.string().trim().regex(HOST)).max(50).default([]),
});
export type DiscoveryOptions = z.infer<typeof DiscoveryOptionsSchema>;
const OPTION_KEYS = Object.keys(DiscoveryOptionsSchema.shape) as (keyof DiscoveryOptions)[];

export const DiscoverySettingsSchema = z
  .object({
    brandId: z.string().uuid(),
    enabled: z.boolean(),
    country: z.string().regex(/^[A-Z]{2}$/),
    provider: z.enum(['app_store', 'brave_web', 'brave_google_play', 'tavily_web']).default('app_store'),
    connectionId: z.string().uuid().nullable().default(null),
    intervalHours: z.number().int().min(24).max(720).default(168),
    lawfulBasisNote: z.string().min(20).max(2000),
  })
  .extend(DiscoveryOptionsSchema.shape);

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

/* ------------------------------------------------------------------ */
/* Query planning                                                      */
/* ------------------------------------------------------------------ */

/** Brand keywords from the Growth Warfare brand profile (D-054), read defensively; [] when none. */
async function brandProfile(tx: DbOrTx, brandId: string): Promise<{ keywords: string[]; landingHost: string | null; goal: string | null }> {
  const [row] = await tx.select({ config: growthBrandConfigs.config }).from(growthBrandConfigs).where(eq(growthBrandConfigs.brandId, brandId));
  const c = (row?.config ?? {}) as { keywords?: unknown; landingUrl?: unknown; businessGoal?: unknown };
  const keywords = Array.isArray(c.keywords) ? c.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length >= 2).map((k) => k.trim().slice(0, 80)) : [];
  let landingHost: string | null = null;
  try {
    landingHost = typeof c.landingUrl === 'string' ? new URL(c.landingUrl).hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    landingHost = null;
  }
  return { keywords: [...new Set(keywords)].slice(0, 100), landingHost, goal: typeof c.businessGoal === 'string' ? c.businessGoal.slice(0, 300) : null };
}

/**
 * Deterministic, bounded query list. Store searches use plain keywords; web searches expand the
 * templates. `offset` (runs so far) rotates through the pool, so every keyword is covered over
 * successive runs without growing any single run.
 */
export function planQueries(input: { brand: string; keywords: string[]; templates: string[]; country: string; max: number; offset: number; store: boolean }): string[] {
  const keys = [...new Set([input.brand, ...input.keywords].map((k) => k.trim()).filter(Boolean))];
  const country = countryName(input.country) ?? input.country;
  const pool: string[] = [];
  if (input.store) pool.push(...keys);
  else {
    const once = input.templates.filter((t) => !t.includes('{keyword}'));
    for (const k of keys) for (const t of input.templates.filter((x) => x.includes('{keyword}'))) pool.push(t.replaceAll('{keyword}', k));
    pool.push(...once);
  }
  const filled = [...new Set(pool.map((q) => q.replaceAll('{brand}', input.brand).replaceAll('{country}', country).replace(/\s+/g, ' ').trim().slice(0, 300)).filter((q) => q.length >= 2))];
  if (!filled.length) return [];
  const n = Math.min(input.max, filled.length);
  const start = (input.offset * n) % filled.length;
  return Array.from({ length: n }, (_, i) => filled[(start + i) % filled.length]!);
}

/* ------------------------------------------------------------------ */
/* Settings and enrolment                                              */
/* ------------------------------------------------------------------ */

export async function configureDiscovery(tx: Tx, tenantId: string, actor: Actor, raw: unknown, now: Date) {
  requireRole(actor, ['owner', 'legal_approver'], 'approving discovery API use');
  requireMfa(actor, 'approving discovery API use');
  const input = DiscoverySettingsSchema.parse(raw);
  if (isWeb(input.provider)) {
    if (!input.connectionId) throw invalid(`Select an approved ${input.provider === 'tavily_web' ? 'Tavily' : 'Brave Search'} connection`);
    const [connection] = await tx.select().from(connections).where(eq(connections.id, input.connectionId));
    if (connection?.provider !== WEB_PROVIDERS[input.provider] || !['active', 'read_only'].includes(connection.status)) throw invalid(`${input.provider === 'tavily_web' ? 'Tavily' : 'Brave Search'} connection unavailable`);
  }
  const [b] = await tx.select().from(brands).where(eq(brands.id, input.brandId));
  if (!b) throw notFound('brand');
  const options = DiscoveryOptionsSchema.parse(Object.fromEntries(OPTION_KEYS.map((k) => [k, input[k]])));
  const values = {
    tenantId,
    brandId: input.brandId,
    enabled: input.enabled,
    country: input.country,
    provider: input.provider,
    connectionId: isWeb(input.provider) ? input.connectionId : null,
    intervalHours: input.intervalHours,
    lawfulBasisNote: input.lawfulBasisNote,
    options,
    approvedBy: actorRef(actor),
    approvedAt: now,
  };
  const [row] = await tx
    .insert(competitorDiscoverySettings)
    .values(values)
    .onConflictDoUpdate({ target: [competitorDiscoverySettings.tenantId, competitorDiscoverySettings.brandId], set: values })
    .returning();
  await audit(
    tx,
    tenantId,
    actor,
    'competitor.discovery.configured',
    { type: 'brand', id: b.id },
    {
      enabled: input.enabled,
      provider: input.provider,
      terms: input.provider === 'app_store' ? TERMS : input.provider === 'tavily_web' ? TAVILY_TERMS : BRAVE_TERMS,
      aiJudge: options.aiJudge,
      autoEnrollConfidence: options.autoEnrollConfidence,
      standingSourceApproval: options.standingSourceApproval,
      monthlySearchLimit: options.monthlySearchLimit,
    },
  );
  return row!;
}

type Standing = { by: string; at: Date } | null;

async function standingFor(tx: Tx, brandId: string): Promise<Standing> {
  const [s] = await tx.select().from(competitorDiscoverySettings).where(eq(competitorDiscoverySettings.brandId, brandId));
  if (!s) return null;
  return DiscoveryOptionsSchema.parse(s.options ?? {}).standingSourceApproval ? { by: s.approvedBy, at: s.approvedAt } : null;
}

async function enroll(tx: Tx, tenantId: string, candidate: typeof competitorCandidates.$inferSelect, standing: Standing) {
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
  const store = candidate.identity.startsWith('google_play:') || candidate.identity.startsWith('app_store:');
  // A discovered source is approved only under the owner's standing approval (D-055); otherwise it
  // waits for legal review. Existing (including revoked) sources are never changed here.
  const [created] = await tx
    .insert(competitorSources)
    .values({
      tenantId,
      competitorId: c.id,
      url: candidate.url,
      kind: store ? 'app_listing' : 'other',
      lawfulBasisNote: standing ? `Approved under the standing discovery approval of ${standing.by} (${standing.at.toISOString()}); robots.txt is honoured on every fetch.` : 'Proposed from discovery evidence. Legal must review page monitoring separately.',
      status: standing ? 'approved' : 'pending',
      approvedBy: standing ? `standing:${standing.by}` : null,
      approvedAt: standing ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning();
  if (created && standing) await audit(tx, tenantId, ACTOR, 'competitor.source.approved', { type: 'competitor_source', id: created.id }, { standingApprovalBy: standing.by, standingApprovalAt: standing.at.toISOString(), url: created.url });
  await tx.update(competitorCandidates).set({ status: 'enrolled', competitorId: c.id }).where(eq(competitorCandidates.id, candidate.id));
  await raiseAlert(tx, tenantId, {
    kind: 'competitor.discovered',
    severity: 'info',
    message: `New competitor enrolled: ${candidate.name}. ${created?.status === 'approved' ? 'Monitoring starts under the standing approval.' : 'Monitoring awaits source approval.'}`,
    refs: { competitorId: c.id, evidenceId: candidate.evidenceId },
    dedupKey: `competitor-discovered:${candidate.identity}`,
  });
}

export async function reviewCandidate(tx: Tx, tenantId: string, actor: Actor, id: string, decision: 'enroll' | 'reject') {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'reviewing competitors');
  const [c] = await tx.select().from(competitorCandidates).where(eq(competitorCandidates.id, id)).for('update');
  if (!c) throw notFound('candidate');
  if (c.status !== 'review') throw invalid('candidate already reviewed');
  if (decision === 'enroll') await enroll(tx, tenantId, c, await standingFor(tx, c.brandId));
  else await tx.update(competitorCandidates).set({ status: 'rejected' }).where(eq(competitorCandidates.id, id));
  await audit(tx, tenantId, actor, 'competitor.candidate.reviewed', { type: 'competitor_candidate', id }, { decision });
  return { id, decision };
}

/* ------------------------------------------------------------------ */
/* AI judge (D-055)                                                    */
/* ------------------------------------------------------------------ */

interface Item {
  identity: string;
  url: string;
  name: string;
  /** Exactly the text the judge may quote: title + snippet (or store name + description). */
  text: string;
  store: boolean;
  providerId: string;
  terms: string;
  query: string;
  raw: unknown;
  lexical: { score: number; confidence: number; category: string; reasons: string[] } | null;
}

const JudgeSchema = z.object({
  abstain: z.boolean(),
  results: z
    .array(
      z.object({
        index: z.number().int().min(0),
        verdict: z.enum(['direct', 'indirect', 'not_competitor']),
        entityType: z.enum(['app', 'website', 'video_channel', 'social_page', 'course_provider', 'other']),
        name: z.string().min(1).max(120),
        reason: z.string().max(300),
        quote: z.string().max(300),
      }),
    )
    .max(60),
});
type Verdict = z.infer<typeof JudgeSchema>['results'][number] & { model: string };

/** Keeps one judge call inside small free-tier token limits (Bangla text costs more tokens). */
const MAX_JUDGED = 25;
const SNIPPET = 280;

async function judge(deps: CoreDeps, tenantId: string, brand: { id: string; name: string }, profile: { keywords: string[]; goal: string | null }, country: string, items: Item[]): Promise<Map<number, Verdict> | null> {
  if (!deps.models || !items.length) return null;
  const list = items
    .slice(0, MAX_JUDGED)
    .map((it, i) => `[${i}] ${it.store ? 'APP STORE' : 'WEB'} | ${it.url}\n${it.text.slice(0, SNIPPET)}`)
    .join('\n\n');
  const out = await runAgent(deps, tenantId, { kind: 'competitor_discovery', agentId: 'competitor-scout', triggeredBy: 'system', input: { brandId: brand.id, results: Math.min(items.length, MAX_JUDGED) } }, async (ctx) => {
    const r = await ctx.think('judge', PROMPTS.competitorDiscovery, {
      purpose: 'extraction',
      maxTokens: 2500,
      outputSchema: JudgeSchema,
      messages: [
        {
          role: 'user',
          content: `Brand: ${brand.name}\nGoal: ${profile.goal ?? 'not stated'}\nMarket: ${countryName(country) ?? country}\nKeywords: ${profile.keywords.slice(0, 40).join(', ') || brand.name}\n\nSearch results:\n${untrustedBlock('search:results', list)}\n\nJudge each result you can. Quote the supporting phrase exactly as it appears in that result.`,
        },
      ],
    });
    return { output: r.output, model: r.servedBy };
  });
  if (out.status !== 'completed' || out.result.output.abstain) return null;
  const map = new Map<number, Verdict>();
  for (const v of out.result.output.results) {
    const it = items[v.index];
    // Hallucination guard: the quote must literally exist in that result's own text.
    if (!it || v.index >= MAX_JUDGED || map.has(v.index) || v.quote.trim().length < 3 || !normalizeText(it.text.slice(0, SNIPPET)).includes(normalizeText(v.quote))) continue;
    map.set(v.index, { ...v, model: out.result.model });
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Discovery run                                                       */
/* ------------------------------------------------------------------ */

function lexicalWeb(query: string, title: string, description: string) {
  const terms = words(query);
  const corpus = new Set(words(`${title} ${description}`));
  const matched = terms.filter((t) => corpus.has(t));
  if (!matched.length) return null;
  return {
    score: Math.round((100 * matched.length) / terms.length),
    confidence: 0.5,
    category: 'indirect',
    reasons: [`Search index matched ${matched.length}/${terms.length} terms: ${matched.join(', ')}`, 'Secondary index evidence only; identity, category and relevance need human verification. No listing or website was crawled.'],
  };
}

const WebResult = z.object({ title: z.string().min(1).max(500), url: z.string().url(), description: z.string().max(10000).default('') });

function toItem(raw: unknown, query: string, searcher: { id: string; store: boolean; playOnly: boolean; terms: string; rank?: CompetitorSearchProvider['rank'] }, now: Date): Item | null {
  if (searcher.store) {
    const parsed = StoreCandidateSchema.safeParse(raw);
    if (!parsed.success) return null;
    const ranked = searcher.rank ? searcher.rank(query, raw, now) : rankCandidate(query, raw, now);
    const id = webIdentity(parsed.data.trackViewUrl);
    if (!id || !id.identity.startsWith('app_store:') || id.identity !== `app_store:${parsed.data.trackId}`) return null;
    return { identity: id.identity, url: ranked?.url ?? id.url, name: parsed.data.trackName.slice(0, 200), text: `${parsed.data.trackName} — ${parsed.data.sellerName}. ${parsed.data.description.slice(0, 1500)}`, store: true, providerId: searcher.id, terms: searcher.terms, query, raw, lexical: ranked };
  }
  const r = WebResult.safeParse(raw);
  if (!r.success) return null;
  const id = webIdentity(r.data.url);
  if (!id || (searcher.playOnly && !id.identity.startsWith('google_play:'))) return null;
  const lexical = searcher.rank ? searcher.rank(query, raw, now) : lexicalWeb(query, r.data.title, r.data.description);
  return {
    identity: id.identity,
    url: id.url,
    name: r.data.title.slice(0, 200),
    text: `${r.data.title}. ${r.data.description}`,
    store: false,
    providerId: searcher.id,
    terms: searcher.terms,
    query,
    raw,
    lexical: lexical ? { score: lexical.score, confidence: lexical.confidence, category: lexical.category, reasons: lexical.reasons } : null,
  };
}

/**
 * One bounded discovery per brand per interval (the worker uses one global queue for provider rate
 * control). D-055: queries come from the brand's keywords; a web index (Tavily or Brave) and the
 * App Store can run together; the approved model judges every result against the brand, with a
 * literal-quote guard; confident candidates are enrolled and, under the owner's standing approval,
 * their public listing or home page is monitored. Without a model the lexical heuristics apply.
 */
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
    const options = DiscoveryOptionsSchema.parse(s.options ?? {});
    const profile = await brandProfile(tx, brandId);
    const [prior] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(competitorDiscoveryRuns)
      .where(and(eq(competitorDiscoveryRuns.brandId, brandId), eq(competitorDiscoveryRuns.status, 'succeeded')));
    const offset = prior?.n ?? 0;
    const plan = (store: boolean) => planQueries({ brand: b.name, keywords: profile.keywords, templates: options.queryTemplates, country: s.country, max: options.maxQueriesPerRun, offset, store });
    const web = isWeb(s.provider);
    let webQueries: string[] = [];
    let limitNote: string | null = null;
    if (web) {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [used] = await tx
        .select({ n: sql<number>`coalesce(sum(${competitorDiscoveryRuns.searchCount}), 0)::int` })
        .from(competitorDiscoveryRuns)
        .where(gte(competitorDiscoveryRuns.createdAt, monthStart));
      const remaining = Math.max(0, options.monthlySearchLimit - (used?.n ?? 0));
      webQueries = plan(false).slice(0, remaining);
      if (!webQueries.length) limitNote = `monthly web search limit reached (${used?.n ?? 0} of ${options.monthlySearchLimit})`;
    }
    const storeQueries = !web ? plan(true) : options.includeAppStore ? plan(true).slice(0, 2) : [];
    await tx.update(competitorDiscoverySettings).set({ lastAttemptAt: now }).where(eq(competitorDiscoverySettings.id, s.id));
    const query = [...webQueries, ...storeQueries].join(' | ').slice(0, 1000) || b.name;
    const [run] = await tx.insert(competitorDiscoveryRuns).values({ tenantId, brandId, query, provider: s.provider, status: 'running' }).returning();
    return { s, b, apps, options, profile, webQueries, storeQueries, limitNote, run: run! };
  });
  if (!claim) return { status: 'skipped' };
  const finishRun = (patch: Partial<typeof competitorDiscoveryRuns.$inferInsert>) =>
    withTenant(deps.db, { tenantId, actor: actorRef(ACTOR) }, (tx) =>
      tx
        .update(competitorDiscoveryRuns)
        .set({ finishedAt: deps.clock.now(), ...patch })
        .where(eq(competitorDiscoveryRuns.id, claim.run.id)),
    );
  try {
    // Searchers: an injected provider (tests) replaces the configured one.
    type Searcher = { id: string; store: boolean; playOnly: boolean; terms: string; rank?: CompetitorSearchProvider['rank']; counts: boolean; queries: string[]; search: CompetitorSearchProvider['search'] };
    const searchers: Searcher[] = [];
    const web = isWeb(claim.s.provider);
    if (web && claim.webQueries.length) {
      let p = provider;
      if (!p) {
        if (!claim.s.connectionId) throw invalid('Discovery provider unavailable');
        const { ctx } = await readContext(deps, tenantId, claim.s.connectionId, WEB_PROVIDERS[claim.s.provider as WebProvider]);
        if (ctx.credentials.provider === 'tavily') p = tavilySearchProvider(deps.http, ctx.credentials.apiKey);
        else if (ctx.credentials.provider === 'brave_search') p = braveSearchProvider(deps.http, ctx.credentials.apiKey, claim.s.provider === 'brave_google_play', deps.sleep);
        else throw invalid('Discovery credentials unavailable');
      }
      searchers.push({ id: p.id ?? claim.s.provider, store: false, playOnly: claim.s.provider === 'brave_google_play', terms: p.terms ?? (claim.s.provider === 'tavily_web' ? TAVILY_TERMS : BRAVE_TERMS), rank: p.rank, counts: true, queries: claim.webQueries, search: p.search.bind(p) });
    }
    if (claim.storeQueries.length) {
      const p = !web && provider ? provider : appStoreSearch;
      searchers.push({ id: p.id ?? 'app_store', store: !p.rank, playOnly: false, terms: p.terms ?? TERMS, rank: p.rank, counts: false, queries: claim.storeQueries, search: p.search.bind(p) });
    }
    if (!searchers.length) {
      await finishRun({ status: 'skipped', note: claim.limitNote ?? 'no queries' });
      return { status: 'skipped', reason: claim.limitNote ?? 'no queries' };
    }

    const own = (it: Item) => {
      const host = (() => {
        try {
          return new URL(it.url).hostname.toLowerCase().replace(/^www\./, '');
        } catch {
          return '';
        }
      })();
      return (
        claim.apps.some((a) => it.identity === `google_play:${a.appId}` || it.identity === `app_store:${a.appId}` || (it.raw as { bundleId?: string }).bundleId === a.appId || a.listingUrl === it.url) ||
        (!!claim.profile.landingHost && it.identity === `web:${claim.profile.landingHost}`) ||
        claim.options.excludeDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`))
      );
    };

    let searchCount = 0;
    const errors: string[] = [];
    const items: Item[] = [];
    const seen = new Set<string>();
    for (const sr of searchers) {
      for (const q of sr.queries) {
        let results: unknown[];
        try {
          if (sr.counts) searchCount++;
          results = (await sr.search(q, claim.s.country)).slice(0, 25);
        } catch (err) {
          errors.push(`${sr.id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
          break; // a refused key or plan limit will refuse the next query too
        }
        for (const raw of results) {
          const it = toItem(raw, q, sr, now);
          if (!it || seen.has(it.identity) || own(it)) continue;
          seen.add(it.identity);
          items.push(it);
        }
      }
    }
    if (!items.length && errors.length && errors.length >= searchers.length) throw invalid(errors.join('; '));

    const verdicts = claim.options.aiJudge ? await judge(deps, tenantId, claim.b, claim.profile, claim.s.country, items) : null;
    const scored = items
      .map((it, i) => {
        const v = verdicts?.get(i);
        // Results beyond what the judge was shown keep the lexical ranking.
        if (verdicts && i < MAX_JUDGED) {
          if (!v || v.verdict === 'not_competitor') return null;
          const direct = v.verdict === 'direct';
          return {
            it,
            name: normalizeText(it.text).includes(normalizeText(v.name)) ? v.name : it.name,
            score: direct ? 85 : 60,
            confidence: direct ? 0.85 : 0.6,
            category: direct ? 'direct' : 'indirect',
            reasons: [
              `AI verdict (${v.model}): ${v.verdict} ${v.entityType.replaceAll('_', ' ')} — ${v.reason}`,
              `Supporting text from the result: "${v.quote}"`,
              `${it.store ? 'Official store metadata' : 'Search index result'} for “${it.query}”`,
              'Relevance is a model judgement over the result text, not a market measurement.',
            ],
          };
        }
        return it.lexical ? { it, name: it.name, score: it.lexical.score, confidence: it.lexical.confidence, category: it.lexical.category, reasons: it.lexical.reasons } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return await withTenant(deps.db, { tenantId, actor: actorRef(ACTOR) }, async (tx) => {
      const [current] = await tx.select().from(competitorDiscoverySettings).where(eq(competitorDiscoverySettings.id, claim.s.id)).for('update');
      if (!current?.enabled || current.approvedAt.getTime() !== claim.s.approvedAt.getTime()) {
        await tx.update(competitorDiscoveryRuns).set({ status: 'cancelled', note: 'Approval changed during search', searchCount, finishedAt: now }).where(eq(competitorDiscoveryRuns.id, claim.run.id));
        return { status: 'cancelled' };
      }
      const standing: Standing = claim.options.standingSourceApproval ? { by: current.approvedBy, at: current.approvedAt } : null;
      let count = 0;
      let enrolled = 0;
      for (const c of scored) {
        const ev = await admitInternalEvidence(tx, tenantId, ACTOR, {
          kind: 'snapshot',
          sourceType: c.it.store ? 'primary' : 'secondary',
          owner: c.it.store ? 'Apple App Store' : c.it.providerId,
          uri: c.it.url,
          content: c.it.raw,
          summary: `Discovery result for ${c.name}; ${c.it.store ? 'official store metadata' : 'unverified search index evidence'}`,
          confidence: c.it.store ? 1 : 0.5,
          license: claim.s.lawfulBasisNote,
          externalPlatformTerms: c.it.terms,
          permittedUses: ['competitive_analysis', 'analytics'],
          freshnessSlaHours: claim.s.intervalHours * 2,
          now,
        });
        const values = { tenantId, brandId, identity: c.it.identity, name: c.name.slice(0, 200), url: c.it.url, category: c.category, score: c.score, confidence: c.confidence, reasons: c.reasons, evidenceId: ev.evidenceId, runId: claim.run.id, lastSeenAt: now };
        const [row] = await tx
          .insert(competitorCandidates)
          .values(values)
          .onConflictDoUpdate({ target: [competitorCandidates.tenantId, competitorCandidates.brandId, competitorCandidates.identity], set: values })
          .returning();
        if (row!.status === 'review' && c.confidence >= claim.options.autoEnrollConfidence) {
          await enroll(tx, tenantId, row!, standing);
          enrolled++;
        }
        count++;
      }
      const note = [verdicts ? `AI judged ${Math.min(items.length, MAX_JUDGED)} results` : claim.options.aiJudge ? 'AI judge unavailable; lexical ranking used' : null, enrolled ? `${enrolled} enrolled` : null, claim.limitNote, ...errors].filter(Boolean).join('; ') || null;
      await tx
        .update(competitorDiscoveryRuns)
        .set({ status: 'succeeded', resultCount: count, searchCount, note: note?.slice(0, 500) ?? null, finishedAt: now })
        .where(eq(competitorDiscoveryRuns.id, claim.run.id));
      return { status: 'succeeded', count, enrolled, searches: searchCount };
    });
  } catch (err) {
    await finishRun({ status: 'failed', note: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    return { status: 'failed' };
  }
}

export async function discoveryOverview(tx: DbOrTx) {
  return {
    settings: (await tx.select().from(competitorDiscoverySettings)).map((s) => ({ ...s, options: DiscoveryOptionsSchema.parse(s.options ?? {}) })),
    candidates: await tx.select().from(competitorCandidates).orderBy(desc(competitorCandidates.score)).limit(200),
    runs: await tx.select().from(competitorDiscoveryRuns).orderBy(desc(competitorDiscoveryRuns.createdAt)).limit(50),
    availability: {
      app_store: 'Free official App Store search; requires tenant approval of API metadata use.',
      web: 'Tavily (free plan: 1,000 searches a month, no card) or Brave web index; requires a connection with the key and approval of the provider terms. Results are judged by the approved model when one is available.',
      google_play: 'Play listings are found through the web index (Tavily or Brave); there is no Google Play catalogue API and listings are never scraped.',
    },
  };
}
