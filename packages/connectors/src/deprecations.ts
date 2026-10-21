import type { ApiVersions, ProviderEndpoints } from './types.js';

/**
 * Provider API deprecation monitoring (FG-P2-001, product plan "Provider deprecation").
 *
 * Two sources of truth:
 * 1. Lifecycle rules per configured version, versioned with the code. Where a provider's policy
 *    fixes the earliest sunset (Shopify: each stable version is supported for at least 12 months)
 *    the date is derived; where it does not (Meta Graph, Google Ads publish per-version dates),
 *    the version is "unverified" until an operator records the published date.
 * 2. Live responses: RFC 9745 `Deprecation` and RFC 8594 `Sunset` headers, Shopify's
 *    `X-Shopify-API-Deprecated-Reason`, and version auto-upgrades (Shopify and Meta serve a newer
 *    version when the requested one is no longer available and say so in a response header).
 */
export type LifecycleProvider = keyof ApiVersions;

export interface ApiLifecycleRule {
  provider: LifecycleProvider;
  apiVersion: string;
  /** dated = the provider retires versions on a schedule; evergreen = no published sunset. */
  kind: 'dated' | 'evergreen';
  /** Earliest sunset known from policy (ISO), or null when it must be recorded by an operator. */
  sunsetAt: string | null;
  basis: string;
  sourceUrl: string;
}

export const LIFECYCLE_CHECKED_AT = '2026-10-21';

export function lifecycleRule(provider: LifecycleProvider, apiVersion: string): ApiLifecycleRule {
  switch (provider) {
    case 'shopify': {
      const m = /^(\d{4})-(01|04|07|10)$/.exec(apiVersion);
      const sunsetAt = m ? new Date(Date.UTC(Number(m[1]) + 1, Number(m[2]) - 1, 1)).toISOString() : null;
      return { provider, apiVersion, kind: 'dated', sunsetAt, basis: 'Shopify supports each stable API version for at least 12 months after its release; the derived date is the earliest possible sunset.', sourceUrl: 'https://shopify.dev/docs/api/usage/versioning' };
    }
    case 'meta':
      return { provider, apiVersion, kind: 'dated', sunsetAt: null, basis: 'Meta keeps each Graph API version available for at least two years after release; record the date from the changelog.', sourceUrl: 'https://developers.facebook.com/docs/graph-api/changelog' };
    case 'googleAds':
      return { provider, apiVersion, kind: 'dated', sunsetAt: null, basis: 'Google Ads publishes a sunset date for every API version; record it from the sunset-dates page.', sourceUrl: 'https://developers.google.com/google-ads/api/docs/sunset-dates' };
    case 'tiktok':
      return { provider, apiVersion, kind: 'evergreen', sunsetAt: null, basis: 'No published sunset for the v2 open API; watched through response headers.', sourceUrl: 'https://developers.tiktok.com/doc/overview' };
    case 'youtube':
      return { provider, apiVersion, kind: 'evergreen', sunsetAt: null, basis: 'YouTube Data API v3 has no published sunset; watched through response headers.', sourceUrl: 'https://developers.google.com/youtube/v3/revision_history' };
    case 'appStoreConnect':
      return { provider, apiVersion, kind: 'evergreen', sunsetAt: null, basis: 'App Store Connect API v1 has no published sunset; watched through response headers.', sourceUrl: 'https://developer.apple.com/documentation/appstoreconnectapi' };
  }
}

export const LIFECYCLE_PROVIDERS: LifecycleProvider[] = ['meta', 'googleAds', 'shopify', 'tiktok', 'youtube', 'appStoreConnect'];

/** Action-type provider ids (contracts PROVIDERS) to lifecycle keys. */
export const LIFECYCLE_KEY: Partial<Record<string, LifecycleProvider>> = { meta: 'meta', google_ads: 'googleAds', shopify: 'shopify', tiktok: 'tiktok', youtube: 'youtube', app_store_connect: 'appStoreConnect' };

export type DeprecationSignalKind = 'deprecation_header' | 'sunset_header' | 'provider_warning' | 'version_upgraded';

export interface DeprecationSignal {
  provider: LifecycleProvider;
  apiVersion: string;
  signal: DeprecationSignalKind;
  /** Path with ids and the version replaced, never a query string. */
  endpoint: string;
  sunsetAt: string | null;
  detail: string;
}

interface Route {
  provider: LifecycleProvider;
  version: (path: string) => string | null;
}

