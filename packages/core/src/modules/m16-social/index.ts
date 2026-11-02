import { injectionSignals, PROMPTS, redactPii, untrustedBlock } from '@futuregrow/agent-kernel';
import { fetchPageInsights, fetchPagePosts, fetchPageProfile, type PAGE_INSIGHT_METRICS, PAGE_POST_METRICS, type PagePostMetric, type PagePostObservation, type PageProfile } from '@futuregrow/connectors';
import { actionRequests, assets, claims, connections, type DbOrTx, evidenceRecords, growthIdeas, kgEntities, metricPoints, metricSeries, socialInteractions, socialPosts, syntheticPersonas, type Tx, withTenant } from '@futuregrow/db';
import { conflict, identifierHash, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, gte, inArray, like, lte, max, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runAgent } from '../../agents.js';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, normalizeText, record, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { lintCopy, screenRetrieved, searchKnowledge, upsertEntity } from '../m03-knowledge/index.js';
import { appendPoints, upsertSeries } from '../m08-analytics/index.js';
import { createBrief } from '../m13-creative/index.js';
import { personaContentCheck } from '../m15-personas/index.js';
import { effectiveFreshness } from '../m23-execution/facts.js';
import { type ActionView, cancelAction, currentPolicyDecision, proposeAction } from '../m23-execution/gateway.js';
import { type ActionRow, registerHooks, registerResolver } from '../m23-execution/registry.js';
import { registerWebhookHandler } from '../webhooks.js';

const PLATFORM_PROVIDER = { facebook: 'meta', instagram: 'meta', tiktok: 'tiktok', youtube: 'youtube' } as const;
type Platform = keyof typeof PLATFORM_PROVIDER;

export const ScheduleSchema = z.object({
  connectionId: z.string().uuid(),
  platform: z.enum(['facebook', 'instagram', 'tiktok', 'youtube']),
  personaId: z.string().uuid().nullable().default(null),
  assetIds: z.array(z.string().uuid()).max(10).default([]),
  caption: z.string().min(1).max(5000),
  link: z.string().url().nullable().default(null),
  claimIds: z.array(z.string().uuid()).default([]),
  scheduledAt: z.string().datetime({ offset: true }),
  geographies: z.array(z.string().min(2)).default([]),
  disclosure: z.object({ isAiGenerated: z.boolean().default(false), paidPartnership: z.boolean().default(false), disclosureText: z.string().max(300).nullable().default(null) }).default({ isAiGenerated: false, paidPartnership: false, disclosureText: null }),
  options: z
    .object({
      tiktokPrivacy: z.enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']).default('SELF_ONLY'),
      youtubeTitle: z.string().max(100).optional(),
      youtubePrivacy: z.enum(['public', 'unlisted', 'private']).default('private'),
      igUserId: z.string().optional(),
    })
    .default({ tiktokPrivacy: 'SELF_ONLY', youtubePrivacy: 'private' }),
});

/**
 * Schedule a post. Anti-spam integrity guards (not business thresholds): the same caption cannot
 * be scheduled to the same account twice within 7 days, and posts to one account are at least
 * 15 minutes apart. Engagement is never manufactured.
 */
export async function schedulePost(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'scheduling social posts');
  const p = ScheduleSchema.parse(raw);
  const [conn] = await tx.select().from(connections).where(eq(connections.id, p.connectionId));
  if (!conn) throw notFound('connection');
  if (conn.provider !== PLATFORM_PROVIDER[p.platform]) throw invalid(`connection is ${conn.provider}, platform ${p.platform} needs ${PLATFORM_PROVIDER[p.platform]}`);
  if ((p.platform === 'instagram' || p.platform === 'tiktok' || p.platform === 'youtube') && p.assetIds.length === 0) throw invalid(`${p.platform} posts need media`);
  if (p.platform === 'facebook' && p.assetIds.length > 0) throw invalid('facebook page posts here are text/link only');
  let caption = p.caption;
  const disclosure = { ...p.disclosure, syntheticPersonaId: p.personaId };
  if (p.personaId) {
    const [persona] = await tx.select().from(syntheticPersonas).where(eq(syntheticPersonas.id, p.personaId));
    if (!persona || persona.status !== 'approved') throw invalid('persona is not approved');
    const check = personaContentCheck(caption);
    if (!check.passed) throw invalid('persona caption makes first-person customer-experience claims');
    disclosure.isAiGenerated = true;
    disclosure.disclosureText = persona.disclosureCopy;
    if (!caption.toLowerCase().includes(persona.disclosureCopy.toLowerCase())) caption = `${caption}\n\n${persona.disclosureCopy}`;
  }
  if (p.disclosure.paidPartnership && !p.disclosure.disclosureText) throw invalid('paid partnership posts need disclosure text (e.g. "#ad")');
  if (disclosure.disclosureText && !caption.toLowerCase().includes(disclosure.disclosureText.toLowerCase())) caption = `${caption}\n\n${disclosure.disclosureText}`;
  const lint = await lintCopy(tx, caption, { claimIds: p.claimIds, channel: p.platform, now: deps.clock.now() });
  if (!lint.passed)
    throw invalid(
      `caption failed lint: ${lint.violations
        .filter((v) => v.severity === 'block')
        .map((v) => v.code)
        .join(', ')}`,
    );
  if (p.assetIds.length) {
    const rows = await tx.select().from(assets).where(inArray(assets.id, p.assetIds));
    const bad = rows.filter((a) => !a.publishEligible);
    if (rows.length !== p.assetIds.length || bad.length) throw invalid(`assets not publish-eligible: ${bad.map((b) => b.id).join(', ') || 'missing'}`);
  }
  const at = new Date(p.scheduledAt);
  await assertNotSpam(tx, p.connectionId, caption, at);
  const [row] = await tx
    .insert(socialPosts)
    .values({
      tenantId,
      connectionId: p.connectionId,
      platform: p.platform,
      personaId: p.personaId,
      assetIds: p.assetIds,
      caption,
      link: p.link,
      claimIds: p.claimIds,
      disclosure: { ...disclosure, options: p.options, geographies: p.geographies },
      scheduledAt: at,
      status: 'scheduled',
      createdBy: actorRef(actor),
    })
    .returning();
  await record(tx, tenantId, actor, 'social.post.scheduled', { type: 'social_post', id: row!.id }, { platform: p.platform, scheduledAt: p.scheduledAt });
  return row!;
}

// Spam key: case, punctuation and spacing do not make a caption new.
const spamKey = (c: string) =>
  sha256Hex(
    normalizeText(c)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim(),
  );

async function assertNotSpam(tx: Tx, connectionId: string, caption: string, at: Date) {
  const hash = spamKey(caption);
  const recent = await tx
    .select({ id: socialPosts.id, caption: socialPosts.caption, scheduledAt: socialPosts.scheduledAt })
    .from(socialPosts)
    .where(and(eq(socialPosts.connectionId, connectionId), inArray(socialPosts.status, ['scheduled', 'submitted', 'published_verified']), gte(socialPosts.scheduledAt, new Date(at.getTime() - 7 * 86_400_000))));
  if (recent.some((r) => spamKey(r.caption) === hash)) throw conflict('the same caption was already scheduled to this account in the last 7 days');
  if (recent.some((r) => Math.abs(r.scheduledAt.getTime() - at.getTime()) < 15 * 60_000)) throw conflict('posts to the same account must be at least 15 minutes apart');
}

const PUBLISH_PLATFORM: Record<string, { platform: Platform; captionKey: string }> = {
  'social.facebook.publish_post': { platform: 'facebook', captionKey: 'message' },
  'social.instagram.publish_media': { platform: 'instagram', captionKey: 'caption' },
  'social.tiktok.publish_video': { platform: 'tiktok', captionKey: 'title' },
  'social.youtube.upload_video': { platform: 'youtube', captionKey: 'description' },
};

/**
 * Autopilot publishing (D-033): a Growth Brain publish decision gets a real M16 post record before
 * it reaches M23, with the same copy lint and anti-spam guards as a scheduled post. The post is
 * created as 'submitted' (the scheduler never dispatches it); M23 policy, approval and
 * verification decide the rest. Returns the params with the new post id, or the params unchanged
 * for other action types or when the post already exists (retries).
 */
