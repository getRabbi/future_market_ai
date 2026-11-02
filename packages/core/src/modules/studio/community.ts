import { communityGroups, communityShares, contentPlanItems, type DbOrTx, socialPosts, type Tx } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { lintCopy } from '../m03-knowledge/index.js';

/**
 * Community growth workspace (D-040). Meta deprecated the Groups API with Graph v19.0 (January
 * 2024) and removed it, publish_to_groups included, from every version within 90 days, so
 * FUTUREGROW never posts to, joins or reads a Facebook group. It keeps the owner's list of groups with their rules and posting
 * permission, ranks them by topic relevance, prepares a group-specific share kit (lesson text plus
 * the lesson card) where the group allows member posts, drafts a polite admin request where it
 * does not, and records shares the owner confirms.
 */

const GROUP_URL = /^https:\/\/(www\.|m\.|web\.)?facebook\.com\/groups\/[A-Za-z0-9._-]+\/?$/;

export const GroupInputSchema = z
  .object({
    url: z.string().trim().regex(GROUP_URL, 'a facebook.com/groups/… link'),
    name: z.string().trim().min(2).max(200),
    audience: z.string().max(500).default(''),
    rules: z.string().max(4000).default(''),
    permission: z.enum(['unknown', 'members_may_post', 'admin_approval', 'admin_only', 'owned']).default('unknown'),
    memberCount: z.number().int().nonnegative().nullable().default(null),
    notes: z.string().max(2000).default(''),
  })
  .strict();

export const GroupUpdateSchema = GroupInputSchema.partial()
  .extend({ status: z.enum(['candidate', 'member', 'approved', 'declined', 'archived']).optional() })
  .strict();

const nfc = (alts: string) => new RegExp(alts.normalize('NFC'), 'iu');
const TOPIC = [nfc('korean|কোরিয়ান'), nfc('eps|topik|টপিক'), nfc('hangul|হাঙ্গুল'), nfc('korea|কোরিয়া'), nfc('language|ভাষা|শিখ|learn|study|পড়া')];
/** Groups about jobs, visas or agencies: sharing there would breach the BD brand rules (no migration or recruitment content). */
const OFF_LIMITS = nfc('চাকরি|চাকুরি|ভিসা|বেতন|এজেন্সি|দালাল|রিক্রুট|নিয়োগ|\\bjobs?\\b|\\bvisas?\\b|\\bagency\\b|\\brecruit');

export function scoreGroup(g: { name: string; audience: string; rules: string }): { relevance: number; notes: string } {
  const text = `${g.name} ${g.audience}`.normalize('NFC');
  if (OFF_LIMITS.test(`${text} ${g.rules.normalize('NFC')}`)) return { relevance: 0, notes: 'Mentions jobs, visas, salaries or agencies: lessons are not shared there (BD brand rules exclude employment and migration content).' };
  const hits = TOPIC.filter((re) => re.test(text)).length;
  const relevance = Math.round((hits / TOPIC.length) * 100) / 100;
  return { relevance, notes: `${hits} of ${TOPIC.length} topic signals (Korean, EPS-TOPIK, Hangul, Korea, language learning) in the name and audience description.` };
}

const PERMISSION_RANK: Record<string, number> = { owned: 0, members_may_post: 1, admin_approval: 2, unknown: 3, admin_only: 4 };

export async function listGroups(t: DbOrTx) {
  const rows = await t.select().from(communityGroups);
  return rows.filter((r) => r.status !== 'archived').sort((a, b) => (PERMISSION_RANK[a.permission] ?? 9) - (PERMISSION_RANK[b.permission] ?? 9) || b.relevance - a.relevance || a.name.localeCompare(b.name));
}

export async function addGroup(t: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'managing community groups');
  const g = GroupInputSchema.parse(raw);
  const url = g.url.replace(/^https:\/\/(m\.|web\.)?facebook/, 'https://www.facebook').replace(/\/$/, '');
  const score = scoreGroup(g);
  const [row] = await t
    .insert(communityGroups)
    .values({ tenantId, ...g, url, relevance: score.relevance, relevanceNotes: score.notes, status: g.permission === 'owned' ? 'approved' : 'candidate', createdBy: actorRef(actor) })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('this group is already in the list');
  await audit(t, tenantId, actor, 'community.group.added', { type: 'community_group', id: row.id }, { url, permission: g.permission });
  return row;
}

export async function updateGroup(t: Tx, tenantId: string, actor: Actor, id: string, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'managing community groups');
  const patch = GroupUpdateSchema.parse(raw);
  const [cur] = await t.select().from(communityGroups).where(eq(communityGroups.id, id));
  if (!cur) throw notFound('community group');
  const next = { ...cur, ...patch };
  const score = scoreGroup(next);
  const [row] = await t
    .update(communityGroups)
    .set({ ...patch, relevance: score.relevance, relevanceNotes: score.notes, updatedBy: actorRef(actor), updatedAt: new Date() })
    .where(eq(communityGroups.id, id))
    .returning();
  await audit(t, tenantId, actor, 'community.group.updated', { type: 'community_group', id }, { fields: Object.keys(patch) });
  return row!;
}

const PERMISSION_REQUEST = (group: string, page: string) =>
  [`আসসালামু আলাইকুম। আমি “${page}” পেজ থেকে লিখছি।`, `আমরা বাংলায় ছোট ছোট কোরিয়ান পাঠ বানাই: শব্দ, হাঙ্গুল, গ্রামার আর কুইজ। “${group}” গ্রুপের সদস্যদের কাজে লাগতে পারে বলে মনে হচ্ছে।`, 'গ্রুপের নিয়ম মেনে মাঝে মাঝে একটা করে পাঠ শেয়ার করার অনুমতি পেলে কৃতজ্ঞ থাকব। কোনো লিংক বা বিজ্ঞাপন থাকবে না।', 'ধন্যবাদ।'].join('\n\n');

