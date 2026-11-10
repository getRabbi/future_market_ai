import { randomUUID } from 'node:crypto';
import { type ModelProvider, PROMPTS, type ProviderOutcome, type StructuredRequest } from '@futuregrow/agent-kernel';
import { JURISDICTION_DOMAIN_KEYS } from '@futuregrow/contracts';
import { actionRequests, artifactLicenses, assets, costLedger, mediaJobs, modelRegistry, organization, renderJobs, socialPosts, videoAutomationItems, videoProjects, withTenant } from '@futuregrow/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveJurisdictionPacks, type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { clearModelCache, createModelGateway } from '../src/agents.js';
import type { Actor } from '../src/deps.js';
import { bindChannel, createBrand } from '../src/modules/brands/index.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import * as knowledge from '../src/modules/m03-knowledge/index.js';
import { recordRemotionLicense } from '../src/modules/m14-assets/index.js';
import { approveModel, seedModelRegistry, setTenantPolicy } from '../src/modules/m24-governance/index.js';
import type { GenerativeVideoProvider } from '../src/modules/media/generative-video.js';
import { GOOGLE_FLOW_URL, updateVideoRouting, type VideoAutomation, type VideoRouting, videoRoutingOverview } from '../src/modules/media/routing.js';
import { StoryboardSchema, toSrt, totalSeconds } from '../src/modules/media/video.js';
import { AUTOMATION_ACTOR_REF, automationKey, automationOverview, MAX_ATTEMPTS, retryAutomationItem, reviewAutomationItem, runVideoAutomation, updateAutomationSettings } from '../src/modules/media/video-automation.js';
import { runDailyVideoAutomation } from '../src/modules/media/video-jobs.js';
import { buildStoryboard, CURRICULUM_VIDEO_KINDS, curriculumScript, VideoScriptSchema } from '../src/modules/media/video-script.js';
import { packUnits, packVersion, verifyCurriculumText } from '../src/modules/studio/curriculum.js';
import { EPS_TOPIK_BN } from '../src/modules/studio/eps-topik-bn.js';
import { upsertProgram } from '../src/modules/studio/index.js';
import * as U from '../src/modules/studio/universal.js';

class ScriptedProvider implements ModelProvider {
  readonly name = 'anthropic';
  responders = new Map<string, (req: StructuredRequest<unknown>) => unknown>();
  requests: StructuredRequest<unknown>[] = [];
  async generateStructured<T>(req: StructuredRequest<T>): Promise<ProviderOutcome<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    const r = this.responders.get(req.system);
    if (!r) throw new Error('no scripted response');
    return { kind: 'ok', output: r(req as StructuredRequest<unknown>) as T, servedBy: 'claude-opus-5-5', usage: { inputTokens: 500, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', requestId: 'req_v' };
  }
}

let h: CoreHarness;
let provider: ScriptedProvider;
const DAY = 86_400_000;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2], tenantId = h.tenantId) => withTenant(h.deps.db, { tenantId, actor: 'user:test' }, fn);
const items = () => tx((t) => t.select().from(videoAutomationItems).orderBy(videoAutomationItems.day, videoAutomationItems.slot));
const today = () => h.clock.now().toISOString().slice(0, 10);

async function configure(patch: Partial<VideoRouting>) {
  const ov = await tx((t) => videoRoutingOverview(t, h.deps, h.tenantId));
  return tx((t) => updateVideoRouting(t, h.deps, h.tenantId, h.users.owner, { settings: { ...ov.settings, ...patch }, expectedVersion: ov.version }));
}
async function automate(target: number, automation: Partial<VideoAutomation>, actor: Actor = h.users.owner) {
  const ov = await tx((t) => automationOverview(t, h.deps, h.tenantId));
  return tx((t) => updateAutomationSettings(t, h.deps, h.tenantId, actor, { dailyAutomation: true, dailyTarget: target, automation: { ...ov.settings.automation, ...automation }, expectedVersion: ov.version }));
}
const nextDay = () => h.clock.advance(DAY);

