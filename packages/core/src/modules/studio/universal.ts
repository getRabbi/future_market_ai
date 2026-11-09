import { PROMPTS } from '@futuregrow/agent-kernel';
import { brandChannels, brands, claims, connections, type DbOrTx, evidenceRecords, kgEntities, socialPosts, studioContentItems, studioPrograms, type Tx, withTenant } from '@futuregrow/db';
import { conflict, forbidden, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { runAgent } from '../../agents.js';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, requireRole } from '../../util.js';
import { BRAND_OBJECTIVES, BrandProfileSchema } from '../brands/index.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { checkCaption, postResults, schedulePost } from '../m16-social/index.js';
import { PLATFORM_FORMATS, type SocialPlatform } from '../m16-social/platforms.js';
import { effectiveFreshness } from '../m23-execution/facts.js';
import { campaignBase, resolveProgramCampaign } from './campaigns.js';

/**
 * Universal Content Studio (P3-01). A general program publishes for one brand of any business:
 * content pillars, platforms, cadence, language and an objective. Each piece of content is a
 * persistent item that moves through research → idea → brief → create → validate → approve →
 * schedule → publish → verify → measure → learn. Ideas and drafts may come from the approved
 * model gateway (grounded only in the brand's approved claims and admitted evidence) or from a
 * person; validation is deterministic (claims, brand rules, platform limits, destination); a
 * different person approves; publishing goes through M16/M23 and an item counts as published
 * only once the post is verified by read-back. Curriculum (EPS) programs are untouched.
 */

const EDIT_ROLES = ['owner', 'admin', 'growth_operator'] as const;
const REVIEW_ROLES = ['owner', 'admin', 'approver', 'growth_operator'] as const;
const GENERAL_PACK = 'general';
const MEASURE_AFTER_DAYS = 3;
const MIN_LEARN_SAMPLE = 3;
const DAY = 86_400_000;

/** Platforms a general program can plan for, and the connection provider that publishes each. */
export const STUDIO_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok'] as const satisfies readonly SocialPlatform[];
type StudioPlatform = (typeof STUDIO_PLATFORMS)[number];
const PROVIDER: Record<StudioPlatform, string> = { facebook: 'meta', instagram: 'meta', linkedin: 'linkedin', x: 'x', youtube: 'youtube', tiktok: 'tiktok' };

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const PillarSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{2,32}$/, 'lower-case letters, digits and underscores'),
    name: shortText(80),
    description: z.string().trim().max(500).default(''),
  })
  .strict();

export const GeneralPlanSchema = z
  .object({
    language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'BCP 47 language, e.g. en or bn'),
    objective: z.enum(BRAND_OBJECTIVES),
    audience: z.string().trim().max(1000).default(''),
    pillars: z.array(PillarSchema).min(1).max(8),
    platforms: z.array(z.enum(STUDIO_PLATFORMS)).min(1).max(STUDIO_PLATFORMS.length),
    postsPerWeek: z.number().int().min(1).max(14).default(3),
    /** https destination the call to action links to (must be one of the brand's destinations). */
    destinationUrl: z.string().url().startsWith('https://').max(500).nullable().default(null),
    cta: z.string().trim().max(120).default(''),
    hashtags: z
      .array(z.string().regex(/^#[\p{L}\p{N}_]{1,60}$/u))
      .max(10)
      .default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const keys = p.pillars.map((x) => x.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['pillars'], message: 'pillar keys must be unique' });
    if (new Set(p.platforms).size !== p.platforms.length) ctx.addIssue({ code: 'custom', path: ['platforms'], message: 'list each platform once' });
  });
export type GeneralPlan = z.infer<typeof GeneralPlanSchema>;

export const GeneralProgramInputSchema = z
  .object({
    kind: z.literal('general'),
    brandId: z.string().uuid(),
    /** The brand channel the program is anchored to; other platforms use the brand's other channels. */
    connectionId: z.string().uuid(),
    name: shortText(120),
    status: z.enum(['active', 'paused']).default('active'),
    plan: GeneralPlanSchema,
    settings: z
      .object({
        campaign: z
          .string()
          .regex(/^[a-z0-9_]{3,40}$/)
          .optional(),
        campaignIdentity: z.enum(['shared', 'per_post']).default('per_post'),
      })
      .strict()
      .default({ campaignIdentity: 'per_post' }),
  })
  .strict();

type ProgramRow = typeof studioPrograms.$inferSelect;
type ItemRow = typeof studioContentItems.$inferSelect;
type Stage = ItemRow['stage'];

/** Allowed stage changes. A rejected item can return to brief; a failed post can be retried from approved. */
export const STAGE_TRANSITIONS: Record<string, readonly string[]> = {
  idea: ['brief', 'rejected'],
  brief: ['draft', 'rejected'],
  draft: ['draft', 'validated', 'rejected'],
  validated: ['draft', 'approved', 'rejected'],
  approved: ['draft', 'scheduled', 'rejected'],
  scheduled: ['published', 'verified', 'failed'],
  published: ['verified', 'failed'],
  verified: ['measured'],
  measured: ['learned'],
  learned: [],
  rejected: ['brief'],
  failed: ['approved', 'rejected'],
};

