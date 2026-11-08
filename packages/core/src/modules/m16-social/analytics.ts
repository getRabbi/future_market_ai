import { type AnalyticsFetch, fetchInstagramAnalytics, fetchLinkedinAnalytics, fetchTiktokAnalytics, fetchYoutubeAnalytics, PLATFORM_METRICS, type SocialAnalyticsPlatform } from '@futuregrow/connectors';
import { brandChannels, connections, type DbOrTx, socialAnalyticsRuns, socialMetricObservations, socialPosts, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, clipText, requireRole } from '../../util.js';
import { readContext } from '../connections.js';

/**
 * Multi-platform analytics (P3-05). Account and post metrics for Instagram, TikTok, YouTube and
 * LinkedIn are imported from each platform's own API into per-day observations with the
 * provider's metric names and definitions. Reports group by platform and never add one
 * platform's numbers to another's: a "view" on TikTok, YouTube and Instagram are different
 * measurements. Missing values stay unknown (not_returned), never zero; a platform total is
 * labelled partial when some posts did not report the metric.
 */

const DAY = 86_400_000;
const LOOKBACK_DAYS = 90;
const STALE_AFTER_HOURS = 48;

export const METRIC_DEFINITIONS: Record<SocialAnalyticsPlatform, Record<string, { label: string; definition: string; unit: 'count' | 'minutes' | 'seconds' | 'rate' }>> = {
  instagram: {
    followers_count: { label: 'Followers', definition: 'Instagram accounts following the professional account at read time.', unit: 'count' },
    media_count: { label: 'Posts', definition: 'Media published by the account.', unit: 'count' },
    reach: { label: 'Accounts reached', definition: 'Unique accounts that saw the media at least once (estimated by Meta).', unit: 'count' },
    views: { label: 'Views', definition: 'Times the media was played or displayed (Meta "views"; replaces impressions).', unit: 'count' },
    likes: { label: 'Likes', definition: 'Likes on the media.', unit: 'count' },
    comments: { label: 'Comments', definition: 'Comments on the media.', unit: 'count' },
    shares: { label: 'Shares', definition: 'Shares of the media.', unit: 'count' },
    saved: { label: 'Saves', definition: 'Times the media was saved.', unit: 'count' },
    total_interactions: { label: 'Interactions', definition: 'Likes, saves, comments and shares, minus unlikes, unsaves and deleted comments (Meta).', unit: 'count' },
  },
  tiktok: {
    follower_count: { label: 'Followers', definition: 'Followers of the creator account.', unit: 'count' },
    following_count: { label: 'Following', definition: 'Accounts the creator follows.', unit: 'count' },
    likes_count: { label: 'Total likes', definition: 'Likes across all of the creator’s videos.', unit: 'count' },
    video_count: { label: 'Videos', definition: 'Public videos of the creator.', unit: 'count' },
    view_count: { label: 'Video views', definition: 'Times the video was viewed (TikTok counts a view when playback starts).', unit: 'count' },
    like_count: { label: 'Likes', definition: 'Likes on the video.', unit: 'count' },
    comment_count: { label: 'Comments', definition: 'Comments on the video.', unit: 'count' },
    share_count: { label: 'Shares', definition: 'Shares of the video.', unit: 'count' },
  },
  youtube: {
    subscriberCount: { label: 'Subscribers', definition: 'Channel subscribers (rounded by YouTube; absent when hidden).', unit: 'count' },
    viewCount: { label: 'Views', definition: 'Video or channel views as counted by YouTube.', unit: 'count' },
    videoCount: { label: 'Videos', definition: 'Public videos on the channel.', unit: 'count' },
    likeCount: { label: 'Likes', definition: 'Likes on the video.', unit: 'count' },
    commentCount: { label: 'Comments', definition: 'Comments on the video.', unit: 'count' },
    estimatedMinutesWatched: { label: 'Watch time (minutes)', definition: 'Minutes watched in the reporting window (YouTube Analytics; needs yt-analytics.readonly).', unit: 'minutes' },
    averageViewDuration: { label: 'Average view duration (s)', definition: 'Average playback length per view in the window (YouTube Analytics).', unit: 'seconds' },
  },
  linkedin: {
    followers: { label: 'Followers', definition: 'Members following the organization page (first-degree network size).', unit: 'count' },
    impressionCount: { label: 'Impressions', definition: 'Times the post was shown to members.', unit: 'count' },
    uniqueImpressionsCount: { label: 'Unique impressions', definition: 'Members who saw the post.', unit: 'count' },
    clickCount: { label: 'Clicks', definition: 'Clicks on the post, company name or logo.', unit: 'count' },
    likeCount: { label: 'Reactions', definition: 'Reactions to the post.', unit: 'count' },
    commentCount: { label: 'Comments', definition: 'Comments on the post.', unit: 'count' },
    shareCount: { label: 'Reposts', definition: 'Reposts of the post.', unit: 'count' },
    engagement: { label: 'Engagement rate', definition: '(clicks + reactions + comments + reposts) / impressions, as LinkedIn reports it.', unit: 'rate' },
  },
};

