import type dns from 'node:dns';
import net from 'node:net';
import { hmacSha256Base64, hmacSha256Hex } from '@futuregrow/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpClient, ProviderHttpError, preWrite } from '../src/http.js';
import { majorToMicros, metaMinorUnitOffset, microsToDecimalString, microsToMinor } from '../src/providers/money.js';
import { parseRobots } from '../src/robots.js';
import { assertFetchableUrl, createGuardedLookup, isBlockedAddress, publicFetch, SsrfBlockedError } from '../src/ssrf.js';
import { verifyMetaSignature, verifyShopifyHmac, verifySvixSignature, verifyTikTokSignature } from '../src/webhooks.js';
import { FixtureServer } from './helpers.js';

const server = new FixtureServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => server.reset());

describe('SSRF guard', () => {
  it('classifies private, loopback, link-local, CGNAT, multicast and mapped addresses as blocked', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('rejects unsafe URLs before any network access', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com', 'http://user:pw@example.com/', 'http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://metadata.internal/', 'http://example.com:22/']) {
      expect(() => assertFetchableUrl(u), u).toThrow(SsrfBlockedError);
    }
    expect(assertFetchableUrl('https://example.com/pricing').hostname).toBe('example.com');
  });

  it('validates resolved addresses at connect time (DNS rebinding)', async () => {
    const fakeResolver = ((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => cb(null, [{ address: '10.0.0.5', family: 4 }])) as unknown as typeof dns.lookup;
    const lookup = createGuardedLookup(fakeResolver);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup('evil.example', {}, (e) => resolve(e)));
    expect(err?.code).toBe('EFG_SSRF');
  });

  it('refuses to fetch loopback fixture servers without the test-only override', async () => {
    server.on('GET', '/page', { text: 'hello', headers: { 'content-type': 'text/plain' } });
    await expect(publicFetch(`${server.baseUrl}/page`)).rejects.toThrow(SsrfBlockedError);
    const ok = await publicFetch(`${server.baseUrl}/page`, { allowPrivateForTests: true });
    expect(ok.body).toBe('hello');
    expect(ok.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('enforces response size limits', async () => {
    server.on('GET', '/big', { text: 'x'.repeat(5000) });
    await expect(publicFetch(`${server.baseUrl}/big`, { allowPrivateForTests: true, maxBytes: 1000 })).rejects.toThrow(/exceeds/);
  });
});

describe('robots.txt', () => {
  const txt = `
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Crawl-delay: 5

User-agent: FUTUREGROW-Collector
Disallow: /no-fg
`;
  it('uses the most specific group and longest match', () => {
    const generic = parseRobots(txt, 'SomeBot/1.0');
    expect(generic.isAllowed('/private/x')).toBe(false);
    expect(generic.isAllowed('/private/public/page')).toBe(true);
    expect(generic.isAllowed('/docs/a.pdf')).toBe(false);
    expect(generic.isAllowed('/docs/a.pdf?x=1')).toBe(true);
    expect(generic.crawlDelaySeconds).toBe(5);
    const fg = parseRobots(txt, 'FUTUREGROW-Collector/0.1');
    expect(fg.isAllowed('/no-fg/page')).toBe(false);
    expect(fg.isAllowed('/private/x')).toBe(true); // specific group replaces '*'
  });
  it('allows everything when there are no rules', () => {
    expect(parseRobots('', 'x').isAllowed('/anything')).toBe(true);
  });
});

describe('HttpClient failure classification', () => {
  const http = new HttpClient({ maxRetries: 2, baseBackoffMs: 1 });

  it('4xx is rejected (not applied) and not retried', async () => {
    server.on('POST', '/w', { status: 400, json: { error: 'bad' } });
    const err = await http.request({ method: 'POST', url: `${server.baseUrl}/w`, json: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.phase).toBe('rejected');
    expect(server.find('POST', '/w')).toHaveLength(1);
  });

  it('5xx on a non-idempotent write is ambiguous and never retried (no double spend)', async () => {
    server.on('POST', '/w', { status: 502, text: 'bad gateway' });
    const err = await http.request({ method: 'POST', url: `${server.baseUrl}/w`, json: {} }).catch((e) => e);
    expect(err.phase).toBe('ambiguous');
    expect(server.find('POST', '/w')).toHaveLength(1);
  });

  it('idempotent reads are retried on 5xx; 429 honours Retry-After', async () => {
    let n = 0;
    server.on('GET', '/r', () => (++n < 3 ? { status: 503, text: 'busy' } : { json: { ok: true } }));
    const res = await http.request<{ ok: boolean }>({ method: 'GET', url: `${server.baseUrl}/r`, idempotent: true });
    expect(res.data.ok).toBe(true);
    expect(n).toBe(3);

    let m = 0;
    server.on('POST', '/rl', () => (++m < 2 ? { status: 429, headers: { 'retry-after': '0' }, json: {} } : { json: { done: 1 } }));
    const r2 = await http.request<{ done: number }>({ method: 'POST', url: `${server.baseUrl}/rl`, json: {} });
    expect(r2.data.done).toBe(1);
  });

  it('connection refused is before_send', async () => {
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as net.AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const err = await new HttpClient({ maxRetries: 0 }).request({ method: 'POST', url: `http://127.0.0.1:${port}/x`, json: {} }).catch((e) => e);
    expect(err.phase).toBe('before_send');
  });

  it('preWrite reclassifies pre-mutation read failures as before_send', async () => {
    server.on('GET', '/pre', { status: 500, text: 'x' });
    const err = await preWrite(() => new HttpClient({ maxRetries: 0 }).request({ method: 'GET', url: `${server.baseUrl}/pre` })).catch((e) => e);
    expect(err.phase).toBe('before_send');
  });
});

describe('webhook signatures', () => {
  const body = '{"event":"x"}';
  it('meta', () => {
    expect(verifyMetaSignature(body, `sha256=${hmacSha256Hex('s3cret', body)}`, 's3cret')).toBe(true);
    expect(verifyMetaSignature(body, `sha256=${hmacSha256Hex('wrong', body)}`, 's3cret')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 's3cret')).toBe(false);
  });
  it('shopify', () => {
    expect(verifyShopifyHmac(body, hmacSha256Base64('shp', body), 'shp')).toBe(true);
    expect(verifyShopifyHmac(`${body} `, hmacSha256Base64('shp', body), 'shp')).toBe(false);
  });
  it('svix with timestamp tolerance', () => {
    const key = Buffer.from('supersecretkeyvalue1234567890ab').toString('base64');
    const ts = String(Math.floor(Date.parse('2026-10-19T12:00:00Z') / 1000));
    const sig = hmacSha256Base64(Buffer.from(key, 'base64'), `msg_1.${ts}.${body}`);
    const now = new Date('2026-10-19T12:01:00Z');
    expect(verifySvixSignature(body, { id: 'msg_1', timestamp: ts, signature: `v1,bogus v1,${sig}` }, `whsec_${key}`, now)).toBe(true);
    expect(verifySvixSignature(body, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, `whsec_${key}`, new Date('2026-10-19T13:00:00Z'))).toBe(false);
  });
  it('tiktok', () => {
    const t = String(Math.floor(Date.parse('2026-10-19T12:00:00Z') / 1000));
    const s = hmacSha256Hex('cs', `${t}.${body}`);
    expect(verifyTikTokSignature(body, `t=${t},s=${s}`, 'cs', new Date('2026-10-19T12:00:30Z'))).toBe(true);
    expect(verifyTikTokSignature(body, `t=${t},s=${s}`, 'other', new Date('2026-10-19T12:00:30Z'))).toBe(false);
  });
});

describe('money', () => {
  it('converts without float drift and refuses unverified currencies', () => {
    expect(majorToMicros('12.34')).toBe(12_340_000);
    expect(majorToMicros('0.1')).toBe(100_000);
    expect(majorToMicros(1.005)).toBe(1_005_000);
    expect(microsToDecimalString(12_345_678)).toBe('12.34');
    expect(microsToMinor(12_340_000, 100)).toBe(1234);
    expect(() => microsToMinor(12_345_000, 100)).toThrow(/not representable/);
    expect(metaMinorUnitOffset('JPY')).toBe(1);
    expect(() => metaMinorUnitOffset('XOF')).toThrow(/unverified/);
  });
});
