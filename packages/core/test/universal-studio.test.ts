import { randomUUID } from 'node:crypto';
import { type ModelProvider, PROMPTS, type ProviderOutcome, type StructuredRequest } from '@futuregrow/agent-kernel';
import { JURISDICTION_DOMAIN_KEYS } from '@futuregrow/contracts';
import { actionRequests, socialPosts, studioContentItems, studioPrograms, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approveJurisdictionPacks, type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { clearModelCache, createModelGateway } from '../src/agents.js';
import { bindChannel, createBrand } from '../src/modules/brands/index.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import * as knowledge from '../src/modules/m03-knowledge/index.js';
import * as social from '../src/modules/m16-social/index.js';
import { decideApproval, executeAction, verifyAction } from '../src/modules/m23-execution/gateway.js';
import { approveModel, seedModelRegistry, setTenantPolicy } from '../src/modules/m24-governance/index.js';
import { campaignBase, upsertProgram } from '../src/modules/studio/index.js';
import * as U from '../src/modules/studio/universal.js';

class ScriptedProvider implements ModelProvider {
  readonly name = 'anthropic';
  responders = new Map<string, (req: StructuredRequest<unknown>) => unknown>();
  requests: StructuredRequest<unknown>[] = [];
  async generateStructured<T>(req: StructuredRequest<T>): Promise<ProviderOutcome<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    const r = this.responders.get(req.system);
    if (!r) throw new Error('no scripted response');
    return { kind: 'ok', output: r(req as StructuredRequest<unknown>) as T, servedBy: 'claude-opus-5-5', usage: { inputTokens: 400, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', requestId: 'req_u' };
  }
}

const server = new FixtureServer();
let h: CoreHarness;
let provider: ScriptedProvider;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

const PLAN = {
  language: 'en',
  objective: 'engagement',
  audience: 'Home baristas who want better coffee without expensive gear',
  pillars: [
    { key: 'how_to', name: 'How-to', description: 'Practical brewing tips' },
    { key: 'product', name: 'Product facts', description: 'What the beans and grinder actually do' },
  ],
  platforms: ['facebook'],
  postsPerWeek: 3,
  destinationUrl: 'https://acme-coffee.example/shop',
  cta: 'See this week’s roast',
  hashtags: ['#coffee'],
} as const;

async function brandWithPage(slug: string, name: string, pageId: string, withClaim: string | null) {
  const ev = await tx((t) =>
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
  const product = await tx((t) => knowledge.upsertEntity(t, h.deps, h.tenantId, h.users.owner, { kind: 'product', key: `${slug}.main`, name, attributes: {}, evidenceId: ev.evidenceId }));
  let claimId: string | null = null;
  if (withClaim) {
    const c = await tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text: withClaim, claimType: 'product_capability', evidenceIds: [ev.evidenceId], entityIds: [product.id] }));
    await tx((t) => knowledge.reviewClaim(t, h.tenantId, h.users.legal, c.id, 'approved'));
    claimId = c.id;
  }
  const conn = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: pageId, displayName: `${name} Page`, grantedScopes: ['pages_manage_posts', 'pages_read_engagement'], credentials: { accessToken: `PAGE_${pageId}` } });
  const brand = await tx((t) =>
    createBrand(t, h.tenantId, h.users.owner, {
      slug,
      name,
      productEntityIds: [product.id],
      profile: { voice: { tone: ['warm'], dontSay: ['guaranteed'] }, destinations: [{ kind: 'website', url: 'https://acme-coffee.example/shop' }] },
    }),
  );
  await tx((t) => bindChannel(t, h.tenantId, h.users.owner, brand.id, conn.id));
  return { brand, conn, claimId, evidenceId: ev.evidenceId };
}

