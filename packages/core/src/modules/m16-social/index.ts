import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { PROMPTS, injectionSignals, redactPii, untrustedBlock } from '@futuregrow/agent-kernel';
import { type DbOrTx, type Tx, assets, connections, socialInteractions, socialPosts, syntheticPersonas, withTenant } from '@futuregrow/db';
import { conflict, identifierHash, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef, systemActor } from '../../deps.js';
import { runAgent } from '../../agents.js';
import { audit, normalizeText, record, requireRole } from '../../util.js';
import { lintCopy, searchKnowledge } from '../m03-knowledge/index.js';
import { personaContentCheck } from '../m15-personas/index.js';
import { proposeAction } from '../m23-execution/gateway.js';
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
  if (!lint.passed) throw invalid(`caption failed lint: ${lint.violations.filter((v) => v.severity === 'block').map((v) => v.code).join(', ')}`);
  if (p.assetIds.length) {
    const rows = await tx.select().from(assets).where(inArray(assets.id, p.assetIds));
    const bad = rows.filter((a) => !a.publishEligible);
    if (rows.length !== p.assetIds.length || bad.length) throw invalid(`assets not publish-eligible: ${bad.map((b) => b.id).join(', ') || 'missing'}`);
  }
  const at = new Date(p.scheduledAt);
  // Spam key: case, punctuation and spacing do not make a caption new.
  const spamKey = (c: string) => sha256Hex(normalizeText(c).replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
  const hash = spamKey(caption);
  const recent = await tx
    .select({ id: socialPosts.id, caption: socialPosts.caption, scheduledAt: socialPosts.scheduledAt })
    .from(socialPosts)
    .where(and(eq(socialPosts.connectionId, p.connectionId), inArray(socialPosts.status, ['scheduled', 'submitted', 'published_verified']), gte(socialPosts.scheduledAt, new Date(at.getTime() - 7 * 86_400_000))));
  if (recent.some((r) => spamKey(r.caption) === hash)) throw conflict('the same caption was already scheduled to this account in the last 7 days');
  if (recent.some((r) => Math.abs(r.scheduledAt.getTime() - at.getTime()) < 15 * 60_000)) throw conflict('posts to the same account must be at least 15 minutes apart');
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
        params: { title: post.caption.slice(0, 2200), videoUrl: `asset://${first}`, privacyLevel: d.options.tiktokPrivacy ?? 'SELF_ONLY', disableComment: false, disableDuet: false, disableStitch: false, brandContentToggle: d.paidPartnership, brandOrganicToggle: !d.paidPartnership, postId: post.id, assetIds: post.assetIds, claimIds: post.claimIds, disclosure },
      };
    case 'youtube':
      return {
        actionType: 'social.youtube.upload_video',
        params: { title: (d.options.youtubeTitle ?? post.caption).slice(0, 100), description: post.caption.slice(0, 5000), privacyStatus: d.options.youtubePrivacy ?? 'private', categoryId: '22', containsSyntheticMedia: d.isAiGenerated, madeForKids: false, postId: post.id, assetIds: [first!], claimIds: post.claimIds, disclosure },
      };
  }
}

/** Scheduler: due posts become ActionRequests attributed to the human who scheduled them. */
export async function dispatchDuePosts(deps: CoreDeps, tenantId: string) {
  const due = await withTenant(deps.db, { tenantId, actor: 'system:social-scheduler' }, (tx) =>
    tx.select().from(socialPosts).where(and(eq(socialPosts.status, 'scheduled'), lte(socialPosts.scheduledAt, deps.clock.now()))).limit(50),
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
    const view = await proposeAction(deps, tenantId, { type: 'user', id: userId, roles: [], mfaVerified: false }, {
      actionType: a.actionType,
      connectionId: post.connectionId,
      params: a.params,
      risk: { geographies: (post.disclosure as { geographies?: string[] }).geographies ?? [], syntheticPersonaId: post.personaId, materialConnection: (post.disclosure as { paidPartnership?: boolean }).paidPartnership === true },
      idempotencyKey: `social-post:${post.id}`,
    });
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
      await tx.update(socialPosts).set({ status: status === 'CANCELLED' ? 'cancelled' : 'failed', statusReason: `${status}: ${reason}`.slice(0, 2000) }).where(eq(socialPosts.id, postId));
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
      return { it: i, chunks: c };
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
      tx.update(socialInteractions).set({ replyDraft: usable ? r.output.reply : null, replyStatus: usable ? 'drafted' : 'skipped' }).where(eq(socialInteractions.id, it.id)),
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
    await tx.update(socialInteractions).set({ replyStatus: 'sent_verified' }).where(eq(socialInteractions.id, (action.params as { interactionId: string }).interactionId));
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

export { audit };
