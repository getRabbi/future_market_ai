import { brandApps, brandChannels, brands, campaignLinks, claims, connections, type DbOrTx, kgEntities, studioPrograms, type Tx } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { contrastRatio } from '@futuregrow/visuals';
import { and, arrayOverlaps, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef } from '../../deps.js';
import { audit, requireRole } from '../../util.js';

/* ------------------------------------------------------------------ */
/* Brand profile (D-041)                                               */
/* ------------------------------------------------------------------ */

const EDIT_ROLES = ['owner', 'admin', 'growth_operator'] as const;
export const BRAND_OBJECTIVES = ['awareness', 'engagement', 'traffic', 'installs', 'activation', 'retention', 'sales', 'leads'] as const;
/** Font families bundled with the renderer (SIL OFL 1.1). Others need their licence and files added first. */
export const BRAND_FONTS = ['noto-sans-bengali', 'noto-sans-kr'] as const;
const PLAY_LISTING = /^https:\/\/play\.google\.com\/store\/apps\/details\?id=([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)$/;
const APP_STORE_LISTING = /^https:\/\/apps\.apple\.com\/[a-z]{2}\/app\/[a-z0-9-]+\/id([0-9]{6,12})$/;

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'colour must be #RRGGBB');
const shortText = (max: number) => z.string().trim().min(1).max(max);

export const BrandPaletteSchema = z
  .object({ background: hex, ink: hex, accent: hex, onAccent: hex, card: hex.optional(), cardInk: hex.optional() })
  .strict()
  .superRefine((p, ctx) => {
    // WCAG 2.x AA for body text: 4.5:1. A palette that fails is refused, not silently adjusted.
    const pairs: [string, string, string][] = [['ink', p.ink, p.background], ['onAccent', p.onAccent, p.accent], ...(p.card && p.cardInk ? ([['cardInk', p.cardInk, p.card]] as [string, string, string][]) : [])];
    for (const [name, fg, bg] of pairs) {
      const ratio = contrastRatio(fg, bg);
      if (ratio < 4.5) ctx.addIssue({ code: 'custom', path: [name], message: `${name} contrast ${ratio.toFixed(2)}:1 is below 4.5:1` });
    }
    if ((p.card === undefined) !== (p.cardInk === undefined)) ctx.addIssue({ code: 'custom', path: ['card'], message: 'card and cardInk go together' });
  });

export const DestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('website'), url: z.string().url().startsWith('https://').max(500), label: shortText(80).optional() }).strict(),
  z.object({ kind: z.literal('android_app'), url: z.string().regex(PLAY_LISTING, 'a Google Play listing URL (…/details?id=<package>)'), label: shortText(80).optional() }).strict(),
  z.object({ kind: z.literal('ios_app'), url: z.string().regex(APP_STORE_LISTING, 'an App Store listing URL (…/app/<name>/id<digits>)'), label: shortText(80).optional() }).strict(),
]);

