import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { makePng } from '../../../test/helpers/png.js';
import { assetRights, assets, renderJobs, withTenant } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { admitEvidence } from '../../../packages/core/src/modules/m01-evidence/index.js';
import * as assetsM from '../../../packages/core/src/modules/m14-assets/index.js';
import { RemotionRenderer, processNextRender } from '../src/runner.js';

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

describe.skipIf(process.env.FG_SKIP_RENDER === '1')('media job: real Remotion render', () => {
  let jobId: string;
  let inputId: string;

  beforeAll(async () => {
    h = await createCoreHarness();
    const e = await tx((t) =>
      admitEvidence(
        t,
        h.tenantId,
        h.users.owner,
        { sourceType: 'internal', sourceOwner: 'acme', sourceUriOrObjectId: `contract://${randomUUID()}`, retrievedAt: h.clock.now().toISOString(), licenseOrUsageRights: 'own photography', schemaVersion: '1', piiClassification: 'none', confidence: 1, permittedUses: ['creative_generation', 'publishing'], kind: 'contract', content: { photographer: 'in-house' } },
        { now: h.clock.now() },
      ),
    );
    const img = await tx((t) => assetsM.uploadAsset(t, h.deps, h.tenantId, h.users.operator, { kind: 'image', title: 'product shot' }, makePng(270, 480)));
    inputId = img.id;
    await tx((t) => assetsM.addRights(t, h.deps, h.tenantId, h.users.operator, img.id, [{ component: 'source_media', rightsHolder: 'Acme', licenseRef: 'own photography', commercialUse: 'allowed', evidenceId: e.evidenceId }]));
    await tx((t) => assetsM.recordRemotionLicense(t, h.tenantId, h.users.owner, { eligibility: 'free_license', basis: 'organization_up_to_3_people', teamSize: 2, attestation: 'Two-person company; eligible for the Remotion free licence.' }));
    const job = await tx((t) => assetsM.requestRender(t, h.deps, h.tenantId, h.users.operator, { composition: 'product_showcase', inputAssetIds: [img.id], props: { headline: 'Import contacts in one step', captions: ['Connect your CRM', 'Pick a file'], cta: 'Start free' } }));
    jobId = job.id;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('renders an H.264 MP4, passes technical QA and inherits input rights', async () => {
    const out = await processNextRender(h.deps, new RemotionRenderer());
    expect(out, JSON.stringify(out)).toMatchObject({ kind: 'completed', jobId });
    if (out.kind !== 'completed') return;
    const [job] = await tx((t) => t.select().from(renderJobs).where(eq(renderJobs.id, jobId)));
    expect(job!.status).toBe('completed');
    expect(job!.statusReason).toBeNull();
    const [asset] = await tx((t) => t.select().from(assets).where(eq(assets.id, out.assetId)));
    expect(asset).toMatchObject({ origin: 'render', mime: 'video/mp4', width: 1080, height: 1920, durationMs: 15000 });
    expect((asset!.qa as any).technical).toMatchObject({ passed: true });
    const bytes = await h.deps.store.get(asset!.objectKey);
    expect(sha256Hex(bytes!)).toBe(asset!.sha256);
    const rights = await tx((t) => t.select().from(assetRights).where(eq(assetRights.assetId, asset!.id)));
    expect(rights.map((r) => r.component).sort()).toEqual(['source_media', 'template']);
    expect(asset!.publishEligible).toBe(true);
    expect(asset!.manifest).toMatchObject({ engine: expect.stringMatching(/^remotion@4\./), inputs: [{ assetId: inputId }] });
  }, 900_000);

  it('refuses to render when an input changed after the request (hash mismatch)', async () => {
    const img = await tx((t) => t.select().from(assets).where(eq(assets.id, inputId)));
    const job = await tx((t) => assetsM.requestRender(t, h.deps, h.tenantId, h.users.operator, { composition: 'product_showcase', inputAssetIds: [inputId], props: { headline: 'Second render' } }));
    await h.deps.store.put(img[0]!.objectKey, makePng(10, 10), 'image/png'); // tamper with stored bytes
    const out = await processNextRender(h.deps, new RemotionRenderer());
    expect(out).toMatchObject({ kind: 'failed', jobId: job.id });
    if (out.kind === 'failed') expect(out.reason).toMatch(/hash changed/);
  }, 300_000);
});
