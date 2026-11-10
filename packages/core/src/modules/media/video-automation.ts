import { randomUUID } from 'node:crypto';
import { assets, brandChannels, brands, contentPlanItems, type DbOrTx, renderJobs, studioContentItems, studioPrograms, type Tx, videoAutomationItems, videoProjects, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, clipText, requireMfa, requireRole } from '../../util.js';
import { BrandProfileSchema } from '../brands/index.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { PACKS, packUnits, packVersion, unitById } from '../studio/curriculum.js';
import { type GeneralPlan, GeneralPlanSchema, groundedMaterial } from '../studio/universal.js';
import type { VideoPreset } from './formats.js';
import { GOOGLE_FLOW_URL, paidVideoUsage, previewVideoRoute, storedVideoRouting, updateVideoRouting, type VideoAutomation, type VideoAutomationBrand, VideoAutomationSchema, type VideoRouting } from './routing.js';
import { insertVideoProject, queueProjectRender, StoryboardSchema, syncVideoProjects } from './video.js';
import { approvedContentScript, buildStoryboard, CLAIMS_CATEGORY, CURRICULUM_VIDEO_KINDS, curriculumScript, generateAiScript, generationPrompt, platformFor, scriptCopy, type VideoScript, VideoScriptSchema, type VideoTopic } from './video-script.js';

/**
 * Daily video automation (D-053): Topic → Script → Storyboard → Validation → Provider Routing →
 * Render → QA → Asset Library → Approval Queue, for every selected brand, up to the tenant's
 * daily target and each brand's quota. Every step is a persisted state of one
 * video_automation_items row with a stable idempotency key, so a restarted worker resumes the
 * row instead of generating twice. Work is claimed with a lease; model calls happen outside
 * database transactions. Nothing here enables a mode, spends paid budget, or publishes: a rendered
 * video waits for a person's review, and publishing still goes through M16/M23.
 */

export const AUTOMATION_ACTOR = 'video-automation';
export const AUTOMATION_ACTOR_REF = `system:${AUTOMATION_ACTOR}`;
/** At most this many automated renders are in flight per tenant (CPU media worker). */
export const DAILY_MAX_IN_FLIGHT = 2;
/** Unfinished pre-render work older than this is skipped instead of resumed. */
export const RESUME_DAYS = 3;
/** Script attempts per item (model unavailable or failing) before it fails. */
export const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60_000;
const RECENT_TOPIC_DAYS = 60;
const RECENT_POST_DAYS = 14;
const DAY_MS = 86_400_000;
const NOT_COUNTED = ['failed', 'skipped', 'rejected'] as const;
const PRE_RENDER = ['planned', 'scripted', 'storyboarded', 'waiting'] as const;
const APPROVED_STAGES = ['approved', 'scheduled', 'published', 'verified', 'measured', 'learned'];

type Item = typeof videoAutomationItems.$inferSelect;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
export const automationKey = (day: string, brandId: string, slot: number) => `va:${day}:${brandId}:${slot}`;

/* ------------------------------------------------------------------ */
/* Brand sources: what a brand's videos may be about                    */
/* ------------------------------------------------------------------ */

type ProgramRow = typeof studioPrograms.$inferSelect;
export interface BrandSource {
  brand: { id: string; name: string; slug: string; profile: ReturnType<typeof BrandProfileSchema.parse> };
  curriculum: ProgramRow | null;
  general: (ProgramRow & { generalPlan: GeneralPlan }) | null;
  categories: { key: string; label: string; needsAi: boolean }[];
  problem: string | null;
}

/** A brand's active Content Studio programs: a general program for the brand, and/or a curriculum program on one of its channels. */
export async function brandSource(t: DbOrTx, brandId: string): Promise<BrandSource | null> {
  const [b] = await t.select().from(brands).where(eq(brands.id, brandId));
  if (!b) return null;
  const channels = (await t.select({ connectionId: brandChannels.connectionId }).from(brandChannels).where(eq(brandChannels.brandId, brandId))).map((c) => c.connectionId);
  const programs = await t
    .select()
    .from(studioPrograms)
    .where(and(eq(studioPrograms.status, 'active'), channels.length ? or(eq(studioPrograms.brandId, brandId), inArray(studioPrograms.connectionId, channels)) : eq(studioPrograms.brandId, brandId)))
    .orderBy(studioPrograms.createdAt);
  const curriculum = programs.find((p) => p.kind === 'curriculum' && PACKS[p.pack] && (p.brandId === brandId || p.brandId === null)) ?? null;
  const g = programs.find((p) => p.kind === 'general' && p.brandId === brandId);
  const plan = g ? GeneralPlanSchema.safeParse(g.plan) : null;
  const general = g && plan?.success ? { ...g, generalPlan: plan.data } : null;
  const categories: BrandSource['categories'] = [];
  if (curriculum) for (const k of CURRICULUM_VIDEO_KINDS) categories.push({ key: k, label: `Curriculum: ${k}`, needsAi: false });
  if (general) {
    for (const p of general.generalPlan.pillars) categories.push({ key: p.key, label: `Pillar: ${p.name}`, needsAi: false });
    categories.push({ key: CLAIMS_CATEGORY, label: 'Approved product claims', needsAi: false });
  }
  return {
    brand: { id: b.id, name: b.name, slug: b.slug, profile: BrandProfileSchema.parse(b.profile ?? {}) },
    curriculum,
    general,
    categories,
    problem: curriculum || general ? null : 'No active Content Studio program for this brand (a general program, or a curriculum program on one of its channels).',
  };
}

/* ------------------------------------------------------------------ */
/* Topic selection                                                      */
/* ------------------------------------------------------------------ */

/**
 * Fresh topics for a brand, best first, rotating categories: curriculum units not taught by a
 * recent post or video; human-approved Content Studio items not yet turned into a video; approved
 * claims not featured recently; and, only when AI is allowed, the brand's pillars. Topics used in
 * the last 60 days (any outcome) are excluded so a failing topic is not retried automatically.
 */
