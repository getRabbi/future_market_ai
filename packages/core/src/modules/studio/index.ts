import { assetRights, assets, claims, connections, contentPlanItems, type DbOrTx, evidenceRecords, socialPosts, studioPrograms, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { type CardSpec, FONT_SOURCES, hammingDistance, PALETTE_IDS, type PaletteId, renderCard } from '@futuregrow/visuals';
import { and, desc, eq, gte, inArray, isNotNull, like, lt, ne, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { recomputeEligibility } from '../m14-assets/index.js';
import { pageBrandScope, postResults } from '../m16-social/index.js';
import { type ClaimRef, type Composition, compose, type Objective } from './compose.js';
import { type CurriculumRef, PACKS, packVersion, unitById, verifyCurriculumText } from './curriculum.js';
import { dayOffset, type HistoryItem, learnFrom, localDay, type PlanKind, planDays } from './planner.js';

export * from './community.js';
export { type ClaimRef, compose, FEATURE_MATCHERS, HOOKS, OBJECTIVES, taggedListingUrl } from './compose.js';
export { type CurriculumRef, PACKS, packUnits, packVersion, unitById, verifyCurriculumText } from './curriculum.js';
export { learnFrom, localDay, nextPostingSlot, POST_WINDOW, planDays, postingWindow } from './planner.js';

/**
 * Content studio (D-040): turns a Facebook Page's curriculum program into a seven-day plan and,
 * once a day, into one verified visual post draft: compose from the lesson bank, render a branded
 * card, check it (card QA, Korean against the unit, near-duplicates, copy lint on caption and card
 * text, asset rights), then hand the draft to the Autopilot's submit step and M23.
 */

/** The studio drafts as the Autopilot, so submitPostDraft accepts its drafts like the Idea Lab's. */
const AUTOPILOT = systemActor('autopilot');
const ACTOR_REF = actorRef(AUTOPILOT);
const PLAN_DAYS = 7;
const NEAR_DUPLICATE_BITS = 6;
const MAX_RENDER_ATTEMPTS = 4;
const MEASURE_AFTER_MS = 24 * 3_600_000;
const FREEZE_AFTER_MS = 7 * 86_400_000;
const PLAY_PREFIX = 'https://play.google.com/store/apps/details?id=';

export const STUDIO_DRAFT_NOTE = 'Studio draft from the verified curriculum: published only through the execution gateway (M23) under the publishing policy, or when a person schedules it.';

const tx = <T>(deps: CoreDeps, tenantId: string, fn: (t: Tx) => Promise<T>) => withTenant(deps.db, { tenantId, actor: ACTOR_REF }, fn);

/* ------------------------------------------------------------------ */
/* Programs                                                            */
/* ------------------------------------------------------------------ */

export const ProgramSettingsSchema = z
  .object({
    appCtaPerWeek: z.number().int().min(0).max(4).default(2),
    linkPerWeek: z.number().int().min(0).max(2).default(1),
    campaign: z
      .string()
      .regex(/^[a-z0-9_]{3,40}$/)
      .default('eps_daily'),
  })
  .strict();

export const ProgramInputSchema = z
  .object({
    connectionId: z.string().uuid(),
    pack: z.string().refine((p) => Boolean(PACKS[p]), 'unknown curriculum pack'),
    status: z.enum(['active', 'paused']).default('active'),
    settings: ProgramSettingsSchema.default({ appCtaPerWeek: 2, linkPerWeek: 1, campaign: 'eps_daily' }),
  })
  .strict();

export type Program = typeof studioPrograms.$inferSelect;

export async function listPrograms(t: DbOrTx) {
  return t.select().from(studioPrograms).orderBy(desc(studioPrograms.createdAt));
}

export async function programForConnection(t: DbOrTx, connectionId: string): Promise<Program | null> {
  const [p] = await t.select().from(studioPrograms).where(eq(studioPrograms.connectionId, connectionId));
  return p ?? null;
}

/** Owner/admin turn a curriculum program on or off for one of their Facebook Pages. */
export async function upsertProgram(t: Tx, tenantId: string, actor: Actor, raw: unknown): Promise<Program> {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'configuring the content studio');
  const input = ProgramInputSchema.parse(raw);
  const [conn] = await t.select().from(connections).where(eq(connections.id, input.connectionId));
  if (!conn || conn.provider !== 'meta') throw invalid('the content studio needs a Facebook Page connection');
  const [row] = await t
    .insert(studioPrograms)
    .values({ tenantId, connectionId: input.connectionId, pack: input.pack, status: input.status, settings: input.settings, createdBy: actorRef(actor) })
    .onConflictDoUpdate({ target: [studioPrograms.tenantId, studioPrograms.connectionId], set: { pack: input.pack, status: input.status, settings: input.settings, updatedBy: actorRef(actor), updatedAt: new Date() } })
    .returning();
  await audit(t, tenantId, actor, 'studio.program.saved', { type: 'studio_program', id: row!.id }, { connectionId: input.connectionId, pack: input.pack, status: input.status, settings: input.settings });
  return row!;
}

/* ------------------------------------------------------------------ */
/* Brand inputs: approved claims and the verified store listing        */
/* ------------------------------------------------------------------ */

async function brandInputs(t: DbOrTx, pageId: string, now: Date): Promise<{ claims: ClaimRef[]; appUrl: string | null; evidenceIds: string[] }> {
  const scope = await pageBrandScope(t, [pageId], now);
  const rows = scope.approvedClaimIds.length ? await t.select().from(claims).where(inArray(claims.id, scope.approvedClaimIds)) : [];
  // The store link is used only when admitted evidence about this Page's product is the listing itself.
  const listing = scope.evidenceIds.length
    ? (
        await t
          .select({ uri: evidenceRecords.sourceUriOrObjectId })
          .from(evidenceRecords)
          .where(and(inArray(evidenceRecords.id, scope.evidenceIds), like(evidenceRecords.sourceUriOrObjectId, `${PLAY_PREFIX}%`)))
          .limit(1)
      )[0]
    : undefined;
  const pkg = listing ? new URL(listing.uri).searchParams.get('id') : null;
  return {
    claims: rows.filter((c) => !c.regulated).map((c) => ({ id: c.id, text: c.text })),
    appUrl: pkg && /^[a-zA-Z0-9_.]+$/.test(pkg) ? `${PLAY_PREFIX}${pkg}` : null,
    evidenceIds: scope.autonomousEvidenceIds.length ? scope.autonomousEvidenceIds : scope.evidenceIds,
  };
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

type PlanRow = typeof contentPlanItems.$inferSelect;

const toHistory = (r: PlanRow): HistoryItem => ({ day: r.day, kind: r.kind as PlanKind, unitId: r.unitId, objective: r.objective as Objective, template: r.template, palette: r.palette, variant: r.variant, hookId: r.hookId, promptId: r.promptId, status: r.status, engagement: r.engagement });

/**
 * Plans the next seven days (Bangladesh calendar days) and returns them. Only days still 'planned'
 * are rewritten, so a drafted or published day never changes; days that passed unposted are
 * marked skipped.
 */
export async function refreshPlan(deps: CoreDeps, tenantId: string, programId: string, opts: { goalId?: string | null; now?: Date } = {}) {
  const now = opts.now ?? deps.clock.now();
  const today = localDay(now);
  return tx(deps, tenantId, async (t) => {
    const [program] = await t.select().from(studioPrograms).where(eq(studioPrograms.id, programId));
    if (!program) throw notFound('content program');
    const pack = PACKS[program.pack];
    if (!pack) throw invalid(`unknown curriculum pack ${program.pack}`);
    const [conn] = await t.select().from(connections).where(eq(connections.id, program.connectionId));
    if (!conn) throw notFound('connection');
    await t
      .update(contentPlanItems)
      .set({ status: 'skipped', statusReason: 'the day passed before the post was drafted', updatedAt: now })
      .where(and(eq(contentPlanItems.programId, programId), eq(contentPlanItems.status, 'planned'), lt(contentPlanItems.day, today)));
    // One post a day per Page: a post that went out (or is going out) today without the studio uses today's slot.
    const ownPosts = (
      await t
        .select({ postId: contentPlanItems.postId })
        .from(contentPlanItems)
        .where(and(eq(contentPlanItems.programId, programId), isNotNull(contentPlanItems.postId)))
    ).map((r) => r.postId!);
    const [other] = await t
      .select({ id: socialPosts.id })
      .from(socialPosts)
      .where(
        and(
          eq(socialPosts.connectionId, program.connectionId),
          inArray(socialPosts.status, ['submitted', 'published_verified']),
          gte(sql`coalesce(${socialPosts.verifiedAt}, ${socialPosts.scheduledAt})`, new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 3_600_000)),
          ownPosts.length ? notInArray(socialPosts.id, ownPosts) : undefined,
        ),
      )
      .limit(1);
    if (other) {
      await t
        .update(contentPlanItems)
        .set({ status: 'skipped', statusReason: `the Page already has a post today (${other.id}); one post a day`, updatedAt: now })
        .where(and(eq(contentPlanItems.programId, programId), eq(contentPlanItems.status, 'planned'), eq(contentPlanItems.day, today)));
    }
    const rows = await t.select().from(contentPlanItems).where(eq(contentPlanItems.programId, programId)).orderBy(contentPlanItems.day);
    const days = [...Array(PLAN_DAYS).keys()].map((i) => dayOffset(today, i)).filter((d) => !(other && d === today));
    const fixed = new Map(rows.filter((r) => days.includes(r.day) && r.status !== 'planned').map((r) => [r.day, r]));
    const history = rows.filter((r) => r.day < today || fixed.has(r.day)).map(toHistory);
    const brand = await brandInputs(t, conn.externalAccountId, now);
    const settings = ProgramSettingsSchema.parse(program.settings ?? {});
    const plan = planDays(
      pack,
      days.filter((d) => !fixed.has(d)),
      history,
      { appClaims: brand.claims.length > 0, appLink: Boolean(brand.appUrl), appCtaPerWeek: settings.appCtaPerWeek, linkPerWeek: settings.linkPerWeek },
    );
    const version = packVersion(pack);
    for (const it of plan.items) {
      await t
        .insert(contentPlanItems)
        .values({ tenantId, programId, goalId: opts.goalId ?? null, day: it.day, kind: it.kind, unitId: it.unitId, packVersion: version, objective: it.objective, segment: it.segment, template: it.template, palette: it.palette, variant: it.variant, rationale: it.rationale })
        .onConflictDoUpdate({
          target: [contentPlanItems.programId, contentPlanItems.day],
          set: { kind: it.kind, unitId: it.unitId, packVersion: version, objective: it.objective, segment: it.segment, template: it.template, palette: it.palette, variant: it.variant, rationale: it.rationale, ...(opts.goalId ? { goalId: opts.goalId } : {}), updatedAt: now },
          setWhere: eq(contentPlanItems.status, 'planned'),
        });
    }
    const upcoming = await t
      .select()
      .from(contentPlanItems)
      .where(and(eq(contentPlanItems.programId, programId), gte(contentPlanItems.day, today)))
      .orderBy(contentPlanItems.day)
      .limit(PLAN_DAYS);
    return { program, today, items: upcoming, learning: plan.learning, notes: plan.notes };
  });
}

/* ------------------------------------------------------------------ */
/* Compose + render + check                                            */
/* ------------------------------------------------------------------ */

const HANGUL_RUN = /[ᄀ-ᇿ㄰-㆏가-힣]+/gu;
/** Korean on the card beyond the unit: the 한 brand mark. */
const CARD_BRAND_KOREAN = ['한'];

const curriculumRef = (pack: (typeof PACKS)[string], unitId: string, c: Composition): CurriculumRef => ({ pack: pack.id, version: packVersion(pack), unitId, ...(c.revealUnitId ? { revealUnitId: c.revealUnitId } : {}) });

interface Prepared {
  composition: Composition;
  card: Awaited<ReturnType<typeof renderCard>>;
  attempts: { palette: string; variant: number; problems: string[] }[];
}

async function prepare(t: DbOrTx, deps: CoreDeps, item: PlanRow, program: Program, pageId: string, now: Date): Promise<{ ok: true; value: Prepared; brand: Awaited<ReturnType<typeof brandInputs>> } | { ok: false; reason: string; attempts: Prepared['attempts'] }> {
  const pack = PACKS[program.pack]!;
  const unit = item.unitId ? unitById(pack, item.unitId) : null;
  if (item.unitId && !unit) return { ok: false, reason: `unit ${item.unitId} is no longer in the ${pack.id} pack`, attempts: [] };
  const brand = await brandInputs(t, pageId, now);
  const settings = ProgramSettingsSchema.parse(program.settings ?? {});
  const recent = await t
    .select({ hookId: contentPlanItems.hookId, promptId: contentPlanItems.promptId, dhash: contentPlanItems.dhash, status: contentPlanItems.status })
    .from(contentPlanItems)
    .where(and(eq(contentPlanItems.programId, program.id), ne(contentPlanItems.id, item.id), isNotNull(contentPlanItems.hookId)))
    .orderBy(desc(contentPlanItems.day))
    .limit(30);
  const serial =
    (
      await t
        .select({ id: contentPlanItems.id })
        .from(contentPlanItems)
        .where(and(eq(contentPlanItems.programId, program.id), inArray(contentPlanItems.status, ['submitted', 'published'])))
    ).length + 1;
  // The previous published lesson (within three days): a quiz or notice question gets its answer here.
  const [last] = await t
    .select({ unitId: contentPlanItems.unitId, day: contentPlanItems.day })
    .from(contentPlanItems)
    .where(and(eq(contentPlanItems.programId, program.id), eq(contentPlanItems.status, 'published'), lt(contentPlanItems.day, item.day)))
    .orderBy(desc(contentPlanItems.day))
    .limit(1);
  const previous = last?.unitId && last.day >= dayOffset(item.day, -3) ? unitById(pack, last.unitId) : null;
  const palettes: { palette: PaletteId; variant: 0 | 1 }[] = [{ palette: item.palette as PaletteId, variant: item.variant as 0 | 1 }, ...PALETTE_IDS.filter((p) => p !== item.palette).map((p, i) => ({ palette: p, variant: ((item.variant + i + 1) % 2) as 0 | 1 }))];
  const attempts: Prepared['attempts'] = [];
  const dhashes = recent.map((r) => r.dhash).filter((d): d is string => Boolean(d));
  for (const look of palettes.slice(0, MAX_RENDER_ATTEMPTS)) {
    const composition = compose({
      unit,
      kind: item.kind as PlanKind,
      objective: item.objective as Objective,
      topicNames: pack.topics,
      claims: brand.claims,
      appUrl: brand.appUrl,
      campaign: settings.campaign,
      palette: look.palette,
      variant: look.variant,
      serial,
      recentHooks: recent.map((r) => r.hookId!).filter(Boolean),
      recentPrompts: recent.map((r) => r.promptId!).filter(Boolean),
      salt: `${item.id}`,
      previous,
    });
    if (!composition) return { ok: false, reason: 'no approved claim backs an app capability post', attempts };
    const card = await renderCard(composition.card);
    const problems = [...card.qa.problems];
    const allowed = [...composition.cardKorean, ...(unit?.korean ?? []), ...CARD_BRAND_KOREAN];
    const foreign = [...new Set(card.text.flatMap((s) => [...s.matchAll(HANGUL_RUN)].map((m) => m[0])))].filter((w) => !allowed.some((k) => k.includes(w)));
    if (foreign.length) problems.push(`card shows Korean outside the unit: ${foreign.join(', ')}`);
    const twin = dhashes.find((d) => hammingDistance(d, card.dhash) < NEAR_DUPLICATE_BITS);
    if (twin) problems.push(`card looks like a recent card (difference hash ${card.dhash} vs ${twin})`);
    attempts.push({ palette: look.palette, variant: look.variant, problems });
    if (!problems.length) return { ok: true, value: { composition, card, attempts }, brand };
  }
  return { ok: false, reason: `no card passed QA in ${attempts.length} attempts: ${attempts.at(-1)?.problems.join('; ')}`, attempts };
}

/** Renders a plan item's card as it would be drafted now (nothing is stored). */
export async function previewPlanItem(deps: CoreDeps, tenantId: string, itemId: string) {
  return tx(deps, tenantId, async (t) => {
    const [item] = await t.select().from(contentPlanItems).where(eq(contentPlanItems.id, itemId));
    if (!item) throw notFound('plan item');
    if (item.assetId) {
      const [a] = await t.select().from(assets).where(eq(assets.id, item.assetId));
      const bytes = a ? await deps.store.get(a.objectKey) : null;
      if (a && bytes) {
        const [post] = item.postId ? await t.select({ caption: socialPosts.caption }).from(socialPosts).where(eq(socialPosts.id, item.postId)) : [];
        return { png: bytes, caption: post?.caption ?? null, qa: (a.qa as { technical?: unknown }).technical ?? null, stored: true, checks: null };
      }
    }
    const [program] = await t.select().from(studioPrograms).where(eq(studioPrograms.id, item.programId));
    const [conn] = await t.select().from(connections).where(eq(connections.id, program!.connectionId));
    const now = deps.clock.now();
    const r = await prepare(t, deps, item, program!, conn!.externalAccountId, now);
    if (!r.ok) throw conflict(r.reason);
    // The checks the draft and M23 will run, so a preview shows whether the post would go out.
    const { composition, card } = r.value;
    const pack = PACKS[program!.pack]!;
    const captionLint = await lintCopy(t, composition.caption, { claimIds: composition.claimIds, channel: 'facebook', now });
    const cardLint = await lintCopy(t, card.text.join('\n'), { claimIds: composition.claimIds, now });
    const checks = {
      captionLint: { passed: captionLint.passed, codes: captionLint.violations.filter((v) => v.severity === 'block').map((v) => v.code) },
      cardLint: { passed: cardLint.passed, codes: cardLint.violations.filter((v) => v.severity === 'block').map((v) => v.code) },
      curriculum: item.unitId ? verifyCurriculumText(composition.caption, curriculumRef(pack, item.unitId, composition)) : null,
      claimIds: composition.claimIds,
      link: composition.link,
    };
    return { png: card.png, caption: composition.caption, qa: card.qa, stored: false, checks };
  });
}

export type DraftResult =
  | { kind: 'drafted'; postId: string; planItemId: string; assetId: string; evidenceIds: string[]; detail: string }
  | { kind: 'existing'; postId: string; planItemId: string; evidenceIds: string[]; detail: string }
  | { kind: 'skipped'; detail: string; planItemId?: string }
  | { kind: 'blocked'; detail: string; needs: 'claims' | 'configuration'; planItemId?: string };

/**
 * Drafts today's planned post: one image post whose caption and card come from the verified unit,
 * with the asset's rights and QA recorded. Returns the draft for the submit step. Never drafts
 * twice for a day; a failed day records why and the next day's item goes ahead.
 */
export async function draftPlannedPost(deps: CoreDeps, tenantId: string, args: { programId: string; goalId: string; cycleId: string; market: string; now?: Date }): Promise<DraftResult> {
  const now = args.now ?? deps.clock.now();
  const plan = await refreshPlan(deps, tenantId, args.programId, { goalId: args.goalId, now });
  const item = plan.items.find((i) => i.day === plan.today);
  if (!item) return { kind: 'skipped', detail: 'Nothing is planned for today.' };
  if (item.status !== 'planned') {
    const [post] = item.postId ? await tx(deps, tenantId, (t) => t.select().from(socialPosts).where(eq(socialPosts.id, item.postId!))) : [];
    if (post?.status === 'draft') {
      const review = (post.disclosure as { review?: { evidenceIds?: string[] } }).review;
      return { kind: 'existing', postId: post.id, planItemId: item.id, evidenceIds: review?.evidenceIds ?? [], detail: `Today's ${item.kind} post was already drafted.` };
    }
    return { kind: 'skipped', planItemId: item.id, detail: `Today's planned post is ${item.status}${item.statusReason ? ` (${item.statusReason})` : ''}.` };
  }
  const program = plan.program;
  const pack = PACKS[program.pack]!;
  const failItem = (reason: string, attempts: unknown[] = []) =>
    tx(deps, tenantId, async (t) => {
      await t
        .update(contentPlanItems)
        .set({ status: 'failed', statusReason: reason.slice(0, 2000), metrics: { attempts }, updatedAt: now })
        .where(eq(contentPlanItems.id, item.id));
      await audit(t, tenantId, AUTOPILOT, 'studio.post.failed', { type: 'content_plan_item', id: item.id }, { reason: reason.slice(0, 500) });
    });

  const result = await tx(deps, tenantId, async (t) => {
    const [conn] = await t.select().from(connections).where(eq(connections.id, program.connectionId));
    if (!conn) throw notFound('connection');
    const prepared = await prepare(t, deps, item, program, conn.externalAccountId, now);
    if (!prepared.ok) return { ok: false as const, reason: prepared.reason, attempts: prepared.attempts };
    const { composition, card, attempts } = prepared.value;
    const brand = prepared.brand;
    // Copy lint on the caption and on every word drawn on the card.
    const captionLint = await lintCopy(t, composition.caption, { claimIds: composition.claimIds, channel: 'facebook', now });
    const cardText = card.text.join('\n');
    const cardLint = await lintCopy(t, cardText, { claimIds: composition.claimIds, now });
    const blocking = [...captionLint.violations, ...cardLint.violations].filter((v) => v.severity === 'block');
    if (blocking.length) return { ok: false as const, reason: `copy lint: ${blocking.map((v) => `${v.code} (${v.excerpt.slice(0, 60)})`).join('; ')}`, attempts };

    // The card becomes a tenant asset with its provenance, rights and QA (M14 decides eligibility).
    const sha = sha256Hex(card.png);
    const put = await deps.store.put(tenantKey(tenantId, 'assets', sha), card.png, 'image/png');
    const unitRef = item.unitId ? curriculumRef(pack, item.unitId, composition) : null;
    const prov = await admitInternalEvidence(t, tenantId, AUTOPILOT, {
      kind: 'document',
      owner: 'futuregrow-content-studio',
      uri: `studio://card/${sha}`,
      content: {
        planItemId: item.id,
        template: composition.card.template,
        palette: composition.card.palette,
        variant: composition.card.variant,
        curriculum: unitRef,
        outputSha256: sha,
        svgSha256: sha256Hex(card.svg),
        dhash: card.dhash,
        qa: card.qa,
        attempts,
        fonts: FONT_SOURCES,
        renderer: 'harfbuzzjs@1.6.3 + @resvg/resvg-wasm@2.6.2',
      },
      summary: `Studio card for plan item ${item.id} (${composition.card.template}, ${composition.card.palette})`,
      confidence: 1,
      license: 'tenant-owned render of FUTUREGROW card templates; fonts Noto Sans KR and Noto Sans Bengali under SIL OFL 1.1',
      permittedUses: ['creative_generation', 'publishing', 'autonomous_execution'],
      now,
    });
    const [inserted] = await t
      .insert(assets)
      .values({
        tenantId,
        kind: 'image',
        title: `Studio ${composition.card.template} card ${item.day}`,
        objectKey: put.key,
        sha256: sha,
        mime: 'image/png',
        bytes: put.bytes,
        width: card.width,
        height: card.height,
        origin: 'render',
        manifest: {
          studio: { planItemId: item.id, template: composition.card.template, palette: composition.card.palette, variant: composition.card.variant, dhash: card.dhash },
          curriculum: unitRef,
          contains: { music: false, voice: false, likeness: false, aiGenerated: false },
          captions: cardText,
          claimIds: composition.claimIds,
          provenanceEvidenceId: prov.evidenceId,
          source: 'branded_template',
        },
        qa: { technical: { passed: card.qa.passed, problems: card.qa.problems, checks: card.qa.checks, minTextPx: card.qa.minTextPx, minContrast: card.qa.minContrast, width: card.width, height: card.height } },
        disclosure: { isAiGenerated: false, syntheticPersonaId: null },
        createdBy: ACTOR_REF,
      })
      .onConflictDoNothing()
      .returning();
    const asset = inserted ?? (await t.select().from(assets).where(eq(assets.sha256, sha)))[0]!;
    if (inserted) {
      const rights: (typeof assetRights.$inferInsert)[] = [
        { tenantId, assetId: asset.id, component: 'template', rightsHolder: 'tenant (FUTUREGROW card templates)', licenseRef: 'futuregrow:studio-templates', commercialUse: 'allowed', evidenceId: prov.evidenceId },
        { tenantId, assetId: asset.id, component: 'source_media', rightsHolder: 'tenant (programmatic render, no third-party imagery)', licenseRef: 'futuregrow:studio-render', commercialUse: 'allowed', evidenceId: prov.evidenceId },
        ...FONT_SOURCES.map((f) => ({ tenantId, assetId: asset.id, component: 'font', rightsHolder: 'Google / The Noto Project Authors', licenseRef: `${f.file}: ${f.license}`, commercialUse: 'allowed', evidenceId: prov.evidenceId })),
      ];
      await t.insert(assetRights).values(rights);
    }
    const eligible = await recomputeEligibility(t, deps, tenantId, asset.id);
    if (!eligible.publishEligible) return { ok: false as const, reason: `card asset not publish-eligible: ${eligible.eligibilityReasons.join('; ')}`, attempts };

    // The card's provenance stays with the asset (its rights cite it); the post cites what the Page and product evidence say.
    const evidenceIds = [...new Set(brand.evidenceIds)];
    const [post] = await t
      .insert(socialPosts)
      .values({
        tenantId,
        connectionId: conn.id,
        platform: 'facebook',
        assetIds: [asset.id],
        caption: composition.caption,
        claimIds: composition.claimIds,
        disclosure: {
          isAiGenerated: false,
          paidPartnership: false,
          syntheticPersonaId: null,
          disclosureText: null,
          options: {},
          geographies: [],
          review: {
            exploratory: false,
            forecastValidated: false,
            language: 'bn',
            draftedBy: 'system:content-studio',
            goalId: args.goalId,
            cycleId: args.cycleId,
            market: args.market,
            planItemId: item.id,
            objective: item.objective,
            evidenceIds,
            curriculum: unitRef,
            visual: { assetId: asset.id, template: composition.card.template, palette: composition.card.palette, variant: composition.card.variant, source: 'branded_template' },
            link: composition.link,
          },
        },
        scheduledAt: now,
        status: 'draft',
        statusReason: STUDIO_DRAFT_NOTE,
        createdBy: ACTOR_REF,
      })
      .returning({ id: socialPosts.id });
    const used = attempts.at(-1)!;
    await t
      .update(contentPlanItems)
      .set({ status: 'drafted', statusReason: null, postId: post!.id, assetId: asset.id, dhash: card.dhash, hookId: composition.hookId, promptId: composition.promptId, ctaFeature: composition.ctaFeature, palette: used.palette, variant: used.variant, metrics: { attempts }, updatedAt: now })
      .where(eq(contentPlanItems.id, item.id));
    await audit(t, tenantId, AUTOPILOT, 'studio.post.drafted', { type: 'content_plan_item', id: item.id }, { postId: post!.id, assetId: asset.id, kind: item.kind, unitId: item.unitId, objective: item.objective, claimIds: composition.claimIds, attempts: attempts.length });
    return { ok: true as const, postId: post!.id, assetId: asset.id, evidenceIds, template: composition.card.template };
  });
  if (!result.ok) {
    await failItem(result.reason, result.attempts);
    return { kind: 'blocked', needs: /claim/.test(result.reason) ? 'claims' : 'configuration', planItemId: item.id, detail: `Today's ${item.kind} post was not drafted: ${result.reason}` };
  }
  return { kind: 'drafted', postId: result.postId, planItemId: item.id, assetId: result.assetId, evidenceIds: result.evidenceIds, detail: `Drafted today's ${item.kind} post (${item.objective.toLowerCase().replace('_', ' ')}) with a ${result.template} card that passed QA, copy lint and the asset rights check.` };
}

/* ------------------------------------------------------------------ */
/* Results and learning                                                */
/* ------------------------------------------------------------------ */

/**
 * Follows each plan item's post (submitted, published, failed) and copies the Page's observed
 * counters once the post is a day old, until it is a week old (comparable lifetimes). Engagement =
 * reactions + 2·comments + 3·shares, from observed values only.
 */
export async function syncPlanResults(deps: CoreDeps, tenantId: string, programId: string) {
  const now = deps.clock.now();
  return tx(deps, tenantId, async (t) => {
    const items = await t
      .select()
      .from(contentPlanItems)
      .where(and(eq(contentPlanItems.programId, programId), isNotNull(contentPlanItems.postId), inArray(contentPlanItems.status, ['drafted', 'submitted', 'published'])));
    if (!items.length) return { updated: 0 };
    const posts = await t
      .select()
      .from(socialPosts)
      .where(
        inArray(
          socialPosts.id,
          items.map((i) => i.postId!),
        ),
      );
    const results = await postResults(t, { postIds: posts.filter((p) => p.status === 'published_verified').map((p) => p.id) });
    let updated = 0;
    for (const it of items) {
      const post = posts.find((p) => p.id === it.postId);
      if (!post) continue;
      const set: Partial<typeof contentPlanItems.$inferInsert> = {};
      if (post.status === 'submitted' && it.status === 'drafted') set.status = 'submitted';
      if (post.status === 'published_verified') {
        set.status = 'published';
        set.publishedAt = post.verifiedAt;
        const r = results.find((x) => x.postId === post.id);
        const metrics = it.metrics as { frozenAt?: string };
        const age = post.verifiedAt ? now.getTime() - post.verifiedAt.getTime() : 0;
        if (r?.observedAt && !metrics.frozenAt && age >= MEASURE_AFTER_MS) {
          const m = r.metrics;
          // Unknown is never zero: when Meta does not return a counter (often `shares`), the post has no score.
          const engagement = m.reactions !== null && m.comments !== null && m.shares !== null ? m.reactions + 2 * m.comments + 3 * m.shares : null;
          set.metrics = { ...metrics, reactions: m.reactions, comments: m.comments, shares: m.shares, observedAt: r.observedAt, evidenceId: r.evidenceId, url: r.url, ageHours: Math.round(age / 3_600_000), ...(age >= FREEZE_AFTER_MS ? { frozenAt: now.toISOString() } : {}) };
          set.engagement = engagement;
        }
      }
      if (['failed', 'cancelled', 'blocked'].includes(post.status) || (post.status === 'draft' && it.status === 'submitted')) {
        set.status = 'failed';
        set.statusReason = post.statusReason ?? post.status;
      }
      if (Object.keys(set).length) {
        await t
          .update(contentPlanItems)
          .set({ ...set, updatedAt: now })
          .where(eq(contentPlanItems.id, it.id));
        updated++;
      }
    }
    return { updated };
  });
}

/** Everything the program has drafted or published, as planner history (newest 120 days). */
export async function programHistory(t: DbOrTx, programId: string): Promise<HistoryItem[]> {
  const rows = await t
    .select()
    .from(contentPlanItems)
    .where(and(eq(contentPlanItems.programId, programId), ne(contentPlanItems.status, 'planned')))
    .orderBy(desc(contentPlanItems.day))
    .limit(120);
  return rows.map(toHistory);
}

/** Calendar, history, learning and funnel measurement for one program (API + Autopilot detail). */
export async function overview(deps: CoreDeps, tenantId: string, programId: string) {
  const plan = await refreshPlan(deps, tenantId, programId);
  return tx(deps, tenantId, async (t) => {
    const history = await t
      .select()
      .from(contentPlanItems)
      .where(and(eq(contentPlanItems.programId, programId), lt(contentPlanItems.day, plan.today)))
      .orderBy(desc(contentPlanItems.day))
      .limit(60);
    const learning = learnFrom([...history, ...plan.items.filter((i) => i.status !== 'planned')].map(toHistory));
    const pack = PACKS[plan.program.pack]!;
    const describe = (r: PlanRow) => ({ ...r, unit: r.unitId ? summarizeUnit(pack, r.unitId) : null });
    const published = [...history, ...plan.items].filter((h) => h.status === 'published');
    return {
      program: plan.program,
      today: plan.today,
      calendar: plan.items.map(describe),
      history: history.map(describe),
      learning,
      planNotes: plan.notes,
      measurement: {
        publishedPosts: published.length,
        measuredPosts: learning.measuredPosts,
        linkPosts: published.filter((h) => h.objective === 'VISIT_APP' || h.objective === 'INSTALL_APP').length,
        notes: [
          'Reactions, top-level comments and shares are read from the Page once a day; reach, impressions and link clicks need the read_insights permission, which the Page token does not have.',
          'Store links carry a Google Play referrer (utm_source=facebook, utm_medium=organic_social, utm_campaign, utm_content = lesson and post number). Installs by campaign appear in Play Console acquisition reports; they are not imported, so no install or conversion figure is shown here.',
        ],
      },
    };
  });
}

function summarizeUnit(pack: (typeof PACKS)[string], unitId: string) {
  const u = unitById(pack, unitId);
  if (!u) return null;
  return { id: u.id, kind: u.kind, segment: u.segment, korean: u.core.join(', ') };
}
