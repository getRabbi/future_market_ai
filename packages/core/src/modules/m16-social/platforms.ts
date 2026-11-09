import { getActionType } from '@futuregrow/contracts';
import { assets, connections, type DbOrTx, platformCapabilities, socialPosts } from '@futuregrow/db';
import { and, desc, eq, inArray } from 'drizzle-orm';

/* ------------------------------------------------------------------ */
/* Platform formats (one concept, adapted per channel; D-042)          */
/* ------------------------------------------------------------------ */

export const PLATFORMS = ['facebook', 'instagram', 'x', 'reddit', 'youtube', 'tiktok', 'linkedin'] as const;
export type SocialPlatform = (typeof PLATFORMS)[number];

export interface PlatformFormat {
  /** Caption limit and how it is counted. */
  caption: { max: number; counting: 'utf16' | 'x_weighted' } | null;
  maxHashtags: number | null;
  links: 'clickable' | 'not_clickable' | 'none';
  images: { max: number; aspects: string[] } | null;
  /** The card renderer makes 4:5 (1080×1350) images; video is not produced by the studio. */
  needsVideo: boolean;
}

export const PLATFORM_FORMATS: Record<SocialPlatform, PlatformFormat> = {
  facebook: { caption: { max: 63_206, counting: 'utf16' }, maxHashtags: null, links: 'clickable', images: { max: 10, aspects: ['4:5', '1:1', '1.91:1'] }, needsVideo: false },
  instagram: { caption: { max: 2_200, counting: 'utf16' }, maxHashtags: 30, links: 'not_clickable', images: { max: 10, aspects: ['4:5', '1:1', '1.91:1'] }, needsVideo: false },
  x: { caption: { max: 280, counting: 'x_weighted' }, maxHashtags: null, links: 'clickable', images: { max: 4, aspects: ['16:9', '4:5', '1:1'] }, needsVideo: false },
  linkedin: { caption: { max: 3_000, counting: 'utf16' }, maxHashtags: null, links: 'clickable', images: { max: 20, aspects: ['1.91:1', '1:1', '4:5'] }, needsVideo: false },
  tiktok: { caption: { max: 2_200, counting: 'utf16' }, maxHashtags: null, links: 'none', images: null, needsVideo: true },
  youtube: { caption: { max: 5_000, counting: 'utf16' }, maxHashtags: 15, links: 'clickable', images: null, needsVideo: true },
  reddit: { caption: null, maxHashtags: null, links: 'clickable', images: null, needsVideo: false },
};

const URL_RE = /https?:\/\/[^\s]+/g;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const LIGHT: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

/**
 * X's weighted length (twitter-text v3): URLs count 23, emoji 2, code points up to U+10FF (Latin,
 * Bangla, Devanagari…) and general punctuation 1, everything else (Hangul, CJK) 2 per code point.
 */
