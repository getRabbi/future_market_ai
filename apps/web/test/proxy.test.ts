import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '../src/server/proxy.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pages Functions proxy (D-013)', () => {
  it('refuses to run without an https API origin', async () => {
    const res = await proxy(new Request('https://app.pages.dev/v1/me'), {});
    expect(res.status).toBe(503);
    expect((await proxy(new Request('https://app.pages.dev/v1/me'), { API_ORIGIN: 'http://api.example' })).status).toBe(503);
  });

  it('forwards path, query, method and body; strips spoofable client-IP headers; re-scopes cookies', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const headers = new Headers({ 'content-type': 'application/json', connection: 'keep-alive' });
      headers.append('set-cookie', 'fg.session_token=abc; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=api.example');
      headers.append('set-cookie', 'fg.other=1; Path=/');
      return new Response('{"ok":true}', { status: 201, headers });
    });
    const req = new Request('https://app.pages.dev/v1/actions?status=APPROVED', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1', 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '203.0.113.7', cookie: 'fg.session_token=abc' },
      body: '{"a":1}',
    });
    const res = await proxy(req, { API_ORIGIN: 'https://api.example' });
    expect(res.status).toBe(201);
    expect(seen[0]!.url).toBe('https://api.example/v1/actions?status=APPROVED');
    const fwd = new Headers(seen[0]!.init.headers);
    expect(fwd.get('x-forwarded-for')).toBe('203.0.113.7'); // the client-supplied value is discarded
    expect(fwd.get('idempotency-key')).toBe('k1');
    expect(fwd.get('cookie')).toBe('fg.session_token=abc');
    expect(fwd.get('x-forwarded-host')).toBe('app.pages.dev');
    expect(fwd.has('host')).toBe(false);
    expect(seen[0]!.init.redirect).toBe('manual');
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).not.toMatch(/domain=/i);
    expect(res.headers.has('connection')).toBe(false);
  });
});