export const BrandProfileSchema = z
  .object({
    voice: z
      .object({
        tone: z.array(shortText(40)).max(8).default([]),
        personality: z.string().trim().max(600).default(''),
        doSay: z.array(shortText(200)).max(20).default([]),
        dontSay: z.array(shortText(200)).max(30).default([]),
        emoji: z.enum(['none', 'light', 'expressive']).default('light'),
      })
      .strict()
      .prefault({}),
    visual: z
      .object({
        palette: BrandPaletteSchema.optional(),
        fonts: z
          .object({ heading: z.enum(BRAND_FONTS), body: z.enum(BRAND_FONTS) })
          .strict()
          .optional(),
        logoAssetId: z.string().uuid().optional(),
      })
      .strict()
      .prefault({}),
    audience: z
      .object({
        description: z.string().trim().max(1000).default(''),
        countries: z
          .array(z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2'))
          .max(50)
          .default([]),
        languages: z
          .array(z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'BCP 47 language, e.g. bn or en-US'))
          .max(10)
          .default([]),
        segments: z.array(shortText(80)).max(20).default([]),
      })
      .strict()
      .prefault({}),
    objectives: z.array(z.enum(BRAND_OBJECTIVES)).max(BRAND_OBJECTIVES.length).default([]),
    destinations: z.array(DestinationSchema).max(20).default([]),
    limits: z
      .object({
        /** Organic posts per connected channel per rolling day. */
        maxPostsPerDayPerChannel: z.number().int().min(0).max(10).default(1),
        /** Paid media stays off at 0; any spend still needs M23 approvals and budget reservations. */
        monthlyAdBudgetUsd: z.number().min(0).max(1_000_000).default(0),
        maxAiCallsPerDay: z.number().int().min(0).max(50).default(4),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type BrandProfile = z.infer<typeof BrandProfileSchema>;

export const BrandInputSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'lower-case letters, digits and dashes (2–48)'),
    name: shortText(120),
    status: z.enum(['active', 'paused', 'archived']).default('active'),
    profile: BrandProfileSchema.prefault({}),
    productEntityIds: z.array(z.string().uuid()).max(50).default([]),
  })
  .strict();

export const BrandUpdateSchema = BrandInputSchema.partial()
  .extend({ expectedVersion: z.number().int().min(1) })
  .strict();

export type Brand = typeof brands.$inferSelect;

const one = <T>(rows: T[]) => rows[0];

async function requireBrand(t: DbOrTx, brandId: string): Promise<Brand> {
  // Row-level security limits the read to the caller's tenant: another tenant's id is "not found".
  const row = one(await t.select().from(brands).where(eq(brands.id, brandId)));
  if (!row) throw notFound('brand not found');
  return row;
}

async function checkProducts(t: DbOrTx, ids: string[]) {
  if (!ids.length) return;
  const found = await t
    .select({ id: kgEntities.id })
    .from(kgEntities)
    .where(and(inArray(kgEntities.id, ids), eq(kgEntities.kind, 'product'), isNull(kgEntities.validTo)));
  const known = new Set(found.map((f) => f.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw invalid(`not a current product fact in this organization: ${missing.join(', ')}`);
}

/* ------------------------------------------------------------------ */
/* Brands                                                              */
/* ------------------------------------------------------------------ */

export async function listBrands(t: DbOrTx) {
  const rows = await t.select().from(brands).orderBy(asc(brands.name));
  if (!rows.length) return [];
  const ids = rows.map((b) => b.id);
  const [chs, apps, progs] = await Promise.all([
    t.select({ brandId: brandChannels.brandId, n: sql<number>`count(*)::int` }).from(brandChannels).where(inArray(brandChannels.brandId, ids)).groupBy(brandChannels.brandId),
    t.select({ brandId: brandApps.brandId, n: sql<number>`count(*)::int` }).from(brandApps).where(inArray(brandApps.brandId, ids)).groupBy(brandApps.brandId),
    t.select({ brandId: studioPrograms.brandId, n: sql<number>`count(*)::int` }).from(studioPrograms).where(inArray(studioPrograms.brandId, ids)).groupBy(studioPrograms.brandId),
  ]);
  const count = (list: { brandId: string | null; n: number }[], id: string) => list.find((x) => x.brandId === id)?.n ?? 0;
  return rows.map((b) => ({ ...b, channels: count(chs, b.id), apps: count(apps, b.id), programs: count(progs, b.id) }));
}

/** One brand with its channel accounts, applications, programs, product facts and approved claims. */
export async function getBrand(t: DbOrTx, brandId: string) {
  const brand = await requireBrand(t, brandId);
  const [channels, apps, programs, products, approved] = await Promise.all([
    t
      .select({ id: brandChannels.id, connectionId: connections.id, provider: connections.provider, externalAccountId: connections.externalAccountId, displayName: connections.displayName, status: connections.status })
      .from(brandChannels)
      .innerJoin(connections, eq(connections.id, brandChannels.connectionId))
      .where(eq(brandChannels.brandId, brandId))
      .orderBy(asc(connections.provider)),
    t.select().from(brandApps).where(eq(brandApps.brandId, brandId)).orderBy(asc(brandApps.platform), asc(brandApps.appId)),
    t.select({ id: studioPrograms.id, connectionId: studioPrograms.connectionId, pack: studioPrograms.pack, status: studioPrograms.status }).from(studioPrograms).where(eq(studioPrograms.brandId, brandId)),
    brand.productEntityIds.length ? t.select({ id: kgEntities.id, name: kgEntities.name, key: kgEntities.key }).from(kgEntities).where(inArray(kgEntities.id, brand.productEntityIds)) : Promise.resolve([]),
    brand.productEntityIds.length
      ? t
          .select({ id: claims.id, text: claims.text, regulated: claims.regulated, expiresAt: claims.expiresAt })
          .from(claims)
          .where(and(eq(claims.status, 'approved'), arrayOverlaps(claims.entityIds, brand.productEntityIds)))
      : Promise.resolve([]),
  ]);
  return { brand, profile: BrandProfileSchema.parse(brand.profile), channels, apps, programs, products, approvedClaims: approved };
}

export async function createBrand(t: Tx, tenantId: string, actor: Actor, raw: unknown): Promise<Brand> {
  requireRole(actor, EDIT_ROLES, 'creating a brand');
  const input = BrandInputSchema.parse(raw);
  await checkProducts(t, input.productEntityIds);
  const [exists] = await t.select({ id: brands.id }).from(brands).where(eq(brands.slug, input.slug));
  if (exists) throw conflict(`a brand with slug "${input.slug}" already exists`);
  const [row] = await t
    .insert(brands)
    .values({ tenantId, slug: input.slug, name: input.name, status: input.status, profile: input.profile, productEntityIds: input.productEntityIds, createdBy: actorRef(actor) })
    .returning();
  await audit(t, tenantId, actor, 'brand.created', { type: 'brand', id: row!.id }, { slug: input.slug, name: input.name });
  return row!;
}

/** Optimistic update: the caller states the version it edited, so concurrent edits are not lost. */
export async function updateBrand(t: Tx, tenantId: string, actor: Actor, brandId: string, raw: unknown): Promise<Brand> {
  requireRole(actor, EDIT_ROLES, 'editing a brand');
  const input = BrandUpdateSchema.parse(raw);
  const current = await requireBrand(t, brandId);
  if (input.productEntityIds) await checkProducts(t, input.productEntityIds);
  if (input.slug && input.slug !== current.slug) {
    const [taken] = await t
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.slug, input.slug), ne(brands.id, brandId)));
    if (taken) throw conflict(`a brand with slug "${input.slug}" already exists`);
  }
  const { expectedVersion, ...changes } = input;
  const [row] = await t
    .update(brands)
    .set({ ...changes, version: current.version + 1, updatedBy: actorRef(actor), updatedAt: new Date() })
    .where(and(eq(brands.id, brandId), eq(brands.version, expectedVersion)))
    .returning();
  if (!row) throw conflict(`brand changed since version ${expectedVersion} (now ${current.version}); reload and edit again`);
  await audit(t, tenantId, actor, 'brand.updated', { type: 'brand', id: brandId }, { version: row.version, fields: Object.keys(changes) });
  return row;
}