/**
 * Prepares a share kit for one group: the lesson of a published plan item (its caption without the
 * app mention and link, plus the card) where members may post, or an admin permission request
 * where posting is unknown or needs approval. At most one prepared or confirmed share per group per
 * seven days, and never the same lesson twice in one group.
 */
export async function prepareShare(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, groupId: string, input: { planItemId?: string | null; pageName: string }) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'preparing community shares');
  const [g] = await t.select().from(communityGroups).where(eq(communityGroups.id, groupId));
  if (!g) throw notFound('community group');
  if (g.status === 'declined' || g.status === 'archived') throw invalid(`the group is ${g.status}`);
  if (g.relevance === 0 && g.relevanceNotes.startsWith('Mentions')) throw invalid(g.relevanceNotes);
  if (g.permission === 'admin_only') throw invalid('only admins may post in this group; ask an admin to share the lesson instead');
  const since = new Date(deps.clock.now().getTime() - 7 * 86_400_000);
  const recent = await t
    .select()
    .from(communityShares)
    .where(and(eq(communityShares.groupId, groupId), gte(communityShares.createdAt, since)));
  if (recent.some((s) => s.status === 'prepared' || s.status === 'shared')) throw conflict('a share for this group was prepared or made in the last 7 days');
  const needsRequest = g.permission === 'unknown';
  if (needsRequest) {
    const caption = PERMISSION_REQUEST(g.name, input.pageName);
    const [row] = await t
      .insert(communityShares)
      .values({ tenantId, groupId, kind: 'permission_request', caption, createdBy: actorRef(actor) })
      .returning();
    await audit(t, tenantId, actor, 'community.share.prepared', { type: 'community_share', id: row!.id }, { groupId, kind: 'permission_request' });
    return row!;
  }
  if (!input.planItemId) throw invalid('choose a published lesson to share');
  const [item] = await t.select().from(contentPlanItems).where(eq(contentPlanItems.id, input.planItemId));
  if (!item || item.status !== 'published' || !item.postId) throw invalid('only lessons already published on the Page are shared');
  const shared = await t
    .select({ id: communityShares.id })
    .from(communityShares)
    .where(and(eq(communityShares.groupId, groupId), eq(communityShares.planItemId, item.id)));
  if (shared.length) throw conflict('this lesson was already shared with this group');
  const [post] = await t.select().from(socialPosts).where(eq(socialPosts.id, item.postId));
  // Group copy: the lesson only, no app mention, store link or hashtags.
  const caption = post!.caption
    .split('\n')
    .filter((l) => !/^📱|^📲|^👉|^#|play\.google|অ্যাপ/u.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lint = await lintCopy(t, caption, { claimIds: [], now: deps.clock.now() });
  if (!lint.passed) throw invalid(`share text failed copy lint: ${lint.violations.map((v) => v.code).join(', ')}`);
  const [row] = await t
    .insert(communityShares)
    .values({ tenantId, groupId, planItemId: item.id, kind: 'lesson', caption, assetId: item.assetId, createdBy: actorRef(actor) })
    .returning();
  await audit(t, tenantId, actor, 'community.share.prepared', { type: 'community_share', id: row!.id }, { groupId, planItemId: item.id, kind: 'lesson' });
  return { ...row!, needsAdminApproval: g.permission === 'admin_approval' };
}

export const ShareConfirmSchema = z
  .object({
    status: z.enum(['shared', 'declined']),
    permalink: z
      .string()
      .regex(/^https:\/\/(www\.|m\.|web\.)?facebook\.com\/groups\//)
      .nullable()
      .default(null),
    outcome: z
      .object({ comments: z.number().int().nonnegative().optional(), reactions: z.number().int().nonnegative().optional(), note: z.string().max(1000).optional() })
      .strict()
      .default({}),
  })
  .strict();

/** The owner confirms a share they made (or that the group declined); outcomes are self-reported and labelled so. */
export async function confirmShare(t: Tx, tenantId: string, actor: Actor, shareId: string, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'confirming community shares');
  const input = ShareConfirmSchema.parse(raw);
  const [s] = await t.select().from(communityShares).where(eq(communityShares.id, shareId));
  if (!s) throw notFound('community share');
  if (s.status !== 'prepared' && !(s.status === 'shared' && input.status === 'shared')) throw conflict(`the share is ${s.status}`);
  const now = new Date();
  const [row] = await t
    .update(communityShares)
    .set({ status: input.status, permalink: input.permalink, outcome: { ...input.outcome, selfReported: true }, confirmedBy: actorRef(actor), confirmedAt: now, updatedAt: now })
    .where(eq(communityShares.id, shareId))
    .returning();
  if (input.status === 'shared') {
    await t
      .update(communityGroups)
      .set({ lastSharedAt: now, ...(s.kind === 'permission_request' ? {} : { status: 'member' }), updatedAt: now })
      .where(eq(communityGroups.id, s.groupId));
  }
  if (s.kind === 'permission_request' && input.status === 'declined') {
    await t.update(communityGroups).set({ status: 'declined', updatedAt: now }).where(eq(communityGroups.id, s.groupId));
  }
  await audit(t, tenantId, actor, 'community.share.confirmed', { type: 'community_share', id: shareId }, { status: input.status, kind: s.kind });
  return row!;
}

export async function listShares(t: DbOrTx) {
  return t.select().from(communityShares).orderBy(desc(communityShares.createdAt)).limit(200);
}
