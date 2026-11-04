import { ProviderHttpError, preWrite } from '../http.js';
import { multipartBody } from '../multipart.js';
import { type ActionExecutor, type ConnectorContext, compareProof, type HealthResult, proof, type ReadConnector } from '../types.js';

/**
 * X (formerly Twitter) API v2 posts with an OAuth 2.0 user-context token (tweet.read, tweet.write,
 * users.read, media.write). Docs checked 2026-11-04: X API is pay-per-use with prepaid credits and no
 * free posting tier (Post: Create $0.015, with a URL $0.20 per request), so the action type ships
 * `supported: false` (B-019) until the owner authorizes that spend. POST /2/media/upload (one-shot
 * image upload, data.id), POST /2/tweets {text, media.media_ids}, GET /2/tweets/:id, DELETE.
 */

type XCreds = Extract<ConnectorContext['credentials'], { provider: 'x' }>;

function creds(ctx: ConnectorContext): XCreds {
  if (ctx.credentials.provider !== 'x') throw new Error('x credentials required');
  return ctx.credentials;
}

const base = (ctx: ConnectorContext) => ctx.endpoints.x.replace(/\/$/, '');
const auth = (ctx: ConnectorContext) => ({ authorization: `Bearer ${creds(ctx).accessToken}` });

export interface XPostParams {
  text: string;
  media?: { assetId: string; sha256: string }[];
  postId: string;
  assetIds: string[];
  claimIds: string[];
  disclosure: Record<string, unknown>;
}

/** X shortens links to t.co; compare text with every URL replaced by a placeholder. */
const withoutUrls = (s: string) => s.replace(/https?:\/\/\S+/g, '<url>').trim();

async function uploadImage(ctx: ConnectorContext, m: { assetId: string; sha256: string }): Promise<string> {
  const a = await ctx.loadAsset(m.assetId);
  if (a.sha256 !== m.sha256) throw new ProviderHttpError(`asset ${m.assetId} content hash ${a.sha256} differs from the approved ${m.sha256}`, { status: null, phase: 'before_send' });
  if (!a.mime.startsWith('image/')) throw new ProviderHttpError(`asset ${m.assetId} is ${a.mime}, not an image`, { status: null, phase: 'before_send' });
  const { body, contentType } = multipartBody({ media_category: 'tweet_image' }, { field: 'media', name: `${m.sha256.slice(0, 16)}.${a.mime.split('/')[1]}`, mime: a.mime, bytes: a.bytes });
  const r = await ctx.http.request<{ data?: { id?: string } }>({ method: 'POST', url: `${base(ctx)}/2/media/upload`, headers: { ...auth(ctx), 'content-type': contentType }, body, idempotent: false, timeoutMs: 120_000 });
  const id = r.data.data?.id;
  if (!id) throw new ProviderHttpError('x returned no media id', { status: r.status, phase: 'ambiguous', body: r.data });
  return id;
}

interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  attachments?: { media_keys?: string[] };
}

async function readPost(ctx: ConnectorContext, id: string): Promise<XTweet | null> {
  try {
    const r = await ctx.http.request<{ data?: XTweet; errors?: { title?: string }[] }>({ method: 'GET', url: `${base(ctx)}/2/tweets/${encodeURIComponent(id)}?tweet.fields=author_id,attachments`, headers: auth(ctx), idempotent: true });
    return r.data.data ?? null;
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status === 404) return null;
    throw err;
  }
}

export const xPublishPost: ActionExecutor<XPostParams> = {
  actionType: 'social.x.publish_post',
  provider: 'x',
  async execute(ctx, p) {
    const mediaIds = await preWrite(async () => {
      const ids: string[] = [];
      for (const m of p.media ?? []) ids.push(await uploadImage(ctx, m));
      return ids;
    });
    const res = await ctx.http.request<{ data?: { id?: string; text?: string } }>({ method: 'POST', url: `${base(ctx)}/2/tweets`, headers: auth(ctx), json: { text: p.text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) }, idempotent: false });
    const id = res.data.data?.id;
    if (!id) throw new ProviderHttpError('x returned no post id', { status: res.status, phase: 'ambiguous', body: res.data });
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: id, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { mediaIds, author: ctx.connection.externalAccountId } },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verify(ctx, p, receipt) {
    const post = await readPost(ctx, receipt.providerObjectId!);
    if (!post) return proof('PENDING', 'read_after_write', { exists: true }, { exists: false }, ctx.now(), 'post not yet readable');
    return compareProof('read_after_write', { id: receipt.providerObjectId, author: ctx.connection.externalAccountId, text: withoutUrls(p.text), media: (p.media ?? []).length }, { id: post.id, author: post.author_id, text: withoutUrls(post.text), media: post.attachments?.media_keys?.length ?? 0 }, ctx.now());
  },
  async rollback(ctx, _p, receipt) {
    const res = await ctx.http.request<{ data?: { deleted?: boolean } }>({ method: 'DELETE', url: `${base(ctx)}/2/tweets/${encodeURIComponent(receipt.providerObjectId!)}`, headers: auth(ctx), idempotent: true });
    return { receipt: { providerRequestId: res.requestId, providerObjectId: receipt.providerObjectId, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { deleted: res.data.data?.deleted === true } }, beforeState: null, rawResponse: res.data };
  },
  async verifyRollback(ctx, _p, receipt) {
    const post = await readPost(ctx, receipt.providerObjectId!);
    return post ? proof('MISMATCH', 'read_after_write', { exists: false }, { exists: true }, ctx.now()) : proof('VERIFIED', 'read_after_write', { exists: false }, { exists: false }, ctx.now());
  },
};

export const xRead: ReadConnector = {
  provider: 'x',
  /** Reads the token's own account; healthy only when it is the connected account. */
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const r = await ctx.http.request<{ data?: { id?: string; username?: string } }>({ method: 'GET', url: `${base(ctx)}/2/users/me`, headers: auth(ctx), idempotent: true });
      const same = r.data.data?.id === ctx.connection.externalAccountId;
      return { healthy: same, status: same ? 'healthy' : 'failing', grantedScopes: null, details: { accountId: r.data.data?.id ?? null, username: r.data.data?.username ?? null, ...(same ? {} : { error: 'the token belongs to a different X account' }) } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
