import { ProviderHttpError } from '../http.js';
import type { ConnectorContext } from '../types.js';
import { googleAccessToken } from './google.js';
import { metaGraphGet } from './meta.js';

/**
 * Multi-platform analytics (P3-05): read-only fetchers for Instagram, TikTok, YouTube and LinkedIn.
 * Each returns provider-named metrics per account and per post exactly as the platform reports
 * them. A metric the platform leaves out (hidden, not available for the object, or a missing
 * scope) is `not_returned` with a null value; nothing is estimated, zero-filled or converted to
 * another platform's definition.
 */

export type SocialAnalyticsPlatform = 'instagram' | 'tiktok' | 'youtube' | 'linkedin';

export interface MetricReading {
  key: string;
  value: number | null;
  status: 'reported' | 'not_returned';
}

export interface ObjectReading {
  ref: string;
  metrics: MetricReading[];
}

export interface AnalyticsFetch {
  platform: SocialAnalyticsPlatform;
  account: ObjectReading | null;
  posts: ObjectReading[];
  /** Why some metrics are missing (scope not granted, object not found …). */
  notes: string[];
  source: { endpoint: string; apiVersion: string };
}

/** The metrics FUTUREGROW asks each platform for, by scope. */
export const PLATFORM_METRICS: Record<SocialAnalyticsPlatform, { account: string[]; post: string[] }> = {
  instagram: { account: ['followers_count', 'media_count'], post: ['reach', 'views', 'likes', 'comments', 'shares', 'saved', 'total_interactions'] },
  tiktok: { account: ['follower_count', 'following_count', 'likes_count', 'video_count'], post: ['view_count', 'like_count', 'comment_count', 'share_count'] },
  youtube: { account: ['subscriberCount', 'viewCount', 'videoCount'], post: ['viewCount', 'likeCount', 'commentCount', 'estimatedMinutesWatched', 'averageViewDuration'] },
  linkedin: { account: ['followers'], post: ['impressionCount', 'uniqueImpressionsCount', 'clickCount', 'likeCount', 'commentCount', 'shareCount', 'engagement'] },
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
};
const reading = (keys: string[], src: Record<string, unknown> | null | undefined): MetricReading[] =>
  keys.map((key) => {
    const value = src ? num(src[key]) : null;
    return { key, value, status: value === null ? 'not_returned' : 'reported' };
  });

/* --------------------------- Instagram (Graph API) --------------------------- */

interface IgInsight {
  name: string;
  values?: { value: unknown }[];
  total_value?: { value: unknown };
}

export async function fetchInstagramAnalytics(ctx: ConnectorContext, mediaIds: string[]): Promise<AnalyticsFetch> {
  const igUserId = String((ctx.connection.metadata as { igUserId?: unknown }).igUserId ?? '');
  if (!/^\d+$/.test(igUserId)) throw new ProviderHttpError('the connection has no Instagram professional account id (igUserId)', { status: null, phase: 'before_send' });
  const notes: string[] = [];
  const acct = await metaGraphGet<Record<string, unknown>>(ctx, igUserId, { fields: 'id,username,followers_count,media_count' });
  const posts: ObjectReading[] = [];
  for (const id of mediaIds.slice(0, 50)) {
    try {
      const r = await metaGraphGet<{ data: IgInsight[] }>(ctx, `${id}/insights`, { metric: PLATFORM_METRICS.instagram.post.join(',') });
      const values = Object.fromEntries(r.data.map((m) => [m.name, m.total_value?.value ?? m.values?.[0]?.value]));
      posts.push({ ref: id, metrics: reading(PLATFORM_METRICS.instagram.post, values) });
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status !== null && [400, 403, 404].includes(err.status)) {
        notes.push(`media ${id}: ${err.message.slice(0, 160)}`);
        posts.push({ ref: id, metrics: reading(PLATFORM_METRICS.instagram.post, null) });
      } else throw err;
    }
  }
  return { platform: 'instagram', account: { ref: igUserId, metrics: reading(PLATFORM_METRICS.instagram.account, acct) }, posts, notes, source: { endpoint: 'graph.facebook.com /{ig-user-id}, /{ig-media-id}/insights', apiVersion: ctx.versions.meta } };
}

/* --------------------------- TikTok (Display API v2) --------------------------- */

