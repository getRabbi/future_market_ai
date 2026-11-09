import { modelRegistry, withSystem, withTenant } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { type MediaCandidate, mediaProviders, mediaQa } from '../src/modules/media/index.js';

let h: CoreHarness;
beforeAll(async () => {
  h = await createCoreHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const bytes = new Uint8Array([1, 2, 3, 4]);
const candidate = (over: Partial<MediaCandidate> = {}): MediaCandidate => ({
  providerId: 'stock-library',
  kind: 'stock_image',
  mime: 'image/jpeg',
  bytes,
  sha256: sha256Hex(Buffer.from(bytes)),
  width: 2160,
  height: 2700,
  aiGenerated: false,
  license: { ref: 'vendor licence v3', commercialUse: 'allowed', attribution: null },
  provenance: { sourceUrl: 'https://stock.example/photo/1', photographer: 'A. Person' },
  ...over,
});

describe('provider-neutral media (D-044)', () => {
  it('passes only licensed, correctly sized, hash-verified media with provenance', () => {
    expect(mediaQa(candidate(), 'portrait_4x5')).toEqual({ passed: true, problems: [] });
    const bad = mediaQa(candidate({ width: 1000, height: 1000, sha256: 'f'.repeat(64), license: { ref: 'unknown', commercialUse: 'unknown', attribution: null }, provenance: {} }), 'portrait_4x5');
    expect(bad.passed).toBe(false);
    expect(bad.problems).toEqual(expect.arrayContaining(['content hash does not match the bytes', '1000×1000 is smaller than 1080×1350', expect.stringMatching(/^aspect/), expect.stringMatching(/does not allow commercial use/), 'no provenance recorded']));
    expect(mediaQa(candidate({ kind: 'ai_image', aiGenerated: false }), 'portrait_4x5').problems).toContain('an AI image must carry the AI-generated disclosure');
  });

  it('enables only providers whose credentials and rights records exist and that FUTUREGROW can actually execute', async () => {
    const status = () => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test:media' }, (t) => mediaProviders({ t, deps: h.deps, tenantId: h.tenantId }));
    let s = await status();
    expect(Object.fromEntries(s.map((p) => [p.kind, p.enabled]))).toEqual({ template_card: true, verified_asset: false, stock_image: false, ai_image: false, ai_voice: false, ai_video: false });
    // P3-04: generative video has no adapter and no approved provider; it is reported, never offered.
    expect(s.find((p) => p.kind === 'ai_video')).toMatchObject({ adapter: 'not_built', prerequisitesMet: false });
    expect(s.find((p) => p.kind === 'ai_image')!.reason).toMatch(/B-011/);
    // P3-03: the Pexels adapter exists; without a connected key and an approved licence record it stays disabled.
    expect(s.find((p) => p.kind === 'stock_image')!.requires).toEqual([expect.stringMatching(/Pexels API key/), expect.stringMatching(/stock_media licence/)]);
    expect(s.find((p) => p.kind === 'stock_image')).toMatchObject({ adapter: 'available', prerequisitesMet: false, enabled: false });
    // An approved chat model is not an image model; an approved image model with commercial rights is.
    await withSystem(h.deps.db, 'test', (t) =>
      t.insert(modelRegistry).values({ provider: 'openai_compatible', modelId: 'chat-1', displayName: 'Chat', purposes: ['generation'], licenseOrTerms: 'reviewed', commercialUse: 'allowed', trainingOnCustomerData: 'no', approvedForProduction: true, approvedBy: 'user:owner', inputUsdPerMtok: 0, outputUsdPerMtok: 0 }),
    );
    expect((await status()).find((p) => p.kind === 'ai_image')!.enabled).toBe(false);
    await withSystem(h.deps.db, 'test', (t) =>
      t
        .insert(modelRegistry)
        .values({ provider: 'openai_compatible', modelId: 'image-1', displayName: 'Image', purposes: ['image_generation'], licenseOrTerms: 'reviewed', commercialUse: 'allowed', trainingOnCustomerData: 'no', approvedForProduction: true, approvedBy: 'user:owner', inputUsdPerMtok: 0, outputUsdPerMtok: 0 }),
    );
    s = await status();
    // P3-02: an approved image model alone is not enough: no provider is configured for it, it has no per-image price
    // and no approved licence record, so it is never claimed usable.
    const ai = s.find((p) => p.kind === 'ai_image')!;
    expect(ai).toMatchObject({ enabled: false, prerequisitesMet: false, adapter: 'available' });
    expect(ai.requires).toEqual(expect.arrayContaining([expect.stringMatching(/openai_compatible image provider is not configured/), expect.stringMatching(/licence record named "openai_compatible\/image-1"/), expect.stringMatching(/per-image price/)]));
    expect(s.find((p) => p.kind === 'template_card')).toMatchObject({ enabled: true, adapter: 'available' });
  });
});
