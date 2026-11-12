import { randomBytes } from 'node:crypto';
import { actionRequests, claims, communityGroups, creatorContracts, creators, type DbOrTx, fraudFlags, growthCampaigns, growthChannelTasks, growthOpportunities, growthSignals, messageTemplates, referralClicks, referralConversions, referralLinks, socialPosts, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { and, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, normalizeText, record, requireRole } from '../../util.js';
import { getBrand } from '../brands/index.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { schedulePost } from '../m16-social/index.js';
import { createTemplate } from '../m20-lifecycle/index.js';
import { createReferralLink } from '../m22-creators/index.js';
import { cancelActionsInScope } from '../m24-governance/index.js';
import { type ChannelReadiness, channelReadiness } from './channels.js';
import { conquestCopyCheck, kindFeature } from './conquest.js';
import { type Channel, getBrandConfig, requireFeature, requireOperator, type Settings } from './settings.js';

/**
 * F3 Growth Blitz & Distribution Mesh (D-054). A campaign becomes one task per usable channel.
 * Tasks are deduplicated by (campaign, channel, content) and by recent identical content on the
 * same channel, respect per-channel daily quotas, and reach the outside world only through the
 * existing paths: M16 scheduled posts → M23 policy/approval/verification, M20 email templates and
 * journeys, M22 referral links, or a person (owned site, partners, communities). Nothing is sent
 * to a person who did not consent, and nothing joins groups, DMs people or spends money.
 */
const DAY = 86_400_000;
const _M23_CHANNELS: Channel[] = ['facebook', 'instagram', 'email'];
const HUMAN_CHANNELS: Channel[] = ['owned_site', 'partner', 'community', 'paid_ads'];

const withUtm = (url: string | null, code: string, medium: string) => (url ? `${url}${url.includes('?') ? '&' : '?'}utm_source=futuregrow&utm_medium=${medium}&utm_campaign=${code}` : null);

interface Message {
  headline: string | null;
  points: { claimId: string; text: string }[];
}

/** The campaign's message: only approved claim texts (picked by overlap with the subject). */
async function campaignMessage(t: DbOrTx, brandId: string, subject: string, now: Date, preferred: string[] = []): Promise<Message> {
  const b = await getBrand(t, brandId);
  const ids = b.approvedClaims.map((c) => c.id);
  const rows = ids.length
    ? await t
        .select()
        .from(claims)
        .where(and(inArray(claims.id, ids), eq(claims.status, 'approved')))
    : [];
  const usable = rows.filter((c) => !c.expiresAt || c.expiresAt > now);
  const subj = new Set(
    normalizeText(subject)
      .split(' ')
      .filter((w) => w.length > 3),
  );
  const ranked = usable
    .map((c) => ({
      c,
      score:
        (preferred.includes(c.id) ? 10 : 0) +
        normalizeText(c.text)
          .split(' ')
          .filter((w) => subj.has(w)).length,
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
  return { headline: ranked[0]?.text ?? null, points: ranked.slice(0, 3).map((c) => ({ claimId: c.id, text: c.text })) };
}

function contentFor(ch: ChannelReadiness, m: Message, ctx: { brand: string; code: string; landingUrl: string | null; subject: string; market: string | null }): Record<string, unknown> {
  const link = withUtm(ctx.landingUrl, ctx.code, ch.channel);
  const body = m.points.map((p) => p.text).join('\n');
  const claimIds = m.points.map((p) => p.claimId);
  switch (ch.channel) {
    case 'facebook':
    case 'instagram':
      return { caption: [m.headline, ...m.points.slice(1).map((p) => p.text)].filter(Boolean).join('\n\n'), link, claimIds, needsAsset: ch.channel === 'instagram' };
    case 'email':
      return { name: `gw-${ctx.code}-email`, category: 'commercial', subject: clipText(m.headline ?? ctx.brand, 120), bodyText: `${body}\n\n${link ?? ''}`.trim(), claimIds, audience: 'consented subscribers only (marketing_email granted, not suppressed); a person picks the segment in Lifecycle' };
    case 'owned_site':
      return { title: m.headline, sections: m.points.map((p) => p.text), cta: { label: 'Get started', url: link }, publishVia: 'a person publishes it on the brand website' };
    case 'partner':
      return { kit: `${m.headline ?? ctx.brand}\n\n${body}`, link, note: 'Send to an authorized partner who agreed to share; they post it under their own name with a clear partnership disclosure.' };
    case 'community':
      return { kit: `${m.headline ?? ctx.brand}\n\n${body}`, link, disclosure: `I work with ${ctx.brand}.`, rules: 'Read and follow each group’s rules; share once per group, personalize the post, never repost the same text across groups.' };
    case 'referral':
    case 'creator':
      return {
        brief: { message: m.headline, approvedPoints: m.points, mustDisclose: ['#ad or the platform’s paid-partnership label'], doNot: ['claim results not in the approved points', 'name or disparage competitors', 'offer discounts that are not approved', 'post fake reviews or ask for incentivized reviews'] },
        link,
      };
    case 'paid_ads':
      return { proposal: { headline: m.headline?.slice(0, 30) ?? null, description: m.points[1]?.text.slice(0, 90) ?? null, landing: link, budgetMicros: 0 }, path: 'Ads › Campaign creation (PAUSED, always approved by a person)' };
    default:
      return {};
  }
}

/** Create (idempotently) one task per selected channel for a campaign. */
export async function planChannelTasks(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, campaignId: string, s: Settings, opts: { channels?: Channel[] } = {}) {
  const now = deps.clock.now();
  const [c] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, campaignId));
  if (!c) throw notFound('campaign');
  const { config } = await getBrandConfig(t, c.brandId);
  const b = await getBrand(t, c.brandId);
  const pkg = c.package as { campaignCode?: string; opportunity?: { title?: string } };
  const code = pkg.campaignCode ?? `gw${c.id.replaceAll('-', '').slice(0, 8)}`;
  const readiness = await channelReadiness(t, deps, c.brandId, s);
  const wanted = opts.channels ?? (config.channels.length ? config.channels : readiness.filter((r) => r.available).map((r) => r.channel));
  const msg = await campaignMessage(t, c.brandId, String(pkg.opportunity?.title ?? c.title), now, c.claimIds);
  const out: (typeof growthChannelTasks.$inferSelect)[] = [];
  for (const ch of readiness.filter((r) => wanted.includes(r.channel) && r.channel !== 'creator')) {
    const content = contentFor(ch, msg, { brand: b.brand.name, code, landingUrl: config.landingUrl, subject: c.title, market: config.market });
    const contentHash = sha256Hex(JSON.stringify(content));
    const blocked = !ch.available ? ch.reason : !msg.headline ? 'The brand has no approved claim to say anything with.' : null;
    const [row] = await t
      .insert(growthChannelTasks)
      .values({
        tenantId,
        campaignId,
        brandId: c.brandId,
        channel: ch.channel,
        connectionId: ch.connectionId,
        status: blocked ? 'blocked' : 'planned',
        content,
        contentHash,
        dedupKey: `${campaignId}:${ch.channel}:${contentHash.slice(0, 24)}`,
        rules: { path: ch.path, actionType: ch.actionType, readiness: ch.reason },
        statusReason: blocked,
      })
      .onConflictDoNothing()
      .returning();
    if (row) out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Trend-window blitz                                                  */
/* ------------------------------------------------------------------ */

/** F3: prepare a time-boxed multi-channel campaign for an urgent opportunity (no execution). */
export async function prepareBlitz(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, opportunityId: string) {
  requireOperator(actor, 'preparing growth blitz campaigns');
  const now = deps.clock.now();
  const [o] = await t.select().from(growthOpportunities).where(eq(growthOpportunities.id, opportunityId));
  if (!o) throw notFound('opportunity');
  const s = await requireFeature(t, tenantId, 'F3', o.brandId);
  if (!['new', 'reviewing', 'accepted', 'converted'].includes(o.status)) throw invalid(`the opportunity is ${o.status}`);
  if (o.expiresAt <= now) throw invalid('the opportunity window has passed');
  const [sig] = await t.select().from(growthSignals).where(eq(growthSignals.id, o.signalId));
  if (sig?.status !== 'active') throw invalid('the signal behind this opportunity is no longer active');
  const [existing] = await t
    .select()
    .from(growthCampaigns)
    .where(and(eq(growthCampaigns.opportunityId, opportunityId), eq(growthCampaigns.kind, 'blitz')));
  if (existing) return { campaign: existing, tasks: await t.select().from(growthChannelTasks).where(eq(growthChannelTasks.campaignId, existing.id)), created: false };
  const open = await t.execute<{ n: number }>(sql`select count(*)::int as n from growth_campaigns where brand_id = ${o.brandId} and status in ('draft','ready_for_review','approved','in_flight')`);
  if ((open.rows[0]?.n ?? 0) >= s.effective.maxConcurrentCampaigns) throw conflict(`${open.rows[0]?.n} campaigns are already open for this brand (limit ${s.effective.maxConcurrentCampaigns})`);
  const msg = await campaignMessage(t, o.brandId, sig.subject, now);
  const lint = msg.headline ? await lintCopy(t, msg.points.map((p) => p.text).join('\n'), { claimIds: msg.points.map((p) => p.claimId), now }) : null;
  const readiness = await channelReadiness(t, deps, o.brandId, s);
  const code = `gw${randomBytes(4).toString('hex')}`;
  const expiresAt = new Date(Math.min(o.expiresAt.getTime(), now.getTime() + (o.urgency === 'high' ? 7 : 14) * DAY));
  const blockers = [...(!msg.headline ? ['No approved claim for this brand.'] : []), ...(lint && !lint.passed ? ['Copy lint failed.'] : []), ...(readiness.some((r) => r.available) ? [] : ['No usable distribution channel.'])];
  const pkg = {
    schema: 'blitz/1',
    generatedAt: now.toISOString(),
    campaignCode: code,
    opportunity: { id: o.id, title: o.title, reason: o.reason, urgency: o.urgency, score: o.score },
    window: { opensAt: now.toISOString(), closesAt: expiresAt.toISOString(), why: `signal ${sig.kind.replaceAll('_', ' ')} observed ${sig.observedAt.toISOString().slice(0, 10)}; the campaign closes with the opportunity` },
    message: msg,
    channels: readiness,
    cost: { organicUsd: 0, paidMicros: 0, aiUsd: 0, note: 'Organic channels cost nothing to submit; paid channels are proposals with a zero budget until a person authorizes spend.' },
    dependencies: readiness.filter((r) => !r.available).map((r) => ({ channel: r.channel, needs: r.reason })),
    compliance: { lint: lint ? { passed: lint.passed, violations: lint.violations } : null },
    blockers,
  };
  const [row] = await t
    .insert(growthCampaigns)
    .values({
      tenantId,
      brandId: o.brandId,
      opportunityId,
      kind: 'blitz',
      title: `Blitz: ${o.title}`.slice(0, 300),
      status: blockers.length ? 'blocked' : 'ready_for_review',
      package: pkg as unknown as Record<string, unknown>,
      evidenceIds: sig.evidenceIds,
      claimIds: msg.points.map((p) => p.claimId),
      approval: {
        required: [
          { code: 'campaign_review', who: ['owner', 'admin', 'approver'], why: 'A person other than the author approves the blitz.' },
          { code: 'm23_per_action', who: ['M23 policy'], why: 'Each post or email is still approved and verified by M23.' },
        ],
        acknowledged: [],
        approvedBy: null,
        approvedAt: null,
      },
      goals: (await getBrandConfig(t, o.brandId)).config.conversionEvents.map((ev) => ({ event: ev, metric: `count of ${ev} events carrying utm_campaign=${code}`, attribution: 'observational' })),
      expiresAt,
      createdBy: actorRef(actor),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [again] = await t
      .select()
      .from(growthCampaigns)
      .where(and(eq(growthCampaigns.opportunityId, opportunityId), eq(growthCampaigns.kind, 'blitz')));
    return { campaign: again!, tasks: await t.select().from(growthChannelTasks).where(eq(growthChannelTasks.campaignId, again!.id)), created: false };
  }
  if (o.status !== 'converted') await t.update(growthOpportunities).set({ status: 'converted', campaignId: row.id, updatedAt: now }).where(eq(growthOpportunities.id, opportunityId));
  const tasks = await planChannelTasks(t, deps, tenantId, row.id, s);
  await record(t, tenantId, actor, 'growth.campaign.prepared', { type: 'growth_campaign', id: row.id }, { kind: 'blitz', opportunityId, tasks: tasks.length, blockers });
  return { campaign: row, tasks, created: true };
}

/* ------------------------------------------------------------------ */
/* Submitting a task                                                   */
/* ------------------------------------------------------------------ */

export interface SubmitInput {
  scheduledAt?: string;
  assetIds?: string[];
  geographies?: string[];
  creatorId?: string;
  contractId?: string;
}

/**
 * Hand one approved task to its real execution path. Gates, in order: the campaign's feature is
 * on for the brand, no emergency stop, external operations allowed, campaign approved and not
 * expired, task ready, daily channel quota, no identical content on the channel in 7 days.
 */
export async function submitTask(deps: CoreDeps, tenantId: string, actor: Actor, taskId: string, input: SubmitInput = {}) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'submitting growth tasks');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const now = deps.clock.now();
    const [task] = await t.select().from(growthChannelTasks).where(eq(growthChannelTasks.id, taskId)).for('update');
    if (!task) throw notFound('task');
    const [c] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, task.campaignId));
    if (!c) throw notFound('campaign');
    const s = await requireFeature(t, tenantId, kindFeature(c.kind) === 'F2' ? 'F3' : kindFeature(c.kind), c.brandId);
    if (!s.controls.externalOperations && task.channel !== 'creator' && task.channel !== 'referral') throw conflict('external operations are off in Growth settings');
    if (c.status !== 'approved' && c.status !== 'in_flight') throw conflict(`the campaign is ${c.status.replaceAll('_', ' ')}; it must be approved first`);
    if (c.expiresAt && c.expiresAt <= now) throw conflict('the campaign window has closed');
    if (!['planned', 'ready'].includes(task.status)) throw conflict(`the task is ${task.status.replaceAll('_', ' ')}`);
    if (task.channel === 'paid_ads') throw conflict('paid campaigns are created by a person in Ads › Campaign creation (PAUSED, always approved); Growth Warfare never creates spend');
    const quota = s.effective.channelQuotas[task.channel as Channel] ?? 0;
    const [used] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(growthChannelTasks)
      .where(and(eq(growthChannelTasks.brandId, task.brandId), eq(growthChannelTasks.channel, task.channel), gte(growthChannelTasks.submittedAt, new Date(now.getTime() - DAY))));
    if ((used?.n ?? 0) >= quota) throw conflict(`${task.channel} quota reached: ${used?.n ?? 0} of ${quota} today (Growth settings › channel quotas, capped by the ${s.aggression} level)`);
    const [dupe] = await t
      .select({ id: growthChannelTasks.id })
      .from(growthChannelTasks)
      .where(and(eq(growthChannelTasks.channel, task.channel), eq(growthChannelTasks.contentHash, task.contentHash), ne(growthChannelTasks.id, task.id), isNotNull(growthChannelTasks.submittedAt), gte(growthChannelTasks.submittedAt, new Date(now.getTime() - 7 * DAY))))
      .limit(1);
    if (dupe) throw conflict('identical content already went to this channel in the last 7 days (duplicate publishing is blocked)');
    const content = task.content as Record<string, unknown>;
    const pkg = c.package as { campaignCode?: string };
    const { config } = await getBrandConfig(t, c.brandId);
    const names = await t.execute<{ name: string }>(sql`select name from competitors`);
    const text = String(content.caption ?? content.bodyText ?? content.kit ?? '');
    const guard = conquestCopyCheck(text, { competitorNames: names.rows.map((r) => r.name), hasApprovedOffer: false, comparativeClaims: [] });
    if (guard.length) throw invalid(`copy guard: ${guard.map((g) => g.code).join(', ')}`);
    let status: (typeof growthChannelTasks.$inferSelect)['status'] = 'submitted';
    const refs: Record<string, unknown> = { ...(task.refs as Record<string, unknown>) };
    if (task.channel === 'facebook' || task.channel === 'instagram') {
      if (!task.connectionId) throw conflict('no connected account for this channel');
      if (task.channel === 'instagram' && !input.assetIds?.length) throw invalid('Instagram posts need an approved image (assetIds)');
      const at = input.scheduledAt ? new Date(input.scheduledAt) : new Date(now.getTime() + 10 * 60_000);
      if (at.getTime() < now.getTime() + 5 * 60_000) throw invalid('schedule at least 5 minutes ahead so the post can still be cancelled');
      const post = await schedulePost(t, deps, tenantId, actor, {
        connectionId: task.connectionId,
        platform: task.channel,
        caption: String(content.caption),
        link: (content.link as string | null) ?? null,
        claimIds: (content.claimIds as string[]) ?? [],
        assetIds: input.assetIds ?? [],
        scheduledAt: at.toISOString(),
        geographies: input.geographies ?? (config.market ? [config.market] : []),
      });
      refs.postId = post.id;
    } else if (task.channel === 'email') {
      const tpl = await createTemplate(t, deps, tenantId, actor, { name: String(content.name), category: 'commercial', subject: String(content.subject), bodyText: String(content.bodyText), claimIds: (content.claimIds as string[]) ?? [] });
      refs.templateId = tpl.id;
      status = 'awaiting_approval';
    } else if (task.channel === 'referral' || task.channel === 'creator') {
      if (!input.creatorId || !input.contractId) throw invalid('choose the creator and contract');
      if (!config.landingUrl) throw invalid('set the brand landing URL first');
      const link = await createReferralLink(t, tenantId, actor, { creatorId: input.creatorId, contractId: input.contractId, destinationUrl: withUtm(config.landingUrl, pkg.campaignCode ?? 'gw', 'referral')! });
      refs.referralLinkId = link.id;
      refs.referralCode = link.code;
      refs.creatorId = input.creatorId;
      status = 'executed';
    } else if (HUMAN_CHANNELS.includes(task.channel as Channel)) {
      status = 'ready';
      refs.handedToHumanAt = now.toISOString();
    }
    await t
      .update(growthChannelTasks)
      .set({ status, refs, submittedBy: actorRef(actor), submittedAt: now, statusReason: null, updatedAt: now })
      .where(eq(growthChannelTasks.id, task.id));
    if (c.status === 'approved') await t.update(growthCampaigns).set({ status: 'in_flight', updatedAt: now }).where(eq(growthCampaigns.id, c.id));
    await record(t, tenantId, actor, 'growth.task.submitted', { type: 'growth_channel_task', id: task.id }, { channel: task.channel, campaignId: c.id, refs });
    const [row] = await t.select().from(growthChannelTasks).where(eq(growthChannelTasks.id, task.id));
    return row!;
  });
}

