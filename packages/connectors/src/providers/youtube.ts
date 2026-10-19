import { ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type ConnectorContext, type HealthResult, type ReadConnector, compareProof, proof } from '../types.js';
import { googleAccessToken } from './google.js';

type YtCreds = Extract<ConnectorContext['credentials'], { provider: 'youtube' }>;

function creds(ctx: ConnectorContext): YtCreds {
  if (ctx.credentials.provider !== 'youtube') throw new Error('youtube credentials required');
  return ctx.credentials;
}

interface YtParams {
  title: string;
  description: string;
  privacyStatus: 'public' | 'unlisted' | 'private';
  categoryId: string;
  containsSyntheticMedia: boolean;
  madeForKids: boolean;
  assetIds: string[];
}

interface YtVideo {
  id: string;
  snippet?: { title?: string };
  status?: { uploadStatus?: string; privacyStatus?: string; containsSyntheticMedia?: boolean; rejectionReason?: string; failureReason?: string };
}

async function readVideo(ctx: ConnectorContext, id: string): Promise<YtVideo | null> {
  const token = await googleAccessToken(ctx.http, ctx.endpoints.googleOAuth, creds(ctx));
  const res = await ctx.http.request<{ items?: YtVideo[] }>({
    method: 'GET',
    url: `${ctx.endpoints.youtubeData}/videos?part=status,snippet&id=${encodeURIComponent(id)}`,
    headers: { authorization: `Bearer ${token}` },
    idempotent: true,
  });
  return res.data.items?.[0] ?? null;
}

export const youtubeUploadVideo: ActionExecutor<YtParams> = {
  actionType: 'social.youtube.upload_video',
  provider: 'youtube',
  async execute(ctx, p) {
    const { token, asset, uploadUrl } = await preWrite(async () => {
      if (p.madeForKids) throw new ProviderHttpError("made-for-kids uploads require the children's policy path [BLOCK]", { status: null, phase: 'rejected' });
      const t = await googleAccessToken(ctx.http, ctx.endpoints.googleOAuth, creds(ctx));
      const a = await ctx.loadAsset(p.assetIds[0]!);
      // Resumable session creation does not create a video until bytes are uploaded.
      const init = await ctx.http.request({
        method: 'POST',
        url: `${ctx.endpoints.youtubeUpload}/videos?uploadType=resumable&part=snippet,status`,
        headers: {
          authorization: `Bearer ${t}`,
          'x-upload-content-type': a.mime,
          'x-upload-content-length': String(a.bytes.byteLength),
        },
        json: {
          snippet: { title: p.title, description: p.description, categoryId: p.categoryId },
          status: { privacyStatus: p.privacyStatus, selfDeclaredMadeForKids: false, containsSyntheticMedia: p.containsSyntheticMedia },
        },
        idempotent: false,
      });
      const location = init.headers.location;
      if (!location) throw new ProviderHttpError('youtube did not return an upload session', { status: init.status, phase: 'rejected' });
      return { token: t, asset: a, uploadUrl: location };
    });
    const res = await ctx.http.request<YtVideo>({
      method: 'PUT',
      url: uploadUrl,
      headers: { authorization: `Bearer ${token}`, 'content-type': asset.mime },
      body: asset.bytes,
      idempotent: false,
      timeoutMs: 600_000,
    });
    if (!res.data?.id) throw new ProviderHttpError('youtube returned no video id', { status: res.status, phase: 'ambiguous', body: res.data });
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: res.data.id, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { assetSha256: asset.sha256 } },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verify(ctx, p, receipt) {
    const v = await readVideo(ctx, receipt.providerObjectId!);
    if (!v) return proof('PENDING', 'read_after_write', { exists: true }, { exists: false }, ctx.now());
    const upload = v.status?.uploadStatus;
    if (upload === 'failed' || upload === 'rejected' || upload === 'deleted') {
      return proof('MISMATCH', 'read_after_write', { uploadStatus: 'processed' }, { uploadStatus: upload, reason: v.status?.rejectionReason ?? v.status?.failureReason ?? null }, ctx.now());
    }
    if (upload !== 'processed') return proof('PENDING', 'read_after_write', { uploadStatus: 'processed' }, { uploadStatus: upload ?? null }, ctx.now(), 'processing');
    return compareProof(
      'read_after_write',
      { title: p.title, privacyStatus: p.privacyStatus, containsSyntheticMedia: p.containsSyntheticMedia },
      { title: v.snippet?.title, privacyStatus: v.status?.privacyStatus, containsSyntheticMedia: v.status?.containsSyntheticMedia ?? false },
      ctx.now(),
    );
  },
  async rollback(ctx, _p, receipt) {
    const token = await googleAccessToken(ctx.http, ctx.endpoints.googleOAuth, creds(ctx));
    const res = await ctx.http.request({
      method: 'DELETE',
      url: `${ctx.endpoints.youtubeData}/videos?id=${encodeURIComponent(receipt.providerObjectId!)}`,
      headers: { authorization: `Bearer ${token}` },
      idempotent: true,
    });
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: receipt.providerObjectId, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { rollback: true } },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verifyRollback(ctx, _p, receipt) {
    const v = await readVideo(ctx, receipt.providerObjectId!);
    return v ? proof('MISMATCH', 'read_after_write', { exists: false }, { exists: true }, ctx.now()) : proof('VERIFIED', 'read_after_write', { exists: false }, { exists: false }, ctx.now());
  },
};

export const youtubeRead: ReadConnector = {
  provider: 'youtube',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const token = await googleAccessToken(ctx.http, ctx.endpoints.googleOAuth, creds(ctx));
      const res = await ctx.http.request<{ items?: { id: string }[] }>({
        method: 'GET',
        url: `${ctx.endpoints.youtubeData}/channels?part=id&mine=true`,
        headers: { authorization: `Bearer ${token}` },
        idempotent: true,
      });
      const ok = (res.data.items ?? []).some((c) => c.id === ctx.connection.externalAccountId);
      return { healthy: ok, status: ok ? 'healthy' : 'degraded', grantedScopes: null, details: { channels: res.data.items?.length ?? 0 } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
