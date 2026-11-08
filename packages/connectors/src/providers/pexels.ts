import { ProviderHttpError } from '../http.js';
import type { ConnectorContext, HealthResult, ReadConnector } from '../types.js';

/**
 * Pexels API (P3-03, licensed stock media): https://www.pexels.com/api/documentation/
 * Photos: GET /v1/search, GET /v1/photos/:id. Videos: GET /videos/search, GET /videos/videos/:id.
 * Authorization is the API key in the Authorization header. Content is under the Pexels License
 * (https://www.pexels.com/license/): free to use, attribution appreciated and required by the API
 * guidelines where possible ("Photo by … on Pexels"), no selling unaltered copies, no implying
 * that people shown endorse a product, no showing identifiable people in a bad light.
 */

export const PEXELS_LICENSE = {
  name: 'Pexels License',
  url: 'https://www.pexels.com/license/',
  commercialUse: 'allowed' as const,
  restrictions: ['do not sell unaltered copies', 'do not imply that identifiable people or brands endorse a product', 'do not show identifiable people in a bad or offensive light'],
  attributionGuideline: 'Credit the photographer and Pexels where possible ("Photo by <name> on Pexels").',
};

function key(ctx: ConnectorContext): string {
  if (ctx.credentials.provider !== 'pexels') throw new Error('pexels credentials required');
  return ctx.credentials.apiKey;
}

const base = (ctx: ConnectorContext) => ctx.endpoints.pexels.replace(/\/$/, '');

export interface StockSearchQuery {
  query: string;
  orientation?: 'landscape' | 'portrait' | 'square';
  size?: 'large' | 'medium' | 'small';
  page?: number;
  perPage?: number;
}

export interface StockCandidate {
  provider: 'pexels';
  mediaType: 'photo' | 'video';
  externalId: string;
  pageUrl: string;
  width: number;
  height: number;
  author: string;
  authorUrl: string | null;
  description: string;
  previewUrl: string;
  /** The file FUTUREGROW downloads on import (bounded size). */
  downloadUrl: string;
  durationSeconds: number | null;
  attribution: string;
}

export interface StockSearchResult {
  page: number;
  perPage: number;
  totalResults: number;
  items: StockCandidate[];
  rateLimit: { limit: number | null; remaining: number | null; resetAt: string | null };
}

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url?: string;
  alt?: string;
  src: { original: string; large2x?: string; large?: string; medium?: string };
}
interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  image: string;
  duration: number;
  user: { name: string; url?: string };
  video_files: { id: number; quality: string | null; file_type: string; width: number | null; height: number | null; link: string }[];
}

const rate = (h: Record<string, string>) => ({
  limit: h['x-ratelimit-limit'] ? Number(h['x-ratelimit-limit']) : null,
  remaining: h['x-ratelimit-remaining'] ? Number(h['x-ratelimit-remaining']) : null,
  resetAt: h['x-ratelimit-reset'] ? new Date(Number(h['x-ratelimit-reset']) * 1000).toISOString() : null,
});

/** Bounded download of a photo: the original resized by Pexels' image CDN to at most 2400 px wide. */
export function photoDownloadUrl(original: string): string {
  const u = new URL(original);
  u.searchParams.set('auto', 'compress');
  u.searchParams.set('cs', 'tinysrgb');
  u.searchParams.set('w', '2400');
  return u.toString();
}

export function photoCandidate(p: PexelsPhoto): StockCandidate {
  return {
    provider: 'pexels',
    mediaType: 'photo',
    externalId: String(p.id),
    pageUrl: p.url,
    width: p.width,
    height: p.height,
    author: p.photographer,
    authorUrl: p.photographer_url ?? null,
    description: p.alt ?? '',
    previewUrl: p.src.medium ?? p.src.large ?? p.src.original,
    downloadUrl: photoDownloadUrl(p.src.original),
    durationSeconds: null,
    attribution: `Photo by ${p.photographer} on Pexels`,
  };
}

/** The largest MP4 rendition no larger than 1080p on its short side (enough for 1080×1920 renders). */
export function bestVideoFile(v: PexelsVideo) {
  const mp4 = v.video_files.filter((f) => f.file_type === 'video/mp4' && f.width && f.height);
  const fit = mp4.filter((f) => Math.min(f.width!, f.height!) <= 1080).sort((a, b) => b.width! * b.height! - a.width! * a.height!);
  return fit[0] ?? mp4.sort((a, b) => a.width! * a.height! - b.width! * b.height!)[0] ?? null;
}