/** A person did a human task (owned site, partner, community share): record where, for attribution. */
export async function confirmHumanTask(t: Tx, tenantId: string, actor: Actor, taskId: string, input: { url: string; note?: string; groupId?: string | null }) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'recording human participation');
  if (!/^https:\/\//.test(input.url)) throw invalid('give the https link of what was published');
  const [task] = await t.select().from(growthChannelTasks).where(eq(growthChannelTasks.id, taskId)).for('update');
  if (!task) throw notFound('task');
  if (!HUMAN_CHANNELS.includes(task.channel as Channel) || task.channel === 'paid_ads') throw invalid('only owned-site, partner and community tasks are done by a person');
  if (!['ready', 'planned', 'submitted'].includes(task.status)) throw conflict(`the task is ${task.status.replaceAll('_', ' ')}`);
  if (task.channel === 'community' && input.groupId) {
    const [g] = await t.select().from(communityGroups).where(eq(communityGroups.id, input.groupId));
    if (!g) throw notFound('community group');
    if (g.permission === 'admin_only') throw conflict('only admins may post in this group');
    const recent = await t.execute<{ n: number }>(sql`select count(*)::int as n from growth_channel_tasks where channel = 'community' and refs->>'groupId' = ${input.groupId} and status = 'done_by_human' and updated_at > now() - interval '7 days'`);
    if ((recent.rows[0]?.n ?? 0) > 0) throw conflict('this group already got a Growth Warfare share this week; one share per group per week');
    await t.update(communityGroups).set({ lastSharedAt: new Date() }).where(eq(communityGroups.id, g.id));
  }
  const now = new Date();
  await t
    .update(growthChannelTasks)
    .set({ status: 'done_by_human', refs: { ...(task.refs as Record<string, unknown>), url: input.url, note: input.note ?? null, groupId: input.groupId ?? null, doneBy: actorRef(actor), doneAt: now.toISOString() }, updatedAt: now })
    .where(eq(growthChannelTasks.id, taskId));
  await audit(t, tenantId, actor, 'growth_warfare.task.done_by_human', { type: 'growth_channel_task', id: taskId }, { url: input.url, channel: task.channel });
  const [row] = await t.select().from(growthChannelTasks).where(eq(growthChannelTasks.id, taskId));
  return row!;
}