function routes(e: ProviderEndpoints, url: URL): Route[] {
  const starts = (base: string | null) => Boolean(base) && url.href.startsWith(base!.replace(/\/$/, ''));
  const out: Route[] = [];
  if (url.hostname.endsWith('.myshopify.com') || starts(e.shopifyOverride)) out.push({ provider: 'shopify', version: (p) => /\/admin\/api\/(\d{4}-\d{2})\//.exec(p)?.[1] ?? null });
  if (starts(e.metaGraph)) out.push({ provider: 'meta', version: (p) => /^\/(v\d+\.\d+)\//.exec(p)?.[1] ?? null });
  if (starts(e.googleAds)) out.push({ provider: 'googleAds', version: (p) => /^\/(v\d+)\//.exec(p)?.[1] ?? null });
  if (starts(e.tiktok)) out.push({ provider: 'tiktok', version: (p) => /^\/(v\d+)\//.exec(p)?.[1] ?? null });
  if (starts(e.appStoreConnect)) out.push({ provider: 'appStoreConnect', version: (p) => /^\/(v\d+)\//.exec(p)?.[1] ?? null });
  if (starts(e.youtubeData) || starts(e.youtubeUpload)) out.push({ provider: 'youtube', version: (p) => /\/youtube\/(v\d+)\b/.exec(p)?.[1] ?? null });
  return out;
}

/** Which provider and API version a request URL belongs to (configured version wins ties). */
export function classifyProviderUrl(rawUrl: string, endpoints: ProviderEndpoints, versions: ApiVersions): { provider: LifecycleProvider; apiVersion: string; endpoint: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const matches = routes(endpoints, url)
    .map((r) => ({ provider: r.provider, apiVersion: r.version(url.pathname) }))
    .filter((m): m is { provider: LifecycleProvider; apiVersion: string } => m.apiVersion !== null);
  const best = matches.find((m) => versions[m.provider] === m.apiVersion) ?? matches[0];
  if (!best) return null;
  const endpoint = url.pathname
    .replace(best.apiVersion, ':version')
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /^act_\d+$/.test(seg) ? ':id' : seg))
    .join('/');
  return { ...best, endpoint };
}

function httpDate(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** RFC 9745 structured date (`@1735689599`), or the older draft forms (`true`, an HTTP-date). */
function deprecationDate(v: string): string | null {
  const m = /^@(-?\d+)$/.exec(v.trim());
  if (m) return new Date(Number(m[1]) * 1000).toISOString();
  return httpDate(v);
}

export function detectDeprecationSignals(input: { url: string; headers: Headers }, endpoints: ProviderEndpoints, versions: ApiVersions): DeprecationSignal[] {
  const where = classifyProviderUrl(input.url, endpoints, versions);
  if (!where) return [];
  const h = input.headers;
  const out: DeprecationSignal[] = [];
  const base = { provider: where.provider, apiVersion: where.apiVersion, endpoint: where.endpoint };
  const sunset = httpDate(h.get('sunset'));
  const link = h.get('link');
  const docs = link ? /<([^>]+)>\s*;\s*rel="?(?:deprecation|sunset)"?/i.exec(link)?.[1] : undefined;
  const dep = h.get('deprecation');
  if (dep) {
    const when = deprecationDate(dep);
    out.push({ ...base, signal: 'deprecation_header', sunsetAt: sunset, detail: `Deprecation: ${dep}${when ? ` (${when})` : ''}${docs ? `; see ${docs}` : ''}` });
  }
  if (sunset) out.push({ ...base, signal: 'sunset_header', sunsetAt: sunset, detail: `Sunset: ${h.get('sunset')}${docs ? `; see ${docs}` : ''}` });
  if (where.provider === 'shopify') {
    const reason = h.get('x-shopify-api-deprecated-reason');
    if (reason) out.push({ ...base, signal: 'provider_warning', sunsetAt: null, detail: `X-Shopify-API-Deprecated-Reason: ${reason.slice(0, 300)}` });
    const served = h.get('x-shopify-api-version');
    if (served && served !== where.apiVersion) out.push({ ...base, signal: 'version_upgraded', sunsetAt: null, detail: `requested ${where.apiVersion}, Shopify served ${served}: the requested version is no longer supported` });
  }
  if (where.provider === 'meta') {
    const served = h.get('facebook-api-version');
    if (served && served !== where.apiVersion) out.push({ ...base, signal: 'version_upgraded', sunsetAt: null, detail: `requested ${where.apiVersion}, Meta served ${served}: the requested version has expired` });
  }
  return out;
}
