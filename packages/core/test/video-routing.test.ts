import { artifactLicenses, assets, costLedger, mediaJobs, modelRegistry, organization, renderJobs, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import type { Actor } from '../src/deps.js';
import { recordRemotionLicense, requestRender } from '../src/modules/m14-assets/index.js';
import { requestFlowImport } from '../src/modules/media/flow-import.js';
import { approveVideoGeneration, cancelVideoGeneration, type GenerativeVideoProvider, reconcileVideoCharge, requestGenerativeVideo } from '../src/modules/media/generative-video.js';
import { assertVideoModeEnabled, DEFAULT_VIDEO_ROUTING, paidVideoUsage, previewVideoRoute, updateVideoRouting, type VideoRouting, videoRoutingOverview } from '../src/modules/media/routing.js';
import { processNextMediaJob } from '../src/modules/media/sources.js';
import { createVideoProject, renderVideoProject } from '../src/modules/media/video.js';
import { dailyVideoPlan, queueVideoGeneration, runDailyVideoAutomation, videoJobHistory } from '../src/modules/media/video-jobs.js';

let h: CoreHarness;
let n = 0;
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.from(`fixture-${++n}`.padEnd(40, '.'))]);
const tx = <T>(f: Parameters<typeof withTenant<T>>[2], tenantId = h.tenantId) => withTenant(h.deps.db, { tenantId, actor: 'user:test' }, f);
const overview = () => tx((t) => videoRoutingOverview(t, h.deps, h.tenantId));
async function configure(patch: Partial<VideoRouting>, actor: Actor = h.users.owner) {
  const ov = await overview();
  return tx((t) => updateVideoRouting(t, h.deps, h.tenantId, actor, { settings: { ...ov.settings, ...patch }, expectedVersion: ov.version }));
}
const PAID: Partial<VideoRouting> = { enabled: { remotion: true, google_flow: false, wan_cloud: true, higgsfield: true }, paidGenerationDisabled: false, requirePaidApproval: false, maxPaidUsdPerVideo: 2, dailyPaidBudgetUsd: 5, monthlyPaidBudgetUsd: 20 };

function fixture(sizes: { width: number; height: number }[], over: Partial<GenerativeVideoProvider> = {}): GenerativeVideoProvider & { start: ReturnType<typeof vi.fn>; poll: ReturnType<typeof vi.fn> } {
  return {
    sizes,
    supports: (i: { width: number; height: number }) => sizes.some((s) => s.width === i.width && s.height === i.height),
    start: vi.fn(async () => ({ operationId: `op-${++n}` })),
    poll: vi.fn(async () => ({ status: 'succeeded' as const, bytes: mp4(), actualCostUsd: 0.3 })),
    ...over,
  } as never;
}
const gen = (modelId: string, prompt: string, extra: Record<string, unknown> = {}) => ({ modelId, prompt, seconds: 5, width: 720, height: 1280, title: 'Clip', ...extra });
async function clearJobs() {
  await tx(async (t) => {
    await t.delete(mediaJobs);
    await t.delete(costLedger);
  });
}