export async function postForPublishAction(tx: Tx, deps: CoreDeps, tenantId: string, input: { actionType: string; connectionId: string | null; params: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const spec = PUBLISH_PLATFORM[input.actionType];
  if (!spec) return input.params;
  const existingId = input.params.postId as string | undefined;
  if (existingId) {
    const [existing] = await tx.select({ id: socialPosts.id }).from(socialPosts).where(eq(socialPosts.id, existingId));
    if (existing) return input.params;
  }
  if (!input.connectionId) throw invalid('publishing needs a connection');
  const [conn] = await tx.select().from(connections).where(eq(connections.id, input.connectionId));
  if (!conn || conn.provider !== PLATFORM_PROVIDER[spec.platform]) throw invalid(`no ${PLATFORM_PROVIDER[spec.platform]} connection for ${spec.platform}`);
  const caption = String(input.params[spec.captionKey] ?? '').trim();
  if (!caption) throw invalid('the post has no text');
  const claimIds = Array.isArray(input.params.claimIds) ? (input.params.claimIds as string[]) : [];
  const assetIds = Array.isArray(input.params.assetIds) ? (input.params.assetIds as string[]) : [];
  const lint = await lintCopy(tx, caption, { claimIds, channel: spec.platform, now: deps.clock.now() });
  if (!lint.passed)
    throw invalid(
      `caption failed lint: ${lint.violations
        .filter((v) => v.severity === 'block')
        .map((v) => v.code)
        .join(', ')}`,
    );
  const now = deps.clock.now();
  await assertNotSpam(tx, input.connectionId, caption, now);
  const disclosure = (input.params.disclosure as Record<string, unknown> | undefined) ?? { isAiGenerated: false, paidPartnership: false, syntheticPersonaId: null, disclosureText: null };
  const actor = systemActor('autopilot');
  const [row] = await tx
    .insert(socialPosts)
    .values({
      tenantId,
      connectionId: input.connectionId,
      platform: spec.platform,
      personaId: (disclosure.syntheticPersonaId as string | null) ?? null,
      assetIds,
      caption,
      link: typeof input.params.link === 'string' ? input.params.link : null,
      claimIds,
      disclosure: { ...disclosure, options: {}, geographies: [] },
      scheduledAt: now,
      status: 'submitted',
      createdBy: actorRef(actor),
    })
    .returning();
  await record(tx, tenantId, actor, 'social.post.scheduled', { type: 'social_post', id: row!.id }, { platform: spec.platform, scheduledAt: now.toISOString(), via: 'autopilot' });
  return { ...input.params, postId: row!.id };
}

function postAction(post: typeof socialPosts.$inferSelect, conn: typeof connections.$inferSelect, assetKinds: Record<string, string>) {
  const d = post.disclosure as { isAiGenerated: boolean; paidPartnership: boolean; disclosureText: string | null; syntheticPersonaId: string | null; options: Record<string, string>; geographies: string[] };
  const disclosure = { isAiGenerated: d.isAiGenerated, paidPartnership: d.paidPartnership, syntheticPersonaId: d.syntheticPersonaId, disclosureText: d.disclosureText };
  const first = post.assetIds[0];
  switch (post.platform as Platform) {
    case 'facebook':
      return { actionType: 'social.facebook.publish_post', params: { pageId: conn.externalAccountId, message: post.caption, ...(post.link ? { link: post.link } : {}), postId: post.id, assetIds: [], claimIds: post.claimIds, disclosure } };
    case 'instagram':
      return {
        actionType: 'social.instagram.publish_media',
        params: { igUserId: d.options.igUserId ?? conn.externalAccountId, mediaType: assetKinds[first!] === 'video' ? 'REELS' : 'IMAGE', mediaUrl: `asset://${first}`, caption: post.caption.slice(0, 2200), postId: post.id, assetIds: post.assetIds, claimIds: post.claimIds, disclosure },
      };
    case 'tiktok':
      return {
        actionType: 'social.tiktok.publish_video',
        params: {
          title: post.caption.slice(0, 2200),
          videoUrl: `asset://${first}`,
          privacyLevel: d.options.tiktokPrivacy ?? 'SELF_ONLY',
          disableComment: false,
          disableDuet: false,
          disableStitch: false,
          brandContentToggle: d.paidPartnership,
          brandOrganicToggle: !d.paidPartnership,
          postId: post.id,
          assetIds: post.assetIds,
          claimIds: post.claimIds,
          disclosure,
        },
      };
    case 'youtube':
      return {
        actionType: 'social.youtube.upload_video',
        params: {
          title: (d.options.youtubeTitle ?? post.caption).slice(0, 100),
          description: post.caption.slice(0, 5000),
          privacyStatus: d.options.youtubePrivacy ?? 'private',
          categoryId: '22',
          containsSyntheticMedia: d.isAiGenerated,
          madeForKids: false,
          postId: post.id,
          assetIds: [first!],
          claimIds: post.claimIds,
          disclosure,
        },
      };
  }
}

/** Scheduler: due posts become ActionRequests attributed to the human who scheduled them. */
export async function dispatchDuePosts(deps: CoreDeps, tenantId: string) {
  const due = await withTenant(deps.db, { tenantId, actor: 'system:social-scheduler' }, (tx) =>
    tx
      .select()
      .from(socialPosts)
      .where(and(eq(socialPosts.status, 'scheduled'), lte(socialPosts.scheduledAt, deps.clock.now())))
      .limit(50),
  );
  const out: { postId: string; actionId: string; status: string }[] = [];
  for (const post of due) {
    const { conn, kinds } = await withTenant(deps.db, { tenantId, actor: 'system:social-scheduler' }, async (tx) => {
      const [c] = await tx.select().from(connections).where(eq(connections.id, post.connectionId));
      const rows = post.assetIds.length ? await tx.select({ id: assets.id, kind: assets.kind }).from(assets).where(inArray(assets.id, post.assetIds)) : [];
      return { conn: c!, kinds: Object.fromEntries(rows.map((r) => [r.id, r.kind])) };
    });
    const a = postAction(post, conn, kinds);
    const userId = post.createdBy.replace(/^user:/, '');
    const view = await proposeAction(
      deps,
      tenantId,
      { type: 'user', id: userId, roles: [], mfaVerified: false },
      {
        actionType: a.actionType,
        connectionId: post.connectionId,
        params: a.params,
        risk: { geographies: (post.disclosure as { geographies?: string[] }).geographies ?? [], syntheticPersonaId: post.personaId, materialConnection: (post.disclosure as { paidPartnership?: boolean }).paidPartnership === true },
        idempotencyKey: `social-post:${post.id}`,
      },
    );
    const denied = view.status === 'DENIED' || view.status === 'REJECTED';
    await withTenant(deps.db, { tenantId, actor: 'system:social-scheduler' }, (tx) =>
      tx
        .update(socialPosts)
        .set({ status: denied ? 'blocked' : 'submitted', actionId: view.id, statusReason: denied ? (view.statusReason ?? 'denied by policy') : null })
        .where(and(eq(socialPosts.id, post.id), eq(socialPosts.status, 'scheduled'))),
    );
    out.push({ postId: post.id, actionId: view.id, status: view.status });
  }
  return out;
}

/** asset:// references become fresh URLs only at the execution boundary (never stored). */
async function resolveMediaUrl(deps: CoreDeps, tx: Tx, ref: string): Promise<string> {
  if (!ref.startsWith('asset://')) return ref;
  const id = ref.slice('asset://'.length);
  const [a] = await tx.select().from(assets).where(eq(assets.id, id));
  if (!a) throw new Error(`asset ${id} missing`);
  const base = process.env.FG_MEDIA_PUBLIC_BASE_URL;
  if (base) return `${base.replace(/\/$/, '')}/${a.objectKey}`;
  const url = await deps.store.presign(a.objectKey, 'GET', 3600);
  if (!url) throw new Error('no public media URL available (configure R2 or FG_MEDIA_PUBLIC_BASE_URL)');
  return url;
}

registerResolver('social.instagram.publish_media', async (deps, tx, action: ActionRow) => ({ ...action.params, mediaUrl: await resolveMediaUrl(deps, tx, action.params.mediaUrl as string) }));
registerResolver('social.tiktok.publish_video', async (deps, tx, action: ActionRow) => ({ ...action.params, videoUrl: await resolveMediaUrl(deps, tx, action.params.videoUrl as string) }));

for (const t of ['social.facebook.publish_post', 'social.instagram.publish_media', 'social.tiktok.publish_video', 'social.youtube.upload_video']) {
  registerHooks(t, {
    async onVerified(tx, action, receipt, proof) {
      const postId = (action.params as { postId: string }).postId;
      const observed = (proof.observed ?? {}) as { permalink_url?: string; permalink?: string };
      await tx
        .update(socialPosts)
        .set({ status: 'published_verified', externalPostId: receipt.providerObjectId, externalUrl: observed.permalink_url ?? observed.permalink ?? null, verifiedAt: new Date() })
        .where(eq(socialPosts.id, postId));
    },
    async onTerminalFailure(tx, action, status, reason) {
      const postId = (action.params as { postId: string }).postId;
      await tx
        .update(socialPosts)
        .set({ status: status === 'CANCELLED' ? 'cancelled' : 'failed', statusReason: `${status}: ${reason}`.slice(0, 2000) })
        .where(eq(socialPosts.id, postId));
    },
  });
}

/* ------------------------------------------------------------------ */
/* Community interactions                                              */
/* ------------------------------------------------------------------ */

const ABUSE = /\b(kill yourself|kys|idiot|stupid|scam|fraud|lawsuit|sue you|lawyer|attorney)\b/i;

export function moderate(text: string) {
  const injection = injectionSignals(text);
  const escalation = ABUSE.test(text);
  return { injectionSignals: injection, needsEscalation: escalation || injection.length > 0, abusiveOrLegal: escalation };
}

export async function recordInteraction(tx: Tx, deps: CoreDeps, tenantId: string, input: { connectionId: string; platform: string; externalId: string; parentExternalId?: string | null; kind: 'comment' | 'mention' | 'message'; authorId: string; text: string; receivedAt: Date }) {
  const [row] = await tx
    .insert(socialInteractions)
    .values({
      tenantId,
      connectionId: input.connectionId,
      platform: input.platform,
      externalId: input.externalId,
      parentExternalId: input.parentExternalId ?? null,
      kind: input.kind,
      authorHash: identifierHash(deps.config.identifierPepper, 'social_author', input.authorId),
      text: input.text.slice(0, 8000),
      receivedAt: input.receivedAt,
      moderation: moderate(input.text),
    })
    .onConflictDoNothing()
    .returning();
  if (row) await record(tx, tenantId, systemActor('social'), 'social.interaction.received', { type: 'social_interaction', id: row.id }, { platform: input.platform, kind: input.kind });
  return row ?? null;
}

/** Meta webhook: page feed comments (field "feed", item "comment", verb "add"). */
registerWebhookHandler('meta', async ({ deps, tenantId, connectionId, payload }) => {
  if (!tenantId || !connectionId) return 'ignored';
  const p = payload as { object?: string; entry?: { id: string; changes?: { field: string; value: { item?: string; verb?: string; comment_id?: string; post_id?: string; message?: string; from?: { id?: string }; created_time?: number } }[] }[] };
  if (p.object !== 'page') return 'ignored';
  let n = 0;
  await withTenant(deps.db, { tenantId, actor: 'connector:meta' }, async (tx) => {
    for (const e of p.entry ?? []) {
      for (const c of e.changes ?? []) {
        const v = c.value;
        if (c.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add' || !v.comment_id || !v.message) continue;
        if (v.from?.id === e.id) continue; // the Page's own comments, including replies sent through M23
        const r = await recordInteraction(tx, deps, tenantId, {
          connectionId,
          platform: 'facebook',
          externalId: v.comment_id,
          parentExternalId: v.post_id ?? null,
          kind: 'comment',
          authorId: v.from?.id ?? 'unknown',
          text: v.message,
          receivedAt: v.created_time ? new Date(v.created_time * 1000) : new Date(),
        });
        if (r) n++;
      }
    }
  });
  return n ? 'processed' : 'ignored';
});

const ReplySchema = z.object({ recommendPublicReply: z.boolean(), escalate: z.boolean(), reason: z.string().max(500), reply: z.string().max(2000), citedChunkIds: z.array(z.string()) });

export async function draftReply(deps: CoreDeps, tenantId: string, actor: Actor, interactionId: string) {
  return runAgent(deps, tenantId, { kind: 'reply_draft', agentId: 'community-assistant', triggeredBy: actorRef(actor), input: { interactionId } }, async (ctx) => {
    const { it, chunks } = await withTenant(deps.db, { tenantId, actor: 'agent:community-assistant' }, async (tx) => {
      const [i] = await tx.select().from(socialInteractions).where(eq(socialInteractions.id, interactionId));
      if (!i) throw notFound('interaction');
      const c = await searchKnowledge(tx, { query: i.text.slice(0, 300), roles: [], audience: 'public', limit: 6, match: 'any' });
      return { it: i, chunks: screenRetrieved(c).kept };
    });
    const mod = it.moderation as { needsEscalation?: boolean };
    if (mod.needsEscalation) {
      await withTenant(deps.db, { tenantId, actor: 'agent:community-assistant' }, (tx) => tx.update(socialInteractions).set({ replyStatus: 'skipped' }).where(eq(socialInteractions.id, it.id)));
      ctx.note('moderation', { escalated: true });
      return { draft: null, escalate: true };
    }
    const r = await ctx.think('reply', PROMPTS.socialReply, {
      purpose: 'generation',
      outputSchema: ReplySchema,
      messages: [{ role: 'user', content: `Public comment:\n${untrustedBlock('social_comment', redactPii(it.text))}\n\nKnowledge excerpts:\n${chunks.map((c) => untrustedBlock(`chunk:${c.chunkId}`, c.text)).join('\n')}` }],
    });
    const valid = new Set(chunks.map((c) => c.chunkId));
    const lint = await withTenant(deps.db, { tenantId, actor: 'agent:community-assistant' }, (tx) => lintCopy(tx, r.output.reply, { claimIds: [], now: deps.clock.now() }));
    const usable = r.output.recommendPublicReply && !r.output.escalate && r.output.citedChunkIds.every((id) => valid.has(id)) && lint.passed && r.output.reply.trim().length > 0;
    await withTenant(deps.db, { tenantId, actor: 'agent:community-assistant' }, (tx) =>
      tx
        .update(socialInteractions)
        .set({ replyDraft: usable ? r.output.reply : null, replyStatus: usable ? 'drafted' : 'skipped' })
        .where(eq(socialInteractions.id, it.id)),
    );
    ctx.note('validate', { usable, lintPassed: lint.passed });
    return { draft: usable ? r.output.reply : null, escalate: !usable };
  });
}

/** A human sends (or edits then sends) a drafted reply through M23. */
export async function proposeReply(deps: CoreDeps, tenantId: string, actor: Actor, interactionId: string, input: { message?: string; geographies: string[] }) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'replying to comments');
  const it = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => (await tx.select().from(socialInteractions).where(eq(socialInteractions.id, interactionId)))[0]);
  if (!it) throw notFound('interaction');
  const message = input.message ?? it.replyDraft;
  if (!message) throw invalid('no reply text');
  const lint = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => lintCopy(tx, message, { claimIds: [], now: deps.clock.now() }));
  if (!lint.passed) throw invalid('reply failed lint');
  const view = await proposeAction(deps, tenantId, actor, {
    actionType: 'social.facebook.reply_comment',
    connectionId: it.connectionId,
    params: { commentId: it.externalId, message, interactionId: it.id, claimIds: [] },
    risk: { geographies: input.geographies },
    idempotencyKey: `reply:${it.id}`,
  });
  await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => tx.update(socialInteractions).set({ replyStatus: 'submitted', replyActionId: view.id }).where(eq(socialInteractions.id, it.id)));
  return view;
}