export async function fetchTiktokAnalytics(ctx: ConnectorContext, videoIds: string[]): Promise<AnalyticsFetch> {
  if (ctx.credentials.provider !== 'tiktok') throw new Error('tiktok credentials required');
  const base = `${ctx.endpoints.tiktok.replace(/\/$/, '')}/${ctx.versions.tiktok}`;
  const headers = { authorization: `Bearer ${ctx.credentials.accessToken}`, 'content-type': 'application/json; charset=UTF-8' };
  const notes: string[] = [];
  const check = (data: { error?: { code: string; message?: string } }) => {
    const code = data.error?.code ?? 'ok';
    if (code !== 'ok') throw new ProviderHttpError(`tiktok error ${code}: ${data.error?.message ?? ''}`, { status: ['access_token_invalid', 'scope_not_authorized'].includes(code) ? 401 : 400, phase: 'rejected', body: data });
  };
  let account: ObjectReading | null = null;
  try {
    const u = await ctx.http.request<{ data?: { user?: Record<string, unknown> }; error?: { code: string; message?: string } }>({ method: 'GET', url: `${base}/user/info/?fields=open_id,${PLATFORM_METRICS.tiktok.account.join(',')}`, headers, idempotent: true });
    check(u.data);
    account = { ref: String(u.data.data?.user?.open_id ?? ctx.connection.externalAccountId), metrics: reading(PLATFORM_METRICS.tiktok.account, u.data.data?.user) };
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status === 401) {
      notes.push('account statistics need the user.info.stats scope');
      account = { ref: ctx.connection.externalAccountId, metrics: reading(PLATFORM_METRICS.tiktok.account, null) };
    } else throw err;
  }
  const posts: ObjectReading[] = [];
  for (let i = 0; i < videoIds.length; i += 20) {
    const batch = videoIds.slice(i, i + 20);
    const r = await ctx.http.request<{ data?: { videos?: Record<string, unknown>[] }; error?: { code: string; message?: string } }>({ method: 'POST', url: `${base}/video/query/?fields=id,${PLATFORM_METRICS.tiktok.post.join(',')}`, headers, json: { filters: { video_ids: batch } }, idempotent: true });
    check(r.data);
    const found = r.data.data?.videos ?? [];
    for (const id of batch) {
      const v = found.find((x) => String(x.id) === id);
      if (!v) notes.push(`video ${id} not returned (deleted, private to the app, or still processing)`);
      posts.push({ ref: id, metrics: reading(PLATFORM_METRICS.tiktok.post, v ?? null) });
    }
  }
  return { platform: 'tiktok', account, posts, notes, source: { endpoint: 'open.tiktokapis.com /user/info/, /video/query/', apiVersion: ctx.versions.tiktok } };
}

/* --------------------------- YouTube (Data API v3 + Analytics API v2) --------------------------- */