export async function candidateTopics(t: DbOrTx, src: BrandSource, opts: { now: Date; day: string; categories: string[]; useAi: boolean; exclude: Set<string> }): Promise<VideoTopic[]> {
  const since = new Date(opts.now.getTime() - RECENT_TOPIC_DAYS * DAY_MS);
  const used = new Set(
    (
      await t
        .select({ k: videoAutomationItems.topicKey })
        .from(videoAutomationItems)
        .where(and(eq(videoAutomationItems.brandId, src.brand.id), gte(videoAutomationItems.createdAt, since)))
    ).map((r) => r.k),
  );
  for (const k of opts.exclude) used.add(k);
  const allow = (c: string) => !opts.categories.length || opts.categories.includes(c);
  const byCategory = new Map<string, VideoTopic[]>();
  const push = (topic: VideoTopic) => {
    if (used.has(topic.key) || !allow(topic.category)) return;
    byCategory.set(topic.category, [...(byCategory.get(topic.category) ?? []), topic]);
  };

  if (src.curriculum) {
    const pack = PACKS[src.curriculum.pack]!;
    const version = packVersion(pack);
    const recentPosts = new Set(
      (
        await t
          .select({ unitId: contentPlanItems.unitId })
          .from(contentPlanItems)
          .where(and(eq(contentPlanItems.programId, src.curriculum.id), inArray(contentPlanItems.status, ['submitted', 'published']), gte(contentPlanItems.day, addDays(opts.day, -RECENT_POST_DAYS))))
      ).map((r) => r.unitId),
    );
    for (const u of packUnits(pack)) {
      if (!(CURRICULUM_VIDEO_KINDS as readonly string[]).includes(u.kind) || recentPosts.has(u.id)) continue;
      push({ key: `eps:${pack.id}:${u.id}`, category: u.kind, source: 'curriculum', title: u.id, angle: '', hook: '', claimIds: [], programId: src.curriculum.id, pack: pack.id, packVersion: version, unitId: u.id });
    }
  }
  if (src.general) {
    const items = await t
      .select()
      .from(studioContentItems)
      .where(and(eq(studioContentItems.programId, src.general.id), inArray(studioContentItems.stage, APPROVED_STAGES)))
      .orderBy(desc(studioContentItems.updatedAt))
      .limit(50);
    for (const it of items) {
      const idea = it.idea as { angle?: string; hook?: string; claimIds?: string[] };
      const brief = it.brief as { keyMessage?: string; claimIds?: string[] };
      push({ key: `item:${it.id}`, category: it.pillar, source: 'content_item', title: it.title, angle: brief.keyMessage ?? idea.angle ?? '', hook: idea.hook ?? '', claimIds: brief.claimIds ?? idea.claimIds ?? [], programId: src.general.id, itemId: it.id });
    }
    const material = await groundedMaterial(t, src.general, opts.now);
    for (const c of material.claims) push({ key: `claim:${c.id}`, category: CLAIMS_CATEGORY, source: 'claim', title: `${src.brand.name}: ${clipText(c.text, 100)}`, angle: c.text, hook: src.brand.name, claimIds: [c.id], programId: src.general.id });
    if (opts.useAi) {
      for (const p of src.general.generalPlan.pillars) {
        for (let n = 1; n <= 10; n++) {
          const key = `pillar:${p.key}:${opts.day}:${n}`;
          if (used.has(key)) continue;
          push({ key, category: p.key, source: 'pillar', title: p.name, angle: p.description, hook: '', claimIds: material.claims.map((c) => c.id).slice(0, 10), programId: src.general.id });
          break;
        }
      }
    }
  }
  // Round-robin over categories in a stable order, so one category does not take every slot.
  const queues = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  const out: VideoTopic[] = [];
  for (let i = 0; queues.some((q) => q.length > i); i++) for (const q of queues) if (q[i]) out.push(q[i]!);
  return out;
}

/* ------------------------------------------------------------------ */
/* Daily usage and planning                                             */
/* ------------------------------------------------------------------ */

/** Renders today that the automation did not create (hand-made storyboards) plus automation items that still count. */
export async function dailyUsage(t: DbOrTx, day: string) {
  const start = new Date(`${day}T00:00:00Z`);
  const renders = await t
    .select({ id: renderJobs.id })
    .from(renderJobs)
    .where(and(eq(renderJobs.composition, 'scene_story'), gte(renderJobs.requestedAt, start), sql`${renderJobs.status} not in ('failed', 'blocked_license')`));
  const automated = renders.length
    ? new Set(
        (
          await t
            .select({ id: videoProjects.renderJobId })
            .from(videoProjects)
            .where(
              and(
                eq(videoProjects.createdBy, AUTOMATION_ACTOR_REF),
                inArray(
                  videoProjects.renderJobId,
                  renders.map((r) => r.id),
                ),
              ),
            )
        ).map((r) => r.id),
      )
    : new Set<string | null>();
  const items = await t.select({ brandId: videoAutomationItems.brandId, status: videoAutomationItems.status }).from(videoAutomationItems).where(eq(videoAutomationItems.day, day));
  const counted = items.filter((i) => !(NOT_COUNTED as readonly string[]).includes(i.status));
  const perBrand = new Map<string, { counted: number; total: number }>();
  for (const i of items) {
    const b = perBrand.get(i.brandId) ?? { counted: 0, total: 0 };
    b.total++;
    if (!(NOT_COUNTED as readonly string[]).includes(i.status)) b.counted++;
    perBrand.set(i.brandId, b);
  }
  const manualRenders = renders.filter((r) => !automated.has(r.id)).length;
  return { manualRenders, automationCounted: counted.length, used: manualRenders + counted.length, perBrand };
}

async function inFlightRenders(t: DbOrTx) {
  return (
    await t
      .select({ id: renderJobs.id })
      .from(renderJobs)
      .where(and(eq(renderJobs.composition, 'scene_story'), inArray(renderJobs.status, ['queued', 'rendering'])))
  ).length;
}

/** The route the automation asks for: Smart → template storyboards render with Remotion; a named mode asks for that mode. */
function routeRequest(a: VideoAutomation, preset: VideoPreset, seconds: number) {
  const cinematic = a.preferredMode !== 'smart' && a.preferredMode !== 'remotion';
  return { provider: a.preferredMode, quality: cinematic ? ('cinematic' as const) : ('template' as const), preset, seconds: cinematic ? Math.min(8, seconds) : Math.min(90, Math.max(1, seconds)), allowPaid: false };
}