beforeAll(async () => {
  h = await createCoreHarness();
  for (const [provider, modelId, price] of [
    ['wan_cloud', 'wan-fixture', 0.1],
    ['higgsfield', 'hf-fixture', 0.2],
  ] as const) {
    await h.deps.db
      .insert(modelRegistry)
      .values({ provider, modelId, displayName: `${provider} fixture`, purposes: ['video_generation'], licenseOrTerms: 'Fixture', commercialUse: 'allowed', trainingOnCustomerData: 'no', approvedForProduction: true, approvedBy: h.users.owner.id, approvedAt: h.clock.now(), usdPerVideoSecond: price });
    await tx((t) =>
      t.insert(artifactLicenses).values({
        tenantId: h.tenantId,
        exactName: `${provider}/${modelId}`,
        versionOrCommit: 'test',
        sha256: (provider === 'wan_cloud' ? 'a' : 'b').repeat(64),
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
  }
});
afterAll(async () => {
  await h?.close();
});

describe('video switchboard', () => {
  it('defaults are free-first: Remotion ON (needs its licence), every paid mode OFF with a $0 budget', async () => {
    const ov = await overview();
    expect(ov.version).toBe(0);
    expect(ov.settings).toEqual(DEFAULT_VIDEO_ROUTING);
    expect(ov.settings).toMatchObject({ paidGenerationDisabled: true, maxPaidUsdPerVideo: 0, dailyPaidBudgetUsd: 0, monthlyPaidBudgetUsd: 0, requirePaidApproval: true });
    expect(Object.fromEntries(ov.modes.map((m) => [m.id, m.state]))).toEqual({ remotion: 'setup_required', google_flow: 'disabled', wan_cloud: 'disabled', higgsfield: 'disabled' });
    expect(ov.modes.find((m) => m.id === 'wan_cloud')!.requires.join(' ')).toMatch(/remote Wan\/ComfyUI GPU worker/);
    expect(ov.modes.find((m) => m.id === 'google_flow')!.note).toMatch(/Manual generation — no automated free API/);
    const d = await tx((t) => previewVideoRoute(t, h.deps, h.tenantId, { quality: 'cinematic' }));
    expect(d).toMatchObject({ mode: null, execution: 'unavailable' });
    expect(d.setup.length).toBeGreaterThan(0);
  });

  it('persists switches with optimistic concurrency; only an MFA owner/admin may change them', async () => {
    await expect(configure({ dailyTarget: 7 }, h.users.operator)).rejects.toThrow(/roles/);
    await expect(configure({ dailyTarget: 7 }, { ...h.users.owner, mfaVerified: false })).rejects.toThrow(/multi-factor/);
    await expect(configure({ smartMode: false, defaultProvider: 'google_flow' })).rejects.toThrow();
    const saved = await configure({ dailyTarget: 7, enabled: { ...DEFAULT_VIDEO_ROUTING.enabled, google_flow: true } });
    expect(saved.version).toBe(1);
    expect((await overview()).settings).toMatchObject({ dailyTarget: 7, enabled: { google_flow: true } });
    // A stale writer cannot overwrite the newer settings.
    await expect(tx((t) => updateVideoRouting(t, h.deps, h.tenantId, h.users.admin, { settings: DEFAULT_VIDEO_ROUTING, expectedVersion: 0 }))).rejects.toThrow(/changed in the meantime/);
    expect((await overview()).version).toBe(1);
  });

  it('Remotion switch gates both render paths; existing render behaviour is unchanged when ON', async () => {
    await tx((t) => recordRemotionLicense(t, h.tenantId, h.users.owner, { eligibility: 'company_license', licenseRef: 'TEST-LIC-1', attestation: 'Fixture company licence attestation' }));
    expect((await overview()).modes.find((m) => m.id === 'remotion')!.state).toBe('ready');
    const storyboard = { preset: 'vertical_9x16', scenes: [{ id: 's1', durationSeconds: 3, text: 'Plan your week' }] };
    const p = await tx((t) => createVideoProject(t, h.deps, h.tenantId, h.users.operator, { title: 'Regression', storyboard }));
    const rendering = await tx((t) => renderVideoProject(t, h.deps, h.tenantId, h.users.operator, p.id));
    expect(rendering.status).toBe('rendering');
    const [job] = await tx((t) => t.select().from(renderJobs).where(eq(renderJobs.id, rendering.renderJobId!)));
    expect(job).toMatchObject({ status: 'queued', composition: 'scene_story', workflowConfig: { engine: 'remotion', width: 1080, height: 1920, fps: 30, durationInFrames: 90, codec: 'h264' } });
    await configure({ enabled: { ...(await overview()).settings.enabled, remotion: false } });
    const p2 = await tx((t) => createVideoProject(t, h.deps, h.tenantId, h.users.operator, { title: 'Blocked', storyboard: { ...storyboard, cta: 'Try it' } }));
    await expect(tx((t) => renderVideoProject(t, h.deps, h.tenantId, h.users.operator, p2.id))).rejects.toThrow(/Remotion \+ FFmpeg is OFF/);
    await expect(tx((t) => requestRender(t, h.deps, h.tenantId, h.users.operator, {}))).rejects.toThrow(/is OFF/);
    await configure({ enabled: { ...(await overview()).settings.enabled, remotion: true } });
    expect((await tx((t) => previewVideoRoute(t, h.deps, h.tenantId, { quality: 'template' }))).execution).toBe('automatic');
  });

  it('Google Flow is manual-only: import is validated, probed with audio allowed and recorded with provenance', async () => {
    await expect(tx((t) => assertVideoModeEnabled(t, h.tenantId, 'google_flow'))).rejects.toThrow(/manual-only/);
    const d = await tx((t) => previewVideoRoute(t, h.deps, h.tenantId, { quality: 'cinematic' }));
    expect(d).toMatchObject({ mode: 'google_flow', execution: 'manual' });
    const routed = await tx((t) => queueVideoGeneration(t, h.deps, h.tenantId, h.users.operator, { route: { quality: 'cinematic' }, idempotencyKey: 'flow-route-1' }));
    expect(routed).toMatchObject({ manual: { url: expect.stringContaining('labs.google') } });
    expect(await tx((t) => t.select().from(mediaJobs))).toHaveLength(0);
    const meta = { title: 'Flow clip', preset: 'vertical_9x16', attestation: { generatedWithGoogleFlow: true, ownAccount: true, commercialUseConfirmed: true, containsPeople: false, containsMusic: false, containsVoice: false, containsThirdPartyBrands: false } };
    await expect(tx((t) => requestFlowImport(t, h.deps, h.tenantId, h.users.operator, meta, Buffer.from('not a video at all, definitely')))).rejects.toThrow(/MP4/);
    await expect(tx((t) => requestFlowImport(t, h.deps, h.tenantId, h.users.operator, { ...meta, attestation: { ...meta.attestation, containsThirdPartyBrands: true } }, mp4()))).rejects.toThrow(/third-party brands/);
    const bytes = mp4();
    const probe = vi.fn(async (_b: Uint8Array, o?: { allowAudio?: boolean }) => ({ width: 1080, height: 1920, seconds: 8, hasAudio: o?.allowAudio === true }));
    h.deps.videoProbe = probe;
    const { job } = await tx((t) => requestFlowImport(t, h.deps, h.tenantId, h.users.operator, meta, bytes));
    expect(await tx((t) => requestFlowImport(t, h.deps, h.tenantId, h.users.operator, meta, bytes))).toMatchObject({ duplicate: true, job: { id: job.id } });
    const out = await processNextMediaJob(h.deps);
    expect(out).toMatchObject({ kind: 'succeeded', jobId: job.id });
    expect(probe).toHaveBeenCalledWith(expect.anything(), { allowAudio: true });
    const [asset] = await tx((t) =>
      t
        .select()
        .from(assets)
        .where(eq(assets.id, (out as { assetId: string }).assetId)),
    );
    expect(asset).toMatchObject({ kind: 'video', origin: 'generated', disclosure: { isAiGenerated: true }, manifest: { generator: 'google_flow', hasAudio: true } });
    // No reviewed Google terms recorded as an artifact licence yet: usable in storyboards, not publish-eligible.
    expect(asset!.publishEligible).toBe(false);
    expect(asset!.eligibilityReasons).toContain('missing model/weights licence for generated asset');
    await configure({ enabled: { ...(await overview()).settings.enabled, google_flow: false } });
    await expect(tx((t) => requestFlowImport(t, h.deps, h.tenantId, h.users.operator, meta, mp4()))).rejects.toThrow(/Google Flow \(manual\) is OFF/);
  });

  it('paid modes stay "Setup required" without a GPU worker or credentials, and OFF blocks submission', async () => {
    h.deps.videos = {};
    await configure(PAID);
    const ov = await overview();
    expect(ov.modes.find((m) => m.id === 'wan_cloud')).toMatchObject({ enabled: true, ready: false, state: 'setup_required' });
    expect(ov.modes.find((m) => m.id === 'higgsfield')!.requires.join(' ')).toMatch(/Higgsfield API credentials/);
    await expect(tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...gen('wan-fixture', 'Calm teal waves at dusk'), authorizedMaxUsd: 1 }))).rejects.toThrow(/unavailable/);
    h.deps.videos = { wan_cloud: fixture([{ width: 720, height: 1280 }]), higgsfield: fixture([{ width: 720, height: 1280 }]) };
    expect((await overview()).modes.find((m) => m.id === 'wan_cloud')!.state).toBe('ready');
    await configure({ enabled: { remotion: true, google_flow: false, wan_cloud: false, higgsfield: true } });
    expect((await overview()).modes.find((m) => m.id === 'wan_cloud')!.state).toBe('disabled');
    await expect(tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...gen('wan-fixture', 'Calm teal waves at dusk'), authorizedMaxUsd: 1 }))).rejects.toThrow(/is OFF/);
  });

  it('Smart routing is free-first, never silently paid, prefers the cheaper eligible provider and adapts the size', async () => {
    await configure({ ...PAID, enabled: { remotion: true, google_flow: true, wan_cloud: true, higgsfield: true }, providerPriority: ['higgsfield', 'google_flow', 'remotion', 'wan_cloud'] });
    const route = (r: Record<string, unknown>) => tx((t) => previewVideoRoute(t, h.deps, h.tenantId, r));
    expect(await route({ quality: 'template' })).toMatchObject({ mode: 'remotion', execution: 'automatic' });
    expect(await route({ quality: 'cinematic', allowPaid: true })).toMatchObject({ mode: 'google_flow', execution: 'manual' });
    await configure({ enabled: { remotion: true, google_flow: false, wan_cloud: true, higgsfield: true } });
    expect(await route({ quality: 'cinematic', seconds: 5 })).toMatchObject({ mode: 'wan_cloud', execution: 'needs_authorization', estimateUsd: 0.5, output: { width: 720, height: 1280 } });
    expect(await route({ quality: 'cinematic', seconds: 5, allowPaid: true })).toMatchObject({ mode: 'wan_cloud', execution: 'paid_automatic' });
    expect(await route({ quality: 'cinematic', seconds: 5, allowPaid: true, provider: 'higgsfield' })).toMatchObject({ mode: 'higgsfield', estimateUsd: 1 });
    await configure({ requirePaidApproval: true });
    expect(await route({ quality: 'cinematic', seconds: 5, allowPaid: true })).toMatchObject({ execution: 'approval_required' });
    await configure({ paidGenerationDisabled: true });
    const none = await route({ quality: 'cinematic', allowPaid: true });
    expect(none).toMatchObject({ mode: null, execution: 'unavailable' });
    expect(none.setup.join(' ')).toMatch(/Disable all paid generation/);
    await configure({ paidGenerationDisabled: false, requirePaidApproval: false });
  });

  it('enforces explicit authorization, per-video, daily and monthly paid limits server-side', async () => {
    await clearJobs();
    await configure({ ...PAID, maxPaidUsdPerVideo: 1, dailyPaidBudgetUsd: 1, monthlyPaidBudgetUsd: 3 });
    const req = (prompt: string, extra: Record<string, unknown> = {}) => tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...gen('wan-fixture', prompt), ...extra }));
    await expect(req('Calm teal waves at dusk')).rejects.toThrow(/explicit authorization/);
    await expect(req('Calm teal waves at dusk', { authorizedMaxUsd: 0.4 })).rejects.toThrow(/explicit authorization/);
    await expect(req('Calm teal waves at dusk', { authorizedMaxUsd: 2, seconds: 15 })).rejects.toThrow(/per-video limit/);
    const first = await req('Calm teal waves at dusk', { authorizedMaxUsd: 0.5 });
    expect(first).toMatchObject({ status: 'queued', costUsd: 0.5, provider: 'wan_cloud' });
    await req('Slow sunrise over hills', { authorizedMaxUsd: 0.5 });
    await expect(req('Rain on a window', { authorizedMaxUsd: 0.5 })).rejects.toThrow(/Daily paid budget/);
    const usage = await tx((t) => paidVideoUsage(t, h.tenantId, h.clock.now()));
    expect(usage).toMatchObject({ reservedUsd: 1, daySpentUsd: 0 });
    await configure({ paidGenerationDisabled: true });
    await expect(req('Rain on a window', { authorizedMaxUsd: 0.5 })).rejects.toThrow(/disabled/);
    await configure({ paidGenerationDisabled: false });
  });

  it('prevents duplicate submissions with idempotency keys and active-request dedupe', async () => {
    await clearJobs();
    const body = { ...gen('wan-fixture', 'Paper boats drifting'), authorizedMaxUsd: 0.5, idempotencyKey: 'idem-boats-0001' };
    const a = await tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, body));
    const b = await tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, body));
    expect(b.id).toBe(a.id);
    await expect(tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...body, prompt: 'Paper planes gliding' }))).rejects.toThrow(/different request parameters/);
    await expect(tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...body, idempotencyKey: undefined }))).rejects.toThrow(/identical generation is already pending/);
    expect(await tx((t) => t.select().from(mediaJobs))).toHaveLength(1);
  });

  it('serializes concurrent reservations so the daily budget is never exceeded', async () => {
    await clearJobs();
    await configure({ ...PAID, maxPaidUsdPerVideo: 0.5, dailyPaidBudgetUsd: 0.5, monthlyPaidBudgetUsd: 1 });
    const results = await Promise.allSettled(['Orange leaves falling', 'Snow on pine trees', 'City lights at night'].map((prompt) => tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...gen('wan-fixture', prompt), authorizedMaxUsd: 0.5 }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([expect.stringMatching(/budget/), expect.stringMatching(/budget/)]);
    await configure({ ...PAID });
  });

  it('requires an MFA owner/admin approval; approval re-checks budgets and only then queues', async () => {
    await clearJobs();
    await configure({ requirePaidApproval: true });
    const wan = h.deps.videos!.wan_cloud as ReturnType<typeof fixture>;
    wan.start.mockClear();
    const job = await tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.operator, { ...gen('wan-fixture', 'Lanterns over a lake'), authorizedMaxUsd: 0.5 }));
    expect(job.status).toBe('awaiting_approval');
    expect((await tx((t) => paidVideoUsage(t, h.tenantId, h.clock.now()))).awaitingApproval).toBe(1);
    expect(await processNextMediaJob(h.deps)).toEqual({ kind: 'none' });
    await expect(tx((t) => approveVideoGeneration(t, h.deps, h.tenantId, h.users.operator, job.id))).rejects.toThrow(/roles/);
    const approved = await tx((t) => approveVideoGeneration(t, h.deps, h.tenantId, h.users.admin, job.id));
    expect(approved.status).toBe('queued');
    expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'retry', jobId: job.id });
    expect(wan.start).toHaveBeenCalledTimes(1);
    expect(wan.start.mock.calls[0]![0]).toMatchObject({ idempotencyKey: `futuregrow:${h.tenantId}:${job.id}`, maxCostUsd: 0.5, width: 720, height: 1280 });
    await configure({ requirePaidApproval: false });
  });

  it('cancels before submission without charge; after submission cancels at the provider and holds billing until reconciled', async () => {
    await clearJobs();
    const wan = fixture([{ width: 720, height: 1280 }], { cancel: vi.fn(async () => ({ cancelled: true })) });
    h.deps.videos!.wan_cloud = wan;
    const early = await tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...gen('wan-fixture', 'Clouds over mountains'), authorizedMaxUsd: 0.5 }));
    expect(await tx((t) => cancelVideoGeneration(t, h.deps, h.tenantId, h.users.operator, early.id))).toMatchObject({ status: 'cancelled' });
    expect(await processNextMediaJob(h.deps)).toEqual({ kind: 'none' });
    expect(wan.start).not.toHaveBeenCalled();
    expect((await tx((t) => paidVideoUsage(t, h.tenantId, h.clock.now()))).reservedUsd).toBe(0);
    const late = await tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...gen('wan-fixture', 'Fireflies in a meadow'), authorizedMaxUsd: 0.5 }));
    expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'retry', jobId: late.id });
    await tx((t) => cancelVideoGeneration(t, h.deps, h.tenantId, h.users.operator, late.id));
    await processNextMediaJob(h.deps);
    expect(wan.cancel).toHaveBeenCalledTimes(1);
    expect(wan.poll).not.toHaveBeenCalled();
    const [row] = await tx((t) => t.select().from(mediaJobs).where(eq(mediaJobs.id, late.id)));
    expect(row).toMatchObject({ status: 'cancelled', provenance: { billingUnresolved: true, cancelledAtProvider: true } });
    expect((await tx((t) => paidVideoUsage(t, h.tenantId, h.clock.now()))).reservedUsd).toBe(0.5);
    await expect(tx((t) => reconcileVideoCharge(t, h.deps, h.tenantId, h.users.operator, late.id, { actualCostUsd: 0.12, invoiceRef: 'INV-1' }))).rejects.toThrow(/roles/);
    await tx((t) => reconcileVideoCharge(t, h.deps, h.tenantId, h.users.finance, late.id, { actualCostUsd: 0.12, invoiceRef: 'INV-1' }));
    expect(await tx((t) => paidVideoUsage(t, h.tenantId, h.clock.now()))).toMatchObject({ reservedUsd: 0, daySpentUsd: 0.12, unreconciledJobs: 0 });
  });

  it('keeps the reservation when a provider reports no charge; retries an ambiguous submit only when replay-safe', async () => {
    await clearJobs();
    h.deps.videoProbe = async () => ({ width: 720, height: 1280, seconds: 5 });
    let calls = 0;
    const hf = fixture([{ width: 720, height: 1280 }], {
      replaySafe: true,
      start: vi.fn(async () => {
        if (++calls === 1) throw new Error('socket hang up after send');
        return { operationId: 'hf-req-1' };
      }),
      poll: vi.fn(async () => ({ status: 'succeeded' as const, bytes: mp4(), actualCostUsd: null, costBasis: 'unreported' as const })),
    });
    h.deps.videos!.higgsfield = hf;
    const job = await tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...gen('hf-fixture', 'A paper crane unfolding'), authorizedMaxUsd: 1 }));
    expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'retry', reason: expect.stringMatching(/same idempotency key/) });
    h.clock.advance(5 * 60_000);
    expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'retry', reason: 'Provider generation submitted' });
    expect(hf.start.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey)).toEqual([`futuregrow:${h.tenantId}:${job.id}`, `futuregrow:${h.tenantId}:${job.id}`]);
    h.clock.advance(31_000);
    expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'succeeded', jobId: job.id });
    const [row] = await tx((t) => t.select().from(mediaJobs).where(eq(mediaJobs.id, job.id)));
    expect(row).toMatchObject({ status: 'succeeded', costUsd: 1, provenance: { billingUnresolved: true, costBasis: 'unreported' } });
    expect(await tx((t) => paidVideoUsage(t, h.tenantId, h.clock.now()))).toMatchObject({ reservedUsd: 1, unreconciledJobs: 1, daySpentUsd: 0 });
    const history = await tx((t) => videoJobHistory(t, h.deps, h.tenantId));
    expect(history.jobs.find((j) => j.id === job.id)).toMatchObject({ mode: 'higgsfield', billingUnresolved: true, costBasis: 'unreported' });
    await tx((t) => reconcileVideoCharge(t, h.deps, h.tenantId, h.users.owner, job.id, { actualCostUsd: 0.8, invoiceRef: 'HF-BILL-7' }));
    expect(await tx((t) => paidVideoUsage(t, h.tenantId, h.clock.now()))).toMatchObject({ reservedUsd: 0, daySpentUsd: 0.8 });
    // A non-replay-safe adapter never resubmits an ambiguous submission: the job fails and the reservation stays.
    h.deps.videos!.wan_cloud = fixture([{ width: 720, height: 1280 }], { start: vi.fn(async () => Promise.reject(new Error('timeout after send'))) });
    const wanJob = await tx((t) => requestGenerativeVideo(t, h.deps, h.tenantId, h.users.owner, { ...gen('wan-fixture', 'Ink drops in water'), authorizedMaxUsd: 0.5 }));
    expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'failed', jobId: wanJob.id });
    expect((await tx((t) => paidVideoUsage(t, h.tenantId, h.clock.now()))).reservedUsd).toBe(0.5);
  });

  it('isolates settings, jobs and approvals per tenant', async () => {
    const other = `org_other_${n}`;
    await h.deps.db.insert(organization).values({ id: other, name: 'Other', slug: other });
    const otherOwner: Actor = { type: 'user', id: 'u_other_owner', roles: ['owner'], mfaVerified: true };
    const mine = await overview();
    const theirs = await tx((t) => videoRoutingOverview(t, h.deps, other), other);
    expect(theirs.settings).toEqual(DEFAULT_VIDEO_ROUTING);
    expect(theirs.version).toBe(0);
    await tx((t) => updateVideoRouting(t, h.deps, other, otherOwner, { settings: { ...DEFAULT_VIDEO_ROUTING, dailyTarget: 2 }, expectedVersion: 0 }), other);
    expect((await overview()).settings).toEqual(mine.settings);
    const myJobs = (await tx((t) => videoJobHistory(t, h.deps, h.tenantId))).jobs;
    expect(myJobs.length).toBeGreaterThan(0);
    expect((await tx((t) => videoJobHistory(t, h.deps, other), other)).jobs).toHaveLength(0);
    const target = myJobs.find((j) => j.source === 'media_job')!;
    await expect(tx((t) => cancelVideoGeneration(t, h.deps, other, otherOwner, target.id), other)).rejects.toThrow(/not found/);
  });

  it('daily automation renders QA-passed storyboards up to the target, skips duplicates and pauses on blockers', async () => {
    expect((await tx((t) => dailyVideoPlan(t, h.deps, h.tenantId))).blockers).toContain('Daily automation is OFF.');
    expect((await runDailyVideoAutomation(h.deps, h.tenantId)).queued).toHaveLength(0);
    await configure({ dailyAutomation: true, dailyTarget: 3 });
    const sb = (text: string) => ({ preset: 'square_1x1', scenes: [{ id: 's1', durationSeconds: 2, text }] });
    await tx((t) => createVideoProject(t, h.deps, h.tenantId, h.users.operator, { title: 'A', storyboard: sb('Morning routine tips') }));
    await tx((t) => createVideoProject(t, h.deps, h.tenantId, h.users.operator, { title: 'A copy', storyboard: sb('Morning routine tips') }));
    await tx((t) => createVideoProject(t, h.deps, h.tenantId, h.users.operator, { title: 'B', storyboard: sb('Evening wind-down ideas') }));
    const plan = await tx((t) => dailyVideoPlan(t, h.deps, h.tenantId));
    expect(plan).toMatchObject({ target: 3, blockers: [] });
    expect(plan.skippedDuplicates).toBeGreaterThanOrEqual(1);
    const run = await runDailyVideoAutomation(h.deps, h.tenantId);
    expect(run.queued.length).toBe(plan.slots);
    expect(run.queued.length).toBeLessThanOrEqual(2);
    const again = await tx((t) => dailyVideoPlan(t, h.deps, h.tenantId));
    expect(again.candidates.filter((id) => run.queued.includes(id))).toHaveLength(0);
  });
});
