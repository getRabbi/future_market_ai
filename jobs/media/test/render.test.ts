import { randomUUID } from 'node:crypto';
import { assetRights, assets, renderJobs, withTenant } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admitEvidence } from '../../../packages/core/src/modules/m01-evidence/index.js';
import * as assetsM from '../../../packages/core/src/modules/m14-assets/index.js';
import * as video from '../../../packages/core/src/modules/media/video.js';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { makePng } from '../../../test/helpers/png.js';
import { processNextRender, RemotionRenderer } from '../src/runner.js';

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
        {
          sourceType: 'internal',
          sourceOwner: 'acme',
          sourceUriOrObjectId: `contract://${randomUUID()}`,
          retrievedAt: h.clock.now().toISOString(),
          licenseOrUsageRights: 'own photography',
          schemaVersion: '1',
          piiClassification: 'none',
          confidence: 1,
          permittedUses: ['creative_generation', 'publishing'],
          kind: 'contract',
          content: { photographer: 'in-house' },
        },
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

  it('Video Studio: renders a two-scene square storyboard to a playable MP4 with a thumbnail and SRT subtitles', async () => {
    const ev = await tx((t) =>
      admitEvidence(
        t,
        h.tenantId,
        h.users.owner,
        {
          sourceType: 'internal',
          sourceOwner: 'acme',
          sourceUriOrObjectId: `contract://${randomUUID()}`,
          retrievedAt: h.clock.now().toISOString(),
          licenseOrUsageRights: 'own photography',
          schemaVersion: '1',
          piiClassification: 'none',
          confidence: 1,
          permittedUses: ['creative_generation', 'publishing'],
          kind: 'contract',
          content: { photographer: 'in-house' },
        },
        { now: h.clock.now() },
      ),
    );
    const img = await tx((t) => assetsM.uploadAsset(t, h.deps, h.tenantId, h.users.operator, { kind: 'image', title: 'scene photo' }, makePng(540, 540, [40, 160, 120])));
    const unlicensed = await tx((t) => assetsM.uploadAsset(t, h.deps, h.tenantId, h.users.operator, { kind: 'image', title: 'no rights yet' }, makePng(300, 300, [200, 30, 30])));
    const board = (assetId: string) => ({
      preset: 'square_1x1',
      scenes: [
        { id: 'intro', durationSeconds: 2, text: 'Brewing basics', subtitle: 'Grind, bloom, pour.', assetId, transition: 'fade' },
        { id: 'end', durationSeconds: 2, text: 'Try it this weekend', subtitle: 'Share your cup with us.', transition: 'slide', textPosition: 'bottom' },
      ],
    });
    // Media without cleared rights blocks the render, with the reason.
    const blocked = await tx((t) => video.createVideoProject(t, h.deps, h.tenantId, h.users.operator, { title: 'Blocked story', storyboard: board(unlicensed.id) }));
    expect((blocked.qa as { storyboard: { passed: boolean; problems: string[] } }).storyboard.problems.join(' ')).toMatch(/lacks cleared source-media rights/);
    await expect(tx((t) => video.renderVideoProject(t, h.deps, h.tenantId, h.users.operator, blocked.id))).rejects.toThrow(/fix the storyboard first/);

    await tx((t) => assetsM.addRights(t, h.deps, h.tenantId, h.users.operator, img.id, [{ component: 'source_media', rightsHolder: 'Acme', licenseRef: 'own photography', commercialUse: 'allowed', evidenceId: ev.evidenceId }]));
    const p = await tx((t) => video.createVideoProject(t, h.deps, h.tenantId, h.users.operator, { title: 'Brewing basics', storyboard: board(img.id) }));
    expect(p.qa).toMatchObject({ storyboard: { passed: true, problems: [] } });
    const rendering = await tx((t) => video.renderVideoProject(t, h.deps, h.tenantId, h.users.operator, p.id));
    expect(rendering.status).toBe('rendering');
    const out = await processNextRender(h.deps, new RemotionRenderer());
    expect(out, JSON.stringify(out)).toMatchObject({ kind: 'completed', jobId: rendering.renderJobId });
    expect(await tx((t) => video.syncVideoProjects(t, h.tenantId))).toBe(1);
    const d = await tx((t) => video.videoProject(t, h.tenantId, p.id));
    expect(d.project).toMatchObject({ status: 'ready', statusReason: null });
    const mp4 = d.files.find((f) => f.id === d.project.outputAssetId)!;
    expect(mp4).toMatchObject({ kind: 'video', mime: 'video/mp4', width: 1080, height: 1080, durationMs: 4000, publishEligible: true });
    expect(d.files.find((f) => f.id === d.project.thumbnailAssetId)).toMatchObject({ kind: 'image', mime: 'image/png', width: 1080, height: 1080 });
    expect(d.files.find((f) => f.id === d.project.subtitlesAssetId)).toMatchObject({ kind: 'caption', mime: 'application/x-subrip' });
    expect(d.srt).toBe(['1', '00:00:00,000 --> 00:00:02,000', 'Grind, bloom, pour.', '', '2', '00:00:02,000 --> 00:00:04,000', 'Share your cup with us.', ''].join(String.fromCharCode(10)));
    const [asset] = await tx((t) => t.select().from(assets).where(eq(assets.id, mp4.id)));
    const bytes = await h.deps.store.get(asset!.objectKey);
    // A real, playable MP4: ISO BMFF "ftyp" box at offset 4 and the stored hash matches.
    expect(Buffer.from(bytes!.subarray(4, 8)).toString('ascii')).toBe('ftyp');
    expect(sha256Hex(bytes!)).toBe(asset!.sha256);
    expect((asset!.qa as { technical: { passed: boolean; metadata: { canPlayInVideoTag: boolean; codec: string } } }).technical).toMatchObject({ passed: true, metadata: { canPlayInVideoTag: true, codec: 'h264' } });
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