export interface AutomationBlockers {
  blockers: string[];
  brandNotes: { brandId: string; note: string }[];
}

/** What stops the automation before any work (and any AI spend) happens. */
export async function automationBlockers(t: DbOrTx, deps: Pick<CoreDeps, 'videos' | 'clock'>, tenantId: string, settings: VideoRouting): Promise<AutomationBlockers> {
  const blockers: string[] = [];
  if (!settings.dailyAutomation) blockers.push('Daily automation is OFF.');
  const enabledBrands = settings.automation.brands.filter((b) => b.enabled);
  if (!enabledBrands.length) blockers.push('No brand is selected for daily video automation.');
  const route = await previewVideoRoute(t, deps, tenantId, routeRequest(settings.automation, enabledBrands[0]?.presets[0] ?? 'vertical_9x16', 20));
  if (route.execution === 'unavailable') blockers.push(`No video route: ${route.reason}${route.setup.length ? ` Setup: ${route.setup.join(' ')}` : ''}`);
  const brandNotes: AutomationBlockers['brandNotes'] = [];
  for (const b of enabledBrands) {
    const src = await brandSource(t, b.brandId);
    if (!src) brandNotes.push({ brandId: b.brandId, note: 'Brand not found.' });
    else if (src.problem) brandNotes.push({ brandId: b.brandId, note: src.problem });
  }
  return { blockers, brandNotes };
}

/**
 * Creates today's missing rows (deterministic idempotency keys, insert-or-nothing), round-robin
 * over the selected brands, within the tenant target and each brand's quota. A brand gets at most
 * twice its quota of rows per day, so failing topics cannot create unbounded work.
 */
async function planToday(t: Tx, tenantId: string, settings: VideoRouting, day: string, now: Date): Promise<{ created: number; notes: { brandId: string; note: string }[] }> {
  const usage = await dailyUsage(t, day);
  let remaining = Math.max(0, settings.dailyTarget - usage.used);
  const notes: { brandId: string; note: string }[] = [];
  const brandsOn = settings.automation.brands.filter((b) => b.enabled);
  const state = new Map<string, { cfg: VideoAutomationBrand; src: BrandSource; counted: number; total: number; topics: VideoTopic[] | null; done: boolean }>();
  for (const cfg of brandsOn) {
    const src = await brandSource(t, cfg.brandId);
    if (!src || src.problem) continue;
    const u = usage.perBrand.get(cfg.brandId) ?? { counted: 0, total: 0 };
    state.set(cfg.brandId, { cfg, src, counted: u.counted, total: u.total, topics: null, done: false });
  }
  let created = 0;
  const chosen = new Set<string>();
  while (remaining > 0 && [...state.values()].some((s) => !s.done)) {
    for (const s of state.values()) {
      if (s.done || remaining <= 0) continue;
      if (s.counted >= s.cfg.dailyQuota || s.total >= s.cfg.dailyQuota * 2) {
        s.done = true;
        continue;
      }
      s.topics ??= await candidateTopics(t, s.src, { now, day, categories: s.cfg.categories, useAi: settings.automation.useAi, exclude: chosen });
      const topic = s.topics.find((x) => !chosen.has(x.key));
      if (!topic) {
        notes.push({ brandId: s.cfg.brandId, note: 'No fresh topic: every allowed topic was used recently (add approved content, claims or categories).' });
        s.done = true;
        continue;
      }
      chosen.add(topic.key);
      const slot = s.total;
      const preset = s.cfg.presets[slot % s.cfg.presets.length]!;
      const platforms = s.src.general?.generalPlan.platforms ?? ['facebook'];
      const inserted = await t
        .insert(videoAutomationItems)
        .values({ tenantId, brandId: s.cfg.brandId, day, slot, idempotencyKey: automationKey(day, s.cfg.brandId, slot), topicKey: topic.key, topic: topic as unknown as Record<string, unknown>, category: topic.category, preset, platform: topic.source === 'curriculum' ? 'facebook' : platformFor(preset, platforms) })
        .onConflictDoNothing()
        .returning({ id: videoAutomationItems.id });
      s.total++;
      if (inserted.length) {
        s.counted++;
        remaining--;
        created++;
      }
    }
  }
  return { created, notes };
}

/* ------------------------------------------------------------------ */
/* State changes (lease-checked)                                        */
/* ------------------------------------------------------------------ */

async function setItem(t: DbOrTx, item: Pick<Item, 'id' | 'version'>, patch: Partial<typeof videoAutomationItems.$inferInsert>, now: Date): Promise<Item | null> {
  const [row] = await t
    .update(videoAutomationItems)
    .set({ ...patch, updatedAt: now, version: item.version + 1 })
    .where(and(eq(videoAutomationItems.id, item.id), eq(videoAutomationItems.version, item.version)))
    .returning();
  return row ?? null;
}

/** Rendering items follow their video project's real state; nothing is marked complete before the render QA passed. */
async function syncRendering(t: Tx, tenantId: string, now: Date) {
  await syncVideoProjects(t, tenantId);
  const rendering = await t.select().from(videoAutomationItems).where(eq(videoAutomationItems.status, 'rendering'));
  const ids = rendering.map((r) => r.videoProjectId).filter((x): x is string => Boolean(x));
  const projects = ids.length ? await t.select().from(videoProjects).where(inArray(videoProjects.id, ids)) : [];
  let changed = 0;
  for (const item of rendering) {
    const p = projects.find((x) => x.id === item.videoProjectId);
    if (!p || p.status === 'rendering') continue;
    const next: Partial<typeof videoAutomationItems.$inferInsert> =
      p.status === 'ready'
        ? { status: 'awaiting_approval', statusReason: 'Rendered and QA-passed; waiting for a person to review before publishing.' }
        : p.status === 'storyboard'
          ? { status: 'storyboarded', statusReason: p.statusReason ?? 'render not started' }
          : { status: 'failed', statusReason: clipText(p.statusReason ?? `render ${p.status}`, 500), provenance: { ...item.provenance, retry: p.status === 'failed' ? 'render' : 'script' } };
    if (await setItem(t, item, next, now)) changed++;
    if (next.status === 'awaiting_approval') await audit(t, tenantId, systemActor(AUTOMATION_ACTOR), 'media.video_automation.rendered', { type: 'video_automation_item', id: item.id }, { videoProjectId: p.id, assetId: p.outputAssetId });
  }
  return changed;
}