/* ------------------------------------------------------------------ */
/* Explicit mappings: channel accounts, applications, programs         */
/* ------------------------------------------------------------------ */

export async function bindChannel(t: Tx, tenantId: string, actor: Actor, brandId: string, connectionId: string) {
  requireRole(actor, EDIT_ROLES, 'linking a channel account to a brand');
  await requireBrand(t, brandId);
  const conn = one(await t.select({ id: connections.id, provider: connections.provider }).from(connections).where(eq(connections.id, connectionId)));
  if (!conn) throw notFound('connection not found');
  const existing = one(await t.select().from(brandChannels).where(eq(brandChannels.connectionId, connectionId)));
  if (existing && existing.brandId !== brandId) throw conflict('this channel account already belongs to another brand; unlink it there first');
  if (existing) return existing;
  const [row] = await t
    .insert(brandChannels)
    .values({ tenantId, brandId, connectionId, createdBy: actorRef(actor) })
    .returning();
  await audit(t, tenantId, actor, 'brand.channel.linked', { type: 'brand', id: brandId }, { connectionId, provider: conn.provider });
  return row!;
}

export async function unbindChannel(t: Tx, tenantId: string, actor: Actor, brandId: string, connectionId: string) {
  requireRole(actor, EDIT_ROLES, 'unlinking a channel account');
  await requireBrand(t, brandId);
  const inUse = one(
    await t
      .select({ id: studioPrograms.id })
      .from(studioPrograms)
      .where(and(eq(studioPrograms.connectionId, connectionId), eq(studioPrograms.brandId, brandId))),
  );
  if (inUse) throw conflict('a content program of this brand publishes to this account; move or pause the program first');
  const removed = await t
    .delete(brandChannels)
    .where(and(eq(brandChannels.brandId, brandId), eq(brandChannels.connectionId, connectionId)))
    .returning({ id: brandChannels.id });
  if (removed.length) await audit(t, tenantId, actor, 'brand.channel.unlinked', { type: 'brand', id: brandId }, { connectionId });
  return { removed: removed.length };
}