/** Which analytics platform a connection reports, if any. */
export function analyticsPlatformOf(c: { provider: string; metadata: Record<string, unknown> }): SocialAnalyticsPlatform | null {
  if (c.provider === 'meta') return typeof c.metadata.igUserId === 'string' ? 'instagram' : null;
  if (c.provider === 'tiktok' || c.provider === 'youtube' || c.provider === 'linkedin') return c.provider;
  return null;
}

export interface AnalyticsSyncResult {
  runId: string;
  platform: SocialAnalyticsPlatform;
  status: 'succeeded' | 'partial' | 'failed';
  posts: number;
  reported: number;
  notReturned: number;
  notes: string[];
  error: string | null;
}

/** Imports today's account and post metrics for one connection (read-only provider calls). */
export async function syncSocialAnalytics(deps: CoreDeps, tenantId: string, connectionId: string, opts: { actor?: Actor } = {}): Promise<AnalyticsSyncResult> {
  const actor = opts.actor ?? systemActor('social-analytics');
  if (opts.actor) requireRole(opts.actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'importing social analytics');
  const now = deps.clock.now();
  const tctx = { tenantId, actor: actorRef(actor) };
  const { conn, platform, posts } = await withTenant(deps.db, tctx, async (t) => {
    const [conn] = await t.select().from(connections).where(eq(connections.id, connectionId));
    if (!conn) throw notFound('connection');
    const platform = analyticsPlatformOf(conn);
    if (!platform) throw invalid(`connection ${conn.displayName} (${conn.provider}) has no analytics to import${conn.provider === 'meta' ? ' (no Instagram account id recorded)' : ''}`);
    const posts = await t
      .select({ id: socialPosts.id, externalPostId: socialPosts.externalPostId })
      .from(socialPosts)
      .where(and(eq(socialPosts.connectionId, connectionId), eq(socialPosts.platform, platform), eq(socialPosts.status, 'published_verified'), isNotNull(socialPosts.externalPostId), gte(socialPosts.verifiedAt, new Date(now.getTime() - LOOKBACK_DAYS * DAY))))
      .orderBy(desc(socialPosts.verifiedAt))
      .limit(200);
    return { conn, platform, posts };
  });
  const [run] = await withTenant(deps.db, tctx, (t) => t.insert(socialAnalyticsRuns).values({ tenantId, connectionId, platform, status: 'running', startedAt: now }).returning());
  const refs = posts.map((p) => p.externalPostId!);
  let fetched: AnalyticsFetch;
  try {
    const { ctx } = await readContext(deps, tenantId, connectionId);
    const window = { startDate: new Date(now.getTime() - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10), endDate: now.toISOString().slice(0, 10) };
    fetched = platform === 'instagram' ? await fetchInstagramAnalytics(ctx, refs) : platform === 'tiktok' ? await fetchTiktokAnalytics(ctx, refs) : platform === 'youtube' ? await fetchYoutubeAnalytics(ctx, refs, window) : await fetchLinkedinAnalytics(ctx, refs);
  } catch (err) {
    const error = clipText(err instanceof Error ? err.message : String(err), 1000);
    await withTenant(deps.db, tctx, async (t) => {
      await t.update(socialAnalyticsRuns).set({ status: 'failed', error, finishedAt: deps.clock.now() }).where(eq(socialAnalyticsRuns.id, run!.id));
      await audit(t, tenantId, actor, 'social.analytics.failed', { type: 'connection', id: connectionId }, { platform, error: clipText(error, 200) });
    });
    return { runId: run!.id, platform, status: 'failed', posts: refs.length, reported: 0, notReturned: 0, notes: [], error };
  }
  const day = now.toISOString().slice(0, 10);
  let reported = 0;
  let notReturned = 0;
  await withTenant(deps.db, tctx, async (t) => {
    const rows = [
      ...(fetched.account ? fetched.account.metrics.map((m) => ({ scope: 'account' as const, objectRef: fetched.account!.ref, postId: null as string | null, m })) : []),
      ...fetched.posts.flatMap((p) => p.metrics.map((m) => ({ scope: 'post' as const, objectRef: p.ref, postId: posts.find((x) => x.externalPostId === p.ref)?.id ?? null, m }))),
    ];
    for (const r of rows) {
      if (r.m.status === 'reported') reported++;
      else notReturned++;
      await t
        .insert(socialMetricObservations)
        .values({ tenantId, connectionId, platform, scope: r.scope, objectRef: r.objectRef, postId: r.postId, metricKey: r.m.key, value: r.m.value, status: r.m.status, observedOn: day, observedAt: now, source: fetched.source })
        .onConflictDoUpdate({
          target: [socialMetricObservations.tenantId, socialMetricObservations.platform, socialMetricObservations.scope, socialMetricObservations.objectRef, socialMetricObservations.metricKey, socialMetricObservations.observedOn],
          // A re-read the same day replaces the value and counts a revision only when it changed.
          set: { value: r.m.value, status: r.m.status, observedAt: now, revision: sql`case when ${socialMetricObservations.value} is distinct from ${r.m.value} then ${socialMetricObservations.revision} + 1 else ${socialMetricObservations.revision} end` },
        });
    }
    const status = notReturned && !reported ? 'partial' : fetched.notes.length || notReturned ? 'partial' : 'succeeded';
    await t
      .update(socialAnalyticsRuns)
      .set({ status, counts: { posts: refs.length, reported, notReturned, notes: fetched.notes.slice(0, 20) }, finishedAt: deps.clock.now() })
      .where(eq(socialAnalyticsRuns.id, run!.id));
    await audit(t, tenantId, actor, 'social.analytics.imported', { type: 'connection', id: connectionId }, { platform, posts: refs.length, reported, notReturned, account: conn.displayName });
  });
  const status = fetched.notes.length || notReturned ? 'partial' : 'succeeded';
  return { runId: run!.id, platform, status, posts: refs.length, reported, notReturned, notes: fetched.notes, error: null };
}