export function xWeightedLength(text: string): number {
  const urls = text.match(URL_RE) ?? [];
  let n = urls.length * 23;
  const rest = text.normalize('NFC').replace(URL_RE, '');
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(rest)) {
    if (PICTOGRAPHIC.test(segment)) {
      n += 2;
      continue;
    }
    for (const ch of segment) {
      const cp = ch.codePointAt(0)!;
      n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return n;
}

export interface CaptionCheck {
  platform: SocialPlatform;
  ok: boolean;
  length: number;
  limit: number | null;
  problems: string[];
  notes: string[];
}

/**
 * Checks (never truncates) a caption for a platform. Over-long copy is refused so the creative is
 * rewritten for that channel instead of being cut mid-sentence.
 */
export function checkCaption(platform: SocialPlatform, caption: string, opts: { link?: string | null; images?: number } = {}): CaptionCheck {
  const f = PLATFORM_FORMATS[platform];
  const problems: string[] = [];
  const notes: string[] = [];
  const full = opts.link && f.links !== 'none' ? `${caption}\n${opts.link}` : caption;
  const length = f.caption?.counting === 'x_weighted' ? xWeightedLength(full) : full.length;
  if (!f.caption) problems.push(`${platform} publishing is not automated; prepare an owner-assisted share instead`);
  else if (length > f.caption.max) problems.push(`${length} ${f.caption.counting === 'x_weighted' ? 'weighted characters' : 'characters'} exceed ${platform}'s ${f.caption.max}`);
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (f.maxHashtags !== null && tags > f.maxHashtags) problems.push(`${tags} hashtags exceed ${platform}'s ${f.maxHashtags}`);
  if (opts.link && f.links === 'not_clickable') notes.push(`${platform} does not make caption links clickable; point to the profile link instead`);
  if (opts.link && f.links === 'none') problems.push(`${platform} posts cannot carry a link`);
  if ((opts.images ?? 0) > 0 && !f.images) problems.push(`${platform} needs a video, not images`);
  if (f.images && (opts.images ?? 0) > f.images.max) problems.push(`${opts.images} images exceed ${platform}'s ${f.images.max}`);
  if (f.needsVideo && !(opts.images ?? 0)) notes.push('the studio does not produce video yet');
  return { platform, ok: problems.length === 0, length, limit: f.caption?.max ?? null, problems, notes };
}

/* ------------------------------------------------------------------ */
/* Platform readiness: explicit operational status per tenant          */
/* ------------------------------------------------------------------ */

export type PlatformStatus = 'live_verified' | 'ready' | 'needs_connection' | 'connection_unhealthy' | 'missing_permissions' | 'awaiting_approval' | 'needs_video' | 'disabled' | 'owner_assisted';

const SPEC: Record<SocialPlatform, { provider: string | null; actionType: string | null; capability: string | null; engagement: string; analytics: string }> = {
  facebook: {
    provider: 'meta',
    actionType: 'social.facebook.publish_post',
    capability: 'facebook_page_publish',
    engagement: 'Comments arrive by signed webhook; reply drafts are grounded in approved knowledge and sent only by a person through M23.',
    analytics: 'Daily Page post counters (reactions, top-level comments, shares when returned); Page insights need read_insights.',
  },
  instagram: { provider: 'meta', actionType: 'social.instagram.publish_media', capability: 'instagram_content_publish', engagement: 'Not collected yet.', analytics: 'Not collected yet.' },
  x: { provider: 'x', actionType: 'social.x.publish_post', capability: 'x_post_create', engagement: 'Not collected (reads are billed per request).', analytics: 'Not collected.' },
  reddit: { provider: null, actionType: null, capability: null, engagement: 'Owner-assisted only.', analytics: 'Owner-reported outcomes in the community workspace.' },
  youtube: { provider: 'youtube', actionType: 'social.youtube.upload_video', capability: 'youtube_video_upload', engagement: 'Not collected yet.', analytics: 'Not collected yet.' },
  tiktok: { provider: 'tiktok', actionType: 'social.tiktok.publish_video', capability: 'tiktok_direct_post', engagement: 'Not collected yet.', analytics: 'Not collected yet.' },
  linkedin: { provider: 'linkedin', actionType: 'social.linkedin.publish_post', capability: 'linkedin_org_post', engagement: 'Not collected yet.', analytics: 'Not collected yet.' },
};

const DAY = 86_400_000;

export interface PlatformReadiness {
  platform: SocialPlatform;
  status: PlatformStatus;
  reasons: string[];
  provider: string | null;
  actionType: string | null;
  automatedPublishing: boolean;
  connections: { id: string; displayName: string; status: string; healthStatus: string; missingScopes: string[] }[];
  lastVerifiedPostAt: string | null;
  format: PlatformFormat;
  engagement: string;
  analytics: string;
}

/**
 * What each platform can really do for this organization right now. A platform is "live_verified"
 * only with an independently verified post in the last 14 days; nothing is reported as working on
 * the strength of code or credentials alone.
 */
export async function platformReadiness(t: DbOrTx, now: Date): Promise<PlatformReadiness[]> {
  const [conns, caps, verified, videos] = await Promise.all([
    t
      .select()
      .from(connections)
      .where(inArray(connections.provider, ['meta', 'x', 'youtube', 'tiktok', 'linkedin'])),
    t.select().from(platformCapabilities),
    t
      .select({ platform: socialPosts.platform, verifiedAt: socialPosts.verifiedAt })
      .from(socialPosts)
      .where(and(eq(socialPosts.status, 'published_verified')))
      .orderBy(desc(socialPosts.verifiedAt))
      .limit(500),
    t
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.kind, 'video'), eq(assets.publishEligible, true)))
      .limit(1),
  ]);
  return PLATFORMS.map((platform) => {
    const spec = SPEC[platform];
    const format = PLATFORM_FORMATS[platform];
    const base = { platform, provider: spec.provider, actionType: spec.actionType, format, engagement: spec.engagement, analytics: spec.analytics };
    const reasons: string[] = [];
    if (!spec.provider || !spec.actionType) {
      return {
        ...base,
        status: 'owner_assisted' as const,
        automatedPublishing: false,
        connections: [],
        lastVerifiedPostAt: null,
        reasons: ['Reddit API access needs Reddit approval (and a contract for commercial use); automated promotional posting stays disabled. Prepare share kits in the community workspace, follow each subreddit’s rules, and record what you posted.'],
      };
    }
    const action = getActionType(spec.actionType);
    const cap = caps.find((c) => c.capability === spec.capability);
    const required = cap?.requiredScopes ?? [];
    const mine = conns.filter((c) => c.provider === spec.provider && (platform !== 'instagram' || typeof (c.metadata as { igUserId?: unknown }).igUserId === 'string'));
    const view = mine.map((c) => ({ id: c.id, displayName: c.displayName, status: c.status, healthStatus: c.healthStatus, missingScopes: c.grantedScopes.length ? required.filter((s) => !c.grantedScopes.includes(s)) : [] }));
    const last = verified.find((v) => v.platform === platform)?.verifiedAt ?? null;
    const lastVerifiedPostAt = last?.toISOString() ?? null;
    const usable = view.filter((c) => c.status === 'active' && c.healthStatus !== 'failing');
    let status: PlatformStatus;
    if (!action?.supported || cap?.supported === false) {
      status = 'disabled';
      reasons.push(action?.blockerRef ? `Publishing is disabled (${action.blockerRef}): ${action.description}` : 'Publishing is disabled in the capability registry.');
    } else if (!mine.length) {
      status = 'needs_connection';
      reasons.push(platform === 'instagram' ? 'Connect a Facebook Page whose linked Instagram professional account id (igUserId) is recorded.' : `Connect a ${platform} account.`);
    } else if (!usable.length) {
      status = 'connection_unhealthy';
      reasons.push('Every connected account is inactive or failing its health check; reconnect it.');
    } else if (usable.every((c) => c.missingScopes.length)) {
      status = 'missing_permissions';
      reasons.push(`Missing permission(s): ${[...new Set(usable.flatMap((c) => c.missingScopes))].join(', ')}.`);
    } else if (format.needsVideo && !videos.length) {
      status = 'needs_video';
      reasons.push('This platform publishes video: render one in the Video Studio (Asset studio) or upload a video with recorded rights.');
    } else if (last && now.getTime() - last.getTime() <= 14 * DAY) {
      status = 'live_verified';
      reasons.push(`Last post verified by read-back ${lastVerifiedPostAt}.`);
    } else if (cap?.appReviewRequired === 'true' && platform !== 'facebook' && !usable.some((c) => mine.find((m) => m.id === c.id)?.appAudited === true)) {
      status = 'awaiting_approval';
      reasons.push(platform === 'linkedin' ? 'Posting as an organization needs LinkedIn Community Management API approval for the app.' : 'The platform must approve (audit) the app before public posting.');
    } else {
      status = 'ready';
      reasons.push('Connected with the required permissions; no post has been verified on this platform in the last 14 days.');
    }
    if (platform === 'facebook' && status === 'live_verified') reasons.push('Public visibility is not independently verified while the Meta app is in Development mode.');
    return { ...base, status, reasons, automatedPublishing: status === 'live_verified' || status === 'ready', connections: view, lastVerifiedPostAt };
  });
}