function transition(item: ItemRow, to: Stage) {
  if (!(STAGE_TRANSITIONS[item.stage] ?? []).includes(to)) throw conflict(`content item is ${item.stage}; it cannot move to ${to}`);
}

async function loadItem(t: DbOrTx, itemId: string): Promise<ItemRow> {
  const [item] = await t.select().from(studioContentItems).where(eq(studioContentItems.id, itemId));
  if (!item) throw notFound('content item');
  return item;
}

async function loadProgram(t: DbOrTx, programId: string): Promise<ProgramRow & { generalPlan: GeneralPlan }> {
  const [p] = await t.select().from(studioPrograms).where(eq(studioPrograms.id, programId));
  if (!p) throw notFound('content program');
  if (p.kind !== 'general') throw invalid('this is a curriculum program; it is managed in the Content studio');
  return { ...p, generalPlan: GeneralPlanSchema.parse(p.plan) };
}

async function update(t: Tx, tenantId: string, actor: Actor, item: ItemRow, patch: Partial<typeof studioContentItems.$inferInsert>, event: string, detail: Record<string, unknown> = {}): Promise<ItemRow> {
  const [row] = await t
    .update(studioContentItems)
    .set({ ...patch, updatedBy: actorRef(actor), updatedAt: new Date(), version: item.version + 1 })
    .where(and(eq(studioContentItems.id, item.id), eq(studioContentItems.version, item.version)))
    .returning();
  if (!row) throw conflict('the content item changed in the meantime; reload and try again');
  await audit(t, tenantId, actor, event, { type: 'studio_content_item', id: item.id }, { programId: item.programId, from: item.stage, to: row.stage, ...detail });
  return row;
}

/* ------------------------------------------------------------------ */
/* Programs                                                            */
/* ------------------------------------------------------------------ */

/** Connections bound to the brand, by platform (Instagram needs a recorded igUserId on the Meta Page connection). */
async function brandPlatformConnections(t: DbOrTx, brandId: string): Promise<Partial<Record<StudioPlatform, string>>> {
  const rows = await t.select({ id: connections.id, provider: connections.provider, metadata: connections.metadata, status: connections.status }).from(brandChannels).innerJoin(connections, eq(connections.id, brandChannels.connectionId)).where(eq(brandChannels.brandId, brandId));
  const out: Partial<Record<StudioPlatform, string>> = {};
  for (const platform of STUDIO_PLATFORMS) {
    const c = rows.find((r) => r.provider === PROVIDER[platform] && r.status !== 'revoked' && (platform !== 'instagram' || typeof (r.metadata as { igUserId?: unknown }).igUserId === 'string'));
    if (c) out[platform] = c.id;
  }
  return out;
}

export async function upsertGeneralProgram(t: Tx, tenantId: string, actor: Actor, raw: unknown): Promise<ProgramRow> {
  requireRole(actor, [...EDIT_ROLES], 'configuring a content program');
  const input = GeneralProgramInputSchema.parse(raw);
  const [brand] = await t.select().from(brands).where(eq(brands.id, input.brandId));
  if (!brand) throw notFound('brand');
  const [channel] = await t.select().from(brandChannels).where(eq(brandChannels.connectionId, input.connectionId));
  if (!channel || channel.brandId !== input.brandId) throw conflict("link the program's channel account to this brand first (Brands & channels)");
  const reachable = await brandPlatformConnections(t, input.brandId);
  const missing = input.plan.platforms.filter((p) => !reachable[p]);
  if (missing.length) throw invalid(`the brand has no connected channel for: ${missing.join(', ')}. Link those accounts to the brand, or remove the platforms.`);
  if (input.plan.destinationUrl) {
    const profile = BrandProfileSchema.parse(brand.profile ?? {});
    if (!profile.destinations.some((d) => d.url === input.plan.destinationUrl)) throw invalid("the destination must be one of the brand's destinations (Brands › profile)");
  }
  const [current] = await t.select().from(studioPrograms).where(eq(studioPrograms.connectionId, input.connectionId));
  if (current && current.kind !== 'general') throw conflict('this channel already runs a curriculum program; pause it in the Content studio or use another channel');
  if (current && current.brandId !== input.brandId) throw conflict('this channel’s program belongs to another brand');
  const campaign = await resolveProgramCampaign(t, {
    requested: input.settings.campaign,
    current: current ? ((current.settings as { campaign?: string }).campaign ?? null) : null,
    connectionId: input.connectionId,
    base: campaignBase(brand.slug, input.name),
  });
  const settings = { campaign, campaignIdentity: input.settings.campaignIdentity };
  const [row] = await t
    .insert(studioPrograms)
    .values({ tenantId, connectionId: input.connectionId, pack: GENERAL_PACK, kind: 'general', name: input.name, plan: input.plan, status: input.status, settings, brandId: input.brandId, createdBy: actorRef(actor) })
    .onConflictDoUpdate({ target: [studioPrograms.tenantId, studioPrograms.connectionId], set: { name: input.name, plan: input.plan, status: input.status, settings, updatedBy: actorRef(actor), updatedAt: new Date() } })
    .returning();
  await audit(t, tenantId, actor, 'studio.general_program.saved', { type: 'studio_program', id: row!.id }, { brandId: input.brandId, connectionId: input.connectionId, name: input.name, platforms: input.plan.platforms, pillars: input.plan.pillars.map((p) => p.key), campaign });
  return row!;
}