export interface PlatformReport {
  platform: SocialAnalyticsPlatform;
  definitions: (typeof METRIC_DEFINITIONS)[SocialAnalyticsPlatform];
  connections: { id: string; displayName: string }[];
  freshness: { lastRunAt: string | null; lastStatus: string | null; lastError: string | null; stale: boolean; lastObservedOn: string | null };
  account: { ref: string; metrics: Record<string, { value: number | null; status: string; observedOn: string }> }[];
  posts: { ref: string; postId: string | null; caption: string | null; url: string | null; metrics: Record<string, { value: number | null; status: string; observedOn: string; revision: number }> }[];
  /** Sum per metric over posts that reported it; `complete` only when every post reported. Rates are never summed. */
  totals: Record<string, { value: number | null; posts: number; of: number; complete: boolean }>;
  coverage: { verifiedPosts: number; postsWithData: number };
}

/** Per-platform report (optionally one brand): latest values, coverage, freshness and honest totals. */
export async function socialAnalyticsReport(t: DbOrTx, now: Date, opts: { brandId?: string } = {}): Promise<PlatformReport[]> {
  let conns = await t
    .select()
    .from(connections)
    .where(inArray(connections.provider, ['meta', 'tiktok', 'youtube', 'linkedin']));
  if (opts.brandId) {
    const bound = new Set((await t.select({ id: brandChannels.connectionId }).from(brandChannels).where(eq(brandChannels.brandId, opts.brandId))).map((r) => r.id));
    conns = conns.filter((c) => bound.has(c.id));
  }
  const out: PlatformReport[] = [];
  for (const platform of ['instagram', 'tiktok', 'youtube', 'linkedin'] as const) {
    const mine = conns.filter((c) => analyticsPlatformOf(c) === platform);
    if (!mine.length) continue;
    const ids = mine.map((c) => c.id);
    const [obs, runs, verified] = await Promise.all([
      t
        .select()
        .from(socialMetricObservations)
        .where(and(eq(socialMetricObservations.platform, platform), inArray(socialMetricObservations.connectionId, ids), gte(socialMetricObservations.observedOn, new Date(now.getTime() - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10))))
        .orderBy(desc(socialMetricObservations.observedOn)),
      t
        .select()
        .from(socialAnalyticsRuns)
        .where(and(eq(socialAnalyticsRuns.platform, platform), inArray(socialAnalyticsRuns.connectionId, ids)))
        .orderBy(desc(socialAnalyticsRuns.startedAt))
        .limit(1),
      t
        .select({ id: socialPosts.id, externalPostId: socialPosts.externalPostId, caption: socialPosts.caption, url: socialPosts.externalUrl })
        .from(socialPosts)
        .where(and(inArray(socialPosts.connectionId, ids), eq(socialPosts.platform, platform), eq(socialPosts.status, 'published_verified'), gte(socialPosts.verifiedAt, new Date(now.getTime() - LOOKBACK_DAYS * DAY)))),
    ]);
    const latest = new Map<string, (typeof obs)[number]>();
    for (const o of obs) {
      const k = `${o.scope}|${o.objectRef}|${o.metricKey}`;
      if (!latest.has(k)) latest.set(k, o);
    }
    const account = new Map<string, PlatformReport['account'][number]>();
    const posts = new Map<string, PlatformReport['posts'][number]>();
    for (const o of latest.values()) {
      if (o.scope === 'account') {
        const a = account.get(o.objectRef) ?? { ref: o.objectRef, metrics: {} };
        a.metrics[o.metricKey] = { value: o.value, status: o.status, observedOn: o.observedOn };
        account.set(o.objectRef, a);
      } else {
        const v = verified.find((x) => x.externalPostId === o.objectRef);
        const p = posts.get(o.objectRef) ?? { ref: o.objectRef, postId: o.postId, caption: v ? clipText(v.caption, 120) : null, url: v?.url ?? null, metrics: {} };
        p.metrics[o.metricKey] = { value: o.value, status: o.status, observedOn: o.observedOn, revision: o.revision };
        posts.set(o.objectRef, p);
      }
    }
    const totals: PlatformReport['totals'] = {};
    for (const key of PLATFORM_METRICS[platform].post) {
      if (METRIC_DEFINITIONS[platform][key]?.unit === 'rate' || key === 'averageViewDuration') continue;
      const values = [...posts.values()].map((p) => p.metrics[key]).filter((m): m is NonNullable<typeof m> => Boolean(m));
      const reportedVals = values.filter((m) => m.status === 'reported' && m.value !== null).map((m) => m.value!);
      totals[key] = { value: reportedVals.length ? reportedVals.reduce((a, b) => a + b, 0) : null, posts: reportedVals.length, of: posts.size, complete: posts.size > 0 && reportedVals.length === posts.size };
    }
    const run = runs[0];
    const lastObservedOn = obs[0]?.observedOn ?? null;
    out.push({
      platform,
      definitions: METRIC_DEFINITIONS[platform],
      connections: mine.map((c) => ({ id: c.id, displayName: c.displayName })),
      freshness: { lastRunAt: run?.startedAt.toISOString() ?? null, lastStatus: run?.status ?? null, lastError: run?.error ?? null, stale: !run || now.getTime() - run.startedAt.getTime() > STALE_AFTER_HOURS * 3_600_000, lastObservedOn },
      account: [...account.values()],
      posts: [...posts.values()],
      totals,
      coverage: { verifiedPosts: verified.length, postsWithData: [...posts.values()].filter((p) => Object.values(p.metrics).some((m) => m.status === 'reported')).length },
    });
  }
  return out;
}

/** Daily worker: every analytics-capable, active connection of the tenant. Failures are recorded per run, not thrown. */
export async function syncAllSocialAnalytics(deps: CoreDeps, tenantId: string): Promise<AnalyticsSyncResult[]> {
  const conns = await withTenant(deps.db, { tenantId, actor: 'system:social-analytics' }, (t) =>
    t
      .select()
      .from(connections)
      .where(and(inArray(connections.provider, ['meta', 'tiktok', 'youtube', 'linkedin']), eq(connections.status, 'active'))),
  );
  const out: AnalyticsSyncResult[] = [];
  for (const c of conns.filter((x) => analyticsPlatformOf(x))) out.push(await syncSocialAnalytics(deps, tenantId, c.id));
  return out;
}
