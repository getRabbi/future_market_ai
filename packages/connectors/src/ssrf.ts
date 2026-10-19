import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { sha256Hex } from '@futuregrow/observability';

/**
 * SSRF guard for fetching *public* third-party content (competitor pages, SEO audits of the
 * tenant's site, robots.txt). The resolved address is validated inside the socket `lookup`, i.e.
 * at connect time, so DNS rebinding between check and connect is not possible.
 */

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

export function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) return BLOCKED_V4.some(([b, n]) => inV4Range(address, b, n));
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    if (a === '::' || a === '::1') return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // mapped, hex form: refuse
    if (/^(fc|fd)/.test(a)) return true; // unique local
    if (/^fe[89ab]/.test(a)) return true; // link local
    if (/^ff/.test(a)) return true; // multicast
    if (a.startsWith('64:ff9b:') || a.startsWith('2001:db8') || a.startsWith('2002:')) return true; // nat64/doc/6to4
    return false;
  }
  return true;
}

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export function assertFetchableUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfBlockedError('invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SsrfBlockedError(`scheme ${u.protocol} not allowed`);
  if (u.username || u.password) throw new SsrfBlockedError('credentials in URL not allowed');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new SsrfBlockedError(`port ${u.port} not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new SsrfBlockedError(`address ${host} is not public`);
  if (/(^|\.)(localhost|local|internal|localdomain)$/i.test(host)) throw new SsrfBlockedError(`host ${host} is not public`);
  return u;
}

type LookupFn = (hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => void;

export function createGuardedLookup(resolver: typeof dns.lookup = dns.lookup, allowPrivate = false): LookupFn {
  return (hostname, options, cb) => {
    resolver(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '', 0);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }]) as dns.LookupAddress[];
      const bad = list.find((a) => !allowPrivate && isBlockedAddress(a.address));
      if (bad || list.length === 0) {
        const e = new Error(`SSRF guard: ${hostname} resolved to non-public address ${bad?.address ?? '(none)'}`) as NodeJS.ErrnoException;
        e.code = 'EFG_SSRF';
        return cb(e, '', 0);
      }
      if (options.all) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface PublicFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
  /** Test hook only: permit loopback targets (fixture servers). Never enabled in production code. */
  allowPrivateForTests?: boolean;
}

export interface PublicFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  sha256: string;
  fetchedAt: Date;
  redirects: string[];
}

export async function publicFetch(rawUrl: string, opts: PublicFetchOptions = {}): Promise<PublicFetchResult> {
  const allowPrivate = opts.allowPrivateForTests === true && process.env.NODE_ENV === 'test';
  const agent = new Agent({
    connect: { lookup: createGuardedLookup(dns.lookup, allowPrivate) as never, timeout: 10_000 },
    headersTimeout: opts.timeoutMs ?? 15_000,
    bodyTimeout: opts.timeoutMs ?? 15_000,
  });
  const redirects: string[] = [];
  let current = allowPrivate ? new URL(rawUrl) : assertFetchableUrl(rawUrl);
  try {
    for (let hop = 0; ; hop++) {
      const res = await undiciFetch(current, {
        method: 'GET',
        redirect: 'manual',
        dispatcher: agent,
        headers: {
          'user-agent': opts.userAgent ?? 'FUTUREGROW-Collector/0.1 (+https://futuregrow.invalid/bot)',
          accept: opts.accept ?? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        if (!loc) throw new SsrfBlockedError('redirect without location');
        if (hop >= (opts.maxRedirects ?? 5)) throw new SsrfBlockedError('too many redirects');
        const next = new URL(loc, current);
        current = allowPrivate ? next : assertFetchableUrl(next.toString());
        redirects.push(current.toString());
        continue;
      }
      const max = opts.maxBytes ?? 3 * 1024 * 1024;
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > max) {
            await reader.cancel();
            throw new SsrfBlockedError(`response exceeds ${max} bytes`);
          }
          chunks.push(value);
        }
      }
      const buf = Buffer.concat(chunks);
      return {
        url: rawUrl,
        finalUrl: current.toString(),
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: buf.toString('utf8'),
        bytes: buf.byteLength,
        sha256: sha256Hex(buf),
        fetchedAt: new Date(),
        redirects,
      };
    }
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === 'EFG_SSRF') throw new SsrfBlockedError((err as { cause: Error }).cause.message);
    throw err;
  } finally {
    await agent.close();
  }
}