/* ------------------------------------------------------------------ */
/* Community opportunity distribution (manual review queue)            */
/* ------------------------------------------------------------------ */

const NO_PROMO = /no (self[- ]?)?promo|no advertis|no links|no selling|no spam|promotion(s)? (is |are )?not allowed/i;

/**
 * Draft a helpful, disclosed reply to a public discussion a person found. Group rules are read
 * first: a group that forbids promotion gets an answer without a link. A person posts it.
 */
export async function draftCommunityReply(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, input: { campaignId: string; discussionUrl: string; question: string; groupId?: string | null }) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'drafting community replies');
  if (!/^https:\/\//.test(input.discussionUrl)) throw invalid('discussion URL must be https');
  const [c] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, input.campaignId));
  if (!c) throw notFound('campaign');
  const s = await requireFeature(t, tenantId, 'F3', c.brandId);
  const group = input.groupId ? (await t.select().from(communityGroups).where(eq(communityGroups.id, input.groupId)))[0] : undefined;
  if (input.groupId && !group) throw notFound('community group');
  if (group && group.permission === 'admin_only') throw conflict('only the group’s admins may post there');
  const b = await getBrand(t, c.brandId);
  const { config } = await getBrandConfig(t, c.brandId);
  const msg = await campaignMessage(t, c.brandId, input.question, deps.clock.now());
  if (!msg.headline) throw conflict('the brand has no approved claim to answer with');
  const promoAllowed = !(group && NO_PROMO.test(group.rules));
  const code = (c.package as { campaignCode?: string }).campaignCode ?? 'gw';
  const reply = [`Disclosure: I work with ${b.brand.name}.`, ...msg.points.slice(0, 2).map((p) => p.text), promoAllowed && config.landingUrl ? `More: ${withUtm(config.landingUrl, code, 'community')}` : null].filter(Boolean).join('\n\n');
  const content = {
    discussionUrl: input.discussionUrl,
    question: clipText(input.question, 1000),
    reply,
    claimIds: msg.points.slice(0, 2).map((p) => p.claimId),
    groupId: group?.id ?? null,
    rulesCheck: group ? { permission: group.permission, promotionAllowed: promoAllowed, rules: clipText(group.rules, 500) } : { permission: 'unknown', promotionAllowed: true, rules: 'Read the discussion’s rules before posting.' },
  };
  const contentHash = sha256Hex(JSON.stringify(content));
  const [row] = await t
    .insert(growthChannelTasks)
    .values({ tenantId, campaignId: c.id, brandId: c.brandId, channel: 'community', status: 'ready', content, contentHash, dedupKey: `community:${c.id}:${sha256Hex(input.discussionUrl).slice(0, 24)}`, rules: { path: 'human', quota: s.effective.channelQuotas.community } })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('a reply for this discussion is already drafted for this campaign');
  await audit(t, tenantId, actor, 'growth_warfare.community.reply_drafted', { type: 'growth_channel_task', id: row.id }, { discussionUrl: input.discussionUrl, promotionAllowed: promoAllowed });
  return row;
}