export async function listGeneralPrograms(t: DbOrTx) {
  const rows = await t.select().from(studioPrograms).where(eq(studioPrograms.kind, 'general')).orderBy(desc(studioPrograms.createdAt));
  const counts = rows.length
    ? await t
        .select({ programId: studioContentItems.programId, stage: studioContentItems.stage })
        .from(studioContentItems)
        .where(
          inArray(
            studioContentItems.programId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return rows.map((r) => {
    const stages: Record<string, number> = {};
    for (const c of counts.filter((x) => x.programId === r.id)) stages[c.stage] = (stages[c.stage] ?? 0) + 1;
    return { ...r, stages };
  });
}

/* ------------------------------------------------------------------ */
/* Research: the brand's grounded material                              */
/* ------------------------------------------------------------------ */

export interface GroundedMaterial {
  brand: { id: string; name: string; slug: string; profile: ReturnType<typeof BrandProfileSchema.parse> };
  claims: { id: string; text: string }[];
  evidence: { id: string; summary: string; kind: string }[];
  recentTitles: string[];
  insights: PillarInsight[];
}

/**
 * Research stage: approved, unexpired, non-regulated claims about the brand's products and the
 * admitted, fresh evidence behind them. Nothing else may be stated as fact by an idea or draft.
 */
export async function groundedMaterial(t: DbOrTx, program: ProgramRow, now: Date): Promise<GroundedMaterial> {
  const [brand] = await t.select().from(brands).where(eq(brands.id, program.brandId!));
  if (!brand) throw notFound('brand');
  const entityIds = brand.productEntityIds;
  const entities = entityIds.length
    ? await t
        .select({ id: kgEntities.id, evidenceId: kgEntities.evidenceId })
        .from(kgEntities)
        .where(and(inArray(kgEntities.id, entityIds), eq(kgEntities.status, 'active')))
    : [];
  const brandClaims = entityIds.length ? (await t.select().from(claims).where(eq(claims.status, 'approved'))).filter((c) => !c.regulated && (!c.expiresAt || c.expiresAt > now) && c.entityIds.some((id) => entityIds.includes(id))) : [];
  const evIds = [...new Set([...entities.map((e) => e.evidenceId).filter((x): x is string => Boolean(x)), ...brandClaims.flatMap((c) => c.evidenceIds)])];
  const ev = evIds.length ? (await t.select().from(evidenceRecords).where(inArray(evidenceRecords.id, evIds))).filter((e) => e.status === 'admitted' && effectiveFreshness(e, now) !== 'stale') : [];
  const recent = await t.select({ title: studioContentItems.title }).from(studioContentItems).where(eq(studioContentItems.programId, program.id)).orderBy(desc(studioContentItems.createdAt)).limit(30);
  return {
    brand: { id: brand.id, name: brand.name, slug: brand.slug, profile: BrandProfileSchema.parse(brand.profile ?? {}) },
    claims: brandClaims.map((c) => ({ id: c.id, text: c.text })),
    evidence: ev.map((e) => ({ id: e.id, summary: clipText(e.summary ?? e.kind, 300), kind: e.kind })),
    recentTitles: recent.map((r) => r.title),
    insights: await programInsights(t, program.id),
  };
}

/* ------------------------------------------------------------------ */
/* Ideas (AI-assisted or manual)                                        */
/* ------------------------------------------------------------------ */

const IdeaOutputSchema = z.object({
  abstain: z.boolean(),
  abstainReason: z.string().max(500).nullable(),
  ideas: z
    .array(
      z.object({
        title: z.string().min(3).max(140),
        pillar: z.string().max(32),
        platform: z.string().max(20),
        angle: z.string().min(10).max(800),
        hook: z.string().min(3).max(240),
        rationale: z.string().min(10).max(800),
        evidenceIds: z.array(z.string()).max(10),
        claimIds: z.array(z.string()).max(10),
      }),
    )
    .max(10),
});

export const ManualIdeaSchema = z
  .object({
    title: shortText(140),
    pillar: z.string().min(2).max(32),
    platform: z.enum(STUDIO_PLATFORMS),
    angle: z.string().trim().min(10).max(800),
    hook: z.string().trim().max(240).default(''),
    claimIds: z.array(z.string().uuid()).max(10).default([]),
  })
  .strict();

async function insertIdea(
  t: Tx,
  tenantId: string,
  actor: Actor,
  program: ProgramRow & { generalPlan: GeneralPlan },
  idea: { title: string; pillar: string; platform: StudioPlatform; angle: string; hook: string; rationale?: string; evidenceIds: string[]; claimIds: string[] },
  origin: 'ai' | 'manual',
  provenance: Record<string, unknown>,
) {
  const reachable = await brandPlatformConnections(t, program.brandId!);
  const connectionId = reachable[idea.platform];
  if (!connectionId) throw invalid(`the brand has no connected ${idea.platform} channel`);
  const [row] = await t
    .insert(studioContentItems)
    .values({
      tenantId,
      programId: program.id,
      brandId: program.brandId!,
      stage: 'idea',
      pillar: idea.pillar,
      platform: idea.platform,
      connectionId,
      title: idea.title,
      origin,
      idea: { angle: idea.angle, hook: idea.hook, rationale: idea.rationale ?? null, evidenceIds: idea.evidenceIds, claimIds: idea.claimIds },
      provenance,
      createdBy: actorRef(actor),
    })
    .returning();
  await audit(t, tenantId, actor, 'studio.item.idea_added', { type: 'studio_content_item', id: row!.id }, { programId: program.id, origin, pillar: idea.pillar, platform: idea.platform });
  return row!;
}

export async function addIdea(t: Tx, tenantId: string, actor: Actor, programId: string, raw: unknown) {
  requireRole(actor, [...EDIT_ROLES], 'adding content ideas');
  const input = ManualIdeaSchema.parse(raw);
  const program = await loadProgram(t, programId);
  if (!program.generalPlan.pillars.some((p) => p.key === input.pillar)) throw invalid(`unknown pillar ${input.pillar}`);
  if (!program.generalPlan.platforms.includes(input.platform)) throw invalid(`the program does not plan for ${input.platform}`);
  return insertIdea(t, tenantId, actor, program, { ...input, evidenceIds: [] }, 'manual', { author: actorRef(actor) });
}

export const IdeaRequestSchema = z.object({ count: z.number().int().min(1).max(10).default(5), pillar: z.string().max(32).optional() }).strict();

export type IdeaOutcome = { status: 'created'; items: ItemRow[]; dropped: { title: string; reason: string }[]; runId: string } | { status: 'abstained'; reason: string; runId: string | null };

/**
 * AI-assisted idea generation through the approved model gateway (registry, per-tenant AI spending
 * limit and kill switches all apply). Ideas citing an ID that was not provided, an unknown pillar
 * or a platform outside the program are dropped and reported, never repaired.
 */
export async function generateIdeas(deps: CoreDeps, tenantId: string, actor: Actor, programId: string, raw: unknown): Promise<IdeaOutcome> {
  requireRole(actor, [...EDIT_ROLES], 'generating content ideas');
  const req = IdeaRequestSchema.parse(raw ?? {});
  const now = deps.clock.now();
  const { program, material } = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const program = await loadProgram(t, programId);
    return { program, material: await groundedMaterial(t, program, now) };
  });
  if (program.status !== 'active') return { status: 'abstained', reason: 'the program is paused', runId: null };
  const pillars = req.pillar ? program.generalPlan.pillars.filter((p) => p.key === req.pillar) : program.generalPlan.pillars;
  if (!pillars.length) throw invalid(`unknown pillar ${req.pillar}`);
  const input = {
    brand: { name: material.brand.name, voice: material.brand.profile.voice, audience: material.brand.profile.audience },
    program: { name: program.name, language: program.generalPlan.language, objective: program.generalPlan.objective, audience: program.generalPlan.audience, platforms: program.generalPlan.platforms, pillars },
    approvedClaims: material.claims,
    evidence: material.evidence,
    recentIdeas: material.recentTitles,
    whatWorked: material.insights.filter((i) => i.sufficient).map((i) => ({ pillar: i.pillar, posts: i.posts, meanEngagement: i.meanEngagement })),
    count: req.count,
  };
  const outcome = await runAgent(deps, tenantId, { kind: 'studio_ideas', agentId: 'universal-studio', triggeredBy: actorRef(actor), input: { programId, count: req.count, pillar: req.pillar ?? null } }, async (ctx) => {
    const r = await ctx.think('ideas', PROMPTS.studioIdeas, { purpose: 'generation', messages: [{ role: 'user', content: JSON.stringify(input) }], outputSchema: IdeaOutputSchema, maxTokens: 3000 });
    return { output: r.output, servedBy: r.servedBy, runId: ctx.runId };
  });
  if (outcome.status !== 'completed') return { status: 'abstained', reason: outcome.status === 'abstained' ? outcome.reason : outcome.error, runId: outcome.runId };
  const { output } = outcome.result;
  if (output.abstain || !output.ideas.length) return { status: 'abstained', reason: output.abstainReason ?? 'the model found no grounded idea', runId: outcome.runId };
  const claimIds = new Set(material.claims.map((c) => c.id));
  const evidenceIds = new Set(material.evidence.map((e) => e.id));
  const dropped: { title: string; reason: string }[] = [];
  const items = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const out: ItemRow[] = [];
    for (const idea of output.ideas.slice(0, req.count)) {
      const reason = !pillars.some((p) => p.key === idea.pillar)
        ? `unknown pillar ${idea.pillar}`
        : !program.generalPlan.platforms.includes(idea.platform as StudioPlatform)
          ? `platform ${idea.platform} is not in the program`
          : idea.claimIds.find((id) => !claimIds.has(id))
            ? 'cites a claim that is not an approved brand claim'
            : idea.evidenceIds.find((id) => !evidenceIds.has(id))
              ? 'cites evidence that was not provided'
              : material.recentTitles.some((x) => x.toLowerCase() === idea.title.toLowerCase())
                ? 'repeats a recent idea'
                : null;
      if (reason) {
        dropped.push({ title: idea.title, reason });
        continue;
      }
      out.push(await insertIdea(t, tenantId, actor, program, { ...idea, platform: idea.platform as StudioPlatform }, 'ai', { runId: outcome.runId, model: outcome.result.servedBy, prompt: { name: PROMPTS.studioIdeas.name, version: PROMPTS.studioIdeas.version, hash: PROMPTS.studioIdeas.hash } }));
    }
    return out;
  });
  return items.length ? { status: 'created', items, dropped, runId: outcome.runId } : { status: 'abstained', reason: `every proposed idea was dropped: ${dropped.map((d) => d.reason).join('; ')}`, runId: outcome.runId };
}