registerHooks('social.facebook.reply_comment', {
  async onVerified(tx, action) {
    await tx
      .update(socialInteractions)
      .set({ replyStatus: 'sent_verified' })
      .where(eq(socialInteractions.id, (action.params as { interactionId: string }).interactionId));
  },
});

export async function listPosts(tx: DbOrTx) {
  return tx.select().from(socialPosts).orderBy(desc(socialPosts.scheduledAt)).limit(200);
}

export async function listInteractions(tx: DbOrTx) {
  return tx.select().from(socialInteractions).orderBy(desc(socialInteractions.receivedAt)).limit(200);
}

export async function audienceStats(tx: DbOrTx) {
  const r = await tx.execute<{ platform: string; posts: number; verified: number }>(sql`select platform, count(*)::int as posts, count(*) filter (where status = 'published_verified')::int as verified from social_posts group by platform`);
  return r.rows;
}

/* ------------------------------------------------------------------ */
/* Organic Page insights → M08 KPI series                              */
/* ------------------------------------------------------------------ */

/** M08 KPI series fed by the Page insights sync, one per Meta metric. */
export const FACEBOOK_INSIGHT_SERIES = {
  page_post_engagements: { key: 'kpi.facebook.page_post_engagements', name: 'Facebook Page post engagements', unit: 'engagements' },
  page_daily_follows_unique: { key: 'kpi.facebook.page_daily_follows_unique', name: 'Facebook Page new follows', unit: 'follows' },
  page_media_view: { key: 'kpi.facebook.page_media_view', name: 'Facebook Page content views', unit: 'views' },
  page_views_total: { key: 'kpi.facebook.page_views_total', name: 'Facebook Page profile views', unit: 'views' },
} as const satisfies Record<(typeof PAGE_INSIGHT_METRICS)[number], { key: string; name: string; unit: string }>;

export const FACEBOOK_ENGAGEMENT_SERIES_KEY = FACEBOOK_INSIGHT_SERIES.page_post_engagements.key;
export const isFacebookInsightsKey = (key: string) => Object.values(FACEBOOK_INSIGHT_SERIES).some((s) => s.key === key);

/** The first sync backfills as far as one request reaches; later syncs refresh the days Meta may still revise. */
const INSIGHTS_BACKFILL_DAYS = 88;
const INSIGHTS_REFRESH_DAYS = 7;

export interface PageInsightsSync {
  pageId: string;
  from: string;
  to: string;
  metrics: Record<string, { status: string; days: number; seriesId?: string; error?: string }>;
  points: number;
  evidenceId: string | null;
  note: string | null;
}

/**
 * Pull daily organic Page insights into M08 KPI series, each point backed by the admitted evidence
 * of the fetch, so forecasts, goals and the Growth Brain can use real engagement. Idempotent
 * (points are upserted by day); days Meta returns no value for stay absent, never zero-filled.
 * A series belongs to one Page (its channel is `facebook:<page id>`): another Page's values are
 * refused rather than mixed in.
 */
