import { createHash } from 'node:crypto';
import { OpenAIImageProvider } from '@futuregrow/agent-kernel';
import { assetRights, assets, costLedger, mediaJobs, stockAssets, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { makePng } from '../../../test/helpers/png.js';
import { createConnection } from '../src/modules/connections.js';
import { approveArtifact, approveModel, registerArtifact, seedModelRegistry, setTenantPolicy } from '../src/modules/m24-governance/index.js';
import { mediaProviders } from '../src/modules/media/index.js';
import * as S from '../src/modules/media/sources.js';

const server = new FixtureServer();
let h: CoreHarness;
let pexels: string;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const status = async () => Object.fromEntries((await tx((t) => mediaProviders({ t, deps: h.deps, tenantId: h.tenantId }))).map((p) => [p.id, p]));

const photo = (id: number, w: number, hgt: number) => ({
  id,
  width: w,
  height: hgt,
  url: `https://www.pexels.com/photo/coffee-${id}/`,
  photographer: 'Ana Lima',
  photographer_url: 'https://www.pexels.com/@ana',
  alt: 'Coffee beans on a table',
  src: { original: `${server.baseUrl}/photos/${id}/pexels-photo-${id}.png`, medium: `${server.baseUrl}/photos/${id}/m.png` },
});
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64, 1)]);

async function licence(name: string, type: 'stock_media' | 'weights', terms: string) {
  const a = await tx((t) =>
    registerArtifact(t, h.tenantId, h.users.legal, {
      exactName: name,
      versionOrCommit: '2026-11',
      sha256: sha(name),
      artifactType: type,
      copyrightOwner: null,
      licenseIdOrCustomTerms: terms,
      commercialUse: 'allowed',
      redistribution: 'restricted',
      derivativeUse: 'allowed',
      attributionRequired: 'false',
      geographicOrUseRestrictions: [],
      sourceDataRightsStatus: 'known',
      sourceUrl: type === 'stock_media' ? 'https://www.pexels.com/license/' : null,
    }),
  );
  return tx((t) => approveArtifact(t, h.tenantId, h.users.legal, a.id));
}

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  h.deps.config.endpoints = { ...h.deps.config.endpoints, pexels: server.baseUrl };
  await seedModelRegistry(h.t.handle.db);
}, 180_000);
afterAll(async () => {
  await h?.close();
  await server.stop();
});
beforeEach(() => server.reset());

