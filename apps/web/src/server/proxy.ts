/**
 * Same-origin proxy for Cloudflare Pages (D-013 fallback when the app and API do not share a
 * registrable domain). Paths are forwarded 1:1 (`/v1/*`, `/api/auth/*`) to API_ORIGIN so session
 * cookies are first-party on the Pages host. Only these two prefixes are routed here.
 */
export interface Env {
  API_ORIGIN?: string;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];
const CLIENT_IP_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip'];

export async function proxy(request: Request, env: Env): Promise<Response> {
  if (!env.API_ORIGIN || !/^https:\/\//.test(env.API_ORIGIN)) {
    return new Response(JSON.stringify({ error: { code: 'PROXY_UNCONFIGURED', message: 'API_ORIGIN (https) is not configured for this Pages project' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, env.API_ORIGIN);
  const headers = new Headers(request.headers);
  for (const h of [...HOP_BY_HOP, ...CLIENT_IP_HEADERS]) headers.delete(h);
  // The client address as seen by Cloudflare; the API trusts one proxy hop for rate limiting.
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', 'https');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await fetch(target.toString(), { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' });
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'set-cookie' && !HOP_BY_HOP.includes(k.toLowerCase())) out.set(k, v);
  });
  // Re-scope cookies to the Pages host: drop any Domain attribute the API may set.
  const cookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const c of cookies) out.append('set-cookie', c.replace(/;\s*domain=[^;]+/i, ''));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