export async function syncPageInsights(deps: CoreDeps, tenantId: string, connectionId: string, opts: { actor?: Actor } = {}): Promise<PageInsightsSync> {
  const actor = opts.actor ?? systemActor('page-insights-sync');
  if (actor.type === 'user') requireRole(actor, ['owner', 'admin', 'growth_operator'], 'syncing Page insights');
  const { connection, ctx } = await readContext(deps, tenantId, connectionId, 'meta');
  const tctx = { tenantId, actor: actorRef(actor) };
  const now = deps.clock.now();
  const pageId = connection.externalAccountId;
  const owner = `facebook:${pageId}`;
  const defs = Object.entries(FACEBOOK_INSIGHT_SERIES) as [string, (typeof FACEBOOK_INSIGHT_SERIES)[keyof typeof FACEBOOK_INSIGHT_SERIES]][];
  const existing = await withTenant(deps.db, tctx, (tx) =>
    tx
      .select({ key: metricSeries.key, channel: metricSeries.channel, last: max(metricPoints.ts) })
      .from(metricSeries)
      .leftJoin(metricPoints, eq(metricPoints.seriesId, metricSeries.id))
      .where(
        inArray(
          metricSeries.key,
          defs.map(([, d]) => d.key),
        ),
      )
      .groupBy(metricSeries.key, metricSeries.channel),
  );
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const metrics: PageInsightsSync['metrics'] = {};
  const wanted: string[] = [];
  for (const [metric, d] of defs) {
    const s = byKey.get(d.key);
    if (s && s.channel !== owner) metrics[metric] = { status: 'other_page', days: 0, error: `${d.key} already holds ${s.channel ?? 'other'} data` };
    else wanted.push(metric);
  }
  const day = (offsetDays: number) => new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const recent = (key: string) => {
    const last = byKey.get(key)?.last;
    return Boolean(last && now.getTime() - new Date(last).getTime() < 30 * 86_400_000);
  };
  const to = day(-1);
  // Metrics with recent values refresh the last week; the others (new, or never answered) backfill.
  const fresh = wanted.filter((m) => recent(FACEBOOK_INSIGHT_SERIES[m as keyof typeof FACEBOOK_INSIGHT_SERIES].key));
  const stale = wanted.filter((m) => !fresh.includes(m));
  const from = day(stale.length ? -INSIGHTS_BACKFILL_DAYS : -INSIGHTS_REFRESH_DAYS);
  const fetched = {
    ...(fresh.length ? await fetchPageInsights(ctx, day(-INSIGHTS_REFRESH_DAYS), to, fresh) : {}),
    ...(stale.length ? await fetchPageInsights(ctx, day(-INSIGHTS_BACKFILL_DAYS), to, stale) : {}),
  };

  return withTenant(deps.db, tctx, async (tx) => {
    const total = Object.values(fetched).reduce((s, r) => s + r.values.length, 0);
    let evidenceId: string | null = null;
    let points = 0;
    if (total > 0) {
      const ev = await admitInternalEvidence(tx, tenantId, actor, {
        kind: 'metric',
        sourceType: 'primary',
        owner: 'meta',
        uri: `meta://page/${pageId}/insights/${from}..${to}@${now.toISOString()}`,
        content: { pageId, from, to, metrics: fetched },
        summary: `Facebook Page ${connection.displayName} insights ${from}..${to}: ${Object.entries(fetched)
          .map(([m, r]) => `${m} ${r.values.length} day${r.values.length === 1 ? '' : 's'}`)
          .join(', ')}`,
        confidence: 1,
        license: 'Meta Platform Terms (authorized Page data)',
        permittedUses: ['analytics', 'forecasting', 'causal_measurement'],
        externalPlatformTerms: 'meta',
        freshnessSlaHours: 48,
        now,
      });
      if (ev.status === 'admitted') evidenceId = ev.evidenceId;
    }
    for (const [metric, r] of Object.entries(fetched)) {
      const d = FACEBOOK_INSIGHT_SERIES[metric as keyof typeof FACEBOOK_INSIGHT_SERIES];
      metrics[metric] = { status: r.status, days: r.values.length, ...(r.error ? { error: r.error } : {}) };
      if (!r.values.length || !evidenceId) continue;
      const series = await upsertSeries(tx, tenantId, actor, { key: d.key, name: `${d.name} (${connection.displayName})`.slice(0, 300), unit: d.unit, granularity: 'day', kind: 'kpi', channel: owner, sourceEvidenceId: evidenceId });
      if (series.channel !== owner) {
        metrics[metric] = { status: 'other_page', days: 0, error: `${d.key} already holds ${series.channel ?? 'other'} data` };
        continue;
      }
      await appendPoints(
        tx,
        tenantId,
        series.id,
        r.values.map((v) => ({ ts: `${v.date}T00:00:00Z`, value: v.value, evidenceId })),
      );
      metrics[metric]!.seriesId = series.id;
      points += r.values.length;
    }
    const scopes = connection.grantedScopes ?? [];
    const note =
      points > 0
        ? null
        : wanted.length === 0
          ? 'Every Facebook insights series already belongs to another Page.'
          : total > 0
            ? 'The fetched insights were not admitted as evidence, so no values were stored.'
            : `Meta returned no Page insights values for ${from}..${to}.${scopes.includes('read_insights') ? '' : ' The Page token was not granted read_insights; reconnect the Page with that permission.'} Meta may also withhold insights from small Pages.`;
    await record(tx, tenantId, actor, 'social.insights.synced', { type: 'connection', id: connectionId }, { pageId, from, to, points, evidenceId, metrics: Object.fromEntries(Object.entries(metrics).map(([m, r]) => [m, r.status])) });
    return { pageId, from, to, metrics, points, evidenceId, note };
  });
}

/* ------------------------------------------------------------------ */
/* Organic post counters: daily snapshots and their changes (D-035)    */
/* ------------------------------------------------------------------ */

/**
 * Signal series derived from two consecutive daily post snapshots. They never use the Page
 * insights KPI keys: post counters are lifetime totals, not Meta's daily engagement metric.
 */
export const FACEBOOK_POST_CHANGE_SERIES = {
  reactions: { key: 'signal.facebook.posts.reactions_change', name: 'Facebook post reactions gained between daily snapshots', unit: 'reactions' },
  comments: { key: 'signal.facebook.posts.comments_change', name: 'Facebook post top-level comments gained between daily snapshots', unit: 'comments' },
  shares: { key: 'signal.facebook.posts.shares_change', name: 'Facebook post shares gained between daily snapshots', unit: 'shares' },
} as const satisfies Record<PagePostMetric, { key: string; name: string; unit: string }>;

const POST_METRICS = Object.keys(PAGE_POST_METRICS) as PagePostMetric[];
const SNAPSHOT_WINDOW_DAYS = 90;
/** A change is derived only from the previous UTC day's snapshot taken 12–36 hours earlier. */
const CHANGE_MIN_HOURS = 12;
const CHANGE_MAX_HOURS = 36;
const pageUri = (pageId: string, what: 'posts' | 'profile', day?: string) => `meta://page/${pageId}/${what}@${day ?? ''}`;

export interface PostChange {
  previousEvidenceId: string;
  previousObservedAt: string;
  /** Summed change over posts with a value in both reads (or created after the first); null when no post qualifies. */
  metrics: Record<PagePostMetric, { value: number | null; posts: number; excluded: number }>;
}

interface PostSnapshotContent {
  schema: 'facebook.page_post_snapshot.v1';
  pageId: string;
  connectionId: string;
  observedAt: string;
  window: { since: string; truncated: boolean };
  definitions: Record<PagePostMetric, string>;
  posts: PagePostObservation[];
  change: PostChange | null;
}

export interface PostTotals {
  posts: number;
  /** Lifetime totals at the read time over the posts that returned the counter. */
  metrics: Record<PagePostMetric, { value: number; posts: number; notReturned: number }>;
}

export interface PostSnapshotResult {
  pageId: string;
  day: string;
  observedAt: string;
  /** true: today's snapshot already existed, so Meta was not called again. */
  reused: boolean;
  evidenceId: string | null;
  totals: PostTotals;
  stats: ReturnType<typeof organicStats>;
  change: PostChange | null;
  points: number;
  note: string | null;
}

export function postTotals(posts: PagePostObservation[]): PostTotals {
  const metrics = Object.fromEntries(
    POST_METRICS.map((m) => {
      const ok = posts.filter((p) => p.metrics[m].status === 'ok');
      return [m, { value: ok.reduce((s, p) => s + (p.metrics[m].value ?? 0), 0), posts: ok.length, notReturned: posts.length - ok.length }];
    }),
  ) as PostTotals['metrics'];
  return { posts: posts.length, metrics };
}

/**
 * The change of each counter between two reads. A post counts when both reads returned the
 * counter, or when it was created after the first read (it did not exist then). Posts missing
 * from either read, or with an unreturned counter, are excluded: unknown never becomes zero.
 */
export function postChange(previous: { evidenceId: string; observedAt: string; posts: PagePostObservation[] }, current: PagePostObservation[]): PostChange {
  const before = new Map(previous.posts.map((p) => [p.id, p]));
  const firstRead = Date.parse(previous.observedAt);
  const metrics = Object.fromEntries(
    POST_METRICS.map((m) => {
      let value = 0;
      let posts = 0;
      let excluded = 0;
      for (const p of current) {
        const now = p.metrics[m];
        const then = before.get(p.id)?.metrics[m];
        if (now.status === 'ok' && then?.status === 'ok') value += now.value! - then.value!;
        else if (now.status === 'ok' && !then && Date.parse(p.createdTime) > firstRead) value += now.value!;
        else {
          excluded++;
          continue;
        }
        posts++;
      }
      return [m, { value: posts ? value : null, posts, excluded }];
    }),
  ) as PostChange['metrics'];
  return { previousEvidenceId: previous.evidenceId, previousObservedAt: previous.observedAt, metrics };
}