/* ------------------------------------------------------------------ */
/* Brief                                                               */
/* ------------------------------------------------------------------ */

export const BriefInputSchema = z
  .object({
    keyMessage: z.string().trim().min(10).max(600).optional(),
    claimIds: z.array(z.string().uuid()).max(10).optional(),
    cta: z.string().trim().max(120).optional(),
    useDestination: z.boolean().default(true),
  })
  .strict();

/** Tagged destination link: the item's campaign identity (per-post or shared) as UTM parameters. */
export function taggedDestination(url: string, campaign: string, content: string, platform: string): string {
  const u = new URL(url);
  u.searchParams.set('utm_source', platform);
  u.searchParams.set('utm_medium', 'organic_social');
  u.searchParams.set('utm_campaign', campaign);
  u.searchParams.set('utm_content', content);
  return u.toString();
}

const itemCampaign = (program: ProgramRow, item: ItemRow, now: Date) => {
  const s = program.settings as { campaign?: string; campaignIdentity?: string };
  const base = s.campaign ?? campaignBase('content');
  const day = now.toISOString().slice(2, 10).replaceAll('-', '');
  return s.campaignIdentity === 'shared' ? base : `${base}_${day}_${sha256Hex(item.id).slice(0, 4)}`;
};

/** Evidence-backed brief: objective, audience, key message, only approved brand claims, call to action and a tagged destination. */
export async function writeBrief(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, itemId: string, raw: unknown) {
  requireRole(actor, [...EDIT_ROLES], 'writing a content brief');
  const input = BriefInputSchema.parse(raw ?? {});
  const item = await loadItem(t, itemId);
  transition(item, 'brief');
  const program = await loadProgram(t, item.programId);
  const now = deps.clock.now();
  const material = await groundedMaterial(t, program, now);
  const idea = item.idea as { angle?: string; claimIds?: string[]; evidenceIds?: string[] };
  const claimIds = input.claimIds ?? idea.claimIds ?? [];
  const unknown = claimIds.filter((id) => !material.claims.some((c) => c.id === id));
  if (unknown.length) throw invalid(`claims not usable for this brand (not approved, expired, regulated or about another product): ${unknown.join(', ')}`);
  const campaign = itemCampaign(program, item, now);
  const destination = input.useDestination && program.generalPlan.destinationUrl ? taggedDestination(program.generalPlan.destinationUrl, campaign, item.id.slice(0, 8), item.platform) : null;
  const evidenceIds = [...new Set(idea.evidenceIds ?? [])];
  const brief = {
    objective: program.generalPlan.objective,
    audience: program.generalPlan.audience || material.brand.profile.audience.description,
    language: program.generalPlan.language,
    keyMessage: input.keyMessage ?? idea.angle ?? item.title,
    claims: material.claims.filter((c) => claimIds.includes(c.id)),
    claimIds,
    evidenceIds,
    voice: material.brand.profile.voice,
    cta: input.cta ?? program.generalPlan.cta,
    destination,
    hashtags: program.generalPlan.hashtags,
    format: PLATFORM_FORMATS[item.platform as StudioPlatform],
  };
  return update(t, tenantId, actor, item, { stage: 'brief', brief, campaign }, 'studio.item.briefed', { claimIds, campaign });
}