/** Pre-render work older than RESUME_DAYS is skipped (with a reason), not resumed forever. */
async function expireStale(t: Tx, day: string, now: Date) {
  const r = await t
    .update(videoAutomationItems)
    .set({ status: 'skipped', statusReason: `expired: not completed within ${RESUME_DAYS} days`, updatedAt: now, leaseToken: null, leaseUntil: null })
    .where(and(inArray(videoAutomationItems.status, [...PRE_RENDER]), lt(videoAutomationItems.day, addDays(day, -RESUME_DAYS))))
    .returning({ id: videoAutomationItems.id });
  return r.length;
}

/** Claims work with a lease; a crashed worker's lease expires and the next run resumes the row. */
async function claim(t: Tx, statuses: readonly string[], limit: number, day: string, now: Date): Promise<Item[]> {
  const rows = await t
    .select({ id: videoAutomationItems.id })
    .from(videoAutomationItems)
    .where(and(inArray(videoAutomationItems.status, [...statuses]), gte(videoAutomationItems.day, addDays(day, -RESUME_DAYS)), or(isNull(videoAutomationItems.leaseUntil), lt(videoAutomationItems.leaseUntil, now)), or(isNull(videoAutomationItems.nextAttemptAt), lte(videoAutomationItems.nextAttemptAt, now))))
    .orderBy(videoAutomationItems.day, videoAutomationItems.slot)
    .limit(limit)
    .for('update', { skipLocked: true });
  if (!rows.length) return [];
  return t
    .update(videoAutomationItems)
    .set({ leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(
      inArray(
        videoAutomationItems.id,
        rows.map((r) => r.id),
      ),
    )
    .returning();
}

/* ------------------------------------------------------------------ */
/* Script step (model call outside any transaction)                     */
/* ------------------------------------------------------------------ */

interface ScriptResult {
  script: VideoScript | null;
  origin: 'ai' | 'template' | 'curriculum' | null;
  /** retry = the model was unavailable and no template fits; skip = the topic cannot make a truthful video. */
  outcome: 'ok' | 'retry' | 'skip';
  reason: string | null;
  provenance: Record<string, unknown>;
}

async function writeScript(deps: CoreDeps, tenantId: string, item: Item, settings: VideoRouting, now: Date): Promise<ScriptResult> {
  const topic = item.topic as unknown as VideoTopic;
  const preset = item.preset as VideoPreset;
  const ctx = await withTenant(deps.db, { tenantId, actor: AUTOMATION_ACTOR_REF }, async (t) => {
    const src = await brandSource(t, item.brandId);
    if (!src) return null;
    const material = src.general && topic.source !== 'curriculum' ? await groundedMaterial(t, src.general, now) : null;
    const recent = (await t.select({ script: videoAutomationItems.script }).from(videoAutomationItems).where(eq(videoAutomationItems.brandId, item.brandId)).orderBy(desc(videoAutomationItems.createdAt)).limit(40)).map((r) => (r.script as { title?: string } | null)?.title).filter((x): x is string => Boolean(x));
    return { src, material, recentTitles: [...recent, ...(material?.recentTitles ?? [])] };
  });
  if (!ctx) return { script: null, origin: null, outcome: 'skip', reason: 'brand not found', provenance: {} };
  const { src, material } = ctx;

  if (topic.source === 'curriculum') {
    const pack = topic.pack ? PACKS[topic.pack] : undefined;
    if (!pack || !src.curriculum) return { script: null, origin: null, outcome: 'skip', reason: 'the curriculum program is no longer active', provenance: {} };
    if (packVersion(pack) !== topic.packVersion) return { script: null, origin: null, outcome: 'skip', reason: 'the curriculum pack changed since the topic was chosen', provenance: {} };
    const unit = topic.unitId ? unitById(pack, topic.unitId) : null;
    if (!unit) return { script: null, origin: null, outcome: 'skip', reason: `unknown unit ${topic.unitId}`, provenance: {} };
    const r = curriculumScript(pack, unit, { preset, platform: item.platform });
    return 'script' in r ? { script: r.script, origin: 'curriculum', outcome: 'ok', reason: null, provenance: { curriculum: r.script.curriculum, cost: { aiUsd: 0 } } } : { script: null, origin: null, outcome: 'skip', reason: r.reason, provenance: {} };
  }

  if (!src.general || !material) return { script: null, origin: null, outcome: 'skip', reason: 'the brand has no active general content program', provenance: {} };
  const plan = src.general.generalPlan;
  const template = () => approvedContentScript({ brandName: src.brand.name, language: plan.language, topic, claims: material.claims, cta: plan.cta.slice(0, 60), preset, platform: item.platform });
  if (topic.source === 'claim' && !material.claims.some((c) => topic.claimIds.includes(c.id))) return { script: null, origin: null, outcome: 'skip', reason: 'the claim is no longer approved', provenance: {} };

  if (settings.automation.useAi) {
    const pillar = plan.pillars.find((p) => p.key === topic.category) ?? null;
    const ai = await generateAiScript(deps, tenantId, AUTOMATION_ACTOR_REF, {
      brand: { name: src.brand.name, voice: src.brand.profile.voice, audience: src.brand.profile.audience },
      language: plan.language,
      objective: plan.objective,
      audience: plan.audience,
      topic,
      pillar,
      claims: material.claims,
      evidence: material.evidence,
      recentTitles: ctx.recentTitles,
      preset,
      platform: item.platform,
      cta: plan.cta.slice(0, 60),
    });
    const aiProv = { runId: ai.runId, costUsd: ai.costUsd, ...(ai.ok ? { model: ai.model } : { problem: ai.reason }) };
    if (ai.ok) return { script: ai.script, origin: 'ai', outcome: 'ok', reason: null, provenance: { ai: aiProv, cost: { aiUsd: ai.costUsd ?? 0 } } };
    const fallback = template();
    if (fallback) return { script: fallback, origin: 'template', outcome: 'ok', reason: `template used: ${ai.reason}`, provenance: { ai: aiProv, cost: { aiUsd: ai.costUsd ?? 0 } } };
    return { script: null, origin: null, outcome: ai.unavailable ? 'retry' : 'skip', reason: ai.unavailable ? `${ai.reason}; no approved content fits a template for this topic` : ai.reason, provenance: { ai: aiProv, cost: { aiUsd: ai.costUsd ?? 0 } } };
  }
  const fallback = template();
  return fallback ? { script: fallback, origin: 'template', outcome: 'ok', reason: null, provenance: { cost: { aiUsd: 0 } } } : { script: null, origin: null, outcome: 'skip', reason: 'AI is OFF for the automation and no approved content fits a template for this topic', provenance: {} };
}

/* ------------------------------------------------------------------ */
/* Storyboard, validation and routing (one transaction per item)        */
/* ------------------------------------------------------------------ */

async function storyboardAndRoute(t: Tx, deps: CoreDeps, tenantId: string, item: Item, settings: VideoRouting, remotionLicensed: boolean, now: Date): Promise<Item | null> {
  const actor = systemActor(AUTOMATION_ACTOR);
  let current = item;
  const parsedScript = VideoScriptSchema.safeParse(item.script);
  if (!parsedScript.success) return setItem(t, current, { status: 'failed', statusReason: 'stored script is invalid', leaseToken: null, leaseUntil: null }, now);
  const script = parsedScript.data;
  if (!current.videoProjectId) {
    // The voiceover and title are checked too (the storyboard gate covers on-screen text and subtitles).
    const lint = await lintCopy(t, scriptCopy(script), { claimIds: script.claimIds, now });
    const blocking = lint.violations.filter((v) => v.severity === 'block');
    if (blocking.length) {
      await audit(t, tenantId, actor, 'media.video_automation.qa_failed', { type: 'video_automation_item', id: item.id }, { stage: 'script', problems: blocking.map((v) => v.code) });
      return setItem(t, current, { status: 'failed', statusReason: clipText(`script QA failed: ${blocking.map((v) => `${v.code}: ${v.message}${v.excerpt ? ` (“${clipText(v.excerpt, 60)}”)` : ''}`).join('; ')}`, 1000), leaseToken: null, leaseUntil: null, provenance: { ...current.provenance, retry: 'script' } }, now);
    }
    const src = await brandSource(t, item.brandId);
    if (!src) return setItem(t, current, { status: 'skipped', statusReason: 'brand not found', leaseToken: null, leaseUntil: null }, now);
    const cfg = settings.automation.brands.find((b) => b.brandId === item.brandId);
    const wanted = [...(cfg?.assetIds ?? []), ...(src.brand.profile.visual.logoAssetId ? [src.brand.profile.visual.logoAssetId] : [])];
    const rows = wanted.length ? await t.select().from(assets).where(inArray(assets.id, wanted)) : [];
    const usable = (id: string) => rows.some((r) => r.id === id && (r.kind === 'image' || r.kind === 'video'));
    const media = {
      assetIds: (cfg?.assetIds ?? []).filter(usable),
      logoAssetId: src.brand.profile.visual.logoAssetId && usable(src.brand.profile.visual.logoAssetId) ? src.brand.profile.visual.logoAssetId : null,
      aiGenerated: rows.some((r) => (r.disclosure as { isAiGenerated?: boolean }).isAiGenerated || (r.manifest as { contains?: { aiGenerated?: boolean } }).contains?.aiGenerated || r.personaId),
    };
    let storyboard: ReturnType<typeof buildStoryboard>;
    try {
      storyboard = buildStoryboard(script, { palette: src.brand.profile.visual.palette }, media);
    } catch (err) {
      return setItem(t, current, { status: 'failed', statusReason: `storyboard does not fit the Video Studio schema: ${clipText(err instanceof Error ? err.message : String(err), 300)}`, leaseToken: null, leaseUntil: null, provenance: { ...current.provenance, retry: 'script' } }, now);
    }
    // The same rights, claims-lint and disclosure gates as a hand-made storyboard.
    const project = await insertVideoProject(t, deps, tenantId, actor, { title: script.title, brandId: item.brandId, storyboard });
    const qa = project.qa as { storyboard?: { passed?: boolean; problems?: string[] } };
    if (qa.storyboard?.passed !== true) {
      await audit(t, tenantId, actor, 'media.video_automation.qa_failed', { type: 'video_automation_item', id: item.id }, { videoProjectId: project.id, problems: qa.storyboard?.problems ?? [] });
      return setItem(t, current, { status: 'failed', videoProjectId: project.id, statusReason: clipText(`storyboard QA failed: ${(qa.storyboard?.problems ?? []).join('; ')}`, 1000), leaseToken: null, leaseUntil: null, provenance: { ...current.provenance, retry: 'script' } }, now);
    }
    const next = await setItem(t, current, { status: 'storyboarded', videoProjectId: project.id, statusReason: null }, now);
    if (!next) return null;
    current = next;
  }

  // Someone may have rendered the storyboard from the Video Studio meanwhile: follow it instead of queueing twice.
  const [project] = await t.select({ status: videoProjects.status }).from(videoProjects).where(eq(videoProjects.id, current.videoProjectId!));
  if (project?.status === 'rendering' || project?.status === 'ready') return setItem(t, current, { status: 'rendering', mode: 'remotion', statusReason: 'Rendering with Remotion.', leaseToken: null, leaseUntil: null }, now);
  const seconds = script.scenes.reduce((a, s) => a + s.seconds, 0);
  const decision = await previewVideoRoute(t, deps, tenantId, routeRequest(settings.automation, item.preset as VideoPreset, seconds));
  const [brand] = await t.select({ name: brands.name }).from(brands).where(eq(brands.id, item.brandId));
  const prompt = generationPrompt(script, brand?.name ?? 'the brand');
  const release = { leaseToken: null, leaseUntil: null } as const;
  switch (decision.execution) {
    case 'automatic': {
      if (!remotionLicensed) return setItem(t, current, { status: 'storyboarded', mode: 'remotion', statusReason: 'Waiting: record the Remotion licence eligibility in Governance before rendering (B-014).', ...release }, now);
      if ((await inFlightRenders(t)) >= DAILY_MAX_IN_FLIGHT) return setItem(t, current, { status: 'storyboarded', mode: 'remotion', statusReason: 'Waiting for a free render slot.', ...release }, now);
      try {
        await t.transaction(async (sp) => queueProjectRender(sp as unknown as Tx, deps, tenantId, actor, current.videoProjectId!));
      } catch (err) {
        return setItem(t, current, { status: 'waiting', mode: 'remotion', statusReason: clipText(`render not queued: ${err instanceof Error ? err.message : String(err)}`, 500), ...release }, now);
      }
      await audit(t, tenantId, actor, 'media.video_automation.render_queued', { type: 'video_automation_item', id: item.id }, { videoProjectId: current.videoProjectId, route: decision.reason });
      return setItem(t, current, { status: 'rendering', mode: 'remotion', statusReason: 'Rendering with Remotion.', ...release }, now);
    }
    case 'manual':
      return setItem(
        t,
        current,
        {
          status: 'manual_task',
          mode: 'google_flow',
          statusReason: 'Manual Google Flow task prepared: generate the clip in Flow and import it. FUTUREGROW does not automate Flow.',
          manualTask: {
            kind: 'google_flow',
            url: GOOGLE_FLOW_URL,
            prompt,
            preset: item.preset,
            seconds: Math.min(8, seconds),
            steps: ['Open Google Flow with your own Google account and paste the prompt.', 'Download the MP4.', 'Import it with "Import from Google Flow" and answer the rights questions.', 'Use the clip as a scene of the prepared storyboard, or publish it after review.'],
          },
          ...release,
        },
        now,
      );
    case 'needs_authorization':
    case 'approval_required':
    case 'paid_automatic':
      // Never spends: a paid route always waits for a person to authorize a maximum charge.
      return setItem(
        t,
        current,
        {
          status: 'waiting',
          mode: decision.mode,
          statusReason: `Paid route (${decision.mode}): ${decision.reason} The automation never authorizes paid generation.`,
          manualTask: {
            kind: 'paid_authorization',
            mode: decision.mode,
            estimateUsd: decision.estimateUsd,
            prompt,
            preset: item.preset,
            seconds: Math.min(8, seconds),
            steps: ['Review the prompt and the maximum charge.', 'Create the generation from Video Generation with an explicit maximum charge; budgets and approvals apply.'],
          },
          ...release,
        },
        now,
      );
    default:
      return setItem(t, current, { status: 'waiting', mode: null, statusReason: clipText(`No video route: ${decision.reason}${decision.setup.length ? ` Setup: ${decision.setup.join(' ')}` : ''}`, 1000), ...release }, now);
  }
}

/* ------------------------------------------------------------------ */
/* The run                                                              */
/* ------------------------------------------------------------------ */

export interface AutomationRunResult {
  ran: boolean;
  blockers: string[];
  notes: { brandId: string; note: string }[];
  created: number;
  scripted: number;
  routed: number;
  synced: number;
  expired: number;
  skipped: { id: string; reason: string }[];
  retrying: { id: string; reason: string }[];
}

const lockKey = (tenantId: string) => sql`hashtext(${`video-automation:${tenantId}`})`;

/**
 * One automation run for a tenant. Planning holds a per-tenant advisory lock (a second worker
 * finds it busy and does nothing); scripts and routing are claimed with leases. Safe to run
 * again at any time: completed rows are never redone, interrupted rows resume.
 */
export async function runVideoAutomation(deps: CoreDeps, tenantId: string): Promise<AutomationRunResult> {
  const now = deps.clock.now();
  const day = utcDay(now);
  const result: AutomationRunResult = { ran: false, blockers: [], notes: [], created: 0, scripted: 0, routed: 0, synced: 0, expired: 0, skipped: [], retrying: [] };
  const tx = <T>(fn: (t: Tx) => Promise<T>) => withTenant(deps.db, { tenantId, actor: AUTOMATION_ACTOR_REF }, fn);

  const planned = await tx(async (t) => {
    const lock = await t.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${lockKey(tenantId)}) as ok`);
    if (!lock.rows[0]?.ok) return null;
    result.synced = await syncRendering(t, tenantId, now);
    result.expired = await expireStale(t, day, now);
    const { settings, remotionLicensed } = await storedVideoRouting(t, tenantId);
    const b = await automationBlockers(t, deps, tenantId, settings);
    result.blockers = b.blockers;
    result.notes = b.brandNotes;
    if (b.blockers.length) return { settings, remotionLicensed, scriptWork: [] as Item[], routeWork: [] as Item[] };
    const p = await planToday(t, tenantId, settings, day, now);
    result.created = p.created;
    result.notes.push(...p.notes);
    const scriptWork = await claim(t, ['planned'], settings.automation.maxScriptsPerRun, day, now);
    const routeWork = await claim(t, ['scripted', 'storyboarded', 'waiting'], 20, day, now);
    return { settings, remotionLicensed, scriptWork, routeWork };
  });
  if (!planned) return { ...result, blockers: ['Another automation run is in progress for this tenant.'] };
  if (result.blockers.length) return result;
  result.ran = true;
  const { settings, remotionLicensed } = planned;

  const toRoute: Item[] = [...planned.routeWork];
  for (const item of planned.scriptWork) {
    let r: ScriptResult;
    try {
      r = await writeScript(deps, tenantId, item, settings, now);
    } catch (err) {
      r = { script: null, origin: null, outcome: 'retry', reason: clipText(err instanceof Error ? err.message : String(err), 300), provenance: {} };
    }
    const saved = await tx(async (t) => {
      const [fresh] = await t.select().from(videoAutomationItems).where(eq(videoAutomationItems.id, item.id));
      if (!fresh || fresh.leaseToken !== item.leaseToken || fresh.status !== 'planned') return null; // lease lost: another run owns it now
      const attempts = fresh.attempts + 1;
      const spent = ((fresh.provenance as { cost?: { aiUsd?: number } }).cost?.aiUsd ?? 0) + ((r.provenance as { cost?: { aiUsd?: number } }).cost?.aiUsd ?? 0);
      const provenance = { ...fresh.provenance, ...r.provenance, attempts, cost: { aiUsd: spent }, ...(r.outcome === 'ok' && r.reason ? { scriptNote: r.reason } : {}) };
      if (r.outcome === 'ok' && r.script) {
        await audit(t, tenantId, systemActor(AUTOMATION_ACTOR), 'media.video_automation.scripted', { type: 'video_automation_item', id: item.id }, { origin: r.origin, topic: fresh.topicKey, scenes: r.script.scenes.length });
        return setItem(t, fresh, { status: 'scripted', script: r.script as unknown as Record<string, unknown>, origin: r.origin, statusReason: r.reason, attempts, provenance }, now);
      }
      if (r.outcome === 'retry' && attempts < MAX_ATTEMPTS) return setItem(t, fresh, { status: 'planned', statusReason: `retrying: ${r.reason}`, attempts, nextAttemptAt: new Date(now.getTime() + attempts * 60 * 60_000), provenance, leaseToken: null, leaseUntil: null }, now);
      return setItem(t, fresh, { status: r.outcome === 'retry' ? 'failed' : 'skipped', statusReason: r.outcome === 'retry' ? `failed after ${attempts} attempts: ${r.reason}` : r.reason, attempts, provenance, leaseToken: null, leaseUntil: null }, now);
    });
    if (saved?.status === 'scripted') {
      result.scripted++;
      toRoute.push(saved);
    } else if (saved?.status === 'planned') result.retrying.push({ id: item.id, reason: saved.statusReason ?? '' });
    else if (saved) result.skipped.push({ id: item.id, reason: saved.statusReason ?? '' });
  }

  for (const item of toRoute) {
    const out = await tx(async (t) => {
      const [fresh] = await t.select().from(videoAutomationItems).where(eq(videoAutomationItems.id, item.id));
      if (!fresh || fresh.leaseToken !== item.leaseToken || !['scripted', 'storyboarded', 'waiting'].includes(fresh.status)) return null;
      return storyboardAndRoute(t, deps, tenantId, fresh, settings, remotionLicensed, now);
    });
    if (out) result.routed++;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* People: settings, review, retry, overview                            */
/* ------------------------------------------------------------------ */

export const AutomationSettingsUpdateSchema = z
  .object({
    dailyAutomation: z.boolean(),
    dailyTarget: z.number().int().min(1).max(10),
    automation: VideoAutomationSchema,
    expectedVersion: z.number().int().min(0),
  })
  .strict();

/** Owner/admin with MFA; the same versioned record as the switchboard, so switches are never overwritten by a stale form. */
export async function updateAutomationSettings(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  const input = AutomationSettingsUpdateSchema.parse(raw);
  const { settings } = await storedVideoRouting(t, tenantId);
  for (const b of input.automation.brands) {
    const [row] = await t.select({ id: brands.id }).from(brands).where(eq(brands.id, b.brandId));
    if (!row) throw invalid(`unknown brand ${b.brandId}`);
  }
  await updateVideoRouting(t, deps, tenantId, actor, { settings: { ...settings, dailyAutomation: input.dailyAutomation, dailyTarget: input.dailyTarget, automation: input.automation }, expectedVersion: input.expectedVersion });
  return automationOverview(t, deps, tenantId);
}

export const ReviewSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).default('') }).strict();

/**
 * A person reviews a rendered video. Approval only clears it for publishing; publishing itself
 * still goes through M16/M23 (policy, approvals, verification). Rejection retires the topic.
 */
export async function reviewAutomationItem(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'approver'], 'reviewing automated videos');
  const input = ReviewSchema.parse(raw ?? {});
  const [item] = await t.select().from(videoAutomationItems).where(eq(videoAutomationItems.id, id));
  if (!item) throw notFound('automated video');
  if (item.status !== 'awaiting_approval') throw conflict(`the video is ${item.status}; only rendered videos awaiting approval can be reviewed`);
  const now = deps.clock.now();
  const row = await setItem(
    t,
    item,
    {
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      statusReason: input.decision === 'approve' ? 'Approved for publishing; publish through the Content Studio or Video Studio (M23 policy applies).' : clipText(`Rejected: ${input.note || 'no reason given'}`, 500),
      reviewedBy: actorRef(actor),
      reviewedAt: now,
    },
    now,
  );
  if (!row) throw conflict('the video changed in the meantime; reload and try again');
  await audit(t, tenantId, actor, `media.video_automation.${input.decision === 'approve' ? 'approved' : 'rejected'}`, { type: 'video_automation_item', id }, { videoProjectId: item.videoProjectId, note: input.note });
  return row;
}

/**
 * Retry only where it is safe: a failed render is queued again from the same storyboard (no new
 * script, no model call); a script or QA failure, a skipped topic or a waiting item starts over
 * from the topic. Approved, rejected and in-progress items cannot be retried.
 */
export async function retryAutomationItem(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'retrying automated videos');
  const [item] = await t.select().from(videoAutomationItems).where(eq(videoAutomationItems.id, id));
  if (!item) throw notFound('automated video');
  if (!['failed', 'skipped', 'waiting', 'manual_task'].includes(item.status)) throw conflict(`the video is ${item.status}; only failed, skipped or waiting videos can be retried`);
  if (item.leaseUntil && item.leaseUntil > deps.clock.now()) throw conflict('the automation is working on this video right now');
  const now = deps.clock.now();
  const renderOnly = item.status === 'failed' && (item.provenance as { retry?: string }).retry === 'render' && item.videoProjectId;
  const patch: Partial<typeof videoAutomationItems.$inferInsert> = renderOnly
    ? { status: 'storyboarded', statusReason: `render retry requested by ${actorRef(actor)}`, nextAttemptAt: null }
    : item.status === 'waiting' && item.videoProjectId
      ? { status: 'storyboarded', statusReason: `routing retry requested by ${actorRef(actor)}`, nextAttemptAt: null }
      : { status: 'planned', statusReason: `retry requested by ${actorRef(actor)}`, script: null, origin: null, videoProjectId: null, manualTask: null, mode: null, attempts: 0, nextAttemptAt: null };
  // Work older than the resume window would be expired at once: a retry moves it to today.
  const row = await setItem(t, item, { ...patch, day: item.day < addDays(utcDay(now), -RESUME_DAYS) ? utcDay(now) : item.day }, now);
  if (!row) throw conflict('the video changed in the meantime; reload and try again');
  await audit(t, tenantId, actor, 'media.video_automation.retry', { type: 'video_automation_item', id }, { from: item.status, to: row.status });
  return row;
}

/** Manual "run now" for owners/admins (same run as the worker's; AI budgets and every gate apply). */
export async function runVideoAutomationNow(deps: CoreDeps, tenantId: string, actor: Actor) {
  requireRole(actor, ['owner', 'admin'], 'running the video automation');
  requireMfa(actor, 'running the video automation');
  return runVideoAutomation(deps, tenantId);
}

const publicItem = (i: Item) => ({
  id: i.id,
  brandId: i.brandId,
  day: i.day,
  slot: i.slot,
  topicKey: i.topicKey,
  category: i.category,
  preset: i.preset,
  platform: i.platform,
  status: i.status,
  statusReason: i.statusReason,
  origin: i.origin,
  mode: i.mode,
  title: (i.script as { title?: string } | null)?.title ?? (i.topic as { title?: string }).title ?? i.topicKey,
  script: i.script,
  manualTask: i.manualTask,
  videoProjectId: i.videoProjectId,
  attempts: i.attempts,
  aiUsd: (i.provenance as { cost?: { aiUsd?: number } }).cost?.aiUsd ?? 0,
  /** Why a template was used instead of the model's script, kept after later status changes. */
  scriptNote: (i.provenance as { scriptNote?: string }).scriptNote ?? null,
  reviewedBy: i.reviewedBy,
  reviewedAt: i.reviewedAt?.toISOString() ?? null,
  updatedAt: i.updatedAt.toISOString(),
});

/** Everything the Daily Video Automation dashboard shows. Read-only. */
export async function automationOverview(t: DbOrTx, deps: Pick<CoreDeps, 'videos' | 'clock'>, tenantId: string) {
  const now = deps.clock.now();
  const day = utcDay(now);
  const { settings, version, remotionLicensed } = await storedVideoRouting(t, tenantId);
  const allBrands = await t.select({ id: brands.id, name: brands.name, slug: brands.slug }).from(brands).orderBy(brands.name).limit(100);
  const brandRows = [];
  for (const b of allBrands) {
    const src = await brandSource(t, b.id);
    brandRows.push({ ...b, categories: src?.categories ?? [], problem: src?.problem ?? null, config: settings.automation.brands.find((x) => x.brandId === b.id) ?? null });
  }
  const recent = await t
    .select()
    .from(videoAutomationItems)
    .where(gte(videoAutomationItems.day, addDays(day, -13)))
    .orderBy(desc(videoAutomationItems.day), desc(videoAutomationItems.updatedAt))
    .limit(300);
  const today = recent.filter((i) => i.day === day);
  const count = (rows: Item[], statuses: readonly string[]) => rows.filter((r) => statuses.includes(r.status)).length;
  const usage = await dailyUsage(t, day);
  const history = [...new Set(recent.map((r) => r.day))].map((d) => {
    const rows = recent.filter((r) => r.day === d);
    return {
      day: d,
      total: rows.length,
      rendered: count(rows, ['awaiting_approval', 'approved']),
      approved: count(rows, ['approved']),
      failed: count(rows, ['failed']),
      skipped: count(rows, ['skipped', 'rejected']),
      manual: count(rows, ['manual_task']),
      aiUsd: rows.reduce((a, r) => a + ((r.provenance as { cost?: { aiUsd?: number } }).cost?.aiUsd ?? 0), 0),
    };
  });
  const blockers = await automationBlockers(t, deps, tenantId, settings);
  const projects = recent.map((r) => r.videoProjectId).filter((x): x is string => Boolean(x));
  const projectRows = projects.length ? await t.select({ id: videoProjects.id, status: videoProjects.status, storyboard: videoProjects.storyboard, outputAssetId: videoProjects.outputAssetId }).from(videoProjects).where(inArray(videoProjects.id, projects)) : [];
  const withProject = (i: Item) => {
    const p = projectRows.find((x) => x.id === i.videoProjectId);
    const sb = p ? StoryboardSchema.safeParse(p.storyboard) : null;
    return { ...publicItem(i), project: p ? { id: p.id, status: p.status, outputAssetId: p.outputAssetId, storyboard: sb?.success ? sb.data : null } : null };
  };
  return {
    settings: { dailyAutomation: settings.dailyAutomation, dailyTarget: settings.dailyTarget, automation: settings.automation },
    version,
    remotionLicensed,
    brands: brandRows,
    blockers: blockers.blockers,
    brandNotes: blockers.brandNotes,
    today: {
      day,
      target: settings.dailyTarget,
      used: usage.used,
      manualRenders: usage.manualRenders,
      remaining: Math.max(0, settings.dailyTarget - usage.used),
      planned: count(today, ['planned']),
      inProgress: count(today, ['scripted', 'storyboarded', 'rendering']),
      completed: count(today, ['awaiting_approval', 'approved']),
      waiting: count(today, ['waiting', 'manual_task']),
      failed: count(today, ['failed']),
      skipped: count(today, ['skipped', 'rejected']),
      aiUsd: today.reduce((a, r) => a + ((r.provenance as { cost?: { aiUsd?: number } }).cost?.aiUsd ?? 0), 0),
    },
    inFlightRenders: await inFlightRenders(t),
    maxInFlight: DAILY_MAX_IN_FLIGHT,
    pendingApprovals: recent.filter((i) => i.status === 'awaiting_approval').map(withProject),
    items: recent.slice(0, 100).map(withProject),
    history,
    paidUsage: await paidVideoUsage(t, tenantId, now),
  };
}