/** Facts a person or a model can read about a Page's recent posting (deterministic). */
export function organicStats(posts: PagePostObservation[], now: Date) {
  const sorted = [...posts].sort((a, b) => b.createdTime.localeCompare(a.createdTime));
  const last = sorted[0]?.createdTime ?? null;
  const formats = new Map<string, PagePostObservation[]>();
  for (const p of posts) formats.set(p.statusType ?? 'unknown', [...(formats.get(p.statusType ?? 'unknown') ?? []), p]);
  const mean = (ps: PagePostObservation[], m: PagePostMetric) => {
    const ok = ps.filter((p) => p.metrics[m].status === 'ok');
    return ok.length ? ok.reduce((s, p) => s + p.metrics[m].value!, 0) / ok.length : null;
  };
  return {
    posts: posts.length,
    lastPostAt: last,
    daysSinceLastPost: last ? Math.floor((now.getTime() - Date.parse(last)) / 86_400_000) : null,
    activeDays: new Set(posts.map((p) => p.createdTime.slice(0, 10))).size,
    formats: [...formats].map(([statusType, ps]) => ({ statusType, posts: ps.length, meanReactions: mean(ps, 'reactions'), meanComments: mean(ps, 'comments') })),
    topPosts: [...posts]
      .filter((p) => p.metrics.reactions.status === 'ok' || p.metrics.comments.status === 'ok')
      .sort((a, b) => (b.metrics.reactions.value ?? 0) + (b.metrics.comments.value ?? 0) - ((a.metrics.reactions.value ?? 0) + (a.metrics.comments.value ?? 0)))
      .slice(0, 3)
      .map((p) => ({ id: p.id, createdTime: p.createdTime, statusType: p.statusType, reactions: p.metrics.reactions.value, comments: p.metrics.comments.value, excerpt: (p.message ?? '').replace(/\s+/g, ' ').slice(0, 120) })),
  };
}

export function describeTotals(t: PostTotals): string {
  return POST_METRICS.map((m) => {
    const r = t.metrics[m];
    const label = m === 'comments' ? 'top-level comments' : m;
    if (!r.posts) return `${label} not returned by Meta`;
    return `${label} ${r.value} (from ${r.posts} post${r.posts === 1 ? '' : 's'}${r.notReturned ? `; not returned for ${r.notReturned}` : ''})`;
  }).join(', ');
}

/**
 * Read the Page's own posts of the last 90 days with their reaction, comment and share counters
 * and store them as one evidence snapshot per Page and UTC day (idempotent: a second call that
 * day reuses the stored snapshot and makes no Graph call). When yesterday's snapshot exists
 * 12–36 h earlier, the change between the two reads is stored as signal series points for today;
 * nothing is backfilled and missing counters stay missing.
 */
export async function collectPagePostSnapshot(deps: CoreDeps, tenantId: string, connectionId: string, opts: { actor?: Actor } = {}): Promise<PostSnapshotResult> {
  const actor = opts.actor ?? systemActor('page-post-snapshot');
  if (actor.type === 'user') requireRole(actor, ['owner', 'admin', 'growth_operator'], 'collecting Page post counters');
  const { connection, ctx } = await readContext(deps, tenantId, connectionId, 'meta');
  const tctx = { tenantId, actor: actorRef(actor) };
  const now = deps.clock.now();
  const pageId = connection.externalAccountId;
  const day = now.toISOString().slice(0, 10);
  const snapshots = (t: DbOrTx) =>
    t
      .select({ id: evidenceRecords.id, uri: evidenceRecords.sourceUriOrObjectId, observedAt: evidenceRecords.observedAt, content: evidenceRecords.content })
      .from(evidenceRecords)
      .where(and(like(evidenceRecords.sourceUriOrObjectId, `${pageUri(pageId, 'posts')}%`), eq(evidenceRecords.status, 'admitted')))
      .orderBy(desc(evidenceRecords.observedAt))
      .limit(1);
  const [latest] = await withTenant(deps.db, tctx, snapshots);
  if (latest && latest.uri === pageUri(pageId, 'posts', day)) {
    const c = latest.content as PostSnapshotContent;
    return { pageId, day, observedAt: c.observedAt, reused: true, evidenceId: latest.id, totals: postTotals(c.posts), stats: organicStats(c.posts, new Date(c.observedAt)), change: c.change, points: 0, note: null };
  }
  const since = new Date(now.getTime() - SNAPSHOT_WINDOW_DAYS * 86_400_000);
  const read = await fetchPagePosts(ctx, { since });
  const prev = latest ? { evidenceId: latest.id, observedAt: (latest.observedAt ?? now).toISOString(), posts: (latest.content as PostSnapshotContent).posts, day: latest.uri.slice(-10) } : null;
  const gapHours = prev ? (now.getTime() - Date.parse(prev.observedAt)) / 3_600_000 : null;
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const consecutive = prev !== null && prev.day === yesterday && gapHours! >= CHANGE_MIN_HOURS && gapHours! <= CHANGE_MAX_HOURS;
  const change = consecutive ? postChange(prev!, read.posts) : null;
  const totals = postTotals(read.posts);
  const owner = `facebook:${pageId}`;
  return withTenant(deps.db, tctx, async (tx) => {
    const content: PostSnapshotContent = {
      schema: 'facebook.page_post_snapshot.v1',
      pageId,
      connectionId,
      observedAt: now.toISOString(),
      window: { since: since.toISOString(), truncated: read.truncated },
      definitions: Object.fromEntries(POST_METRICS.map((m) => [m, PAGE_POST_METRICS[m].definition])) as Record<PagePostMetric, string>,
      posts: read.posts,
      change,
    };
    const stats = organicStats(read.posts, now);
    const top = stats.topPosts[0];
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'snapshot',
      sourceType: 'primary',
      owner: 'meta',
      uri: pageUri(pageId, 'posts', day),
      content,
      summary: [
        `Facebook Page ${connection.displayName}: ${read.posts.length} post${read.posts.length === 1 ? '' : 's'} since ${since.toISOString().slice(0, 10)}${read.truncated ? ' (older posts not read)' : ''}${stats.lastPostAt ? `, latest ${stats.lastPostAt.slice(0, 10)}` : ''}.`,
        read.posts.length ? `Lifetime counters at ${now.toISOString().slice(0, 16)}Z: ${describeTotals(totals)}.` : '',
        top ? `Most reacted: ${top.statusType ?? 'post'} of ${top.createdTime.slice(0, 10)} (${top.reactions ?? '?'} reactions, ${top.comments ?? '?'} comments): "${top.excerpt}".` : '',
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 1000),
      confidence: 1,
      license: 'Meta Platform Terms (authorized Page data)',
      // The tenant's own account data read through its authorized connection, like M17's syncs (D-036).
      permittedUses: ['analytics', 'forecasting', 'autonomous_execution'],
      externalPlatformTerms: 'meta',
      freshnessSlaHours: 48,
      parents: prev ? [prev.evidenceId] : [],
      now,
    });
    const evidenceId = ev.status === 'admitted' ? ev.evidenceId : null;
    let points = 0;
    const skipped: string[] = [];
    for (const m of POST_METRICS) {
      const v = change?.metrics[m].value;
      if (v === null || v === undefined || !evidenceId) continue;
      const d = FACEBOOK_POST_CHANGE_SERIES[m];
      const series = await upsertSeries(tx, tenantId, actor, { key: d.key, name: d.name, unit: d.unit, granularity: 'day', kind: 'signal', channel: owner, sourceEvidenceId: evidenceId });
      if (series.channel !== owner) {
        skipped.push(`${d.key} already holds ${series.channel ?? 'other'} data`);
        continue;
      }
      await appendPoints(tx, tenantId, series.id, [{ ts: `${day}T00:00:00Z`, value: v, evidenceId }]);
      points++;
    }
    const note = !evidenceId
      ? 'The snapshot was not admitted as evidence.'
      : skipped.length
        ? skipped.join('; ')
        : change
          ? null
          : prev
            ? `No daily change: the previous snapshot (${prev.day}) is not from the previous day 12–36 h earlier, so none is derived.`
            : 'First snapshot: changes start with the next daily snapshot.';
    await audit(tx, tenantId, actor, 'social.posts.snapshot', { type: 'connection', id: connectionId }, { pageId, day, posts: read.posts.length, requests: read.requests, evidenceId, points, consecutive });
    return { pageId, day, observedAt: now.toISOString(), reused: false, evidenceId, totals, stats, change, points, note };
  });
}

/* ------------------------------------------------------------------ */
/* Page profile → evidence and the Page's product fact (D-035)         */
/* ------------------------------------------------------------------ */

const PROFILE_MAX_AGE_DAYS = 7;
export const pageFactKey = (pageId: string) => `facebook-page:${pageId}`;
const canonical = (o: Record<string, unknown>) =>
  JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );

/**
 * Read the Page's public profile (at most weekly) as evidence and keep it as the Page's product
 * fact in M03, so claims can be linked to it. Only stable fields go on the fact; follower counts
 * stay in the evidence, so linked claims do not expire with every new follower.
 */
