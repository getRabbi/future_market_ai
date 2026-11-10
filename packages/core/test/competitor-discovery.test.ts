import { HttpClient } from '@futuregrow/connectors';
import { brandApps, brands, competitorCandidates, competitorDiscoverySettings, competitorSources, competitors, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { createConnection } from '../src/modules/connections.js';
import { configureDiscovery, discoveryOverview, rankCandidate, reviewCandidate, runDiscovery } from '../src/modules/m05-competitors/discovery.js';
import { crawlSource } from '../src/modules/m05-competitors/index.js';

let h: CoreHarness;
beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});
const fixture = { trackId: 123456789, trackName: 'Korean Lessons', bundleId: 'com.example.korean', sellerName: 'Example', trackViewUrl: 'https://apps.apple.com/us/app/korean-lessons/id123456789', description: 'Korean lessons practice', releaseDate: '2020-01-01' };

it('runs configured Brave discovery with tenant credentials and keeps secondary evidence in review', async () => {
  const tx = <T>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test' }, f);
  const connection = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'brave_search', displayName: 'Fixture search', externalAccountId: 'fixture-brave', credentials: { apiKey: 'fixture-key' } });
  const [brand] = await tx((t) => t.insert(brands).values({ tenantId: h.tenantId, slug: 'brave-fixture', name: 'Practice English', createdBy: 'test', updatedBy: 'test' }).returning());
  await tx((t) => configureDiscovery(t, h.tenantId, h.users.owner, { brandId: brand!.id, provider: 'brave_google_play', connectionId: connection.id, enabled: true, country: 'BD', lawfulBasisNote: 'Fixture approval of Brave search and evidence storage.' }, h.clock.now()));
  const deps = { ...h.deps, http: new HttpClient({ fetchImpl: async () => Response.json({ web: { results: [{ title: 'Practice English', url: 'https://play.google.com/store/apps/details?id=com.example.english', description: 'Practice English daily' }] } }), maxRetries: 0 }) };
  expect(await runDiscovery(deps, h.tenantId, brand!.id)).toMatchObject({ status: 'succeeded', count: 1 });
  const overview = await tx(discoveryOverview);
  const candidate = overview.candidates.find((c) => c.brandId === brand!.id)!;
  expect(candidate).toMatchObject({ status: 'review', confidence: 0.5, identity: 'google_play:com.example.english' });
  expect(overview.runs.find((r) => r.brandId === brand!.id)?.provider).toBe('brave_google_play');
  await tx((t) => reviewCandidate(t, h.tenantId, h.users.owner, candidate.id, 'enroll'));
  expect((await tx((t) => t.select().from(competitorSources))).find((s) => s.url === candidate.url)?.status).toBe('pending');
  // Keep this fixture independent of the existing App Store assertions below.
  await tx((t) => t.delete(competitorSources).where(eq(competitorSources.url, candidate.url)));
  await tx((t) => t.delete(competitorCandidates).where(eq(competitorCandidates.id, candidate.id)));
  await tx((t) => t.delete(competitors).where(eq(competitors.name, `${candidate.name} (${candidate.identity})`)));
});

it('scores evidence conservatively and rejects spoofed identity URLs', () => {
  const now = new Date('2026-11-09');
  expect(rankCandidate('Korean Lessons', fixture, now)).toMatchObject({ score: 100, confidence: 0.9, category: 'direct' });
  expect(rankCandidate('Korean Exams', fixture, now)).toMatchObject({ score: 50, confidence: 0.5, category: 'indirect' });
  expect(rankCandidate('Korean Lessons', { ...fixture, trackViewUrl: 'https://evil.test/id123456789' }, now)).toBeNull();
  expect(rankCandidate('Shopping', fixture, now)).toBeNull();
});

it('requires approval, deduplicates recurring runs, excludes own apps, preserves rejection and never crawls proposed sources', async () => {
  const tx = <T>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'user:test' }, f);
  const [brand] = await tx((t) => t.insert(brands).values({ tenantId: h.tenantId, slug: 'korean', name: 'Korean Lessons', createdBy: 'test', updatedBy: 'test' }).returning());
  const own = { ...fixture, trackId: 987654321, trackViewUrl: 'https://apps.apple.com/us/app/own/id987654321' };
  const uncertain = { ...fixture, trackId: 111111111, trackName: 'Korean Dictionary', description: 'Korean dictionary', trackViewUrl: 'https://apps.apple.com/us/app/dictionary/id111111111' };
  await tx((t) => t.insert(brandApps).values({ tenantId: h.tenantId, brandId: brand!.id, platform: 'ios', appId: String(own.trackId), listingUrl: own.trackViewUrl, createdBy: 'test' }));
  const provider = { search: vi.fn(async () => [fixture, fixture, own, uncertain]) };
  expect(await runDiscovery(h.deps, h.tenantId, brand!.id, provider)).toEqual({ status: 'skipped' });
  expect(provider.search).not.toHaveBeenCalled();
  const config = { brandId: brand!.id, country: 'US', enabled: true, intervalHours: 24, lawfulBasisNote: 'Fixture legal approval of metadata analysis only.' };
  await expect(tx((t) => configureDiscovery(t, h.tenantId, h.users.analyst, config, h.clock.now()))).rejects.toThrow();
  await tx((t) => configureDiscovery(t, h.tenantId, h.users.owner, config, h.clock.now()));
  await Promise.all([runDiscovery(h.deps, h.tenantId, brand!.id, provider), runDiscovery(h.deps, h.tenantId, brand!.id, provider)]);
  expect(provider.search).toHaveBeenCalledTimes(1);
  let overview = await tx(discoveryOverview);
  expect(overview.candidates).toHaveLength(2);
  const pending = overview.candidates.find((c) => c.status === 'review')!;
  await tx((t) => reviewCandidate(t, h.tenantId, h.users.analyst, pending.id, 'reject'));
  h.clock.advance(25 * 3_600_000);
  await runDiscovery(h.deps, h.tenantId, brand!.id, provider);
  overview = await tx(discoveryOverview);
  expect(overview.candidates).toHaveLength(2);
  expect(overview.candidates.find((c) => c.id === pending.id)?.status).toBe('rejected');
  expect(await tx((t) => t.select().from(competitors))).toHaveLength(1);
  const sources = await tx((t) => t.select().from(competitorSources));
  expect(sources).toHaveLength(1);
  expect(sources[0]?.status).toBe('pending');
  const fetchPublic = vi.fn();
  expect(await crawlSource({ ...h.deps, fetchPublic }, h.tenantId, sources[0]!.id)).toEqual({ status: 'not_approved' });
  expect(fetchPublic).not.toHaveBeenCalled();
  const foreign = await createCoreHarness();
  try {
    expect(await runDiscovery(h.deps, foreign.tenantId, brand!.id, provider)).toEqual({ status: 'skipped' });
    expect(await withTenant(h.deps.db, { tenantId: foreign.tenantId, actor: 'test' }, (t) => t.select().from(competitorCandidates))).toHaveLength(0);
  } finally {
    await foreign.close();
  }
  await tx((t) => t.update(competitorDiscoverySettings).set({ enabled: false }).where(eq(competitorDiscoverySettings.brandId, brand!.id)));
  expect(await runDiscovery(h.deps, h.tenantId, brand!.id, provider)).toEqual({ status: 'skipped' });
});
