import { ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type ConnectorContext, type HealthResult, type ReadConnector, proof } from '../types.js';

type TikTokCreds = Extract<ConnectorContext['credentials'], { provider: 'tiktok' }>;

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code: string; message?: string; log_id?: string };
}

function creds(ctx: ConnectorContext): TikTokCreds {
  if (ctx.credentials.provider !== 'tiktok') throw new Error('tiktok credentials required');
  return ctx.credentials;
}

async function call<T>(ctx: ConnectorContext, path: string, body: unknown, idempotent: boolean) {
  const res = await ctx.http.request<TikTokEnvelope<T>>({
    method: 'POST',
    url: `${ctx.endpoints.tiktok.replace(/\/$/, '')}/${ctx.versions.tiktok}/${path}`,
    headers: { authorization: `Bearer ${creds(ctx).accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
    json: body,
    idempotent,
  });
  const code = res.data.error?.code ?? 'ok';
  if (code !== 'ok') {
    const auth = ['access_token_invalid', 'scope_not_authorized', 'token_not_authorized_for_specified_open_id'].includes(code);
    throw new ProviderHttpError(`tiktok error ${code}: ${res.data.error?.message ?? ''}`, {
      status: auth ? 401 : res.status,
      phase: 'rejected',
      body: res.data,
      providerRequestId: res.data.error?.log_id ?? res.requestId,
    });
  }
  return res;
}

interface CreatorInfo {
  creator_username?: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec?: number;
}

interface TikTokParams {
  title: string;
  videoUrl: string;
  privacyLevel: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContentToggle: boolean;
  brandOrganicToggle: boolean;
  disclosure: { isAiGenerated: boolean };
}

export const tiktokPublishVideo: ActionExecutor<TikTokParams> = {
  actionType: 'social.tiktok.publish_video',
  provider: 'tiktok',
  async execute(ctx, p) {
    // TikTok requires querying creator info immediately before posting and honouring its options.
    const info = await preWrite(async () => {
      const r = await call<CreatorInfo>(ctx, 'post/publish/creator_info/query/', {}, true);
      const ci = r.data.data;
      if (!ci) throw new ProviderHttpError('tiktok creator_info missing', { status: null, phase: 'rejected' });
      if (!ci.privacy_level_options.includes(p.privacyLevel)) {
        throw new ProviderHttpError(`privacy level ${p.privacyLevel} not offered for this creator (${ci.privacy_level_options.join(',')})`, { status: null, phase: 'rejected' });
      }
      return ci;
    });
    const res = await call<{ publish_id: string }>(
      ctx,
      'post/publish/video/init/',
      {
        post_info: {
          title: p.title,
          privacy_level: p.privacyLevel,
          disable_comment: p.disableComment || info.comment_disabled,
          disable_duet: p.disableDuet || info.duet_disabled,
          disable_stitch: p.disableStitch || info.stitch_disabled,
          brand_content_toggle: p.brandContentToggle,
          brand_organic_toggle: p.brandOrganicToggle,
          is_aigc: p.disclosure.isAiGenerated,
        },
        source_info: { source: 'PULL_FROM_URL', video_url: p.videoUrl },
      },
      false,
    );
    const publishId = res.data.data?.publish_id;
    if (!publishId) throw new ProviderHttpError('tiktok returned no publish_id', { status: res.status, phase: 'ambiguous', body: res.data });
    return {
      receipt: {
        providerRequestId: res.data.error?.log_id ?? res.requestId,
        providerObjectId: publishId,
        httpStatus: res.status,
        responseSha256: res.sha256,
        observedAt: ctx.now().toISOString(),
        details: { creator: info.creator_username ?? null },
      },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verify(ctx, p, receipt) {
    const r = await call<{ status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(
      ctx,
      'post/publish/status/fetch/',
      { publish_id: receipt.providerObjectId },
      true,
    );
    const d = r.data.data;
    const observed = { status: d?.status ?? 'UNKNOWN', postIds: d?.publicaly_available_post_id ?? [], failReason: d?.fail_reason ?? null };
    if (d?.status === 'PUBLISH_COMPLETE') {
      // SELF_ONLY posts are complete but have no public post id; that is the expected postcondition.
      const publicExpected = p.privacyLevel === 'PUBLIC_TO_EVERYONE';
      if (publicExpected && observed.postIds.length === 0) return proof('PENDING', 'status_poll', { status: 'PUBLISH_COMPLETE', public: true }, observed, ctx.now(), 'awaiting public post id');
      return proof('VERIFIED', 'status_poll', { status: 'PUBLISH_COMPLETE' }, observed, ctx.now());
    }
    if (d?.status === 'FAILED') return proof('MISMATCH', 'status_poll', { status: 'PUBLISH_COMPLETE' }, observed, ctx.now(), `publish failed: ${d.fail_reason ?? 'unknown'}`);
    return proof('PENDING', 'status_poll', { status: 'PUBLISH_COMPLETE' }, observed, ctx.now(), 'processing');
  },
  // No delete endpoint for posts in the Content Posting API: rollback is manual (escalation).
};

export const tiktokRead: ReadConnector = {
  provider: 'tiktok',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const r = await call<CreatorInfo>(ctx, 'post/publish/creator_info/query/', {}, true);
      return { healthy: true, status: 'healthy', grantedScopes: null, details: { privacyOptions: r.data.data?.privacy_level_options ?? [] } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