let acme: Awaited<ReturnType<typeof brandWithPage>>;
let bolt: Awaited<ReturnType<typeof brandWithPage>>;
let acmeProgram: typeof studioPrograms.$inferSelect;

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  await seedModelRegistry(h.t.handle.db);
  await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'anthropic', modelId: 'claude-opus-5-5', trainingOnCustomerData: 'no', dataRetentionTerms: 'reviewed', inputUsdPerMtok: 4, outputUsdPerMtok: 20 });
  clearModelCache();
  provider = new ScriptedProvider();
  h.deps.models = createModelGateway(h.deps, { anthropic: provider });
  await approveJurisdictionPacks(h.t.handle.db, h.tenantId, h.users.owner, 'US', JURISDICTION_DOMAIN_KEYS);
  await tx((t) =>
    setTenantPolicy(t, h.tenantId, h.users.owner, {
      configured: true,
      currency: 'USD',
      approvedJurisdictions: ['US'],
      categories: { PUBLIC_PUBLISHING: { autonomy: 'approval_required', approverRoles: ['approver'], requiresDistinctApprover: true, maxAudienceSize: null } },
    }),
  );
  acme = await brandWithPage('acme-coffee', 'Acme Coffee', '501', 'Acme Coffee beans are roasted every Monday');
  bolt = await brandWithPage('bolt-bikes', 'Bolt Bikes', '502', null);
}, 180_000);
afterAll(async () => {
  await h?.close();
  await server.stop();
});
beforeEach(() => {
  server.reset();
  provider.responders.clear();
});

describe('campaign identities: programs never collide (P3-01)', () => {
  it('derives readable campaign bases', () => {
    expect(campaignBase('acme-coffee', 'Weekly tips!')).toBe('acme_coffee_weekly_tips');
    expect(campaignBase('eps-topik-bn', 'daily')).toBe('eps_topik_bn_daily');
    expect(campaignBase('x')).toBe('program_x');
    expect(campaignBase('a'.repeat(60)).length).toBe(34);
  });

  it('gives a second curriculum program its own campaign instead of eps_daily, and refuses an explicit clash with a free alternative', async () => {
    const eps = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: '601', displayName: 'EPS Page', grantedScopes: [], credentials: { accessToken: 'P601' } });
    const legacy = await tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: eps.id, pack: 'eps-topik-bn', settings: { appCtaPerWeek: 2, linkPerWeek: 1, campaign: 'eps_daily', campaignIdentity: 'shared' } }));
    expect(legacy.settings).toMatchObject({ campaign: 'eps_daily', campaignIdentity: 'shared' });
    // Saving the legacy program again without a campaign keeps its historical shared campaign.
    const again = await tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: eps.id, pack: 'eps-topik-bn', status: 'paused' }));
    expect(again.settings).toMatchObject({ campaign: 'eps_daily', campaignIdentity: 'shared' });

    const second = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: '602', displayName: 'Second Page', grantedScopes: [], credentials: { accessToken: 'P602' } });
    const p2 = await tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: second.id, pack: 'eps-topik-bn' }));
    expect(p2.settings).toMatchObject({ campaign: 'eps_topik_bn_daily', campaignIdentity: 'per_post' });
    await expect(tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: second.id, pack: 'eps-topik-bn', settings: { appCtaPerWeek: 2, linkPerWeek: 1, campaign: 'eps_daily' } }))).rejects.toThrow(/already used by another program.*for example "eps_daily_2"/);
    const third = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: '603', displayName: 'Third Page', grantedScopes: [], credentials: { accessToken: 'P603' } });
    const p3 = await tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: third.id, pack: 'eps-topik-bn' }));
    expect(p3.settings).toMatchObject({ campaign: 'eps_topik_bn_daily_2' });
  });

  it('runs two brands with independent general programs, distinct campaigns and no shared items', async () => {
    acmeProgram = await tx((t) => U.upsertGeneralProgram(t, h.tenantId, h.users.operator, { kind: 'general', brandId: acme.brand.id, connectionId: acme.conn.id, name: 'Weekly tips', plan: PLAN }));
    const boltProgram = await tx((t) => U.upsertGeneralProgram(t, h.tenantId, h.users.operator, { kind: 'general', brandId: bolt.brand.id, connectionId: bolt.conn.id, name: 'Weekly tips', plan: { ...PLAN, destinationUrl: null, audience: 'Commuters' } }));
    expect(acmeProgram.settings).toMatchObject({ campaign: 'acme_coffee_weekly_tips', campaignIdentity: 'per_post' });
    expect(boltProgram.settings).toMatchObject({ campaign: 'bolt_bikes_weekly_tips' });
    await expect(tx((t) => U.upsertGeneralProgram(t, h.tenantId, h.users.operator, { kind: 'general', brandId: bolt.brand.id, connectionId: bolt.conn.id, name: 'Weekly tips', plan: PLAN, settings: { campaign: 'acme_coffee_weekly_tips' } }))).rejects.toThrow(/already used/);
    // The brand destination must be the brand's own, and the channel must be the brand's.
    await expect(tx((t) => U.upsertGeneralProgram(t, h.tenantId, h.users.operator, { kind: 'general', brandId: bolt.brand.id, connectionId: acme.conn.id, name: 'Wrong', plan: PLAN }))).rejects.toThrow(/link the program's channel/);
    await expect(tx((t) => U.upsertGeneralProgram(t, h.tenantId, h.users.operator, { kind: 'general', brandId: acme.brand.id, connectionId: acme.conn.id, name: 'X', plan: { ...PLAN, platforms: ['linkedin'] } }))).rejects.toThrow(/no connected channel for: linkedin/);
    // A general program is not treated as a curriculum program by the Autopilot.
    expect(await tx((t) => (async () => (await import('../src/modules/studio/index.js')).programForConnection(t, acme.conn.id))())).toBeNull();

    await tx((t) => U.addIdea(t, h.tenantId, h.users.operator, boltProgram.id, { title: 'Chain care in 60 seconds', pillar: 'how_to', platform: 'facebook', angle: 'A clean chain lasts longer and shifts better.' }));
    const programs = await tx((t) => U.listGeneralPrograms(t));
    expect(programs.map((p) => [p.name, p.stages])).toEqual(expect.arrayContaining([['Weekly tips', { idea: 1 }]]));
    expect(await tx((t) => U.listItems(t, acmeProgram.id))).toHaveLength(0);
  });
});

