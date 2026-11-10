import { type HttpClient, ProviderHttpError } from '@futuregrow/connectors';
import { invalid } from '@futuregrow/observability';
import { z } from 'zod';
import type { CompetitorSearchProvider } from './discovery.js';

export const BRAVE_TERMS = 'https://api-dashboard.search.brave.com/terms-of-service';
const Result = z.object({ title: z.string().min(1).max(500), url: z.string().url(), description: z.string().max(10000).default('') });

/** Index evidence is secondary and cannot independently verify a competitor's identity. */
export function rankWebCandidate(query: string, raw: unknown, playOnly: boolean) {
  const result = Result.safeParse(raw);
  if (!result.success) return null;
  const item = result.data;
  const url = new URL(item.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test)$/.test(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
  const packageId = url.hostname === 'play.google.com' && url.pathname === '/store/apps/details' ? url.searchParams.get('id') : null;
  if (playOnly && (!packageId || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageId))) return null;
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const corpus = new Set(`${item.title} ${item.description}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const matched = terms.filter((term) => corpus.has(term));
  if (!matched.length) return null;
  const identity = playOnly ? `google_play:${packageId}` : `web:${url.hostname.replace(/^www\./, '')}`;
  url.hash = '';
  url.search = playOnly ? new URLSearchParams({ id: packageId! }).toString() : '';
  if (!playOnly) url.pathname = '/';
  return {
    item,
    identity,
    url: url.toString(),
    score: Math.round((100 * matched.length) / terms.length),
    confidence: 0.5,
    category: 'indirect',
    reasons: [`Search index matched ${matched.length}/${terms.length} terms: ${matched.join(', ')}`, 'Secondary index evidence only; identity, category and relevance need human verification. No listing or website was crawled.'],
  };
}

/** Documented Brave API. Requires an owner-provisioned key/plan and storage/use approval. */
export function braveSearchProvider(http: HttpClient, apiKey: string, playOnly = false, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): CompetitorSearchProvider {
  if (!apiKey.trim()) throw invalid('Brave Search credentials unavailable');
  return {
    id: playOnly ? 'brave_google_play' : 'brave_web',
    terms: BRAVE_TERMS,
    rank: (query, raw) => rankWebCandidate(query, raw, playOnly),
    async search(query, _country) {
      const q = `${playOnly ? 'site:play.google.com/store/apps/details ' : ''}${query}`;
      if (q.length > 600 || q.trim().split(/\s+/).length > 75) throw invalid('Search query exceeds provider limits');
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.search = new URLSearchParams({ q, count: '20', safesearch: 'strict', text_decorations: 'false' }).toString();
      for (let attempt = 0; ; attempt++) {
        try {
          // Outer retry policy owns pacing; no hidden retries or paid extra pages.
          const response = await http.request({ method: 'GET', url: url.toString(), headers: { 'X-Subscription-Token': apiKey, accept: 'application/json' }, idempotent: false, timeoutMs: 15000, maxResponseBytes: 2000000 });
          if (response.status !== 200) throw invalid('Brave Search unavailable');
          return z.object({ web: z.object({ results: z.array(z.unknown()).max(20) }).optional() }).parse(response.data).web?.results ?? [];
        } catch (err) {
          if (!(err instanceof ProviderHttpError) || ![429, 502, 503, 504].includes(err.status ?? 0) || attempt >= 2 || (err.retryAfterMs ?? 0) > 30000) throw invalid('Brave Search unavailable; check plan, permissions or rate limit');
          await sleep(Math.max(3500 * (attempt + 1), err.retryAfterMs ?? 0));
        }
      }
    },
  };
}