export async function syncPageProfile(deps: CoreDeps, tenantId: string, connectionId: string, opts: { actor?: Actor } = {}): Promise<{ pageId: string; evidenceId: string | null; entityId: string | null; reused: boolean; profile: PageProfile | null }> {
  const actor = opts.actor ?? systemActor('page-profile-sync');
  if (actor.type === 'user') requireRole(actor, ['owner', 'admin', 'growth_operator'], 'reading the Page profile');
  const { connection, ctx } = await readContext(deps, tenantId, connectionId, 'meta');
  const tctx = { tenantId, actor: actorRef(actor) };
  const now = deps.clock.now();
  const pageId = connection.externalAccountId;
  const current = async (t: DbOrTx) =>
    (
      await t
        .select()
        .from(kgEntities)
        .where(and(eq(kgEntities.kind, 'product'), eq(kgEntities.key, pageFactKey(pageId)), eq(kgEntities.status, 'active')))
        .limit(1)
    )[0] ?? null;
  const recent = await withTenant(deps.db, tctx, async (t) => ({
    ev: (
      await t
        .select({ id: evidenceRecords.id, observedAt: evidenceRecords.observedAt, content: evidenceRecords.content })
        .from(evidenceRecords)
        .where(and(like(evidenceRecords.sourceUriOrObjectId, `${pageUri(pageId, 'profile')}%`), eq(evidenceRecords.status, 'admitted')))
        .orderBy(desc(evidenceRecords.observedAt))
        .limit(1)
    )[0],
    fact: await current(t),
  }));
  if (recent.ev?.observedAt && now.getTime() - recent.ev.observedAt.getTime() < PROFILE_MAX_AGE_DAYS * 86_400_000) {
    return { pageId, evidenceId: recent.ev.id, entityId: recent.fact?.id ?? null, reused: true, profile: (recent.ev.content as { profile: PageProfile }).profile };
  }
  const profile = await fetchPageProfile(ctx);
  return withTenant(deps.db, tctx, async (tx) => {
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'api_response',
      sourceType: 'primary',
      owner: 'meta',
      uri: pageUri(pageId, 'profile', now.toISOString().slice(0, 10)),
      content: { schema: 'facebook.page_profile.v1', pageId, connectionId, observedAt: now.toISOString(), profile },
      summary: `Facebook Page "${profile.name}" (${profile.categories.join(', ') || 'no category'}), as published on Facebook: about "${(profile.about ?? profile.description ?? '').replace(/\s+/g, ' ').slice(0, 400)}"; website ${profile.website ?? 'none'}; ${profile.followersCount ?? 'unknown'} followers at the read time; verification ${profile.verificationStatus ?? 'unknown'}.`,
      confidence: 1,
      license: 'Meta Platform Terms (authorized Page data)',
      // The tenant's own account data read through its authorized connection, like M17's syncs (D-036).
      permittedUses: ['analytics', 'publishing', 'autonomous_execution'],
      externalPlatformTerms: 'meta',
      freshnessSlaHours: 24 * 30,
      now,
    });
    if (ev.status !== 'admitted') return { pageId, evidenceId: null, entityId: null, reused: false, profile };
    const attributes = { facebookPageId: pageId, categories: profile.categories, about: profile.about, website: profile.website, link: profile.link };
    let fact = await current(tx);
    if (!fact || fact.name !== profile.name || canonical(fact.attributes) !== canonical(attributes)) {
      fact = await upsertEntity(tx, deps, tenantId, actor, { kind: 'product', key: pageFactKey(pageId), name: profile.name.slice(0, 300), attributes, evidenceId: ev.evidenceId });
    }
    return { pageId, evidenceId: ev.evidenceId, entityId: fact.status === 'active' ? fact.id : null, reused: false, profile };
  });
}

/* ------------------------------------------------------------------ */
/* Brand scope: what may be said about one Page's product (D-035)      */
/* ------------------------------------------------------------------ */

export interface BrandScope {
  pageIds: string[];
  /** The Pages' product facts (M03). */
  entityIds: string[];
  /** Admitted, current evidence about the Pages and their product. */
  evidenceIds: string[];
  /** The part of `evidenceIds` the tenant permits to drive actions without a person (D-023). */
  autonomousEvidenceIds: string[];
  /** Approved, unexpired claims linked to a Page's product fact or citing the Page's own evidence. */
  approvedClaimIds: string[];
  pendingClaims: number;
}

/**
 * Brand scoping keeps one Page's drafts to its own product: a claim belongs to the Page when it
 * is linked to the Page's product fact or cites evidence read from the Page. Unrelated approved
 * claims in the same organization are never used.
 */
export async function pageBrandScope(t: DbOrTx, pageIds: string[], now: Date): Promise<BrandScope> {
  const empty: BrandScope = { pageIds, entityIds: [], evidenceIds: [], autonomousEvidenceIds: [], approvedClaimIds: [], pendingClaims: 0 };
  if (!pageIds.length) return empty;
  const facts = await t
    .select({ id: kgEntities.id, evidenceId: kgEntities.evidenceId })
    .from(kgEntities)
    .where(
      and(
        eq(kgEntities.kind, 'product'),
        inArray(
          kgEntities.key,
          pageIds.map((p) => pageFactKey(p)),
        ),
        eq(kgEntities.status, 'active'),
      ),
    );
  const pageEvidence = await t
    .select()
    .from(evidenceRecords)
    .where(or(...pageIds.map((p) => like(evidenceRecords.sourceUriOrObjectId, `meta://page/${p}/%`))))
    .orderBy(desc(evidenceRecords.observedAt))
    .limit(500);
  const pageEvidenceIds = new Set(pageEvidence.map((e) => e.id));
  const entityIds = new Set(facts.map((f) => f.id));
  const linked = (
    await t
      .select()
      .from(claims)
      .where(inArray(claims.status, ['approved', 'pending_review']))
  ).filter((c) => c.entityIds.some((id) => entityIds.has(id)) || c.evidenceIds.some((id) => pageEvidenceIds.has(id)));
  const approved = linked.filter((c) => c.status === 'approved' && (!c.expiresAt || c.expiresAt > now));
  const candidates = [...new Set([...pageEvidence.slice(0, 20).map((e) => e.id), ...facts.map((f) => f.evidenceId), ...linked.flatMap((c) => c.evidenceIds)])];
  const usable = candidates.length ? (await t.select().from(evidenceRecords).where(inArray(evidenceRecords.id, candidates))).filter((e) => e.status === 'admitted' && effectiveFreshness(e, now) !== 'stale') : [];
  const autonomous = usable.filter((e) => e.permittedUses.includes('autonomous_execution') && !e.prohibitedUses.includes('autonomous_execution'));
  return {
    pageIds,
    entityIds: [...entityIds],
    evidenceIds: usable.map((e) => e.id),
    autonomousEvidenceIds: autonomous.map((e) => e.id),
    approvedClaimIds: approved.map((c) => c.id),
    pendingClaims: linked.filter((c) => c.status === 'pending_review').length,
  };
}

/* ------------------------------------------------------------------ */
/* Exploratory post drafts for review (D-035)                          */
/* ------------------------------------------------------------------ */

export const EXPLORATORY_DRAFT_NOTE = 'Exploratory draft, not forecast-validated: published only through the execution gateway (M23) under the publishing policy, or when a person schedules it.';
const LANGUAGE_NAMES = { bn: 'Bangla (bn)', en: 'English (en)' } as const;
export type DraftLanguage = keyof typeof LANGUAGE_NAMES;
/** The language organic drafts are written in for a market. */
export const draftLanguage = (market: string): DraftLanguage => (market.toUpperCase() === 'BD' ? 'bn' : 'en');

/** Misspellings models make in Bangla, fixed before lint: "শিখা" means flame; learning is "শেখা" (শেখার, শেখায়). */
const BN_SPELLING: [RegExp, string][] = [[new RegExp('(?<![\\p{L}\\p{M}])শিখা(র|য়)?(?![\\p{L}\\p{M}])'.normalize('NFC'), 'gu'), 'শেখা$1']];
export const fixBanglaSpelling = (text: string) => BN_SPELLING.reduce((s, [re, to]) => s.replace(re, to), text.normalize('NFC'));

const GeneratedDrafts = z.object({
  abstain: z.boolean(),
  abstainReason: z.string(),
  title: z.string(),
  angle: z.string(),
  hooks: z.array(z.string()),
  proofPoints: z.array(z.object({ text: z.string(), claimId: z.string() })),
  cta: z.string(),
  prohibitedClaims: z.array(z.string()),
  posts: z.array(z.object({ text: z.string(), claimIds: z.array(z.string()) })),
});

/**
 * One model call drafts an exploratory brief (M13) and up to `maxPosts` Facebook post drafts for
 * an idea, stating only the given approved claims. Every draft passes the same copy lint as a
 * scheduled post; drafts that do not are dropped with the reason. Drafts stay in status 'draft':
 * the scheduler never dispatches them. The Autopilot hands one to M23 itself (submitPostDraft,
 * D-036), or a person schedules one (scheduleDraft).
 */
