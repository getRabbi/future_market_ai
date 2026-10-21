import { describe, expect, it } from 'vitest';
import { classifyProviderUrl, DEFAULT_API_VERSIONS, DEFAULT_ENDPOINTS, detectDeprecationSignals, lifecycleRule } from '../src/index.js';

const detect = (url: string, headers: Record<string, string>) => detectDeprecationSignals({ url, headers: new Headers(headers) }, DEFAULT_ENDPOINTS, DEFAULT_API_VERSIONS);

describe('provider API deprecation detection', () => {
  it('classifies production provider URLs and normalises endpoints without ids or query strings', () => {
    expect(classifyProviderUrl('https://graph.facebook.com/v26.0/1234567890/feed?access_token=x', DEFAULT_ENDPOINTS, DEFAULT_API_VERSIONS)).toEqual({ provider: 'meta', apiVersion: 'v26.0', endpoint: '/:version/:id/feed' });
    expect(classifyProviderUrl('https://googleads.googleapis.com/v26/customers/1234567890/googleAds:searchStream', DEFAULT_ENDPOINTS, DEFAULT_API_VERSIONS)).toMatchObject({ provider: 'googleAds', apiVersion: 'v26', endpoint: '/:version/customers/:id/googleAds:searchStream' });
    expect(classifyProviderUrl('https://acme.myshopify.com/admin/api/2026-10/graphql.json', DEFAULT_ENDPOINTS, DEFAULT_API_VERSIONS)).toMatchObject({ provider: 'shopify', apiVersion: '2026-10' });
    expect(classifyProviderUrl('https://www.googleapis.com/youtube/v3/videos?part=status', DEFAULT_ENDPOINTS, DEFAULT_API_VERSIONS)).toMatchObject({ provider: 'youtube', apiVersion: 'v3' });
    expect(classifyProviderUrl('https://example.com/v1/anything', DEFAULT_ENDPOINTS, DEFAULT_API_VERSIONS)).toBeNull();
  });

  it('reads RFC 9745 Deprecation and RFC 8594 Sunset headers', () => {
    const s = detect('https://graph.facebook.com/v26.0/me', { deprecation: '@1767225600', sunset: 'Thu, 01 Jul 2027 00:00:00 GMT', link: '<https://developers.facebook.com/docs/graph-api/changelog>; rel="sunset"' });
    expect(s.map((x) => x.signal)).toEqual(['deprecation_header', 'sunset_header']);
    expect(s[0]!.detail).toContain('(2026-01-01T00:00:00.000Z)');
    expect(s[1]).toMatchObject({ sunsetAt: '2027-07-01T00:00:00.000Z', detail: expect.stringContaining('see https://developers.facebook.com/docs/graph-api/changelog') });
    expect(detect('https://graph.facebook.com/v26.0/me', {})).toEqual([]);
    // Same version served back: no signal.
    expect(detect('https://graph.facebook.com/v26.0/me', { 'facebook-api-version': 'v26.0' })).toEqual([]);
  });

  it('flags provider-specific warnings and automatic version upgrades', () => {
    const shop = detect('https://acme.myshopify.com/admin/api/2026-10/graphql.json', { 'x-shopify-api-deprecated-reason': 'https://shopify.dev/changelog/x', 'x-shopify-api-version': '2027-01' });
    expect(shop.map((x) => [x.signal, x.detail])).toEqual([
      ['provider_warning', 'X-Shopify-API-Deprecated-Reason: https://shopify.dev/changelog/x'],
      ['version_upgraded', 'requested 2026-10, Shopify served 2027-01: the requested version is no longer supported'],
    ]);
    expect(detect('https://graph.facebook.com/v26.0/me', { 'facebook-api-version': 'v27.0' })[0]).toMatchObject({ signal: 'version_upgraded', provider: 'meta' });
  });

  it('derives the earliest Shopify sunset from its support policy and leaves dated APIs to operators', () => {
    expect(lifecycleRule('shopify', '2026-10')).toMatchObject({ kind: 'dated', sunsetAt: '2027-10-01T00:00:00.000Z' });
    expect(lifecycleRule('shopify', 'unstable').sunsetAt).toBeNull();
    expect(lifecycleRule('meta', 'v26.0')).toMatchObject({ kind: 'dated', sunsetAt: null });
    expect(lifecycleRule('youtube', 'v3').kind).toBe('evergreen');
  });
});