/* ------------------------------------------------------------------ */
/* Micro-creator coordination (M22)                                    */
/* ------------------------------------------------------------------ */

/** Pick contracted creators for a campaign: one creator task each (deduplicated). No payout is involved. */
export async function selectCreators(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, campaignId: string, creatorIds: string[]) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'selecting creators');
  const [c] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, campaignId));
  if (!c) throw notFound('campaign');
  await requireFeature(t, tenantId, 'F3', c.brandId);
  const now = deps.clock.now();
  const rows = creatorIds.length ? await t.select({ cr: creators, k: creatorContracts }).from(creators).innerJoin(creatorContracts, eq(creatorContracts.creatorId, creators.id)).where(inArray(creators.id, creatorIds)) : [];
  const msg = await campaignMessage(t, c.brandId, c.title, now, c.claimIds);
  const { config } = await getBrandConfig(t, c.brandId);
  const out = [];
  for (const id of creatorIds) {
    const live = rows.filter((r) => r.cr.id === id && r.cr.status === 'active' && r.k.startsAt <= now && (!r.k.endsAt || r.k.endsAt > now));
    const contract = live[0]?.k;
    const content = {
      creatorId: id,
      contractId: contract?.id ?? null,
      brief: {
        message: msg.headline,
        approvedPoints: msg.points,
        mustDisclose: contract?.requiredDisclosures ?? [],
        materialRelationship: contract?.materialRelationship ?? null,
        doNot: ['claim results not in the approved points', 'name or disparage competitors', 'promise discounts that are not approved', 'post or request fake or incentivized reviews'],
      },
      landing: config.landingUrl,
    };
    const contentHash = sha256Hex(JSON.stringify(content));
    const [row] = await t
      .insert(growthChannelTasks)
      .values({ tenantId, campaignId, brandId: c.brandId, channel: 'creator', status: contract ? 'planned' : 'blocked', statusReason: contract ? null : 'the creator has no active contract', content, contentHash, dedupKey: `creator:${campaignId}:${id}`, rules: { path: 'internal' } })
      .onConflictDoNothing()
      .returning();
    if (row) out.push(row);
  }
  await audit(t, tenantId, actor, 'growth_warfare.creators.selected', { type: 'growth_campaign', id: campaignId }, { creatorIds, created: out.length });
  return out;
}