export const BrandAppSchema = z.union([
  z.object({ platform: z.literal('android'), listingUrl: z.string().regex(PLAY_LISTING, 'a Google Play listing URL (…/details?id=<package>)') }).strict(),
  z.object({ platform: z.literal('ios'), listingUrl: z.string().regex(APP_STORE_LISTING, 'an App Store listing URL (…/app/<name>/id<digits>)') }).strict(),
]);

/** The application id comes from the listing URL itself, so a mapping can never name one app and link another. */
export function appIdFromListing(platform: 'android' | 'ios', url: string): string | null {
  return (platform === 'android' ? PLAY_LISTING : APP_STORE_LISTING).exec(url)?.[1] ?? null;
}

export async function bindApp(t: Tx, tenantId: string, actor: Actor, brandId: string, raw: unknown) {
  requireRole(actor, EDIT_ROLES, 'linking an application to a brand');
  const input = BrandAppSchema.parse(raw);
  await requireBrand(t, brandId);
  const appId = appIdFromListing(input.platform, input.listingUrl)!;
  const existing = one(
    await t
      .select()
      .from(brandApps)
      .where(and(eq(brandApps.platform, input.platform), eq(brandApps.appId, appId))),
  );
  if (existing && existing.brandId !== brandId) throw conflict(`${input.platform} app ${appId} already belongs to another brand`);
  if (existing) return existing;
  const [row] = await t
    .insert(brandApps)
    .values({ tenantId, brandId, platform: input.platform, appId, listingUrl: input.listingUrl, createdBy: actorRef(actor) })
    .returning();
  await audit(t, tenantId, actor, 'brand.app.linked', { type: 'brand', id: brandId }, { platform: input.platform, appId });
  return row!;
}

/** A program joins a brand only when its channel account is already that brand's. */
export async function assignProgram(t: Tx, tenantId: string, actor: Actor, brandId: string, programId: string) {
  requireRole(actor, EDIT_ROLES, 'assigning a content program to a brand');
  await requireBrand(t, brandId);
  const program = one(await t.select().from(studioPrograms).where(eq(studioPrograms.id, programId)));
  if (!program) throw notFound('content program not found');
  const channel = one(await t.select().from(brandChannels).where(eq(brandChannels.connectionId, program.connectionId)));
  if (!channel || channel.brandId !== brandId) throw conflict("link the program's channel account to this brand first");
  if (program.brandId === brandId) return program;
  const [row] = await t
    .update(studioPrograms)
    .set({ brandId, updatedBy: actorRef(actor), updatedAt: new Date() })
    .where(eq(studioPrograms.id, programId))
    .returning();
  await audit(t, tenantId, actor, 'brand.program.assigned', { type: 'brand', id: brandId }, { programId, previousBrandId: program.brandId });
  return row!;
}

/* ------------------------------------------------------------------ */
/* Campaign identity registry                                          */
/* ------------------------------------------------------------------ */

/** Parse the Play referrer (or App Store campaign token) the studio put on a store link. */
export function linkIdentity(url: string): { appPlatform: 'android' | 'ios'; appId: string; campaign: string; content: string; source: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin === 'https://play.google.com' && u.pathname === '/store/apps/details') {
    const appId = u.searchParams.get('id');
    const ref = new URLSearchParams(u.searchParams.get('referrer') ?? '');
    const campaign = ref.get('utm_campaign');
    const content = ref.get('utm_content');
    if (!appId || !campaign || !content) return null;
    return { appPlatform: 'android', appId, campaign, content, source: ref.get('utm_source') };
  }
  return null;
}

export type CampaignRegistration = { registered: true; linkId: string } | { registered: false; reason: string };

/**
 * Records which brand/program/plan item/post/channel produced a tagged store link. Refuses (without
 * failing the draft) when the program has no brand, the app is not that brand's, or the identity is
 * already registered to different content: such links stay unmapped instead of being misattributed.
 */
