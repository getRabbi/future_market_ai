import type { ModelProvider, ProviderOutcome, StructuredRequest } from '@futuregrow/agent-kernel';
import { PROMPTS } from '@futuregrow/agent-kernel';
import { HttpClient } from '@futuregrow/connectors';
import { auditLog, brandApps, brands, competitorCandidates, competitorDiscoveryRuns, competitorObservations, competitorSources, growthSignals, withTenant } from '@futuregrow/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { clearModelCache, createModelGateway } from '../src/agents.js';
import { createConnection } from '../src/modules/connections.js';
import * as gw from '../src/modules/growth-warfare/index.js';
import { configureDiscovery, planQueries, runDiscovery } from '../src/modules/m05-competitors/discovery.js';
import { countryName, webIdentity } from '../src/modules/m05-competitors/search-providers.js';
import { approveModel, seedModelRegistry } from '../src/modules/m24-governance/index.js';

/** Scripted model: answers the discovery judge prompt from a function of the request. */
class ScriptedProvider implements ModelProvider {
  readonly name = 'anthropic';
  judge: ((req: StructuredRequest<unknown>) => unknown) | null = null;
  calls = 0;
  async generateStructured<T>(req: StructuredRequest<T>): Promise<ProviderOutcome<T>> {
    if (req.system !== PROMPTS.competitorDiscovery.system || !this.judge) throw new Error('unexpected prompt');
    this.calls++;
    return { kind: 'ok', output: this.judge(req as StructuredRequest<unknown>) as T, servedBy: 'claude-opus-5-5', usage: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', requestId: 'req_judge' };
  }
}

type Captured = { url: string; auth: string | null; body: Record<string, unknown> };
function tavilyHttp(results: unknown[], status = 200) {
  const calls: Captured[] = [];
  const http = new HttpClient({
    maxRetries: 0,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) });
      return status === 200 ? Response.json({ query: 'q', results, response_time: 0.4, request_id: 'r1' }) : Response.json({ detail: { error: 'Unauthorized' } }, { status });
    },
  });
  return { http, calls };
}

const RESULTS = [
  { title: 'EPS TOPIK Bangla', url: 'https://play.google.com/store/apps/details?id=com.rabbi.eps_topik_bangla', content: 'Our own listing', score: 0.9 },
  { title: 'Rival TOPIK — EPS exam practice', url: 'https://play.google.com/store/apps/details?id=com.rival.topik&hl=en', content: 'Practice EPS TOPIK exam questions in Bangla with mock tests.', score: 0.8 },
  { title: 'Korean Coaching Dhaka', url: 'https://www.korean-coaching.example/courses', content: 'Korean language course for beginners in Dhaka.', score: 0.7 },
  { title: 'EPS exam date announced', url: 'https://news.example/eps-exam-date', content: 'The exam board announced the EPS exam schedule.', score: 0.6 },
  { title: 'Lesson video', url: 'https://www.youtube.com/watch?v=abc123', content: 'A single video', score: 0.5 },
  { title: 'Korean with Rahim', url: 'https://www.youtube.com/@KoreanWithRahim', content: 'Free EPS TOPIK Bangla lessons every week.', score: 0.5 },
];

let h: CoreHarness;
let provider: ScriptedProvider;
const tx = <T>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test' }, f);

beforeAll(async () => {
  h = await createCoreHarness();
  await seedModelRegistry(h.t.handle.db);
  await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'anthropic', modelId: 'claude-opus-5-5', trainingOnCustomerData: 'no', dataRetentionTerms: 'vendor commercial terms reviewed 2026-11', inputUsdPerMtok: 4, outputUsdPerMtok: 20 });
  clearModelCache();
  provider = new ScriptedProvider();
  h.deps.models = createModelGateway(h.deps, { anthropic: provider });
});
afterAll(async () => {
  await h?.close();
});

