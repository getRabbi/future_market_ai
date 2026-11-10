import { artifactLicenses, assets, mediaJobs, modelRegistry, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { getAiBudget } from '../src/ai-budget.js';
import { generativeVideoReadiness, requestGenerativeVideo } from '../src/modules/media/generative-video.js';
import { DEFAULT_VIDEO_ROUTING, updateVideoRouting } from '../src/modules/media/routing.js';
import { processNextMediaJob } from '../src/modules/media/sources.js';

let h: CoreHarness;
beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});
const request = { modelId: 'fixture-video', prompt: 'Abstract teal geometric forms', seconds: 5, width: 1080, height: 1920, title: 'Fixture', authorizedMaxUsd: 0.5 };
it('gates async generation, holds durable budget, polls once per step and retains provenance and rights review', async () => {
  const tx = <T>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'user:test' }, f);
  expect((await tx((t) => generativeVideoReadiness(t, h.deps))).missing.length).toBeGreaterThan(0);
  await expect(tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, request))).rejects.toThrow(/unavailable/);
  await h.deps.db.insert(modelRegistry).values({
    provider: 'wan_cloud',
    modelId: request.modelId,
    displayName: 'Fixture video (not a real adapter)',
    purposes: ['video_generation'],
    licenseOrTerms: 'Fixture only',
    commercialUse: 'allowed',
    trainingOnCustomerData: 'no',
    approvedForProduction: true,
    approvedBy: h.users.owner.id,
    approvedAt: h.clock.now(),
    usdPerVideoSecond: 0.1,
  });
  await tx((t) =>
    t.insert(artifactLicenses).values({
      tenantId: h.tenantId,
      exactName: 'wan_cloud/fixture-video',
      versionOrCommit: 'test',
      sha256: 'a'.repeat(64),
      artifactType: 'model',
      commercialUse: 'allowed',
      redistribution: 'allowed',
      derivativeUse: 'allowed',
      attributionRequired: 'false',
      sourceDataRightsStatus: 'known',
      approvedForProduction: true,
      approvedBy: 'test',
      licenseIdOrCustomTerms: 'Fixture only',
    }),
  );
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(40)]);
  const start = vi.fn(async () => ({ operationId: 'fixture-op' }));
  const poll = vi.fn(async () => ({ status: 'succeeded' as const, bytes, actualCostUsd: 0.4 }));
  h.deps.videos = { wan_cloud: { start, poll, supports: () => true } };
  // Paid generation is OFF by default: the switchboard must be configured explicitly first.
  await expect(tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, request))).rejects.toThrow(/is OFF/);
  await tx((t) =>
    updateVideoRouting(t, h.deps, h.tenantId, h.users.owner, { expectedVersion: 0, settings: { ...DEFAULT_VIDEO_ROUTING, enabled: { ...DEFAULT_VIDEO_ROUTING.enabled, wan_cloud: true }, paidGenerationDisabled: false, requirePaidApproval: false, maxPaidUsdPerVideo: 1, dailyPaidBudgetUsd: 5, monthlyPaidBudgetUsd: 20 } }),
  );
  h.deps.videoProbe = async () => ({ width: 1080, height: 1920, seconds: 5 });
  h.deps.config.aiSpendDefaultMonthlyUsd = 0.75;
  const job = await tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, request));
  await expect(tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...request, prompt: 'Another abstract teal scene' }))).rejects.toThrow(/budget/);
  expect((await tx((t) => getAiBudget(t, h.tenantId, h.deps.config, h.clock.now()))).reservedUsd).toBe(0.5);
  expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'retry', jobId: job.id });
  expect(start).toHaveBeenCalledTimes(1);
  expect(poll).not.toHaveBeenCalled();
  expect(await processNextMediaJob(h.deps)).toEqual({ kind: 'none' });
  h.clock.advance(31_000);
  expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'succeeded', jobId: job.id });
  expect(start).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledTimes(1);
  const [saved] = await tx((t) => t.select().from(mediaJobs).where(eq(mediaJobs.id, job.id)));
  const [asset] = await tx((t) => t.select().from(assets).where(eq(assets.id, saved!.assetId!)));
  expect(asset).toMatchObject({ publishEligible: false, disclosure: { isAiGenerated: true }, manifest: { generationJobId: job.id } });
  expect(asset!.eligibilityReasons).toContain('contains a likeness without likeness rights');
  const budget = await tx((t) => getAiBudget(t, h.tenantId, h.deps.config, h.clock.now()));
  expect(budget).toMatchObject({ reservedUsd: 0, spentUsd: 0.4 });
});

it('retains a reservation after an ambiguous submit failure; never silently retries a billable operation', async () => {
  h.deps.config.aiSpendDefaultMonthlyUsd = 2;
  h.deps.videos!.wan_cloud!.start = async () => {
    throw new Error('provider transport interrupted after send');
  };
  const job = await withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'user:test' }, (t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, request));
  expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'failed', jobId: job.id });
  const budget = await withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test' }, (t) => getAiBudget(t, h.tenantId, h.deps.config, h.clock.now()));
  expect(budget.reservedUsd).toBe(0.5);
});

it('rejects output that fails local technical QA', async () => {
  h.deps.videos!.wan_cloud!.start = async () => ({ operationId: 'bad-output-op' });
  h.deps.videoProbe = async () => ({ width: 640, height: 480, seconds: 5 });
  const job = await withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'user:test' }, (t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, request));
  expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'retry' });
  h.clock.advance(31_000);
  expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'failed', jobId: job.id, reason: 'Output dimensions or duration failed QA' });
});