/* ------------------------------------------------------------------ */
/* Create: draft (AI or manual) and edit                                */
/* ------------------------------------------------------------------ */

const DraftOutputSchema = z.object({ abstain: z.boolean(), abstainReason: z.string().max(500).nullable(), caption: z.string().max(5000), hashtags: z.array(z.string().max(61)).max(30) });

export const DraftInputSchema = z
  .object({
    caption: z.string().trim().min(1).max(5000).optional(),
    hashtags: z
      .array(z.string().regex(/^#[\p{L}\p{N}_]{1,60}$/u))
      .max(30)
      .optional(),
    assetIds: z.array(z.string().uuid()).max(10).default([]),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

const composeCaption = (caption: string, hashtags: string[], cta: string, platform: string, destination: string | null) => {
  const parts = [caption.trim()];
  if (cta && !caption.includes(cta)) parts.push(cta);
  if (destination && PLATFORM_FORMATS[platform as StudioPlatform]?.links === 'clickable') parts.push(destination);
  if (hashtags.length) parts.push(hashtags.join(' '));
  return parts.join('\n\n');
};

/**
 * Create stage. With a caption the person wrote it (manual); without, the approved model drafts it
 * from the brief. Either way the draft is only a proposal until validation and approval.
 */
export async function draftItem(deps: CoreDeps, tenantId: string, actor: Actor, itemId: string, raw: unknown) {
  requireRole(actor, [...EDIT_ROLES], 'drafting content');
  const input = DraftInputSchema.parse(raw ?? {});
  const item = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (t) => loadItem(t, itemId));
  transition(item, 'draft');
  if (input.expectedVersion !== undefined && input.expectedVersion !== item.version) throw conflict('the content item changed in the meantime; reload and try again');
  const brief = item.brief as { cta?: string; destination?: string | null; hashtags?: string[]; format?: { caption?: { max: number } | null; maxHashtags?: number | null } };
  let caption = input.caption;
  let hashtags = input.hashtags ?? brief.hashtags ?? [];
  let provenance: Record<string, unknown> = { ...item.provenance, draft: { author: actorRef(actor) } };
  if (!caption) {
    const out = await runAgent(deps, tenantId, { kind: 'studio_draft', agentId: 'universal-studio', triggeredBy: actorRef(actor), input: { itemId } }, async (ctx) => {
      const r = await ctx.think('draft', PROMPTS.studioDraft, { purpose: 'generation', messages: [{ role: 'user', content: JSON.stringify({ title: item.title, platform: item.platform, brief }) }], outputSchema: DraftOutputSchema, maxTokens: 1500 });
      return { output: r.output, servedBy: r.servedBy, runId: ctx.runId };
    });
    if (out.status !== 'completed') throw invalid(`no AI draft (${out.status === 'abstained' ? out.reason : out.error}); write the caption yourself`);
    if (out.result.output.abstain || !out.result.output.caption.trim()) throw invalid(`the model abstained: ${out.result.output.abstainReason ?? 'not enough grounded material'}; write the caption yourself`);
    caption = out.result.output.caption;
    hashtags = input.hashtags ?? out.result.output.hashtags.filter((h) => /^#[\p{L}\p{N}_]{1,60}$/u.test(h));
    provenance = { ...item.provenance, draft: { runId: out.runId, model: out.result.servedBy, prompt: { name: PROMPTS.studioDraft.name, version: PROMPTS.studioDraft.version, hash: PROMPTS.studioDraft.hash } } };
  }
  const full = composeCaption(caption, hashtags, brief.cta ?? '', item.platform, brief.destination ?? null);
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const fresh = await loadItem(t, itemId);
    transition(fresh, 'draft');
    return update(t, tenantId, actor, fresh, { stage: 'draft', draft: { caption, hashtags, assetIds: input.assetIds, text: full, origin: input.caption ? 'manual' : 'ai' }, validation: {}, provenance, approvedBy: null, approvedAt: null }, 'studio.item.drafted', { origin: input.caption ? 'manual' : 'ai' });
  });
}

/* ------------------------------------------------------------------ */
/* Validate                                                            */
/* ------------------------------------------------------------------ */

export interface Validation {
  passed: boolean;
  problems: string[];
  warnings: string[];
  checkedAt: string;
}

export async function validateItem(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, itemId: string) {
  requireRole(actor, [...EDIT_ROLES], 'validating content');
  const item = await loadItem(t, itemId);
  transition(item, 'validated');
  const program = await loadProgram(t, item.programId);
  const now = deps.clock.now();
  const draft = item.draft as { text?: string; assetIds?: string[] };
  const brief = item.brief as { claimIds?: string[]; destination?: string | null; voice?: { dontSay?: string[] } };
  const text = draft.text ?? '';
  const problems: string[] = [];
  const warnings: string[] = [];
  const fit = checkCaption(item.platform as SocialPlatform, text, { link: brief.destination ?? null, images: draft.assetIds?.length ?? 0 });
  problems.push(...fit.problems);
  warnings.push(...fit.notes);
  const lint = await lintCopy(t, text, { claimIds: brief.claimIds ?? [], channel: item.platform, now });
  for (const v of lint.violations) (v.severity === 'block' ? problems : warnings).push(`${v.code}: ${v.message}${v.excerpt ? ` (“${clipText(v.excerpt, 80)}”)` : ''}`);
  const lower = text.toLowerCase();
  for (const phrase of brief.voice?.dontSay ?? []) if (lower.includes(phrase.toLowerCase())) problems.push(`uses a phrase the brand never says: “${phrase}”`);
  const material = await groundedMaterial(t, program, now);
  const stale = (brief.claimIds ?? []).filter((id) => !material.claims.some((c) => c.id === id));
  if (stale.length) problems.push(`claims no longer usable (expired, withdrawn or regulated): ${stale.join(', ')}`);
  if (PLATFORM_FORMATS[item.platform as StudioPlatform]?.needsVideo && !(draft.assetIds ?? []).length) problems.push(`${item.platform} needs a video: render one in the Video Studio and attach it`);
  const validation: Validation = { passed: problems.length === 0, problems, warnings, checkedAt: now.toISOString() };
  return update(t, tenantId, actor, item, { stage: validation.passed ? 'validated' : 'draft', validation: { ...validation } }, validation.passed ? 'studio.item.validated' : 'studio.item.validation_failed', { problems: problems.length });
}

/* ------------------------------------------------------------------ */
/* Approve / reject (four eyes)                                         */
/* ------------------------------------------------------------------ */

export async function approveItem(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, itemId: string) {
  requireRole(actor, [...REVIEW_ROLES], 'approving content');
  const item = await loadItem(t, itemId);
  transition(item, 'approved');
  const me = actorRef(actor);
  const draftAuthor = (item.provenance as { draft?: { author?: string } }).draft?.author;
  // The person who wrote or requested the content does not approve it.
  if (item.createdBy === me || draftAuthor === me || item.updatedBy === me) throw forbidden('content is approved by someone other than the person who created, drafted or validated it');
  if (!(item.validation as Partial<Validation>).passed) throw conflict('validate the draft first');
  return update(t, tenantId, actor, item, { stage: 'approved', approvedBy: me, approvedAt: deps.clock.now() }, 'studio.item.approved');
}

export async function rejectItem(t: Tx, tenantId: string, actor: Actor, itemId: string, reason: string) {
  requireRole(actor, [...REVIEW_ROLES], 'rejecting content');
  if (reason.trim().length < 3) throw invalid('say why the content is rejected');
  const item = await loadItem(t, itemId);
  transition(item, 'rejected');
  return update(t, tenantId, actor, item, { stage: 'rejected', statusReason: clipText(reason, 500) }, 'studio.item.rejected', { reason: clipText(reason, 200) });
}

/* ------------------------------------------------------------------ */
/* Schedule → publish (M16/M23) → verify → measure → learn              */
/* ------------------------------------------------------------------ */

export const ScheduleItemSchema = z.object({ scheduledAt: z.string().datetime({ offset: true }), geographies: z.array(z.string().min(2)).default([]) }).strict();

/** Hands the approved draft to M16; the post publishes only through M23 (policy, approvals, read-back). */
export async function scheduleItem(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, itemId: string, raw: unknown) {
  const input = ScheduleItemSchema.parse(raw);
  const item = await loadItem(t, itemId);
  transition(item, 'scheduled');
  if (!item.approvedBy) throw conflict('the content must be approved first');
  const program = await loadProgram(t, item.programId);
  if (program.status !== 'active') throw conflict('the program is paused');
  const draft = item.draft as { text?: string; assetIds?: string[] };
  const brief = item.brief as { claimIds?: string[]; destination?: string | null };
  // The disclosure follows who wrote the published text: an AI-suggested idea rewritten by a person is not AI-generated copy.
  const isAi = (item.draft as { origin?: string }).origin === 'ai';
  const post = await schedulePost(t, deps, tenantId, actor, {
    connectionId: item.connectionId,
    platform: item.platform,
    caption: draft.text,
    // Facebook/LinkedIn/X show the destination as a link preview; the tagged URL is already in the caption for clickable platforms.
    link: null,
    assetIds: draft.assetIds ?? [],
    claimIds: brief.claimIds ?? [],
    scheduledAt: input.scheduledAt,
    geographies: input.geographies,
    disclosure: { isAiGenerated: isAi, paidPartnership: false, disclosureText: null },
  });
  await t
    .update(socialPosts)
    .set({ disclosure: { ...(post.disclosure as Record<string, unknown>), studio: { programId: program.id, itemId: item.id, campaign: item.campaign } } })
    .where(eq(socialPosts.id, post.id));
  return update(t, tenantId, actor, item, { stage: 'scheduled', postId: post.id, scheduledAt: new Date(input.scheduledAt) }, 'studio.item.scheduled', { postId: post.id, scheduledAt: input.scheduledAt });
}

/**
 * Moves scheduled items forward from the post's real state only: verified by read-back →
 * verified; failed/cancelled → failed; after the measurement window with results → measured;
 * once a pillar has enough measured items, its items are learned from (association only).
 */
export async function syncProgramItems(deps: CoreDeps, tenantId: string, programId: string) {
  const actor = { type: 'system' as const, id: 'universal-studio', roles: [], mfaVerified: false };
  const now = deps.clock.now();
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    await loadProgram(t, programId);
    const open = await t
      .select()
      .from(studioContentItems)
      .where(and(eq(studioContentItems.programId, programId), inArray(studioContentItems.stage, ['scheduled', 'published', 'verified', 'measured'])));
    const postIds = open.map((i) => i.postId).filter((x): x is string => Boolean(x));
    const posts = postIds.length ? await t.select().from(socialPosts).where(inArray(socialPosts.id, postIds)) : [];
    const moved = { verified: 0, failed: 0, measured: 0, learned: 0 };
    for (let item of open) {
      const post = posts.find((p) => p.id === item.postId);
      if (!post) continue;
      if ((item.stage === 'scheduled' || item.stage === 'published') && post.status === 'published_verified') {
        item = await update(t, tenantId, actor, item, { stage: 'verified', statusReason: null, metrics: { ...item.metrics, verifiedAt: post.verifiedAt?.toISOString() ?? null, url: post.externalUrl } }, 'studio.item.verified', { postId: post.id });
        moved.verified++;
      } else if ((item.stage === 'scheduled' || item.stage === 'published') && ['failed', 'cancelled', 'rejected'].includes(post.status)) {
        await update(t, tenantId, actor, item, { stage: 'failed', statusReason: post.statusReason ?? `post ${post.status}` }, 'studio.item.failed', { postId: post.id, postStatus: post.status });
        moved.failed++;
        continue;
      } else if (item.stage === 'scheduled' && post.status === 'submitted') {
        item = await update(t, tenantId, actor, item, { stage: 'published', statusReason: 'submitted to the execution gateway; waiting for read-back verification' }, 'studio.item.submitted', { postId: post.id });
      }
      if (item.stage === 'verified' && post.verifiedAt && now.getTime() - post.verifiedAt.getTime() >= MEASURE_AFTER_DAYS * DAY) {
        const results = await postEngagement(t, post.id);
        if (results) {
          await update(t, tenantId, actor, item, { stage: 'measured', metrics: { ...item.metrics, ...results, measuredAt: now.toISOString() } }, 'studio.item.measured', { postId: post.id });
          moved.measured++;
        }
        // No observed results yet: the item stays verified (missing is unknown, never zero).
      }
    }
    // Learn: per pillar, once enough items are measured.
    const insights = await programInsights(t, programId);
    for (const ins of insights.filter((i) => i.sufficient)) {
      const measured = await t
        .select()
        .from(studioContentItems)
        .where(and(eq(studioContentItems.programId, programId), eq(studioContentItems.pillar, ins.pillar), eq(studioContentItems.stage, 'measured')));
      for (const m of measured) {
        await update(t, tenantId, actor, m, { stage: 'learned', metrics: { ...m.metrics, learning: { pillarMean: ins.meanEngagement, pillarPosts: ins.posts, note: 'association only: pillar averages describe past posts, not causes' } } }, 'studio.item.learned', { pillar: ins.pillar });
        moved.learned++;
      }
    }
    return moved;
  });
}