describe('licensed stock media (Pexels, P3-03)', () => {
  it('is disabled with the exact missing prerequisites, and imports nothing without a licence record', async () => {
    expect((await status())['stock-library']).toMatchObject({ enabled: false, adapter: 'available', requires: [expect.stringMatching(/Pexels API key/), expect.stringMatching(/stock_media licence/)] });
    pexels = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'pexels', externalAccountId: 'brand-stock', displayName: 'Pexels', credentials: { apiKey: 'PX_KEY' } })).id;
    await expect(tx((t) => S.requestStockImport(t, h.tenantId, h.users.operator, { connectionId: pexels, mediaType: 'photo', externalId: '42', format: 'portrait_4x5' }))).rejects.toThrow(/Pexels License.*nothing was downloaded/);
    expect(server.requests).toHaveLength(0);
    await licence('Pexels License', 'stock_media', 'Pexels License https://www.pexels.com/license/');
    expect((await status())['stock-library']).toMatchObject({ enabled: true, reason: expect.stringMatching(/Pexels under licence record "Pexels License"/) });
  });

  it('searches with the API key and attribution, and imports a photo cover-fitted to 1080×1350 with rights and provenance', async () => {
    server.on('GET', '/v1/search', (req) => ({
      headers: { 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '199', 'x-ratelimit-reset': '1762600000' },
      json: req.headers.authorization === 'PX_KEY' ? { page: 1, per_page: 24, total_results: 1, photos: [photo(42, 1600, 1200)] } : { error: 'unauthorized' },
    }));
    const found = await S.searchStock(h.deps, h.tenantId, h.users.operator, { connectionId: pexels, mediaType: 'photo', query: 'coffee beans' });
    expect(found.items[0]).toMatchObject({ externalId: '42', author: 'Ana Lima', attribution: 'Photo by Ana Lima on Pexels', imported: [] });
    expect(found.rateLimit).toMatchObject({ limit: 200, remaining: 199 });
    expect(found.licence.restrictions).toContain('do not sell unaltered copies');
    expect(server.find('GET', '/v1/search')[0]!.query.get('per_page')).toBe('24');

    const req = await tx((t) => S.requestStockImport(t, h.tenantId, h.users.operator, { connectionId: pexels, mediaType: 'photo', externalId: '42', format: 'portrait_4x5' }));
    expect(req).toMatchObject({ duplicate: false, job: { status: 'queued', kind: 'stock_import' } });
    // A second request while the first is queued does not queue another job.
    expect(await tx((t) => S.requestStockImport(t, h.tenantId, h.users.operator, { connectionId: pexels, mediaType: 'photo', externalId: '42', format: 'portrait_4x5' }))).toMatchObject({ duplicate: true, job: { id: req.job!.id } });

    // The import re-reads the item by id (never trusts the client) and downloads from a Pexels host only.
    server.on('GET', '/v1/photos/42', { json: photo(42, 1600, 1200) });
    server.on('GET', '/photos/42/pexels-photo-42.png', { headers: { 'content-type': 'image/png' }, body: Buffer.from(makePng(1600, 1200)) });
    const out = await S.processNextMediaJob(h.deps);
    expect(out, JSON.stringify(out)).toMatchObject({ kind: 'succeeded' });
    if (out.kind !== 'succeeded') return;
    expect(server.find('GET', '/photos/42/pexels-photo-42.png')[0]!.query.get('w')).toBe('2400');
    const [a] = await tx((t) => t.select().from(assets).where(eq(assets.id, out.assetId)));
    expect(a).toMatchObject({ origin: 'stock', kind: 'image', mime: 'image/png', width: 1080, height: 1350, publishEligible: true, disclosure: { isAiGenerated: false } });
    expect(a!.manifest).toMatchObject({ source: { provider: 'pexels', externalId: '42', author: 'Ana Lima', attribution: 'Photo by Ana Lima on Pexels' } });
    const rights = await tx((t) => t.select().from(assetRights).where(eq(assetRights.assetId, a!.id)));
    expect(rights).toEqual([expect.objectContaining({ component: 'source_media', rightsHolder: 'Ana Lima', commercialUse: 'allowed', artifactLicenseId: expect.any(String) })]);
    const bytes = await h.deps.store.get(a!.objectKey);
    expect(createHash('sha256').update(bytes!).digest('hex')).toBe(a!.sha256);
    // Duplicate prevention: the same item and format is not downloaded again.
    expect(await tx((t) => S.requestStockImport(t, h.tenantId, h.users.operator, { connectionId: pexels, mediaType: 'photo', externalId: '42', format: 'portrait_4x5' }))).toMatchObject({ duplicate: true, assetId: a!.id, job: null });
    server.on('GET', '/v1/search', { json: { page: 1, per_page: 24, total_results: 1, photos: [photo(42, 1600, 1200)] } });
    expect((await S.searchStock(h.deps, h.tenantId, h.users.operator, { connectionId: pexels, query: 'coffee beans' })).items[0]!.imported).toEqual([{ format: 'portrait_4x5', assetId: a!.id }]);
  });

  it('imports an MP4 video as original and refuses non-Pexels download hosts', async () => {
    const video = (link: string) => ({
      id: 77,
      width: 1080,
      height: 1920,
      url: 'https://www.pexels.com/video/77/',
      image: `${server.baseUrl}/v.jpg`,
      duration: 12,
      user: { name: 'Kai', url: 'https://www.pexels.com/@kai' },
      video_files: [
        { id: 1, quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, link },
        { id: 2, quality: 'uhd', file_type: 'video/mp4', width: 2160, height: 3840, link: `${link}?uhd` },
      ],
    });
    server.on('GET', '/videos/videos/77', { json: video(`${server.baseUrl}/video-files/77/hd.mp4`) });
    server.on('GET', '/video-files/77/hd.mp4', { headers: { 'content-type': 'video/mp4' }, body: mp4 });
    await tx((t) => S.requestStockImport(t, h.tenantId, h.users.operator, { connectionId: pexels, mediaType: 'video', externalId: '77', format: 'original' }));
    const out = await S.processNextMediaJob(h.deps);
    expect(out).toMatchObject({ kind: 'succeeded' });
    if (out.kind === 'succeeded') expect((await tx((t) => t.select().from(assets).where(eq(assets.id, out.assetId))))[0]).toMatchObject({ kind: 'video', mime: 'video/mp4', origin: 'stock' });
    // The 1080p rendition was chosen, not the UHD one.
    expect(server.find('GET', '/video-files/77/hd.mp4')[0]!.query.get('uhd')).toBeNull();

    server.on('GET', '/videos/videos/78', { json: { ...video('https://evil.example/x.mp4'), id: 78 } });
    await tx((t) => S.requestStockImport(t, h.tenantId, h.users.operator, { connectionId: pexels, mediaType: 'video', externalId: '78', format: 'original' }));
    expect(await S.processNextMediaJob(h.deps)).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/not a Pexels host/) });
  });

  it('backs off on rate limits and fails after three attempts without inventing an asset', async () => {
    server.on('GET', '/v1/photos/90', { status: 429, headers: { 'retry-after': '1' }, json: { error: 'rate limit' } });
    const { job } = await tx((t) => S.requestStockImport(t, h.tenantId, h.users.operator, { connectionId: pexels, mediaType: 'photo', externalId: '90', format: 'square_1x1' }));
    expect(await S.processNextMediaJob(h.deps)).toMatchObject({ kind: 'retry' });
    expect(await S.processNextMediaJob(h.deps)).toEqual({ kind: 'none' }); // not due yet
    h.clock.advance(10 * 60_000);
    expect(await S.processNextMediaJob(h.deps)).toMatchObject({ kind: 'retry' });
    h.clock.advance(10 * 60_000);
    expect(await S.processNextMediaJob(h.deps)).toMatchObject({ kind: 'failed' });
    const [j] = await tx((t) => t.select().from(mediaJobs).where(eq(mediaJobs.id, job!.id)));
    expect(j).toMatchObject({ status: 'failed', assetId: null, attempts: 3 });
  });

  it('revoking the licence makes the asset ineligible at once; a withdrawn licence record is caught by the sweep', async () => {
    const [row] = await tx((t) => t.select().from(stockAssets).where(eq(stockAssets.externalId, '42')));
    await expect(tx((t) => S.revokeStockAsset(t, h.deps, h.tenantId, h.users.operator, row!.assetId, 'removed by author'))).rejects.toThrow(/roles/);
    const revoked = await tx((t) => S.revokeStockAsset(t, h.deps, h.tenantId, h.users.legal, row!.assetId, 'removed by the author on Pexels'));
    expect(revoked.publishEligible).toBe(false);
    expect(revoked.eligibilityReasons.join(' ')).toMatch(/rights expired/);
    const [video] = await tx((t) => t.select().from(stockAssets).where(eq(stockAssets.externalId, '77')));
    await tx((t) => t.execute(`update artifact_licenses set approved_for_production = false, approved_by = null where artifact_type = 'stock_media'`));
    expect(await tx((t) => S.recheckStockLicences(t, h.deps, h.tenantId))).toBe(1);
    expect((await tx((t) => t.select().from(assets).where(eq(assets.id, video!.assetId))))[0]!.eligibilityReasons.join(' ')).toMatch(/licence not approved/);
  });
});