describe('query planning and identities (D-055)', () => {
  it('expands templates from brand keywords and rotates through them run by run', () => {
    const base = { brand: 'EPS TOPIK Bangla', keywords: ['EPS TOPIK', 'Korean language'], templates: ['{keyword}', '{keyword} app', '{keyword} {country}'], country: 'BD', max: 4, store: false };
    const first = planQueries({ ...base, offset: 0 });
    expect(first).toEqual(['EPS TOPIK Bangla', 'EPS TOPIK Bangla app', 'EPS TOPIK Bangla bangladesh', 'EPS TOPIK']);
    const second = planQueries({ ...base, offset: 1 });
    expect(second[0]).toBe('EPS TOPIK app');
    // Over enough runs every query of the pool (3 keywords × 3 templates) is used.
    const all = new Set(Array.from({ length: 9 }, (_, i) => planQueries({ ...base, offset: i })).flat());
    expect(all.size).toBe(9);
    // Store searches use plain keywords, no templates.
    expect(planQueries({ ...base, store: true, offset: 0 })).toEqual(['EPS TOPIK Bangla', 'EPS TOPIK', 'Korean language']);
    expect(countryName('BD')).toBe('bangladesh');
    expect(countryName('ZZ')).toBeNull();
  });

  it('normalises listings, accounts and sites, and refuses non-entities', () => {
    expect(webIdentity('https://play.google.com/store/apps/details?id=com.rival.topik&hl=en')).toMatchObject({ identity: 'google_play:com.rival.topik', url: 'https://play.google.com/store/apps/details?id=com.rival.topik', kind: 'app_listing' });
    expect(webIdentity('https://apps.apple.com/bd/app/rival/id123456789')).toMatchObject({ identity: 'app_store:123456789', kind: 'app_listing' });
    expect(webIdentity('https://www.youtube.com/@KoreanWithRahim/videos')).toMatchObject({ identity: 'web:youtube.com/@koreanwithrahim', url: 'https://youtube.com/@KoreanWithRahim' });
    expect(webIdentity('https://m.facebook.com/RivalTopik/posts/1')).toMatchObject({ identity: 'web:facebook.com/rivaltopik' });
    expect(webIdentity('https://www.korean-coaching.example/courses?x=1')).toMatchObject({ identity: 'web:korean-coaching.example', url: 'https://www.korean-coaching.example/' });
    expect(webIdentity('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(webIdentity('https://facebook.com/')).toBeNull();
    expect(webIdentity('http://rival.example/')).toBeNull();
    expect(webIdentity('https://10.0.0.1/')).toBeNull();
    expect(webIdentity('https://play.google.com/store/search?q=topik')).toBeNull();
  });
});

describe('automatic discovery with Tavily and the AI judge (D-055)', () => {
  it('searches the brand keywords, enrolls what the AI judges direct, monitors it under the standing approval, and feeds F1', async () => {
    const connection = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'tavily', displayName: 'Tavily', externalAccountId: 'competitor-search', credentials: { apiKey: 'tvly-test' } });
    const [brand] = await tx((t) => t.insert(brands).values({ tenantId: h.tenantId, slug: 'eps-topik', name: 'EPS TOPIK Bangla', createdBy: 'test', updatedBy: 'test' }).returning());
    await tx((t) => t.insert(brandApps).values({ tenantId: h.tenantId, brandId: brand!.id, platform: 'android', appId: 'com.rabbi.eps_topik_bangla', listingUrl: 'https://play.google.com/store/apps/details?id=com.rabbi.eps_topik_bangla', createdBy: 'test' }));
    await tx((t) => gw.settings.putBrandConfig(t, h.tenantId, h.users.operator, brand!.id, { expectedVersion: 0, config: { keywords: ['EPS TOPIK', 'Korean language'], market: 'BD', businessGoal: 'More installs of EPS TOPIK Bangla' } }));
    await tx((t) =>
      configureDiscovery(
        t,
        h.tenantId,
        h.users.owner,
        { brandId: brand!.id, enabled: true, country: 'BD', provider: 'tavily_web', connectionId: connection.id, intervalHours: 24, includeAppStore: false, standingSourceApproval: true, lawfulBasisNote: 'Owner approves Tavily search, evidence storage and monitoring of public listings.' },
        h.clock.now(),
      ),
    );

    provider.judge = () => ({
      abstain: false,
      results: [
        { index: 0, verdict: 'direct', entityType: 'app', name: 'Rival TOPIK', reason: 'Another app for the same exam in Bangla.', quote: 'Practice EPS TOPIK exam questions' },
        { index: 1, verdict: 'indirect', entityType: 'course_provider', name: 'Korean Coaching Dhaka', reason: 'A course for the same language.', quote: 'Korean language course' },
        { index: 2, verdict: 'not_competitor', entityType: 'website', name: 'EPS exam date announced', reason: 'News.', quote: 'announced the EPS exam schedule' },
        // Fabricated support: the quote is not in that result, so the verdict is dropped.
        { index: 3, verdict: 'direct', entityType: 'video_channel', name: 'Korean with Rahim', reason: 'Lessons.', quote: 'paid certificate course with guaranteed visa' },
        { index: 9, verdict: 'direct', entityType: 'app', name: 'Ghost', reason: 'Out of range.', quote: 'ghost' },
      ],
    });
    const { http, calls } = tavilyHttp(RESULTS);
    const r = await runDiscovery({ ...h.deps, http }, h.tenantId, brand!.id);
    expect(r).toMatchObject({ status: 'succeeded', count: 2, enrolled: 1, searches: 4 });
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ url: 'https://api.tavily.com/search', auth: 'Bearer tvly-test', body: { query: 'EPS TOPIK Bangla', search_depth: 'basic', max_results: 10, country: 'bangladesh', include_raw_content: false } });
    expect(provider.calls).toBe(1);

    const candidates = await tx((t) => t.select().from(competitorCandidates).where(eq(competitorCandidates.brandId, brand!.id)));
    expect(candidates.map((c) => [c.identity, c.status, c.confidence]).sort()).toEqual([
      ['google_play:com.rival.topik', 'enrolled', 0.85],
      ['web:korean-coaching.example', 'review', 0.6],
    ]);
    const rival = candidates.find((c) => c.identity === 'google_play:com.rival.topik')!;
    expect(rival.name).toBe('Rival TOPIK');
    expect(rival.reasons.join(' ')).toContain('Practice EPS TOPIK exam questions');
    const source = (await tx((t) => t.select().from(competitorSources).where(eq(competitorSources.competitorId, rival.competitorId!))))[0]!;
    expect(source).toMatchObject({ status: 'approved', kind: 'app_listing', url: 'https://play.google.com/store/apps/details?id=com.rival.topik' });
    expect(source.approvedBy).toMatch(/^standing:/);
    const audits = await tx((t) =>
      t
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'competitor.source.approved'), eq(auditLog.subjectId, source.id))),
    );
    expect(audits).toHaveLength(1);
    const [run] = await tx((t) => t.select().from(competitorDiscoveryRuns).where(eq(competitorDiscoveryRuns.brandId, brand!.id)));
    expect(run).toMatchObject({ status: 'succeeded', searchCount: 4, resultCount: 2 });

    // F1 sees the enrolled competitor although the brand profile lists no competitor ids.
    await tx((t) =>
      t.insert(competitorObservations).values({ tenantId: h.tenantId, competitorId: rival.competitorId!, kind: 'price_change', summary: 'Rival TOPIK raised its premium plan from 300 to 450 BDT', details: { price: 450 }, evidenceFlag: 'P', evidenceIds: [rival.evidenceId], confidence: 0.9, observedAt: h.clock.now() }),
    );
    const s = await tx((t) => gw.settings.getSettings(t, h.tenantId));
    await tx((t) => gw.settings.updateSettings(t, h.tenantId, h.users.owner, { expectedVersion: s.version, features: { F1: true } }));
    expect((await gw.signals.scanTenant(h.deps, h.tenantId, { force: true, brandId: brand!.id })).status).toBe('completed');
    const sig = await tx((t) =>
      t
        .select()
        .from(growthSignals)
        .where(and(eq(growthSignals.brandId, brand!.id), eq(growthSignals.sourceTable, 'competitor_observations'))),
    );
    expect(sig.map((x) => x.kind)).toEqual(['competitor_price_change']);
  });

  it('keeps web searches under the monthly cap, falls back to lexical ranking without a model, and reports a refused key', async () => {
    const h2 = await createCoreHarness();
    const tx2 = <T>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(h2.deps.db, { tenantId: h2.tenantId, actor: 'test' }, f);
    try {
      const connection = await createConnection(h2.deps, h2.tenantId, h2.users.owner, { provider: 'tavily', displayName: 'Tavily', externalAccountId: 'cap-test', credentials: { apiKey: 'tvly-cap' } });
      const [brand] = await tx2((t) => t.insert(brands).values({ tenantId: h2.tenantId, slug: 'korean-lessons', name: 'Korean Lessons', createdBy: 'test', updatedBy: 'test' }).returning());
      await tx2((t) => gw.settings.putBrandConfig(t, h2.tenantId, h2.users.operator, brand!.id, { expectedVersion: 0, config: { keywords: ['Korean grammar', 'Korean vocabulary', 'Hangul practice'] } }));
      const config = { brandId: brand!.id, enabled: true, country: 'BD', provider: 'tavily_web', connectionId: connection.id, intervalHours: 24, includeAppStore: false, maxQueriesPerRun: 4, monthlySearchLimit: 10, lawfulBasisNote: 'Owner approves Tavily search and evidence storage for the cap test.' };
      await tx2((t) => configureDiscovery(t, h2.tenantId, h2.users.owner, config, h2.clock.now()));
      const { http, calls } = tavilyHttp([{ title: 'Korean lessons app', url: 'https://korean-lessons-rival.example/', content: 'Learn Korean grammar and vocabulary.', score: 0.7 }]);
      const deps = { ...h2.deps, http, models: undefined };
      const used: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = (await runDiscovery(deps, h2.tenantId, brand!.id)) as { status: string; searches?: number };
        used.push(r.status === 'succeeded' ? r.searches! : 0);
        h2.clock.advance(25 * 3_600_000);
      }
      expect(used).toEqual([4, 4, 2, 0]);
      expect(calls).toHaveLength(10);
      const runs = await tx2((t) => t.select().from(competitorDiscoveryRuns).where(eq(competitorDiscoveryRuns.brandId, brand!.id)));
      expect(runs.find((x) => x.status === 'skipped')?.note).toContain('monthly web search limit reached (10 of 10)');
      expect(runs.find((x) => x.status === 'succeeded')?.note).toContain('AI judge unavailable; lexical ranking used');
      const [candidate] = await tx2((t) => t.select().from(competitorCandidates).where(eq(competitorCandidates.brandId, brand!.id)));
      expect(candidate).toMatchObject({ identity: 'web:korean-lessons-rival.example', status: 'review', confidence: 0.5 });

      // A refused key fails the run with an actionable note; nothing is invented.
      const [other] = await tx2((t) => t.insert(brands).values({ tenantId: h2.tenantId, slug: 'refused', name: 'Refused Key Brand', createdBy: 'test', updatedBy: 'test' }).returning());
      await tx2((t) => configureDiscovery(t, h2.tenantId, h2.users.owner, { ...config, brandId: other!.id, monthlySearchLimit: 5000 }, h2.clock.now()));
      const refused = tavilyHttp([], 401);
      expect(await runDiscovery({ ...h2.deps, http: refused.http, models: undefined }, h2.tenantId, other!.id)).toEqual({ status: 'failed' });
      const [failed] = await tx2((t) => t.select().from(competitorDiscoveryRuns).where(eq(competitorDiscoveryRuns.brandId, other!.id)));
      expect(failed?.note).toContain('Tavily refused the API key');
      expect(refused.calls).toHaveLength(1);
    } finally {
      await h2.close();
    }
  });
});