/** Completes (or fails) a render job the way the media worker would, with the asset QA result. */
async function finishRender(jobId: string, ok: boolean) {
  await tx(async (t) => {
    if (!ok) {
      await t.update(renderJobs).set({ status: 'failed', statusReason: 'ffmpeg exited with code 1' }).where(eq(renderJobs.id, jobId));
      return;
    }
    const [a] = await t
      .insert(assets)
      .values({
        tenantId: h.tenantId,
        kind: 'video',
        title: 'render',
        objectKey: `renders/${randomUUID()}.mp4`,
        sha256: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        mime: 'video/mp4',
        bytes: 1000,
        width: 1080,
        height: 1920,
        durationMs: 20_000,
        origin: 'render',
        renderJobId: jobId,
        manifest: {},
        qa: { technical: { passed: true, problems: [] } },
        disclosure: {},
        createdBy: 'test',
      })
      .returning();
    await t.update(renderJobs).set({ status: 'completed', outputAssetId: a!.id }).where(eq(renderJobs.id, jobId));
  });
}

async function evidenceFor(slug: string, name: string) {
  return tx((t) =>
    admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'primary',
        sourceOwner: slug,
        sourceUriOrObjectId: `doc://${slug}/${randomUUID()}`,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'first-party',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 1,
        freshnessSlaHours: 24 * 365,
        permittedUses: ['analytics', 'creative_generation', 'publishing', 'autonomous_execution'],
        kind: 'document',
        summary: `${name} product sheet`,
        content: { n: randomUUID() },
      } as never,
      { now: h.clock.now() },
    ),
  );
}

/** A brand with a Page, optionally a product with an approved claim and a general program. */
async function brand(slug: string, name: string, pageId: string, claim: string | null, general: boolean) {
  const ev = await evidenceFor(slug, name);
  const product = await tx((t) => knowledge.upsertEntity(t, h.deps, h.tenantId, h.users.owner, { kind: 'product', key: `${slug}.main`, name, attributes: {}, evidenceId: ev.evidenceId }));
  let claimId: string | null = null;
  if (claim) {
    const c = await tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text: claim, claimType: 'product_capability', evidenceIds: [ev.evidenceId], entityIds: [product.id] }));
    await tx((t) => knowledge.reviewClaim(t, h.tenantId, h.users.legal, c.id, 'approved'));
    claimId = c.id;
  }
  const conn = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: pageId, displayName: `${name} Page`, grantedScopes: ['pages_manage_posts'], credentials: { accessToken: `PAGE_${pageId}` } });
  const b = await tx((t) =>
    createBrand(t, h.tenantId, h.users.owner, {
      slug,
      name,
      productEntityIds: [product.id],
      profile: { voice: { tone: ['friendly'] }, visual: { palette: { background: '#ffffff', ink: '#111111', accent: '#7c2d12', onAccent: '#ffffff' } }, destinations: [{ kind: 'website', url: `https://${slug}.example/` }] },
    }),
  );
  await tx((t) => bindChannel(t, h.tenantId, h.users.owner, b.id, conn.id));
  if (general) {
    await tx((t) =>
      U.upsertGeneralProgram(t, h.tenantId, h.users.operator, {
        kind: 'general',
        brandId: b.id,
        connectionId: conn.id,
        name: `${name} videos`,
        plan: {
          language: 'en',
          objective: 'engagement',
          audience: 'Online shoppers in Bangladesh',
          pillars: [
            { key: 'tutorial', name: 'How to order', description: 'Step-by-step ordering help' },
            { key: 'promotion', name: 'Promotion', description: 'What the shop offers' },
          ],
          platforms: ['facebook'],
          postsPerWeek: 3,
          destinationUrl: null,
          cta: `Shop at ${name}`,
          hashtags: [],
        },
      }),
    );
  }
  return { brand: b, conn, claimId };
}

let eps: Awaited<ReturnType<typeof brand>>;
let ecoms: Awaited<ReturnType<typeof brand>>;
let bare: Awaited<ReturnType<typeof brand>>;
let other: Awaited<ReturnType<typeof brand>>;

function fixtureVideo(): GenerativeVideoProvider & { start: ReturnType<typeof vi.fn> } {
  const sizes = [{ width: 720, height: 1280 }];
  return { sizes, supports: (i: { width: number; height: number }) => sizes.some((s) => s.width === i.width && s.height === i.height), start: vi.fn(async () => ({ operationId: 'op' })), poll: vi.fn(async () => ({ status: 'running' as const })) } as never;
}