/** Creator comparison for a campaign: clicks, verified conversions, refunds, open fraud flags. */
export async function creatorPerformance(t: DbOrTx, tenantId: string, campaignId: string, opts: { flagDuplicates?: boolean } = {}) {
  const tasks = await t
    .select()
    .from(growthChannelTasks)
    .where(and(eq(growthChannelTasks.campaignId, campaignId), inArray(growthChannelTasks.channel, ['creator', 'referral'])));
  const linkIds = tasks.map((x) => (x.refs as { referralLinkId?: string }).referralLinkId).filter((x): x is string => Boolean(x));
  if (!linkIds.length) return { creators: [], duplicateCustomers: 0, note: 'No referral link has been created for this campaign yet.' };
  const clicks = await t.select({ linkId: referralClicks.linkId, n: sql<number>`count(*)::int` }).from(referralClicks).where(inArray(referralClicks.linkId, linkIds)).groupBy(referralClicks.linkId);
  const conv = await t.select().from(referralConversions).where(inArray(referralConversions.linkId, linkIds));
  const flags = await t
    .select()
    .from(fraudFlags)
    .where(and(inArray(fraudFlags.linkId, linkIds), eq(fraudFlags.status, 'open')));
  const links = await t.select().from(referralLinks).where(inArray(referralLinks.id, linkIds));
  // Double counting: one customer converting through several of this campaign's links.
  const byCustomer = new Map<string, Set<string>>();
  for (const cv of conv) if (cv.customerHash) byCustomer.set(cv.customerHash, (byCustomer.get(cv.customerHash) ?? new Set()).add(cv.linkId));
  const dupes = [...byCustomer.entries()].filter(([, l]) => l.size > 1);
  if (opts.flagDuplicates && 'insert' in t) {
    for (const [hash, ls] of dupes) {
      const exists = await t.execute<{ n: number }>(sql`select count(*)::int as n from fraud_flags where kind = 'duplicate_customer' and details->>'customerHash' = ${hash}`);
      if (!(exists.rows[0]?.n ?? 0)) await (t as Tx).insert(fraudFlags).values({ tenantId, linkId: [...ls][0]!, kind: 'duplicate_customer', details: { customerHash: hash, linkIds: [...ls], campaignId, source: 'growth-warfare' } });
    }
  }
  return {
    creators: links.map((l) => {
      const mine = conv.filter((x) => x.linkId === l.id);
      const valid = mine.filter((x) => x.status !== 'refunded' && !(x.customerHash && (byCustomer.get(x.customerHash)?.size ?? 0) > 1));
      return {
        creatorId: l.creatorId,
        linkId: l.id,
        code: l.code,
        clicks: clicks.find((c) => c.linkId === l.id)?.n ?? 0,
        conversions: mine.length,
        verifiedConversions: valid.length,
        revenueMicros: valid.reduce((s, x) => s + x.amountMicros - x.refundedMicros, 0),
        refunded: mine.filter((x) => x.status === 'refunded').length,
        openFraudFlags: flags.filter((f) => f.linkId === l.id).map((f) => f.kind),
      };
    }),
    duplicateCustomers: dupes.length,
    note: 'Referral conversions are first-party order records (M22); a conversion counted for two links is excluded from both. No payout is triggered here.',
  };
}