export async function draftOrganicPosts(deps: CoreDeps, tenantId: string, actor: Actor, input: { connectionId: string; ideaId: string; claimIds: string[]; language: DraftLanguage; objective: string; context: string; review?: Record<string, string>; maxPosts?: number }) {
  return runAgent(deps, tenantId, { kind: 'brief_generation', agentId: 'creative-strategist', triggeredBy: actorRef(actor), input: { ...input } }, async (ctx) => {
    const tctx = { tenantId, actor: 'agent:creative-strategist' };
    const now = deps.clock.now();
    const mat = await withTenant(deps.db, tctx, async (tx) => ({
      conn: (await tx.select().from(connections).where(eq(connections.id, input.connectionId)))[0],
      idea: (await tx.select().from(growthIdeas).where(eq(growthIdeas.id, input.ideaId)))[0],
      claims: input.claimIds.length ? (await tx.select().from(claims).where(inArray(claims.id, input.claimIds))).filter((c) => c.status === 'approved' && (!c.expiresAt || c.expiresAt > now)) : [],
    }));
    if (!mat.conn || mat.conn.provider !== 'meta') throw invalid('drafts need a Facebook Page connection');
    const idea = mat.idea;
    if (!idea) throw notFound('idea');
    if (!mat.claims.length) {
      ctx.note('observe', { approvedClaims: 0 });
      return { briefId: null, postIds: [] as string[], rejected: [] as { text: string; reason: string }[], abstained: 'no approved claims about this product' };
    }
    const max = Math.min(5, input.maxPosts ?? 3);
    const r = await ctx.think('drafts', PROMPTS.organicPostDrafts, {
      purpose: 'generation',
      outputSchema: GeneratedDrafts,
      messages: [
        {
          role: 'user',
          content: [
            `Language: ${LANGUAGE_NAMES[input.language]}\nChannel: Facebook Page "${mat.conn.displayName}"\nObjective: ${input.objective}\nReturn up to ${max} post drafts. These drafts are exploratory: no forecast or measured result supports them.`,
            untrustedBlock('idea', `${idea.title}: ${idea.hypothesis}`),
            untrustedBlock('page_context', input.context || 'none'),
            `Approved claims (the only product facts a post may state):\n${mat.claims.map((c) => `- claim ${c.id}: ${c.text}`).join('\n')}`,
          ].join('\n\n'),
        },
      ],
    });
    if (r.output.abstain) return { briefId: null, postIds: [] as string[], rejected: [] as { text: string; reason: string }[], abstained: r.output.abstainReason };
    const fix = input.language === 'bn' ? fixBanglaSpelling : (s: string) => s;
    const out = { ...r.output, title: fix(r.output.title), angle: fix(r.output.angle), hooks: r.output.hooks.map(fix), cta: fix(r.output.cta), proofPoints: r.output.proofPoints.map((p) => ({ ...p, text: fix(p.text) })), posts: r.output.posts.map((p) => ({ ...p, text: fix(p.text) })) };
    const ok = new Set(mat.claims.map((c) => c.id));
    const evidenceIds = [...new Set([...idea.evidenceIds, ...mat.claims.flatMap((c) => c.evidenceIds)])];
    const agent: Actor = { type: 'agent', id: 'creative-strategist', roles: [], mfaVerified: false };
    return withTenant(deps.db, tctx, async (tx) => {
      const rejected: { text: string; reason: string }[] = [];
      let briefId: string | null = null;
      try {
        const hooks = out.hooks.map((x) => x.trim()).filter((x) => x.length >= 3);
        const brief = await createBrief(
          tx,
          deps,
          tenantId,
          agent,
          {
            title: `[Exploratory] ${out.title || idea.title}`.slice(0, 200),
            objective: input.objective.slice(0, 500),
            channel: 'facebook',
            audience: idea.audience.slice(0, 500),
            angle: out.angle,
            hooks: (hooks.length ? hooks : [idea.title]).slice(0, 10),
            proofPoints: out.proofPoints.filter((p) => ok.has(p.claimId)).slice(0, 10),
            cta: out.cta,
            formatPlan: { format: 'Facebook Page post', aspectRatio: 'n/a', durationSeconds: null, notes: `${EXPLORATORY_DRAFT_NOTE} Language: ${LANGUAGE_NAMES[input.language]}.` },
            prohibitedClaims: out.prohibitedClaims.slice(0, 20),
            experimentMatrix: [],
            ideaId: idea.id,
          },
          ctx.runId,
        );
        briefId = brief.id;
      } catch (err) {
        rejected.push({ text: 'brief', reason: err instanceof Error ? err.message : String(err) });
      }
      const postIds: string[] = [];
      for (const p of out.posts.slice(0, max)) {
        const text = p.text.trim();
        if (!text || text.length > 5000) {
          rejected.push({ text: text.slice(0, 120), reason: 'empty or too long' });
          continue;
        }
        if (!p.claimIds.every((id) => ok.has(id))) {
          rejected.push({ text: text.slice(0, 120), reason: 'cited a claim that was not provided' });
          continue;
        }
        const lint = await lintCopy(tx, text, { claimIds: p.claimIds, channel: 'facebook', now });
        if (!lint.passed) {
          rejected.push({
            text: text.slice(0, 120),
            reason: `copy lint: ${lint.violations
              .filter((v) => v.severity === 'block')
              .map((v) => v.code)
              .join(', ')}`,
          });
          continue;
        }
        const [row] = await tx
          .insert(socialPosts)
          .values({
            tenantId,
            connectionId: mat.conn!.id,
            platform: 'facebook',
            caption: text,
            claimIds: [...new Set(p.claimIds)],
            disclosure: {
              isAiGenerated: false,
              paidPartnership: false,
              syntheticPersonaId: null,
              disclosureText: null,
              options: {},
              geographies: [],
              review: { exploratory: true, forecastValidated: false, language: input.language, draftedBy: 'agent:creative-strategist', agentRunId: ctx.runId, ideaId: idea.id, briefId, evidenceIds, ...(input.review ?? {}) },
            },
            scheduledAt: now,
            status: 'draft',
            statusReason: EXPLORATORY_DRAFT_NOTE,
            createdBy: actorRef(actor),
          })
          .returning({ id: socialPosts.id });
        postIds.push(row!.id);
      }
      ctx.note('validate', { proposed: r.output.posts.length, kept: postIds.length, rejected: rejected.length });
      await audit(tx, tenantId, agent, 'social.post.drafted', { type: 'growth_idea', id: idea.id }, { briefId, postIds, rejected: rejected.length, language: input.language, exploratory: true });
      return { briefId, postIds, rejected, abstained: undefined as string | undefined };
    });
  });
}

/** Drafts waiting for review, with the claims they state (newest first). */
export async function listPostDrafts(tx: DbOrTx) {
  const rows = await tx
    .select({ id: socialPosts.id, connectionId: socialPosts.connectionId, caption: socialPosts.caption, claimIds: socialPosts.claimIds, disclosure: socialPosts.disclosure, statusReason: socialPosts.statusReason, createdAt: socialPosts.createdAt })
    .from(socialPosts)
    .where(and(eq(socialPosts.status, 'draft'), sql`${socialPosts.disclosure}->'review' is not null`))
    .orderBy(desc(socialPosts.createdAt))
    .limit(50);
  const ids = [...new Set(rows.flatMap((r) => r.claimIds))];
  const used = ids.length ? await tx.select({ id: claims.id, text: claims.text, status: claims.status }).from(claims).where(inArray(claims.id, ids)) : [];
  return rows.map(({ disclosure, ...r }) => ({ ...r, review: (disclosure as { review?: Record<string, unknown> }).review ?? {}, claims: used.filter((c) => r.claimIds.includes(c.id)) }));
}

export interface PostSubmission {
  postId: string;
  /** The M23 action, or null when nothing was proposed. */
  action: ActionView | null;
  /** Why nothing was proposed, or why the gateway refused the post. */
  reason: string | null;
}

/**
 * Autonomous publication (D-036): the Autopilot hands one of its own drafts to M23 as itself,
 * citing the evidence it acted on. Copy lint (a claim may have expired since drafting) and the
 * anti-spam guards run again first. M23 policy alone decides: a pre-authorized post is executed
 * and verified by the worker, anything else waits for a hash-bound approval. A denied post goes
 * back to the drafts with the reason so a person can still review and schedule it; the Autopilot
 * never offers the same draft twice.
 */