describe('Universal Studio pipeline for a non-EPS business', () => {
  it('generates grounded ideas: uncited facts and unknown pillars are dropped, not repaired', async () => {
    provider.responders.set(PROMPTS.studioIdeas.system, (req) => {
      const material = JSON.parse(req.messages[0]!.content) as { approvedClaims: { id: string; text: string }[]; program: { pillars: { key: string }[] } };
      expect(material.approvedClaims.map((c) => c.text)).toEqual(['Acme Coffee beans are roasted every Monday']);
      expect(material.program.pillars.map((p) => p.key)).toEqual(['how_to', 'product']);
      return {
        abstain: false,
        abstainReason: null,
        ideas: [
          {
            title: 'Why Monday roasting matters',
            pillar: 'product',
            platform: 'facebook',
            angle: 'Fresh roast dates explain the flavour difference home brewers notice.',
            hook: 'Roasted Monday, in your cup by Thursday.',
            rationale: 'Engagement through a concrete, true fact.',
            evidenceIds: [acme.evidenceId],
            claimIds: [acme.claimId!],
          },
          { title: 'Our beans win awards', pillar: 'product', platform: 'facebook', angle: 'Award-winning beans for every brewer at home.', hook: 'Award winners.', rationale: 'Bold claim.', evidenceIds: [], claimIds: [randomUUID()] },
          { title: 'Latte art', pillar: 'memes', platform: 'facebook', angle: 'Fun latte art fails from the team.', hook: 'Oops.', rationale: 'Light-hearted team content.', evidenceIds: [], claimIds: [] },
        ],
      };
    });
    const out = await U.generateIdeas(h.deps, h.tenantId, h.users.operator, acmeProgram.id, { count: 3 });
    expect(out, JSON.stringify(out)).toMatchObject({ status: 'created' });
    if (out.status !== 'created') return;
    expect(out.items.map((i) => i.title)).toEqual(['Why Monday roasting matters']);
    expect(out.dropped).toEqual([
      { title: 'Our beans win awards', reason: 'cites a claim that is not an approved brand claim' },
      { title: 'Latte art', reason: 'unknown pillar memes' },
    ]);
    expect(out.items[0]).toMatchObject({ stage: 'idea', origin: 'ai', provenance: { model: 'claude-opus-5-5', prompt: { name: 'studio.ideas' } } });
  });

  it('abstains without an approved model instead of inventing ideas', async () => {
    const saved = h.deps.models;
    h.deps.models = undefined;
    try {
      expect(await U.generateIdeas(h.deps, h.tenantId, h.users.operator, acmeProgram.id, { count: 2 })).toMatchObject({ status: 'abstained', reason: 'MODEL_UNAVAILABLE' });
    } finally {
      h.deps.models = saved;
    }
  });

  it('briefs, drafts, validates, approves with four eyes, publishes through M23 and verifies by read-back', async () => {
    const [item] = await tx((t) => U.listItems(t, acmeProgram.id, { stages: ['idea'] }));
    // Brief: only the brand's approved claims; the destination carries the per-post campaign.
    await expect(tx((t) => U.writeBrief(t, h.deps, h.tenantId, h.users.operator, item!.id, { claimIds: [randomUUID()] }))).rejects.toThrow(/claims not usable/);
    const briefed = await tx((t) => U.writeBrief(t, h.deps, h.tenantId, h.users.operator, item!.id, {}));
    expect(briefed.stage).toBe('brief');
    expect(briefed.campaign).toMatch(/^acme_coffee_weekly_tips_\d{6}_[0-9a-f]{4}$/);
    const brief = briefed.brief as { destination: string; claimIds: string[] };
    expect(new URL(brief.destination).searchParams.get('utm_campaign')).toBe(briefed.campaign);
    expect(brief.claimIds).toEqual([acme.claimId]);

    // AI draft with an unsupported superlative: validation keeps it in draft with the reason.
    provider.responders.set(PROMPTS.studioDraft.system, () => ({ abstain: false, abstainReason: null, caption: 'The best coffee in town, guaranteed. Acme Coffee beans are roasted every Monday.', hashtags: ['#coffee', 'not a tag'] }));
    const drafted = await U.draftItem(h.deps, h.tenantId, h.users.operator, item!.id, {});
    expect(drafted).toMatchObject({ stage: 'draft', draft: { origin: 'ai', hashtags: ['#coffee'] } });
    const failed = await tx((t) => U.validateItem(t, h.deps, h.tenantId, h.users.operator, item!.id));
    expect(failed.stage).toBe('draft');
    const problems = (failed.validation as { problems: string[] }).problems.join(' | ');
    expect(problems).toMatch(/UNSUBSTANTIATED/);
    expect(problems).toMatch(/never says: “guaranteed”/);

    // A person rewrites it; validation passes.
    await U.draftItem(h.deps, h.tenantId, h.users.operator, item!.id, { caption: 'Acme Coffee beans are roasted every Monday, so the bag you open this week is fresh.' });
    const ok = await tx((t) => U.validateItem(t, h.deps, h.tenantId, h.users.operator, item!.id));
    expect(ok).toMatchObject({ stage: 'validated', validation: { passed: true } });
    const preview = await tx((t) => U.itemPreview(t, item!.id));
    expect(preview.text).toContain('utm_campaign=acme_coffee_weekly_tips_');
    expect(preview.fit).toMatchObject({ ok: true });

    // Four eyes: the operator who drafted it cannot approve; another reviewer can.
    await expect(tx((t) => U.approveItem(t, h.deps, h.tenantId, h.users.operator, item!.id))).rejects.toThrow(/someone other than/);
    const approved = await tx((t) => U.approveItem(t, h.deps, h.tenantId, h.users.approver, item!.id));
    expect(approved).toMatchObject({ stage: 'approved', approvedBy: `user:${h.users.approver.id}` });

    const at = new Date(h.clock.now().getTime() + 30 * 60_000).toISOString();
    const scheduled = await tx((t) => U.scheduleItem(t, h.deps, h.tenantId, h.users.operator, item!.id, { scheduledAt: at, geographies: ['US'] }));
    expect(scheduled.stage).toBe('scheduled');
    expect(await U.syncProgramItems(h.deps, h.tenantId, acmeProgram.id)).toEqual({ verified: 0, failed: 0, measured: 0, learned: 0 });

    // Publish through M23 against the Meta fixture; verified only after read-back.
    h.clock.advance(45 * 60_000);
    let message = '';
    server.on('POST', '/v26.0/501/feed', (req) => {
      message = req.form!.get('message')!;
      return { json: { id: '501_9' } };
    });
    server.on('GET', /^\/v26\.0\/501_9$/, () => ({ json: { id: '501_9', message, is_published: true, permalink_url: 'https://fb.example/501_9' } }));
    const dispatched = (await social.dispatchDuePosts(h.deps, h.tenantId)).find((d) => d.postId === scheduled.postId)!;
    expect(dispatched.status).toBe('APPROVAL_REQUIRED');
    const [a] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, dispatched.actionId)));
    await decideApproval(h.deps, h.tenantId, h.users.approver, a!.id, { decision: 'approved', expectedActionHash: a!.actionHash });
    await executeAction(h.deps, h.tenantId, a!.id);
    expect(await U.syncProgramItems(h.deps, h.tenantId, acmeProgram.id)).toMatchObject({ verified: 0 });
    expect((await tx((t) => t.select().from(studioContentItems).where(eq(studioContentItems.id, item!.id))))[0]!.stage).toBe('published');
    expect(await verifyAction(h.deps, h.tenantId, a!.id)).toMatchObject({ status: 'VERIFIED' });
    expect(message).toContain('utm_campaign=acme_coffee_weekly_tips_');
    expect(await U.syncProgramItems(h.deps, h.tenantId, acmeProgram.id)).toMatchObject({ verified: 1 });
    const [row] = await tx((t) => t.select().from(studioContentItems).where(eq(studioContentItems.id, item!.id)));
    expect(row).toMatchObject({ stage: 'verified', metrics: { url: 'https://fb.example/501_9' } });
    const [post] = await tx((t) => t.select().from(socialPosts).where(eq(socialPosts.id, scheduled.postId!)));
    expect(post!.disclosure).toMatchObject({ isAiGenerated: false, studio: { programId: acmeProgram.id, itemId: item!.id } });

    // No results observed yet: stays verified (unknown, never zero), and insights say "not enough data".
    h.clock.advance(4 * 86_400_000);
    expect(await U.syncProgramItems(h.deps, h.tenantId, acmeProgram.id)).toMatchObject({ measured: 0 });
    expect(await tx((t) => U.programInsights(t, acmeProgram.id))).toEqual([]);
  });

  it('rejects stage skips and keeps tenants apart', async () => {
    const idea = await tx((t) => U.addIdea(t, h.tenantId, h.users.operator, acmeProgram.id, { title: 'Grind size basics', pillar: 'how_to', platform: 'facebook', angle: 'Grind size changes extraction more than people think.' }));
    await expect(tx((t) => U.approveItem(t, h.deps, h.tenantId, h.users.approver, idea.id))).rejects.toThrow(/idea; it cannot move to approved/);
    await expect(tx((t) => U.scheduleItem(t, h.deps, h.tenantId, h.users.operator, idea.id, { scheduledAt: h.clock.now().toISOString() }))).rejects.toThrow(/cannot move to scheduled/);
    await expect(tx((t) => U.addIdea(t, h.tenantId, h.users.analyst, acmeProgram.id, { title: 'x', pillar: 'how_to', platform: 'facebook', angle: 'not allowed for analysts' }))).rejects.toThrow(/roles/);
    const other = await createCoreHarness({ tenantSlug: 'studio-other' });
    try {
      const seen = await withTenant(other.t.handle.db, { tenantId: other.tenantId, actor: 'user:o' }, (t) => U.listItems(t, acmeProgram.id));
      expect(seen).toEqual([]);
      await expect(withTenant(other.t.handle.db, { tenantId: other.tenantId, actor: 'user:o' }, (t) => U.writeBrief(t, other.deps, other.tenantId, other.users.operator, idea.id, {}))).rejects.toThrow(/not found/);
    } finally {
      await other.close();
    }
  });
});