beforeAll(async () => {
  h = await createCoreHarness();
  await seedModelRegistry(h.t.handle.db);
  await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'anthropic', modelId: 'claude-opus-5-5', trainingOnCustomerData: 'no', dataRetentionTerms: 'reviewed', inputUsdPerMtok: 4, outputUsdPerMtok: 20 });
  clearModelCache();
  provider = new ScriptedProvider();
  h.deps.models = createModelGateway(h.deps, { anthropic: provider });
  await approveJurisdictionPacks(h.t.handle.db, h.tenantId, h.users.owner, 'US', JURISDICTION_DOMAIN_KEYS);
  await tx((t) => setTenantPolicy(t, h.tenantId, h.users.owner, { configured: true, currency: 'USD', approvedJurisdictions: ['US'], categories: { PUBLIC_PUBLISHING: { autonomy: 'approval_required', approverRoles: ['approver'], requiresDistinctApprover: true, maxAudienceSize: null } } }));
  eps = await brand('eps-topik', 'EPS TOPIK Bangla', '701', null, false);
  await tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: eps.conn.id, pack: 'eps-topik-bn' }));
  ecoms = await brand('ecoms-bd', 'Ecoms BD', '702', 'Ecoms BD ships every order from its own Dhaka warehouse', true);
  bare = await brand('bare-shop', 'Bare Shop', '703', null, true);
  other = await brand('other-co', 'Other Co', '704', 'Other Co sells handmade lamps', true);
  for (const [p, modelId] of [
    ['wan_cloud', 'wan-fixture'],
    ['higgsfield', 'hf-fixture'],
  ] as const) {
    await h.deps.db
      .insert(modelRegistry)
      .values({ provider: p, modelId, displayName: `${p} fixture`, purposes: ['video_generation'], licenseOrTerms: 'Fixture', commercialUse: 'allowed', trainingOnCustomerData: 'no', approvedForProduction: true, approvedBy: h.users.owner.id, approvedAt: h.clock.now(), usdPerVideoSecond: 0.1 });
    await tx((t) =>
      t.insert(artifactLicenses).values({
        tenantId: h.tenantId,
        exactName: `${p}/${modelId}`,
        versionOrCommit: 'test',
        sha256: (p === 'wan_cloud' ? 'c' : 'd').repeat(64),
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
}, 240_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  provider.responders.clear();
});

describe('automatic scripts and storyboards (pure)', () => {
  it('builds a verified curriculum script for every video unit kind and a valid storyboard in 9:16, 1:1 and 16:9', () => {
    const units = packUnits(EPS_TOPIK_BN);
    for (const kind of CURRICULUM_VIDEO_KINDS) {
      const unit = units.find((u) => u.kind === kind)!;
      for (const preset of ['vertical_9x16', 'square_1x1', 'landscape_16x9'] as const) {
        const r = curriculumScript(EPS_TOPIK_BN, unit, { preset, platform: 'facebook' });
        if (!('script' in r)) throw new Error(`${kind}: ${r.reason}`);
        const s = VideoScriptSchema.parse(r.script);
        expect(s.curriculum).toMatchObject({ pack: 'eps-topik-bn', unitId: unit.id });
        expect(s.scenes.every((x) => x.voiceover && x.onScreenText)).toBe(true);
        expect(verifyCurriculumText(s.scenes.map((x) => `${x.onScreenText}\n${x.subtitle}\n${x.voiceover}`).join('\n'), { ...s.curriculum!, version: s.curriculum!.version }).verified).toBe(true);
        const sb = buildStoryboard(s, { palette: { accent: '#7c2d12', onAccent: '#ffffff' } }, { assetIds: [], logoAssetId: null, aiGenerated: false });
        expect(StoryboardSchema.parse(sb)).toEqual(sb);
        expect(sb).toMatchObject({ preset, brandColor: '#7c2d12', textColor: '#ffffff', disclosureText: '' });
        expect(totalSeconds(sb)).toBe(s.scenes.reduce((a, x) => a + x.seconds, 0));
        expect(sb.scenes.map((x) => x.text)).toEqual(s.scenes.map((x) => x.onScreenText));
        expect(toSrt(sb).split('-->').length - 1).toBe(s.scenes.filter((x) => x.subtitle).length);
      }
    }
  });

  it('refuses units that are not video material instead of cutting them', () => {
    const reading = packUnits(EPS_TOPIK_BN).find((u) => u.kind === 'reading')!;
    expect(curriculumScript(EPS_TOPIK_BN, reading, { preset: 'square_1x1', platform: 'facebook' })).toMatchObject({ reason: expect.stringMatching(/not used for videos/) });
  });
});

describe('daily video automation (D-053)', () => {
  it('pauses before any work while no route exists (Remotion licence missing) and only an MFA owner/admin may configure it', async () => {
    await expect(automate(3, { brands: [{ brandId: eps.brand.id, enabled: true, dailyQuota: 2, categories: [], presets: ['vertical_9x16', 'square_1x1'], assetIds: [] }] }, h.users.operator)).rejects.toThrow(/requires one of roles/);
    await expect(automate(3, { brands: [{ brandId: eps.brand.id, enabled: true, dailyQuota: 2, categories: [], presets: ['vertical_9x16'], assetIds: [] }] }, { ...h.users.owner, mfaVerified: false })).rejects.toThrow(/multi-factor/);
    await automate(3, { brands: [{ brandId: eps.brand.id, enabled: true, dailyQuota: 2, categories: [], presets: ['vertical_9x16', 'square_1x1'], assetIds: [] }] });
    const r = await runVideoAutomation(h.deps, h.tenantId);
    expect(r.ran).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/No video route/);
    expect(await items()).toHaveLength(0);
    // Saving the switchboard without the automation fields keeps the automation configuration.
    const ov = await tx((t) => videoRoutingOverview(t, h.deps, h.tenantId));
    const { automation: _a, ...switchboardOnly } = ov.settings;
    await tx((t) => updateVideoRouting(t, h.deps, h.tenantId, h.users.owner, { settings: switchboardOnly, expectedVersion: ov.version }));
    expect((await tx((t) => videoRoutingOverview(t, h.deps, h.tenantId))).settings.automation.brands).toHaveLength(1);
  });

  it('EPS TOPIK Bangla: writes curriculum videos without any model call and renders them with Remotion', async () => {
    await tx((t) => recordRemotionLicense(t, h.tenantId, h.users.owner, { eligibility: 'company_license', licenseRef: 'TEST-LIC-VA', attestation: 'Fixture company licence attestation' }));
    const before = provider.requests.length;
    const run = await runDailyVideoAutomation(h.deps, h.tenantId);
    expect(run.automation).toMatchObject({ ran: true, created: 2, scripted: 2, routed: 2, blockers: [] });
    expect(provider.requests.length).toBe(before);
    const rows = await items();
    expect(rows.map((i) => [i.status, i.origin, i.mode, i.preset])).toEqual([
      ['rendering', 'curriculum', 'remotion', 'vertical_9x16'],
      ['rendering', 'curriculum', 'remotion', 'square_1x1'],
    ]);
    expect(rows.map((i) => i.idempotencyKey)).toEqual([automationKey(today(), eps.brand.id, 0), automationKey(today(), eps.brand.id, 1)]);
    expect(new Set(rows.map((i) => i.category)).size).toBe(2);
    const projects = await tx((t) =>
      t
        .select()
        .from(videoProjects)
        .where(
          inArray(
            videoProjects.id,
            rows.map((i) => i.videoProjectId!),
          ),
        ),
    );
    for (const p of projects) {
      expect(p.createdBy).toBe(AUTOMATION_ACTOR_REF);
      expect(p.brandId).toBe(eps.brand.id);
      const sb = StoryboardSchema.parse(p.storyboard);
      const [job] = await tx((t) => t.select().from(renderJobs).where(eq(renderJobs.id, p.renderJobId!)));
      const dims = sb.preset === 'vertical_9x16' ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 };
      expect(job).toMatchObject({ status: 'queued', composition: 'scene_story', workflowConfig: { engine: 'remotion', ...dims, fps: 30, durationInFrames: totalSeconds(sb) * 30, codec: 'h264' } });
      expect((job!.workflowConfig as { outputs: { subtitles: string } }).outputs.subtitles).toBe(toSrt(sb));
    }
  });

  it('runs again (and concurrently) without duplicating rows, storyboards or renders', async () => {
    const jobsBefore = (await tx((t) => t.select().from(renderJobs))).length;
    const [a, b] = await Promise.all([runVideoAutomation(h.deps, h.tenantId), runVideoAutomation(h.deps, h.tenantId)]);
    expect(a.created + b.created).toBe(0);
    expect(await items()).toHaveLength(2);
    expect((await tx((t) => t.select().from(renderJobs))).length).toBe(jobsBefore);
    expect((await tx((t) => t.select().from(videoProjects).where(eq(videoProjects.createdBy, AUTOMATION_ACTOR_REF)))).length).toBe(2);
    // The idempotency key is enforced by the database, not only by the planner.
    const [first] = await items();
    await expect(tx((t) => t.insert(videoAutomationItems).values({ tenantId: h.tenantId, brandId: eps.brand.id, day: first!.day, slot: 9, idempotencyKey: first!.idempotencyKey, topicKey: 'x', topic: {}, category: 'vocab', preset: 'square_1x1', platform: 'facebook' }))).rejects.toThrow();
  });

  it('moves a video to the approval queue only after the render QA passed; review is human-only and never publishes; a failed render is retried safely', async () => {
    const [ok, bad] = await items();
    const [pOk] = await tx((t) => t.select().from(videoProjects).where(eq(videoProjects.id, ok!.videoProjectId!)));
    const [pBad] = await tx((t) => t.select().from(videoProjects).where(eq(videoProjects.id, bad!.videoProjectId!)));
    await finishRender(pOk!.renderJobId!, true);
    await finishRender(pBad!.renderJobId!, false);
    await runVideoAutomation(h.deps, h.tenantId);
    const [a, b] = await items();
    expect(a).toMatchObject({ status: 'awaiting_approval' });
    expect(b).toMatchObject({ status: 'failed', statusReason: expect.stringMatching(/ffmpeg/) });
    const ov = await tx((t) => automationOverview(t, h.deps, h.tenantId));
    expect(ov.pendingApprovals.map((p) => p.id)).toEqual([a!.id]);
    expect(ov.pendingApprovals[0]!.project?.storyboard?.scenes.length).toBeGreaterThan(2);
    expect(ov.today).toMatchObject({ completed: 1, failed: 1 });

    await expect(tx((t) => reviewAutomationItem(t, h.deps, h.tenantId, { type: 'system', id: 'x', roles: ['owner'], mfaVerified: true }, a!.id, { decision: 'approve' }))).rejects.toThrow(/human user/);
    await expect(tx((t) => reviewAutomationItem(t, h.deps, h.tenantId, h.users.operator, a!.id, { decision: 'approve' }))).rejects.toThrow(/requires one of roles/);
    expect(await tx((t) => reviewAutomationItem(t, h.deps, h.tenantId, h.users.approver, a!.id, { decision: 'approve' }))).toMatchObject({ status: 'approved', reviewedBy: `user:${h.users.approver.id}` });
    await expect(tx((t) => reviewAutomationItem(t, h.deps, h.tenantId, h.users.approver, b!.id, { decision: 'approve' }))).rejects.toThrow(/only rendered videos/);
    expect(await tx((t) => t.select().from(socialPosts))).toHaveLength(0);
    expect(await tx((t) => t.select().from(actionRequests))).toHaveLength(0);

    const jobsBefore = (await tx((t) => t.select().from(renderJobs))).length;
    expect(await tx((t) => retryAutomationItem(t, h.deps, h.tenantId, h.users.operator, b!.id))).toMatchObject({ status: 'storyboarded', videoProjectId: b!.videoProjectId });
    await runVideoAutomation(h.deps, h.tenantId);
    expect((await items())[1]).toMatchObject({ status: 'rendering', videoProjectId: b!.videoProjectId });
    expect((await tx((t) => t.select().from(renderJobs))).length).toBe(jobsBefore + 1);
    await expect(tx((t) => retryAutomationItem(t, h.deps, h.tenantId, h.users.operator, a!.id))).rejects.toThrow(/only failed, skipped or waiting/);
    await finishRender((await tx((t) => t.select().from(videoProjects).where(eq(videoProjects.id, b!.videoProjectId!))))[0]!.renderJobId!, true);
  });

  it('Ecoms BD: AI writes grounded scripts within quotas; an invented claim is dropped and the approved-claim template is used; brands stay isolated', async () => {
    nextDay();
    await automate(3, {
      brands: [
        { brandId: eps.brand.id, enabled: true, dailyQuota: 2, categories: ['vocab'], presets: ['vertical_9x16'], assetIds: [] },
        { brandId: ecoms.brand.id, enabled: true, dailyQuota: 2, categories: [], presets: ['landscape_16x9'], assetIds: [] },
      ],
    });
    const seen: { claims: string[]; topic: { source: string } }[] = [];
    provider.responders.set(PROMPTS.videoScript.system, (req) => {
      const input = JSON.parse(req.messages[0]!.content as string) as { approvedClaims: { id: string }[]; topic: { source: string; title: string } };
      seen.push({ claims: input.approvedClaims.map((c) => c.id), topic: input.topic });
      const invented = input.topic.source === 'pillar';
      return {
        abstain: false,
        abstainReason: null,
        title: invented ? 'Why we beat every shop' : 'Ordering from our Dhaka warehouse',
        hook: 'Where does your order come from?',
        scenes: [
          { onScreenText: 'Where does your order come from?', voiceover: 'Ever wondered where your order ships from?', subtitle: 'Where does your order come from?', seconds: 3, mediaHint: 'warehouse shelves' },
          { onScreenText: 'Ecoms BD ships every order from its own Dhaka warehouse', voiceover: 'Ecoms BD ships every order from its own Dhaka warehouse.', subtitle: 'Our own Dhaka warehouse', seconds: 5, mediaHint: 'packed parcels' },
          { onScreenText: 'Shop at Ecoms BD', voiceover: 'Shop at Ecoms BD.', subtitle: 'Shop at Ecoms BD', seconds: 3, mediaHint: '' },
        ],
        cta: 'Shop at Ecoms BD',
        suggestedMedia: ['warehouse shelves', 'packed parcels'],
        claimIds: invented ? [randomUUID()] : [ecoms.claimId!],
        evidenceIds: [],
      };
    });
    const run = await runVideoAutomation(h.deps, h.tenantId);
    const todays = (await items()).filter((i) => i.day === today());
    // Tenant target 3 across brands, round-robin: EPS, Ecoms, EPS (EPS quota 2, Ecoms quota 2).
    expect(todays.filter((i) => i.brandId === eps.brand.id)).toHaveLength(2);
    expect(todays.filter((i) => i.brandId === ecoms.brand.id)).toHaveLength(1);
    expect(run.created).toBe(3);
    const ecomsItem = todays.find((i) => i.brandId === ecoms.brand.id)!;
    expect(ecomsItem).toMatchObject({ origin: 'ai', category: 'approved_claims', preset: 'landscape_16x9', platform: 'facebook' });
    const script = VideoScriptSchema.parse(ecomsItem.script);
    expect(script).toMatchObject({ title: 'Ordering from our Dhaka warehouse', cta: 'Shop at Ecoms BD', claimIds: [ecoms.claimId], suggestedMedia: ['warehouse shelves', 'packed parcels'] });
    expect(todays.filter((i) => i.brandId === eps.brand.id).every((i) => i.category === 'vocab' && i.origin === 'curriculum')).toBe(true);
    // Only Ecoms' own approved claims were given to the model.
    expect(seen.every((s) => s.claims.length === 1 && s.claims[0] === ecoms.claimId)).toBe(true);
    expect((await items()).some((i) => i.brandId === other.brand.id || i.brandId === bare.brand.id)).toBe(false);

    // Next day: the claim topic was used, so Ecoms gets pillar topics; the invented claim is dropped, the template quotes the approved claim.
    nextDay();
    await automate(2, { brands: [{ brandId: ecoms.brand.id, enabled: true, dailyQuota: 1, categories: ['promotion'], presets: ['square_1x1'], assetIds: [] }] });
    await runVideoAutomation(h.deps, h.tenantId);
    const [pillarItem] = (await items()).filter((i) => i.day === today());
    expect(pillarItem).toMatchObject({ origin: 'template', category: 'promotion', provenance: { scriptNote: expect.stringMatching(/template used: the script cites a claim that is not an approved brand claim/) } });
    const tpl = VideoScriptSchema.parse(pillarItem!.script);
    expect(tpl.scenes.map((s) => s.onScreenText)).toContain('Ecoms BD ships every order from its own Dhaka warehouse');
    expect(tpl.claimIds).toEqual([ecoms.claimId]);
    expect(pillarItem).toMatchObject({ status: 'storyboarded', statusReason: 'Waiting for a free render slot.' }); // two renders are already in flight
  });

  it('a script that breaks the claims rules fails storyboard QA and is never rendered', async () => {
    nextDay();
    await finishAllRenders();
    await automate(1, { brands: [{ brandId: ecoms.brand.id, enabled: true, dailyQuota: 1, categories: ['tutorial'], presets: ['vertical_9x16'], assetIds: [] }] });
    provider.responders.set(PROMPTS.videoScript.system, () => ({
      abstain: false,
      abstainReason: null,
      title: 'Ordering made simple',
      hook: 'Order in a minute',
      scenes: [
        { onScreenText: 'Order in a minute', voiceover: 'Ordering is simple.', subtitle: '', seconds: 3, mediaHint: '' },
        { onScreenText: 'The best prices in Bangladesh, guaranteed', voiceover: 'The best prices, guaranteed.', subtitle: '', seconds: 4, mediaHint: '' },
        { onScreenText: 'Shop at Ecoms BD', voiceover: 'Shop now.', subtitle: '', seconds: 3, mediaHint: '' },
      ],
      cta: 'Shop at Ecoms BD',
      suggestedMedia: [],
      claimIds: [],
      evidenceIds: [],
    }));
    await runVideoAutomation(h.deps, h.tenantId);
    const [item] = (await items()).filter((i) => i.day === today());
    expect(item).toMatchObject({ status: 'failed', origin: 'ai', videoProjectId: null, statusReason: expect.stringMatching(/QA failed: UNSUBSTANTIATED_SUPERLATIVE/) });
    expect(await tx((t) => t.select().from(videoProjects).where(eq(videoProjects.title, 'Ordering made simple')))).toHaveLength(0);
  });

  it('without an AI provider: templates from approved content only, otherwise bounded retries then failure; useAi OFF makes no model call', async () => {
    nextDay();
    const models = h.deps.models;
    h.deps.models = undefined;
    try {
      await automate(1, { brands: [{ brandId: bare.brand.id, enabled: true, dailyQuota: 1, categories: ['tutorial'], presets: ['vertical_9x16'], assetIds: [] }] });
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await runVideoAutomation(h.deps, h.tenantId);
        const [item] = (await items()).filter((i) => i.brandId === bare.brand.id);
        expect(item!.attempts).toBe(attempt);
        expect(item!.status).toBe(attempt < MAX_ATTEMPTS ? 'planned' : 'failed');
        expect(item!.statusReason).toMatch(/MODEL_UNAVAILABLE.*no approved content fits a template/);
        h.clock.advance(attempt * 60 * 60_000 + 1000);
      }
    } finally {
      h.deps.models = models;
    }
    nextDay();
    const before = provider.requests.length;
    await automate(1, { useAi: false, brands: [{ brandId: ecoms.brand.id, enabled: true, dailyQuota: 1, categories: [], presets: ['vertical_9x16'], assetIds: [] }] });
    const r = await runVideoAutomation(h.deps, h.tenantId);
    expect(provider.requests.length).toBe(before);
    // The only template-capable topic (the approved claim) was used recently: no fabricated success.
    expect(r.created).toBe(0);
    expect(r.notes.map((n) => n.note).join(' ')).toMatch(/No fresh topic/);
    await automate(1, { useAi: true });
  });

  it('resumes interrupted work after a worker restart without generating twice', async () => {
    nextDay();
    await finishAllRenders();
    await automate(1, { brands: [{ brandId: eps.brand.id, enabled: true, dailyQuota: 1, categories: ['grammar'], presets: ['vertical_9x16'], assetIds: [] }] });
    // A worker claimed the row and died before writing the script.
    await tx((t) =>
      t.insert(videoAutomationItems).values({
        tenantId: h.tenantId,
        brandId: eps.brand.id,
        day: today(),
        slot: 0,
        idempotencyKey: automationKey(today(), eps.brand.id, 0),
        topicKey: `eps:eps-topik-bn:${packUnits(EPS_TOPIK_BN).find((u) => u.kind === 'grammar')!.id}`,
        topic: {
          key: `eps:eps-topik-bn:${packUnits(EPS_TOPIK_BN).find((u) => u.kind === 'grammar')!.id}`,
          category: 'grammar',
          source: 'curriculum',
          title: 'g',
          angle: '',
          hook: '',
          claimIds: [],
          programId: randomUUID(),
          pack: 'eps-topik-bn',
          packVersion: packVersion(EPS_TOPIK_BN),
          unitId: packUnits(EPS_TOPIK_BN).find((u) => u.kind === 'grammar')!.id,
        },
        category: 'grammar',
        preset: 'vertical_9x16',
        platform: 'facebook',
        leaseToken: 'dead-worker',
        leaseUntil: new Date(h.clock.now().getTime() + 5 * 60_000),
      }),
    );
    let r = await runVideoAutomation(h.deps, h.tenantId);
    expect(r.created).toBe(0);
    let rows = (await items()).filter((i) => i.day === today());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'planned', leaseToken: 'dead-worker' });
    h.clock.advance(6 * 60_000);
    r = await runVideoAutomation(h.deps, h.tenantId);
    rows = (await items()).filter((i) => i.day === today());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'rendering', origin: 'curriculum' });
  });

  it('Google Flow gets a prepared manual task; Wan and Higgsfield wait for explicit paid authorization; nothing is submitted or spent', async () => {
    nextDay();
    await finishAllRenders();
    await configure({ enabled: { remotion: true, google_flow: true, wan_cloud: false, higgsfield: false } });
    await automate(1, { preferredMode: 'google_flow', brands: [{ brandId: eps.brand.id, enabled: true, dailyQuota: 1, categories: ['vocab'], presets: ['vertical_9x16'], assetIds: [] }] });
    await runVideoAutomation(h.deps, h.tenantId);
    let [item] = (await items()).filter((i) => i.day === today());
    expect(item).toMatchObject({ status: 'manual_task', mode: 'google_flow', manualTask: { kind: 'google_flow', url: GOOGLE_FLOW_URL, prompt: expect.stringMatching(/9:16 vertical/) } });

    // Paid modes OFF (or paid disabled): no route, no work.
    nextDay();
    await automate(1, { preferredMode: 'higgsfield' });
    let r = await runVideoAutomation(h.deps, h.tenantId);
    expect(r.blockers.join(' ')).toMatch(/No video route/);
    expect((await items()).filter((i) => i.day === today())).toHaveLength(0);

    h.deps.videos = { wan_cloud: fixtureVideo(), higgsfield: fixtureVideo() };
    await configure({ enabled: { remotion: true, google_flow: false, wan_cloud: true, higgsfield: true }, paidGenerationDisabled: false, requirePaidApproval: false, maxPaidUsdPerVideo: 2, dailyPaidBudgetUsd: 5, monthlyPaidBudgetUsd: 20 });
    for (const mode of ['wan_cloud', 'higgsfield'] as const) {
      await automate(2, { preferredMode: mode, brands: [{ brandId: eps.brand.id, enabled: true, dailyQuota: mode === 'wan_cloud' ? 1 : 2, categories: ['vocab'], presets: ['vertical_9x16'], assetIds: [] }] });
      r = await runVideoAutomation(h.deps, h.tenantId);
      expect(r.blockers).toEqual([]);
      item = (await items()).filter((i) => i.day === today()).at(-1)!;
      expect(item).toMatchObject({ status: 'waiting', mode, manualTask: { kind: 'paid_authorization', mode, estimateUsd: 0.8 }, statusReason: expect.stringMatching(/never authorizes paid generation/) });
    }
    expect(await tx((t) => t.select().from(mediaJobs))).toHaveLength(0);
    expect(await tx((t) => t.select().from(costLedger).where(eq(costLedger.category, 'video_generation')))).toHaveLength(0);
    expect((h.deps.videos!.wan_cloud as ReturnType<typeof fixtureVideo>).start).not.toHaveBeenCalled();
    expect((h.deps.videos!.higgsfield as ReturnType<typeof fixtureVideo>).start).not.toHaveBeenCalled();
    await configure({ enabled: { remotion: true, google_flow: false, wan_cloud: false, higgsfield: false }, paidGenerationDisabled: true, maxPaidUsdPerVideo: 0, dailyPaidBudgetUsd: 0, monthlyPaidBudgetUsd: 0 });
    await automate(1, { preferredMode: 'smart' });
  });

  it('isolates automation per tenant', async () => {
    const otherTenant = `org_va_${randomUUID().slice(0, 8)}`;
    await h.deps.db.insert(organization).values({ id: otherTenant, name: 'Other', slug: otherTenant });
    const r = await runVideoAutomation(h.deps, otherTenant);
    expect(r).toMatchObject({ ran: false, created: 0 });
    expect(r.blockers).toContain('Daily automation is OFF.');
    expect(await tx((t) => t.select().from(videoAutomationItems), otherTenant)).toHaveLength(0);
    const ov = await tx((t) => automationOverview(t, h.deps, otherTenant), otherTenant);
    expect(ov.items).toHaveLength(0);
    expect(ov.brands).toHaveLength(0);
    const mine = await items();
    await expect(tx((t) => retryAutomationItem(t, h.deps, otherTenant, { type: 'user', id: 'u_x', roles: ['owner'], mfaVerified: true }, mine[0]!.id), otherTenant)).rejects.toThrow(/not found/);
  });
});

async function finishAllRenders() {
  const open = await tx((t) =>
    t
      .select()
      .from(renderJobs)
      .where(inArray(renderJobs.status, ['queued', 'rendering'])),
  );
  for (const j of open) await finishRender(j.id, true);
}