export function videoCandidate(v: PexelsVideo): StockCandidate | null {
  const file = bestVideoFile(v);
  if (!file) return null;
  return {
    provider: 'pexels',
    mediaType: 'video',
    externalId: String(v.id),
    pageUrl: v.url,
    width: file.width!,
    height: file.height!,
    author: v.user.name,
    authorUrl: v.user.url ?? null,
    description: '',
    previewUrl: v.image,
    downloadUrl: file.link,
    durationSeconds: v.duration,
    attribution: `Video by ${v.user.name} on Pexels`,
  };
}

async function get<T>(ctx: ConnectorContext, path: string, params: Record<string, string | number | undefined> = {}) {
  const u = new URL(`${base(ctx)}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  return ctx.http.request<T>({ method: 'GET', url: u.toString(), headers: { authorization: key(ctx) }, idempotent: true });
}

export async function pexelsSearch(ctx: ConnectorContext, mediaType: 'photo' | 'video', q: StockSearchQuery): Promise<StockSearchResult> {
  if (!q.query.trim()) throw new ProviderHttpError('a search query is required', { status: null, phase: 'before_send' });
  const params = { query: q.query.trim().slice(0, 200), orientation: q.orientation, size: q.size, page: q.page ?? 1, per_page: Math.min(80, Math.max(1, q.perPage ?? 15)) };
  if (mediaType === 'photo') {
    const r = await get<{ page: number; per_page: number; total_results: number; photos: PexelsPhoto[] }>(ctx, '/v1/search', params);
    return { page: r.data.page, perPage: r.data.per_page, totalResults: r.data.total_results, items: r.data.photos.map(photoCandidate), rateLimit: rate(r.headers) };
  }
  const r = await get<{ page: number; per_page: number; total_results: number; videos: PexelsVideo[] }>(ctx, '/videos/search', params);
  return { page: r.data.page, perPage: r.data.per_page, totalResults: r.data.total_results, items: r.data.videos.map(videoCandidate).filter((x): x is StockCandidate => Boolean(x)), rateLimit: rate(r.headers) };
}

/** Re-reads one item by id (import never trusts a client-supplied URL or author). */
export async function pexelsGet(ctx: ConnectorContext, mediaType: 'photo' | 'video', externalId: string): Promise<StockCandidate> {
  if (!/^\d{1,20}$/.test(externalId)) throw new ProviderHttpError('invalid Pexels id', { status: null, phase: 'before_send' });
  if (mediaType === 'photo') return photoCandidate((await get<PexelsPhoto>(ctx, `/v1/photos/${externalId}`)).data);
  const v = videoCandidate((await get<PexelsVideo>(ctx, `/videos/videos/${externalId}`)).data);
  if (!v) throw new ProviderHttpError('the video has no MP4 rendition', { status: null, phase: 'rejected' });
  return v;
}

/** Downloads the item's file; only Pexels hosts are accepted. */
export async function pexelsDownload(ctx: ConnectorContext, item: StockCandidate, maxBytes = 200 * 1024 * 1024): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const host = new URL(item.downloadUrl).hostname;
  const testHost = new URL(ctx.endpoints.pexels).hostname;
  if (!(host === 'images.pexels.com' || host === 'videos.pexels.com' || host.endsWith('.pexels.com') || host === testHost)) throw new ProviderHttpError(`refusing to download from ${host}: not a Pexels host`, { status: null, phase: 'before_send' });
  const r = await ctx.http.request({ method: 'GET', url: item.downloadUrl, binary: true, idempotent: true, maxResponseBytes: maxBytes, timeoutMs: 120_000 });
  return { bytes: r.bytes, contentType: r.headers['content-type'] ?? null };
}

export const pexelsRead: ReadConnector = {
  provider: 'pexels',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const r = await get<{ total_results: number }>(ctx, '/v1/search', { query: 'nature', per_page: 1 });
      return { healthy: true, status: 'healthy', grantedScopes: null, details: { rateLimit: rate(r.headers) } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