export async function submitPostDraft(deps: CoreDeps, tenantId: string, postId: string, input: { geographies: string[]; evidenceIds: string[] }): Promise<PostSubmission> {
  const actor = systemActor('autopilot');
  const tctx = { tenantId, actor: actorRef(actor) };
  const now = deps.clock.now();
  type Offer = { at: string; geographies: string[]; evidenceIds: string[] };
  const prepared = await withTenant(deps.db, tctx, async (tx) => {
    const [post] = await tx.select().from(socialPosts).where(eq(socialPosts.id, postId)).for('update');
    if (!post) throw notFound('post');
    const review = (post.disclosure as { review?: Record<string, unknown> }).review ?? {};
    let offer = review.autoSubmit as Offer | undefined;
    // A worker that crashed between claiming the post and proposing it resumes with the same key.
    const resuming = post.status === 'submitted' && !post.actionId && Boolean(offer);
    if (!resuming) {
      if (post.status !== 'draft') return { reason: `the post is ${post.status}` };
      if (offer) return { reason: 'the Autopilot already offered this draft to the execution gateway' };
      if (post.createdBy !== actorRef(actor)) return { reason: 'the draft was not written by the Autopilot' };
      const lint = await lintCopy(tx, post.caption, { claimIds: post.claimIds, channel: post.platform, now });
      if (!lint.passed) {
        const reason = `copy lint: ${lint.violations
          .filter((v) => v.severity === 'block')
          .map((v) => v.code)
          .join(', ')}`;
        await tx
          .update(socialPosts)
          .set({ statusReason: `Not published automatically: ${reason}` })
          .where(eq(socialPosts.id, postId));
        return { reason };
      }
      try {
        await assertNotSpam(tx, post.connectionId, post.caption, now);
      } catch (err) {
        return { reason: err instanceof Error ? err.message : String(err) };
      }
      offer = { at: now.toISOString(), geographies: input.geographies, evidenceIds: input.evidenceIds };
      post.disclosure = { ...post.disclosure, geographies: offer.geographies, review: { ...review, autoSubmit: offer } };
      post.status = 'submitted';
      await tx.update(socialPosts).set({ status: post.status, scheduledAt: now, statusReason: null, disclosure: post.disclosure }).where(eq(socialPosts.id, postId));
    }
    const [conn] = await tx.select().from(connections).where(eq(connections.id, post.connectionId));
    if (!conn) throw notFound('connection');
    const rows = post.assetIds.length ? await tx.select({ id: assets.id, kind: assets.kind }).from(assets).where(inArray(assets.id, post.assetIds)) : [];
    return { post, offer: offer!, action: postAction(post, conn, Object.fromEntries(rows.map((r) => [r.id, r.kind]))) };
  });
  if (prepared.action === undefined) return { postId, action: null, reason: prepared.reason };
  const { post, offer, action } = prepared;
  const setPost = (set: Partial<typeof socialPosts.$inferInsert>, details: Record<string, unknown>) =>
    withTenant(deps.db, tctx, async (tx) => {
      await tx.update(socialPosts).set(set).where(eq(socialPosts.id, post.id));
      await audit(tx, tenantId, actor, 'social.post.auto_submitted', { type: 'social_post', id: post.id }, details);
    });
  // Proposed as the Autopilot agent, so an agent kill switch on it also stops queued publications at preflight.
  const proposer: Actor = { type: 'agent', id: 'autopilot', roles: [], mfaVerified: false, promptVersion: PROMPTS.organicPostDrafts.version };
  let view: ActionView;
  try {
    view = await proposeAction(deps, tenantId, proposer, {
      actionType: action.actionType,
      connectionId: post.connectionId,
      params: action.params,
      evidenceIds: offer.evidenceIds,
      risk: { geographies: offer.geographies, syntheticPersonaId: post.personaId, materialConnection: (post.disclosure as { paidPartnership?: boolean }).paidPartnership === true },
      idempotencyKey: `autopilot-post:${post.id}`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await setPost({ status: 'draft', statusReason: `Not published automatically: ${reason}`.slice(0, 2000) }, { error: reason.slice(0, 500) });
    return { postId, action: null, reason };
  }
  const denied = view.status === 'DENIED';
  await setPost(denied ? { status: 'draft', actionId: view.id, statusReason: `Not published automatically: ${view.statusReason ?? 'denied by policy'}`.slice(0, 2000) } : { actionId: view.id }, { actionId: view.id, status: view.status });
  return { postId, action: view, reason: denied ? (view.statusReason ?? 'denied by policy') : null };
}

/**
 * D-039: an Autopilot post waiting for approval goes to M23 again once the current policy would
 * pre-authorize it (for example after the owner pre-authorized publishing). Only a person can
 * approve a waiting action, so it is cancelled first and can never publish; the same payload is
 * then proposed as a new action, which the post follows. Otherwise nothing changes.
 */
export async function resubmitWaitingPost(deps: CoreDeps, tenantId: string, actionId: string): Promise<ActionView | null> {
  const actor = systemActor('autopilot');
  const tctx = { tenantId, actor: actorRef(actor) };
  const waiting = await withTenant(deps.db, tctx, async (tx) => {
    const [a] = await tx.select().from(actionRequests).where(eq(actionRequests.id, actionId));
    if (!a || a.status !== 'APPROVAL_REQUIRED' || a.proposedByType !== 'agent' || a.proposedById !== 'autopilot' || !PUBLISH_PLATFORM[a.actionType]) return null;
    const [post] = await tx
      .select()
      .from(socialPosts)
      .where(eq(socialPosts.id, String(a.params.postId ?? '')));
    if (!post || post.actionId !== a.id || post.status !== 'submitted') return null;
    const { decision } = await currentPolicyDecision(tx, deps, tenantId, a, deps.clock.now());
    return decision.outcome === 'PRE_AUTHORIZED' ? { a, post, policyVersion: decision.policyVersion } : null;
  });
  if (!waiting) return null;
  const { a, post } = waiting;
  await cancelAction(deps, tenantId, actor, a.id, `superseded: policy ${waiting.policyVersion} now pre-authorizes this post, which is proposed again as a new action`);
  const proposer: Actor = { type: 'agent', id: 'autopilot', roles: [], mfaVerified: false, promptVersion: a.proposerPromptVersion ?? PROMPTS.organicPostDrafts.version };
  const view = await proposeAction(deps, tenantId, proposer, { actionType: a.actionType, connectionId: a.connectionId, target: a.target, params: a.params, evidenceIds: a.evidenceIds, risk: a.risk, idempotencyKey: `autopilot-post:${post.id}:after:${a.id}` });
  const denied = view.status === 'DENIED';
  await withTenant(deps.db, tctx, async (tx) => {
    await tx
      .update(socialPosts)
      .set(denied ? { status: 'draft', actionId: view.id, statusReason: `Not published automatically: ${view.statusReason ?? 'denied by policy'}`.slice(0, 2000) } : { status: 'submitted', actionId: view.id, statusReason: null })
      .where(eq(socialPosts.id, post.id));
    await audit(tx, tenantId, actor, 'social.post.resubmitted', { type: 'social_post', id: post.id }, { supersededActionId: a.id, actionId: view.id, status: view.status });
  });
  return view;
}

export interface PostResult {
  postId: string;
  externalPostId: string | null;
  url: string | null;
  verifiedAt: string | null;
  /** When the counters were read; null while no snapshot since publication includes the post. */
  observedAt: string | null;
  evidenceId: string | null;
  /** Lifetime counters; null where Meta did not return one. */
  metrics: Record<PagePostMetric, number | null>;
}

/**
 * What the posts a goal published achieved (D-036): each verified post's lifetime counters from
 * its Page's newest daily snapshot. Observed values only; nothing is estimated or zero-filled.
 */
export async function goalPostResults(t: DbOrTx, goalId: string): Promise<PostResult[]> {
  const posts = await t
    .select({ id: socialPosts.id, connectionId: socialPosts.connectionId, externalPostId: socialPosts.externalPostId, externalUrl: socialPosts.externalUrl, verifiedAt: socialPosts.verifiedAt })
    .from(socialPosts)
    .where(and(eq(socialPosts.status, 'published_verified'), sql`${socialPosts.disclosure}->'review'->>'goalId' = ${goalId}`))
    .orderBy(desc(socialPosts.verifiedAt))
    .limit(20);
  if (!posts.length) return [];
  const conns = await t
    .select({ id: connections.id, pageId: connections.externalAccountId })
    .from(connections)
    .where(inArray(connections.id, [...new Set(posts.map((p) => p.connectionId))]));
  const latest = new Map<string, { id: string; content: PostSnapshotContent }>();
  for (const c of conns) {
    const [row] = await t
      .select({ id: evidenceRecords.id, content: evidenceRecords.content })
      .from(evidenceRecords)
      .where(and(like(evidenceRecords.sourceUriOrObjectId, `${pageUri(c.pageId, 'posts')}%`), eq(evidenceRecords.status, 'admitted')))
      .orderBy(desc(evidenceRecords.observedAt))
      .limit(1);
    if (row) latest.set(c.id, { id: row.id, content: row.content as PostSnapshotContent });
  }
  return posts.map((p) => {
    const snap = latest.get(p.connectionId);
    const obs = snap?.content.posts.find((x) => x.id === p.externalPostId);
    return {
      postId: p.id,
      externalPostId: p.externalPostId,
      url: p.externalUrl,
      verifiedAt: p.verifiedAt?.toISOString() ?? null,
      observedAt: obs ? snap!.content.observedAt : null,
      evidenceId: obs ? snap!.id : null,
      metrics: Object.fromEntries(POST_METRICS.map((m) => [m, obs?.metrics[m].status === 'ok' ? (obs.metrics[m].value ?? null) : null])) as Record<PagePostMetric, number | null>,
    };
  });
}

/**
 * A person schedules a reviewed draft. It then follows the normal path: copy lint again (claims
 * may have expired), anti-spam guards, the scheduler, M23 policy and approval. The person who
 * schedules it becomes its author, so they cannot approve its publication themselves.
 */
export async function scheduleDraft(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, postId: string, input: { scheduledAt: string; geographies: string[] }) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'scheduling social posts');
  const [post] = await tx.select().from(socialPosts).where(eq(socialPosts.id, postId)).for('update');
  if (!post) throw notFound('post');
  if (post.status !== 'draft') throw conflict(`post is ${post.status}`);
  const lint = await lintCopy(tx, post.caption, { claimIds: post.claimIds, channel: post.platform, now: deps.clock.now() });
  if (!lint.passed)
    throw invalid(
      `caption failed lint: ${lint.violations
        .filter((v) => v.severity === 'block')
        .map((v) => v.code)
        .join(', ')}`,
    );
  const at = new Date(input.scheduledAt);
  if (!Number.isFinite(at.getTime())) throw invalid('scheduledAt is not a date');
  await assertNotSpam(tx, post.connectionId, post.caption, at);
  const d = post.disclosure as { review?: Record<string, unknown> };
  const [row] = await tx
    .update(socialPosts)
    .set({ status: 'scheduled', scheduledAt: at, statusReason: null, createdBy: actorRef(actor), disclosure: { ...post.disclosure, geographies: input.geographies, review: { ...(d.review ?? {}), scheduledBy: actorRef(actor), reviewedAt: deps.clock.now().toISOString() } } })
    .where(and(eq(socialPosts.id, postId), eq(socialPosts.status, 'draft')))
    .returning();
  await record(tx, tenantId, actor, 'social.post.scheduled', { type: 'social_post', id: postId }, { platform: post.platform, scheduledAt: at.toISOString(), via: 'draft' });
  return row!;
}

export async function discardDraft(tx: Tx, tenantId: string, actor: Actor, postId: string) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'approver'], 'discarding post drafts');
  const [row] = await tx
    .update(socialPosts)
    .set({ status: 'cancelled', statusReason: `discarded by ${actorRef(actor)}` })
    .where(and(eq(socialPosts.id, postId), eq(socialPosts.status, 'draft')))
    .returning();
  if (!row) throw conflict('not a draft');
  await audit(tx, tenantId, actor, 'social.post.discarded', { type: 'social_post', id: postId }, {});
  return row;
}

export { audit };