export async function registerCampaignLink(t: Tx, tenantId: string, args: { programId: string; planItemId: string; postId: string; connectionId: string; channelPlatform: string; url: string; createdBy: string }): Promise<CampaignRegistration> {
  const id = linkIdentity(args.url);
  if (!id) return { registered: false, reason: 'the link carries no parsable store campaign identity' };
  const program = one(await t.select({ brandId: studioPrograms.brandId }).from(studioPrograms).where(eq(studioPrograms.id, args.programId)));
  if (!program?.brandId) return { registered: false, reason: 'the program is not assigned to a brand' };
  const app = one(
    await t
      .select({ brandId: brandApps.brandId })
      .from(brandApps)
      .where(and(eq(brandApps.platform, id.appPlatform), eq(brandApps.appId, id.appId))),
  );
  if (!app || app.brandId !== program.brandId) return { registered: false, reason: `${id.appPlatform} app ${id.appId} is not linked to the program's brand` };
  const [row] = await t
    .insert(campaignLinks)
    .values({
      tenantId,
      brandId: program.brandId,
      programId: args.programId,
      planItemId: args.planItemId,
      postId: args.postId,
      connectionId: args.connectionId,
      channelPlatform: args.channelPlatform,
      appPlatform: id.appPlatform,
      appId: id.appId,
      campaign: id.campaign,
      content: id.content,
      url: args.url,
      createdBy: args.createdBy,
    })
    .onConflictDoNothing()
    .returning({ id: campaignLinks.id });
  if (row) return { registered: true, linkId: row.id };
  const prior = one(
    await t
      .select()
      .from(campaignLinks)
      .where(and(eq(campaignLinks.appPlatform, id.appPlatform), eq(campaignLinks.appId, id.appId), eq(campaignLinks.campaign, id.campaign), eq(campaignLinks.content, id.content))),
  );
  // A retry of the same draft re-registers the same content: keep the row and refresh the post link.
  if (prior && prior.planItemId === args.planItemId && prior.brandId === program.brandId) {
    if (prior.postId !== args.postId) await t.update(campaignLinks).set({ postId: args.postId }).where(eq(campaignLinks.id, prior.id));
    return { registered: true, linkId: prior.id };
  }
  return { registered: false, reason: `campaign ${id.campaign}/${id.content} is already registered to other content` };
}

export interface CampaignIdentity {
  status: 'registered' | 'unregistered' | 'brand_mismatch';
  brandId: string | null;
  programId: string | null;
  planItemId: string | null;
  postId: string | null;
  connectionId: string | null;
  channelPlatform: string | null;
}

const UNREGISTERED: CampaignIdentity = { status: 'unregistered', brandId: null, programId: null, planItemId: null, postId: null, connectionId: null, channelPlatform: null };

/** Resolves (campaign, content) pairs of one application to the content that produced them. */
export async function resolveCampaignIdentities(t: DbOrTx, appPlatform: 'android' | 'ios', appId: string, pairs: { campaign: string | null; content: string | null }[]): Promise<Map<string, CampaignIdentity>> {
  const key = (campaign: string | null, content: string | null) => `${campaign ?? ''}\u0000${content ?? ''}`;
  const out = new Map<string, CampaignIdentity>();
  const wanted = pairs.filter((p) => p.campaign && p.content);
  for (const p of pairs) out.set(key(p.campaign, p.content), UNREGISTERED);
  if (!wanted.length) return out;
  const owner = one(
    await t
      .select({ brandId: brandApps.brandId })
      .from(brandApps)
      .where(and(eq(brandApps.platform, appPlatform), eq(brandApps.appId, appId))),
  );
  const rows = await t
    .select()
    .from(campaignLinks)
    .where(
      and(
        eq(campaignLinks.appPlatform, appPlatform),
        eq(campaignLinks.appId, appId),
        inArray(
          campaignLinks.campaign,
          wanted.map((w) => w.campaign!),
        ),
        inArray(
          campaignLinks.content,
          wanted.map((w) => w.content!),
        ),
      ),
    );
  for (const r of rows) {
    const k = key(r.campaign, r.content);
    if (!out.has(k)) continue;
    // The registry and the app's brand must agree; otherwise the mapping is reported, not used.
    const status = owner?.brandId === r.brandId ? 'registered' : 'brand_mismatch';
    out.set(k, { status, brandId: r.brandId, programId: r.programId, planItemId: r.planItemId, postId: r.postId, connectionId: r.connectionId, channelPlatform: r.channelPlatform });
  }
  return out;
}

export const identityKey = (campaign: string | null, content: string | null) => `${campaign ?? ''}\u0000${content ?? ''}`;
