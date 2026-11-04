import { ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type ConnectorContext, compareProof, type HealthResult, proof, type ReadConnector } from '../types.js';

/**
 * LinkedIn organization posts (Posts API, Community Management API product). Posting as an
 * organization needs `w_organization_social`, granted only to approved apps, and a member with an
 * ADMINISTRATOR, CONTENT_ADMIN or DIRECT_SPONSORED_CONTENT_POSTER role on that organization.
 * Docs checked 2026-11-04 (li-lms-2026-10): POST /rest/posts → 201 with the post URN in x-restli-id;
 * GET /rest/posts/{urn}?viewContext=AUTHOR reads it back; images upload via /rest/images.
 */

type LinkedInCreds = Extract<ConnectorContext['credentials'], { provider: 'linkedin' }>;
const POSTING_ROLES = ['ADMINISTRATOR', 'CONTENT_ADMIN', 'DIRECT_SPONSORED_CONTENT_POSTER'];

function creds(ctx: ConnectorContext): LinkedInCreds {
  if (ctx.credentials.provider !== 'linkedin') throw new Error('linkedin credentials required');
  return ctx.credentials;
}

function headers(ctx: ConnectorContext, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${creds(ctx).accessToken}`, 'linkedin-version': ctx.versions.linkedin, 'x-restli-protocol-version': '2.0.0', ...extra };
}

const base = (ctx: ConnectorContext) => ctx.endpoints.linkedin.replace(/\/$/, '');

/** The "little" text format reserves these characters; unescaped they are parsed (or truncate the post). */
const RESERVED = /[\\|{}@[\]()<>*_~]/g;
export function toLittle(text: string): string {
  return text.replace(RESERVED, (c) => `\\${c}`);
}

/** Inverse for verification: hashtag templates back to "#tag", escapes removed. */
export function fromLittle(text: string): string {
  return text.replace(/\{hashtag\|\\?#\|([^}]*)\}/g, '#$1').replace(/\\([\\|{}@[\]()<>*_~#])/g, '$1');
}

export interface LinkedInPostParams {
  /** urn:li:organization:{id} */
  authorUrn: string;
  commentary: string;
  media?: { assetId: string; sha256: string; altText?: string }[];
  postId: string;
  assetIds: string[];
  claimIds: string[];
  disclosure: Record<string, unknown>;
}

function authError(err: unknown): never {
  if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) throw new ProviderHttpError(`linkedin refused the request (${err.status}): check w_organization_social and the member's page role`, { status: err.status, phase: 'rejected', body: err.body });
  throw err;
}

async function uploadImage(ctx: ConnectorContext, owner: string, m: { assetId: string; sha256: string }): Promise<string> {
  const a = await ctx.loadAsset(m.assetId);
  // The bytes sent must be exactly the bytes approved (content-addressed asset, re-hashed here).
  if (a.sha256 !== m.sha256) throw new ProviderHttpError(`asset ${m.assetId} content hash ${a.sha256} differs from the approved ${m.sha256}`, { status: null, phase: 'before_send' });
  if (!a.mime.startsWith('image/')) throw new ProviderHttpError(`asset ${m.assetId} is ${a.mime}, not an image`, { status: null, phase: 'before_send' });
  const init = await ctx.http.request<{ value?: { uploadUrl?: string; image?: string } }>({ method: 'POST', url: `${base(ctx)}/rest/images?action=initializeUpload`, headers: headers(ctx), json: { initializeUploadRequest: { owner } }, idempotent: false }).catch(authError);
  const uploadUrl = init.data.value?.uploadUrl;
  const image = init.data.value?.image;
  if (!uploadUrl || !image) throw new ProviderHttpError('linkedin returned no upload URL', { status: init.status, phase: 'ambiguous', body: init.data });
  await ctx.http.request({ method: 'PUT', url: uploadUrl, headers: { authorization: `Bearer ${creds(ctx).accessToken}`, 'content-type': a.mime }, body: a.bytes, idempotent: true, timeoutMs: 120_000 }).catch(authError);
  return image;
}

interface LinkedInPostRead {
  id?: string;
  author?: string;
  commentary?: string;
  visibility?: string;
  lifecycleState?: string;
  content?: { media?: { id?: string }; multiImage?: { images?: { id?: string }[] } };
}

const encodeUrn = (urn: string) => encodeURIComponent(urn);

async function readPost(ctx: ConnectorContext, urn: string): Promise<LinkedInPostRead | null> {
  try {
    const r = await ctx.http.request<LinkedInPostRead>({ method: 'GET', url: `${base(ctx)}/rest/posts/${encodeUrn(urn)}?viewContext=AUTHOR`, headers: headers(ctx), idempotent: true });
    return r.data;
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status === 404) return null;
    throw err;
  }
}

