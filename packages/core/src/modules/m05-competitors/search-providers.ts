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

/* ------------------------------------------------------------------ */
/* D-055: provider-neutral web identities and the Tavily adapter        */
/* ------------------------------------------------------------------ */

/** Hosts where the first path segment(s) name the entity (a channel, page or account), not the site. */
const MULTI_TENANT_HOSTS = new Set(['facebook.com', 'youtube.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'linkedin.com', 'medium.com', 'github.com']);
const NON_ENTITY_SEGMENTS = new Set(['watch', 'shorts', 'results', 'search', 'hashtag', 'share', 'sharer', 'login', 'posts', 'reel', 'reels', 'explore', 'p', 'status', 'story.php', 'photo', 'photos', 'events', 'help', 'policies', 'legal', 'about', 'feed', 'playlist']);

/**
 * Hosts that are never a competitor of a brand: search providers, reference and document hosts,
 * APK mirrors and app directories (they list other publishers' apps), and government sites
 * (official bodies are not competitors). Store listings are unaffected; the AI judge decides
 * everything else.
 */
const NON_COMPETITOR_HOSTS = [
  'tavily.com',
  'brave.com',
  'wikipedia.org',
  'wikimedia.org',
  'scribd.com',
  'pdfcoffee.com',
  'studocu.com',
  'slideshare.net',
  'apkpure.com',
  'apkpure.net',
  'apkcombo.com',
  'apkmirror.com',
  'uptodown.com',
  'softonic.com',
  'aptoide.com',
  'apk.support',
  'appbrain.com',
  'appagg.com',
  'apkfab.com',
  'apkmonk.com',
  'apkgk.com',
  '9apps.com',
  'malavida.com',
  'filehippo.com',
];
export function isNonCompetitorHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  if (/(?:^|\.)(?:gov|mil)(?:\.[a-z]{2})?$/.test(h) || /(?:^|\.)go\.[a-z]{2}$/.test(h)) return true;
  return NON_COMPETITOR_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * The stable identity of what a search result points to: a store listing, a social account or a
 * website. Returns null for anything that is not a plain public https URL or is not an entity
 * (a single video, a search page). The canonical URL is what discovery stores and may monitor.
 */
export function webIdentity(raw: string): { identity: string; url: string; kind: 'app_listing' | 'other'; host: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
  if (host === 'play.google.com') {
    const id = url.pathname === '/store/apps/details' ? url.searchParams.get('id') : null;
    if (!id || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(id)) return null;
    return { identity: `google_play:${id}`, url: `https://play.google.com/store/apps/details?id=${id}`, kind: 'app_listing', host };
  }
  if (host === 'apps.apple.com') {
    const m = url.pathname.match(/\/id(\d{5,15})$/);
    if (!m) return null;
    return { identity: `app_store:${m[1]}`, url: `https://apps.apple.com${url.pathname}`, kind: 'app_listing', host };
  }
  if (MULTI_TENANT_HOSTS.has(host)) {
    const seg = url.pathname.split('/').filter(Boolean);
    if (!seg.length || NON_ENTITY_SEGMENTS.has(seg[0]!.toLowerCase())) return null;
    const take = ['channel', 'c', 'user', 'groups', 'company', 'school', 'in'].includes(seg[0]!.toLowerCase()) && seg[1] ? 2 : 1;
    let path: string;
    try {
      path = seg
        .slice(0, take)
        .map((s) => encodeURIComponent(decodeURIComponent(s)).replaceAll('%40', '@'))
        .join('/');
    } catch {
      return null; // malformed percent-encoding
    }
    return { identity: `web:${host}/${path.toLowerCase()}`, url: `https://${host === 'twitter.com' ? 'x.com' : host}/${path}`, kind: 'other', host };
  }
  return { identity: `web:${host}`, url: `https://${url.hostname.toLowerCase()}/`, kind: 'other', host };
}

export const TAVILY_TERMS = 'https://tavily.com/terms';
const TavilyResponse = z.object({
  results: z
    .array(z.object({ title: z.string().max(2000).nullish(), url: z.string().url(), content: z.string().max(50_000).nullish() }).passthrough())
    .max(20)
    .default([]),
});

/** Tavily wants a lowercase English country name ("bangladesh"); unknown codes simply send none. */
export function countryName(code: string): string | null {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
    return name && name.toUpperCase() !== code.toUpperCase() && !/unknown region/i.test(name) ? name.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Documented Tavily Search API (POST /search, bearer key, basic depth = 1 credit per request; the
 * free plan has 1,000 credits a month without a card). Results are secondary index evidence: a
 * title, URL and snippet, never a crawl of the page. Returns the Brave-compatible
 * `{title, url, description}` shape.
 */
export function tavilySearchProvider(http: HttpClient, apiKey: string): CompetitorSearchProvider {
  if (!apiKey.trim()) throw invalid('Tavily credentials unavailable');
  const call = (body: Record<string, unknown>) => http.request({ method: 'POST', url: 'https://api.tavily.com/search', headers: { authorization: `Bearer ${apiKey}` }, json: body, idempotent: true, timeoutMs: 20_000, maxResponseBytes: 3_000_000 });
  return {
    id: 'tavily_web',
    terms: TAVILY_TERMS,
    async search(query, country) {
      if (query.length > 400) throw invalid('Search query exceeds provider limits');
      const body = { query, search_depth: 'basic', max_results: 10, topic: 'general', include_answer: false, include_raw_content: false, include_images: false };
      const name = countryName(country);
      let res: Awaited<ReturnType<typeof call>>;
      try {
        try {
          res = await call(name ? { ...body, country: name } : body);
        } catch (err) {
          // Tavily's country list is its own; a name it does not know is a 400, so search without it.
          if (!(err instanceof ProviderHttpError) || err.status !== 400 || !name) throw err;
          res = await call(body);
        }
      } catch (err) {
        const status = err instanceof ProviderHttpError ? err.status : null;
        if (status === 401) throw invalid('Tavily refused the API key (check the key in Connections)');
        if (status === 432 || status === 433) throw invalid('Tavily plan limit reached for this month; discovery resumes when credits renew');
        throw invalid(`Tavily search unavailable${status ? ` (HTTP ${status})` : ''}`);
      }
      return TavilyResponse.parse(res.data).results.map((r) => ({ title: (r.title ?? '').slice(0, 500) || r.url, url: r.url, description: (r.content ?? '').slice(0, 2000) }));
    },
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