/** Engagement read from the platform's evidence snapshot (reactions + comments + shares); null when not observed. */
async function postEngagement(t: DbOrTx, postId: string): Promise<{ engagement: number; observed: Record<string, number | null> } | null> {
  const [r] = await postResults(t, { postIds: [postId] });
  if (!r?.observedAt) return null;
  const m = r.metrics as Record<string, number | null>;
  const parts = ['reactions', 'comments', 'shares'].map((k) => m[k]).filter((v): v is number => typeof v === 'number');
  if (!parts.length) return null;
  return { engagement: parts.reduce((a, b) => a + b, 0), observed: { reactions: m.reactions ?? null, comments: m.comments ?? null, shares: m.shares ?? null } };
}

export interface PillarInsight {
  pillar: string;
  posts: number;
  meanEngagement: number | null;
  sufficient: boolean;
  note: string;
}

/** What past measured posts of each pillar did. Descriptive only; fewer than 3 measured posts is "not enough data". */
export async function programInsights(t: DbOrTx, programId: string): Promise<PillarInsight[]> {
  const rows = await t
    .select({ pillar: studioContentItems.pillar, metrics: studioContentItems.metrics })
    .from(studioContentItems)
    .where(and(eq(studioContentItems.programId, programId), inArray(studioContentItems.stage, ['measured', 'learned'])));
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const e = (r.metrics as { engagement?: unknown }).engagement;
    if (typeof e === 'number') by.set(r.pillar, [...(by.get(r.pillar) ?? []), e]);
  }
  return [...by.entries()].map(([pillar, values]) => {
    const sufficient = values.length >= MIN_LEARN_SAMPLE;
    return {
      pillar,
      posts: values.length,
      meanEngagement: sufficient ? values.reduce((a, b) => a + b, 0) / values.length : null,
      sufficient,
      note: sufficient ? 'average engagement of measured posts; an association, not proof that the pillar causes it' : `not enough data: ${values.length} of ${MIN_LEARN_SAMPLE} measured posts`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listItems(t: DbOrTx, programId: string, opts: { stages?: string[] } = {}) {
  return t
    .select()
    .from(studioContentItems)
    .where(and(eq(studioContentItems.programId, programId), opts.stages?.length ? inArray(studioContentItems.stage, opts.stages) : undefined))
    .orderBy(desc(studioContentItems.updatedAt))
    .limit(300);
}

/** Preview: the exact text as it will be posted and how it fits the platform. */
export async function itemPreview(t: DbOrTx, itemId: string) {
  const item = await loadItem(t, itemId);
  const draft = item.draft as { text?: string; assetIds?: string[] };
  const brief = item.brief as { destination?: string | null };
  const text = draft.text ?? '';
  return { itemId, platform: item.platform, stage: item.stage, text, fit: text ? checkCaption(item.platform as SocialPlatform, text, { link: brief.destination ?? null, images: draft.assetIds?.length ?? 0 }) : null, format: PLATFORM_FORMATS[item.platform as StudioPlatform], campaign: item.campaign };
}