export const linkedinPublishPost: ActionExecutor<LinkedInPostParams> = {
  actionType: 'social.linkedin.publish_post',
  provider: 'linkedin',
  async execute(ctx, p) {
    if (!/^urn:li:organization:\d+$/.test(p.authorUrn)) throw new ProviderHttpError(`author ${p.authorUrn} is not an organization URN`, { status: null, phase: 'before_send' });
    const media = p.media ?? [];
    const images = await preWrite(async () => {
      const out: { id: string; altText?: string }[] = [];
      for (const m of media) out.push({ id: await uploadImage(ctx, p.authorUrn, m), ...(m.altText ? { altText: m.altText } : {}) });
      return out;
    });
    const content = images.length === 1 ? { media: { id: images[0]!.id, ...(images[0]!.altText ? { altText: images[0]!.altText } : {}) } } : images.length > 1 ? { multiImage: { images: images } } : undefined;
    const res = await ctx.http
      .request<Record<string, unknown>>({
        method: 'POST',
        url: `${base(ctx)}/rest/posts`,
        headers: headers(ctx),
        json: { author: p.authorUrn, commentary: toLittle(p.commentary), visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, ...(content ? { content } : {}), lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false },
        idempotent: false,
      })
      .catch(authError);
    const urn = res.headers['x-restli-id'] ?? res.headers['x-linkedin-id'] ?? null;
    if (!urn) throw new ProviderHttpError('linkedin returned no post URN', { status: res.status, phase: 'ambiguous', body: res.data });
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: urn, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { images: images.map((i) => i.id), url: `https://www.linkedin.com/feed/update/${urn}/` } },
      beforeState: null,
      rawResponse: { status: res.status, urn },
    };
  },
  async verify(ctx, p, receipt) {
    const post = await readPost(ctx, receipt.providerObjectId!);
    if (!post) return proof('PENDING', 'read_after_write', { exists: true }, { exists: false }, ctx.now(), 'post not yet readable');
    if (post.lifecycleState === 'PUBLISH_REQUESTED') return proof('PENDING', 'read_after_write', { lifecycleState: 'PUBLISHED' }, { lifecycleState: post.lifecycleState }, ctx.now(), 'processing');
    const images = (receipt.details as { images?: string[] } | undefined)?.images ?? [];
    const observedImages = post.content?.multiImage?.images?.map((i) => i.id) ?? (post.content?.media?.id ? [post.content.media.id] : []);
    return compareProof(
      'read_after_write',
      { author: p.authorUrn, commentary: p.commentary, visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', images },
      { author: post.author, commentary: fromLittle(post.commentary ?? ''), visibility: post.visibility, lifecycleState: post.lifecycleState, images: observedImages },
      ctx.now(),
    );
  },
  async rollback(ctx, _p, receipt) {
    // Deletion is idempotent on LinkedIn (204 also for an already deleted post).
    const res = await ctx.http.request({ method: 'DELETE', url: `${base(ctx)}/rest/posts/${encodeUrn(receipt.providerObjectId!)}`, headers: headers(ctx, { 'x-restli-method': 'DELETE' }), idempotent: true }).catch(authError);
    return { receipt: { providerRequestId: res.requestId, providerObjectId: receipt.providerObjectId, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { deleted: res.status === 204 } }, beforeState: null, rawResponse: { status: res.status } };
  },
  async verifyRollback(ctx, _p, receipt) {
    const post = await readPost(ctx, receipt.providerObjectId!);
    return post ? proof('MISMATCH', 'read_after_write', { exists: false }, { exists: true }, ctx.now()) : proof('VERIFIED', 'read_after_write', { exists: false }, { exists: false }, ctx.now());
  },
};

export const linkedinRead: ReadConnector = {
  provider: 'linkedin',
  /** Healthy only when the token's member holds a posting role on the connected organization. */
  async healthCheck(ctx): Promise<HealthResult> {
    const org = ctx.connection.externalAccountId;
    const urn = /^\d+$/.test(org) ? `urn:li:organization:${org}` : org;
    try {
      const r = await ctx.http.request<{ elements?: { organization?: string; role?: string; state?: string }[] }>({ method: 'GET', url: `${base(ctx)}/rest/organizationAcls?q=roleAssignee&state=APPROVED`, headers: headers(ctx), idempotent: true });
      const roles = (r.data.elements ?? []).filter((e) => e.organization === urn && e.state === 'APPROVED').map((e) => e.role ?? '');
      const canPost = roles.some((x) => POSTING_ROLES.includes(x));
      return { healthy: canPost, status: canPost ? 'healthy' : 'failing', grantedScopes: null, details: { organization: urn, roles, canPost, ...(canPost ? {} : { error: 'the member has no posting role on this organization' }) } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