export async function fetchYoutubeAnalytics(ctx: ConnectorContext, videoIds: string[], window: { startDate: string; endDate: string }): Promise<AnalyticsFetch> {
  if (ctx.credentials.provider !== 'youtube') throw new Error('youtube credentials required');
  const token = await googleAccessToken(ctx.http, ctx.endpoints.googleOAuth, ctx.credentials);
  const headers = { authorization: `Bearer ${token}` };
  const notes: string[] = [];
  const ch = await ctx.http.request<{ items?: { id: string; statistics: Record<string, unknown> }[] }>({ method: 'GET', url: `${ctx.endpoints.youtubeData}/channels?part=statistics&id=${encodeURIComponent(ctx.connection.externalAccountId)}`, headers, idempotent: true });
  const stats = ch.data.items?.[0]?.statistics ?? null;
  if (stats?.hiddenSubscriberCount === true) notes.push('the channel hides its subscriber count');
  const account = { ref: ctx.connection.externalAccountId, metrics: reading(PLATFORM_METRICS.youtube.account, stats?.hiddenSubscriberCount === true ? { ...stats, subscriberCount: undefined } : stats) };
  const byId = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const r = await ctx.http.request<{ items?: { id: string; statistics: Record<string, unknown> }[] }>({ method: 'GET', url: `${ctx.endpoints.youtubeData}/videos?part=statistics&id=${batch.map(encodeURIComponent).join(',')}`, headers, idempotent: true });
    for (const it of r.data.items ?? []) byId.set(it.id, { ...it.statistics });
  }
  // Watch time comes only from the YouTube Analytics API (yt-analytics.readonly); without it those metrics stay not_returned.
  if (videoIds.length) {
    try {
      const u = new URL(`${ctx.endpoints.youtubeAnalytics}/reports`);
      u.searchParams.set('ids', 'channel==MINE');
      u.searchParams.set('startDate', window.startDate);
      u.searchParams.set('endDate', window.endDate);
      u.searchParams.set('metrics', 'estimatedMinutesWatched,averageViewDuration');
      u.searchParams.set('dimensions', 'video');
      u.searchParams.set('filters', `video==${videoIds.slice(0, 200).join(',')}`);
      const a = await ctx.http.request<{ columnHeaders?: { name: string }[]; rows?: unknown[][] }>({ method: 'GET', url: u.toString(), headers, idempotent: true });
      const cols = (a.data.columnHeaders ?? []).map((c) => c.name);
      for (const row of a.data.rows ?? []) {
        const id = String(row[cols.indexOf('video')]);
        byId.set(id, { ...(byId.get(id) ?? {}), estimatedMinutesWatched: row[cols.indexOf('estimatedMinutesWatched')], averageViewDuration: row[cols.indexOf('averageViewDuration')] });
      }
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) notes.push('watch time needs the yt-analytics.readonly scope; estimatedMinutesWatched and averageViewDuration are not returned');
      else throw err;
    }
  }
  const posts = videoIds.map((id) => {
    if (!byId.has(id)) notes.push(`video ${id} not returned (deleted or private)`);
    return { ref: id, metrics: reading(PLATFORM_METRICS.youtube.post, byId.get(id) ?? null) };
  });
  return { platform: 'youtube', account, posts, notes, source: { endpoint: 'youtube/v3 channels, videos; youtubeanalytics/v2 reports', apiVersion: ctx.versions.youtube } };
}

/* --------------------------- LinkedIn (Community Management API) --------------------------- */

export async function fetchLinkedinAnalytics(ctx: ConnectorContext, postUrns: string[]): Promise<AnalyticsFetch> {
  if (ctx.credentials.provider !== 'linkedin') throw new Error('linkedin credentials required');
  const org = `urn:li:organization:${ctx.connection.externalAccountId}`;
  const headers = { authorization: `Bearer ${ctx.credentials.accessToken}`, 'linkedin-version': ctx.versions.linkedin, 'x-restli-protocol-version': '2.0.0' };
  const base = ctx.endpoints.linkedin.replace(/\/$/, '');
  const notes: string[] = [];
  const size = await ctx.http.request<{ firstDegreeSize?: number }>({ method: 'GET', url: `${base}/rest/networkSizes/${encodeURIComponent(org)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, headers, idempotent: true });
  const account = { ref: org, metrics: reading(PLATFORM_METRICS.linkedin.account, { followers: size.data.firstDegreeSize }) };
  const stats = new Map<string, Record<string, unknown>>();
  const shares = postUrns.filter((u) => u.startsWith('urn:li:share:'));
  const ugc = postUrns.filter((u) => u.startsWith('urn:li:ugcPost:'));
  for (const [param, list] of [
    ['shares', shares],
    ['ugcPosts', ugc],
  ] as const) {
    for (let i = 0; i < list.length; i += 20) {
      const batch = list.slice(i, i + 20);
      const url = `${base}/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(org)}&${param}=List(${batch.map(encodeURIComponent).join(',')})`;
      const r = await ctx.http.request<{ elements?: { share?: string; ugcPost?: string; totalShareStatistics?: Record<string, unknown> }[] }>({ method: 'GET', url, headers, idempotent: true });
      for (const e of r.data.elements ?? []) {
        const urn = e.share ?? e.ugcPost;
        if (urn) stats.set(urn, e.totalShareStatistics ?? {});
      }
    }
  }
  const posts = postUrns.map((urn) => {
    if (!stats.has(urn)) notes.push(`${urn} not returned`);
    return { ref: urn, metrics: reading(PLATFORM_METRICS.linkedin.post, stats.get(urn) ?? null) };
  });
  return { platform: 'linkedin', account, posts, notes, source: { endpoint: 'rest/networkSizes, rest/organizationalEntityShareStatistics', apiVersion: ctx.versions.linkedin } };
}