describe('AI image generation (P3-02)', () => {
  const b64 = Buffer.from(makePng(1024, 1536, [200, 120, 40])).toString('base64');

  it('stays disabled until the model is approved and priced, the provider configured and the licence recorded', async () => {
    expect((await status())['ai-image-model']).toMatchObject({ enabled: false, adapter: 'available', requires: [expect.stringMatching(/approved for image_generation/)] });
    await expect(tx((t) => S.requestImageGeneration(t, h.deps, h.tenantId, h.users.operator, { prompt: 'A cup of coffee on a wooden table, morning light' }))).rejects.toThrow(/not enabled/);
    await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'openai', modelId: 'gpt-image-1', trainingOnCustomerData: 'no', dataRetentionTerms: 'API data not used for training', inputUsdPerMtok: null, outputUsdPerMtok: null });
    expect((await status())['ai-image-model']!.requires).toEqual(expect.arrayContaining([expect.stringMatching(/provider is not configured/), expect.stringMatching(/licence record named "openai\/gpt-image-1"/), expect.stringMatching(/per-image price/)]));
    await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'openai', modelId: 'gpt-image-1', trainingOnCustomerData: 'no', dataRetentionTerms: 'API data not used for training', inputUsdPerMtok: null, outputUsdPerMtok: null, usdPerImage: 0.04 });
    h.deps.images = { openai: new OpenAIImageProvider({ apiKey: 'sk-test', baseUrl: `${server.baseUrl}/v1` }) };
    await licence('openai/gpt-image-1', 'weights', 'OpenAI Services Agreement: customer owns outputs; commercial use allowed');
    expect((await status())['ai-image-model']).toMatchObject({ enabled: true, reason: expect.stringMatching(/\$0\.04 per image/) });
  });

  it('refuses unsafe prompts before any provider call', async () => {
    await expect(tx((t) => S.requestImageGeneration(t, h.deps, h.tenantId, h.users.operator, { prompt: 'Two kids drinking coffee in a cafe' }))).rejects.toThrow(/children or minors/);
    await expect(tx((t) => S.requestImageGeneration(t, h.deps, h.tenantId, h.users.operator, { prompt: 'A mug with the logo of Starbucks on it' }))).rejects.toThrow(/logo/);
    expect(server.requests).toHaveLength(0);
  });

  it('generates, cover-fits, labels as AI, records model rights, cost and provenance', async () => {
    server.on('POST', '/v1/images/generations', (req) => ({ headers: { 'x-request-id': 'req_img_1' }, json: req.headers.authorization === 'Bearer sk-test' ? { created: 1, data: [{ b64_json: b64 }], usage: { total_tokens: 1200, input_tokens: 40, output_tokens: 1160 } } : { error: { code: 'invalid_api_key' } } }));
    const job = await tx((t) => S.requestImageGeneration(t, h.deps, h.tenantId, h.users.operator, { prompt: 'A cup of coffee on a wooden table, morning light', format: 'portrait_4x5', title: 'Morning cup' }));
    const out = await S.processNextMediaJob(h.deps);
    expect(out, JSON.stringify(out)).toMatchObject({ kind: 'succeeded', jobId: job.id });
    if (out.kind !== 'succeeded') return;
    const call = server.find('POST', '/v1/images/generations')[0]!.json as Record<string, unknown>;
    expect(call).toMatchObject({ model: 'gpt-image-1', size: '1024x1536', n: 1, output_format: 'png' });
    const [a] = await tx((t) => t.select().from(assets).where(eq(assets.id, out.assetId)));
    expect(a).toMatchObject({ origin: 'generated', title: 'Morning cup', width: 1080, height: 1350, publishEligible: true, disclosure: { isAiGenerated: true } });
    expect(a!.manifest).toMatchObject({ contains: { aiGenerated: true }, model: { provider: 'openai', modelId: 'gpt-image-1' } });
    const rights = await tx((t) => t.select().from(assetRights).where(eq(assetRights.assetId, a!.id)));
    expect(rights.map((r) => r.component).sort()).toEqual(['model', 'source_media']);
    const cost = await tx((t) => t.select().from(costLedger).where(eq(costLedger.refId, job.id)));
    expect(cost).toEqual([expect.objectContaining({ category: 'image_generation', provider: 'openai', quantity: 1, amountUsd: 0.04 })]);
    const [j] = await tx((t) => t.select().from(mediaJobs).where(eq(mediaJobs.id, job.id)));
    expect(j).toMatchObject({ status: 'succeeded', costUsd: 0.04, provenance: { requestId: 'req_img_1' } });
  });

  it('records a provider refusal as refused (never retried) and respects the AI spending limit', async () => {
    server.on('POST', '/v1/images/generations', { status: 400, json: { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } } });
    const job = await tx((t) => S.requestImageGeneration(t, h.deps, h.tenantId, h.users.operator, { prompt: 'A dramatic storm over a city skyline at night' }));
    expect(await S.processNextMediaJob(h.deps)).toMatchObject({ kind: 'refused', jobId: job.id });
    expect(server.find('POST', '/v1/images/generations')).toHaveLength(1);
    expect(await tx((t) => t.select().from(costLedger).where(eq(costLedger.refId, job.id)))).toEqual([]);

    await tx((t) => setTenantPolicy(t, h.tenantId, h.users.owner, { configured: true, currency: 'USD', categories: {}, aiSpend: { monthlyLimitUsd: 0.05, warnAtFraction: 0.8 } }));
    await expect(tx((t) => S.requestImageGeneration(t, h.deps, h.tenantId, h.users.operator, { prompt: 'A coffee grinder on a marble counter' }))).rejects.toThrow(/AI spending limit has \$0\.01 left/);
  });
});