/* ------------------------------------------------------------------ */
/* Outcomes                                                            */
/* ------------------------------------------------------------------ */

/** Refresh each task's outcome from its real execution record and first-party events. */
export async function syncCampaignOutcomes(deps: CoreDeps, tenantId: string, campaignId: string) {
  return withTenant(deps.db, { tenantId, actor: 'system:growth-warfare' }, async (t) => {
    const now = deps.clock.now();
    const [c] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, campaignId));
    if (!c) throw notFound('campaign');
    const code = (c.package as { campaignCode?: string }).campaignCode ?? null;
    const goals = (c.goals as { event: string }[]).map((g) => g.event);
    const tasks = await t.select().from(growthChannelTasks).where(eq(growthChannelTasks.campaignId, campaignId));
    for (const task of tasks) {
      const refs = task.refs as Record<string, string | undefined>;
      const outcome: Record<string, unknown> = { measuredAt: now.toISOString(), inference: 'observational attribution (not causal)' };
      let status = task.status;
      if (refs.postId) {
        const [p] = await t.select().from(socialPosts).where(eq(socialPosts.id, refs.postId));
        if (p) {
          outcome.post = { status: p.status, externalUrl: p.externalUrl, verifiedAt: p.verifiedAt?.toISOString() ?? null };
          if (p.actionId) {
            const [a] = await t.select({ status: actionRequests.status }).from(actionRequests).where(eq(actionRequests.id, p.actionId));
            outcome.action = { id: p.actionId, status: a?.status ?? null };
            if (a?.status === 'APPROVAL_REQUIRED') status = 'awaiting_approval';
            if (a?.status === 'EXECUTED_UNVERIFIED') status = 'executed';
          }
          if (p.status === 'published_verified') status = 'verified';
          if (p.status === 'failed' || p.status === 'blocked') status = 'failed';
          if (p.status === 'cancelled') status = 'cancelled';
        }
      }
      if (refs.templateId) {
        const [tpl] = await t.select({ status: messageTemplates.status }).from(messageTemplates).where(eq(messageTemplates.id, refs.templateId));
        outcome.template = { status: tpl?.status ?? null, next: 'approve the template, then attach it to a journey for a consented segment in Lifecycle' };
      }
      if (refs.referralLinkId) {
        const [cl] = await t.select({ n: sql<number>`count(*)::int` }).from(referralClicks).where(eq(referralClicks.linkId, refs.referralLinkId));
        const [cv] = await t
          .select({ n: sql<number>`count(*)::int` })
          .from(referralConversions)
          .where(and(eq(referralConversions.linkId, refs.referralLinkId), ne(referralConversions.status, 'refunded')));
        outcome.referral = { clicks: cl?.n ?? 0, conversions: cv?.n ?? 0 };
      }
      if (code) {
        const medium = task.channel;
        const ev = await t.execute<{ event_name: string; n: number }>(sql`
          select event_name, count(distinct coalesce(profile_id::text, anonymous_id))::int as n from customer_events
          where occurred_at >= ${c.createdAt}
            and (context->'campaign'->>'campaign' = ${code} or context->'campaign'->>'name' = ${code} or context->'page'->>'url' like ${`%utm_campaign=${code}%`})
            and (context->'campaign'->>'medium' = ${medium} or context->'page'->>'url' like ${`%utm_medium=${medium}%`})
          group by event_name`);
        outcome.events = Object.fromEntries(ev.rows.map((r) => [r.event_name, r.n]));
        outcome.conversions = ev.rows.filter((r) => goals.includes(r.event_name)).reduce((s, r) => s + r.n, 0);
      }
      await t.update(growthChannelTasks).set({ outcome, status, updatedAt: now }).where(eq(growthChannelTasks.id, task.id));
    }
    if (c.expiresAt && c.expiresAt <= now && ['approved', 'in_flight', 'ready_for_review', 'draft'].includes(c.status)) {
      await t
        .update(growthCampaigns)
        .set({ status: c.status === 'in_flight' ? 'completed' : 'expired', updatedAt: now })
        .where(eq(growthCampaigns.id, c.id));
      await t
        .update(growthChannelTasks)
        .set({ status: 'cancelled', statusReason: 'the campaign window closed', updatedAt: now })
        .where(and(eq(growthChannelTasks.campaignId, c.id), inArray(growthChannelTasks.status, ['planned', 'ready', 'blocked'])));
    }
    return t.select().from(growthChannelTasks).where(eq(growthChannelTasks.campaignId, campaignId));
  });
}

/** Cancel everything Growth Warfare queued that has not executed yet (emergency stop). */
export async function cancelQueuedWork(t: Tx, tenantId: string, reason: string) {
  const now = new Date();
  const tasks = await t
    .select()
    .from(growthChannelTasks)
    .where(inArray(growthChannelTasks.status, ['planned', 'ready', 'submitted', 'awaiting_approval']));
  const postIds = tasks.map((x) => (x.refs as { postId?: string }).postId).filter((x): x is string => Boolean(x));
  const actions: string[] = [];
  for (const id of postIds) actions.push(...(await cancelActionsInScope(t, tenantId, 'object', id, `Growth Warfare emergency stop: ${reason}`)));
  if (postIds.length)
    await t
      .update(socialPosts)
      .set({ status: 'cancelled', statusReason: `Growth Warfare emergency stop: ${reason}` })
      .where(and(inArray(socialPosts.id, postIds), inArray(socialPosts.status, ['scheduled', 'draft'])));
  if (tasks.length)
    await t
      .update(growthChannelTasks)
      .set({ status: 'cancelled', statusReason: `emergency stop: ${reason}`, updatedAt: now })
      .where(
        inArray(
          growthChannelTasks.id,
          tasks.map((x) => x.id),
        ),
      );
  return { tasks: tasks.length, posts: postIds.length, cancelledActions: actions };
}
