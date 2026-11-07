import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { type KvLike, type MonitorEnv, runMonitor } from '../src/monitor.js';

class MemoryKv implements KvLike {
  readonly data = new Map<string, string>();
  writes = 0;
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.writes++;
    this.data.set(k, v);
  }
}

const WEB = 'https://app.example.test';
const API = 'https://api.example.test';
const HOOK = 'https://hooks.slack.com/services/T/B/secret';

/** A programmable internet: each URL answers from the current scenario. */
function fakeNet() {
  const scenario = { web: true, proxy: true, api: true, status: 'ok' as 'ok' | 'degraded' | 'dbdown', hook: true };
  const posts: { url: string; body: { text?: string } }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === HOOK) {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response('ok', { status: scenario.hook ? 200 : 503 });
    }
    if (url === `${WEB}/login/`) return scenario.web ? new Response('<title>Sign in · FUTUREGROW</title>', { status: 200 }) : new Response('bad gateway', { status: 502 });
    if (url === `${WEB}/v1/openapi.json`) return scenario.proxy ? new Response('{"openapi":"3.1.0"}', { status: 200 }) : new Response('{"error":{"code":"PROXY_UNCONFIGURED"}}', { status: 503 });
    if (url === `${API}/healthz`) {
      if (!scenario.api) throw new TypeError('fetch failed');
      return new Response('{"ok":true}', { status: 200 });
    }
    if (url === `${API}/statusz`) {
      if (!scenario.api) throw new TypeError('fetch failed');
      if (scenario.status === 'dbdown') return new Response('{"ok":false,"components":{"database":{"state":"failing"},"worker":{"state":"unknown"},"backups":{"state":"unknown"}}}', { status: 503 });
      return scenario.status === 'ok' ? new Response('{"ok":true,"components":{"database":{"state":"ok"},"backups":{"state":"not_configured"}}}', { status: 200 }) : new Response('{"ok":false,"components":{"database":{"state":"ok"},"worker":{"state":"stale"},"backups":{"state":"failing"}}}', { status: 503 });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { scenario, posts, f };
}

describe('uptime monitor (Cloudflare Worker)', () => {
  it('stays quiet while healthy and writes no state', async () => {
    const net = fakeNet();
    const kv = new MemoryKv();
    const env: MonitorEnv = { WEB_URL: WEB, API_URL: API, ALERT_WEBHOOK_URL: HOOK, STATE: kv };
    const r = await runMonitor(env, { fetch: net.f });
    expect(r.results.map((c) => [c.name, c.ok])).toEqual([
      ['web', true],
      ['pages-proxy', true],
      ['api', true],
      ['components', true],
    ]);
    expect(net.posts).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  it('alerts after two consecutive failures, re-alerts after 6 h, and reports recovery once', async () => {
    const net = fakeNet();
    const kv = new MemoryKv();
    const env: MonitorEnv = { WEB_URL: WEB, API_URL: API, ALERT_WEBHOOK_URL: HOOK, ENVIRONMENT: 'prod', STATE: kv };
    let now = new Date('2026-10-21T10:00:00Z');
    const run = () => runMonitor(env, { fetch: net.f, now: () => now });
    const step = (minutes: number) => {
      now = new Date(now.getTime() + minutes * 60_000);
    };

    net.scenario.api = false;
    await run(); // first failure: no alert yet (no flapping)
    expect(net.posts).toHaveLength(0);
    step(5);
    await run();
    expect(net.posts.map((p) => p.body.text?.split('\n')[0])).toEqual(['🔴 CRITICAL: api check failing', '🟠 WARNING: components check failing']);
    expect(net.posts[0]!.body.text).toContain('request failed: fetch failed');
    step(5);
    await run();
    expect(net.posts).toHaveLength(2);
    step(6 * 60);
    await run();
    expect(net.posts).toHaveLength(4);

    net.scenario.api = true;
    step(5);
    await run();
    expect(net.posts.slice(4).map((p) => p.body.text?.split('\n')[0])).toEqual(['✅ RESOLVED: api is back', '✅ RESOLVED: components is back']);
    step(5);
    await run();
    expect(net.posts).toHaveLength(6);
  });

  it('names degraded components from /statusz and the broken Pages proxy', async () => {
    const net = fakeNet();
    const env: MonitorEnv = { WEB_URL: WEB, API_URL: API, ALERT_WEBHOOK_URL: HOOK, STATE: new MemoryKv() };
    net.scenario.status = 'degraded';
    net.scenario.proxy = false;
    await runMonitor(env, { fetch: net.f, failureThreshold: 1 });
    const texts = net.posts.map((p) => p.body.text ?? '');
    expect(texts.find((t) => t.includes('components check failing'))).toContain('degraded: worker=stale, backups=failing');
    expect(texts.find((t) => t.includes('pages-proxy check failing'))).toContain('unexpected status (HTTP 503');
  });

  it('retries an alert whose webhook delivery failed', async () => {
    const net = fakeNet();
    const env: MonitorEnv = { WEB_URL: WEB, API_URL: API, ALERT_WEBHOOK_URL: HOOK, STATE: new MemoryKv() };
    net.scenario.web = false;
    net.scenario.hook = false;
    const first = await runMonitor(env, { fetch: net.f, failureThreshold: 1 });
    expect(first.delivered).toBe(0);
    net.scenario.hook = true;
    const second = await runMonitor(env, { fetch: net.f, failureThreshold: 1 });
    expect(second.delivered).toBe(1);
    expect(net.posts.at(-1)!.body.text).toContain('web check failing');
  });

  it('retries an undelivered recovery on later runs, up to five attempts', async () => {
    const net = fakeNet();
    const env: MonitorEnv = { WEB_URL: WEB, API_URL: API, ALERT_WEBHOOK_URL: HOOK, STATE: new MemoryKv() };
    const run = () => runMonitor(env, { fetch: net.f, failureThreshold: 1 });
    net.scenario.web = false;
    expect((await run()).delivered).toBe(1);

    // Back up while the webhook is down: the recovery stays pending instead of being lost.
    net.scenario.web = true;
    net.scenario.hook = false;
    const missed = await run();
    expect(missed.alerts.map((a) => a.status)).toEqual(['recovery']);
    expect(missed.delivered).toBe(0);
    net.scenario.hook = true;
    expect((await run()).delivered).toBe(1);
    expect(net.posts.at(-1)!.body.text).toContain('RESOLVED: web is back');
    expect((await run()).alerts).toHaveLength(0);

    // A webhook that stays down: five attempts, then the recovery is given up.
    net.scenario.web = false;
    await run();
    net.scenario.web = true;
    net.scenario.hook = false;
    const attempts: number[] = [];
    for (let i = 0; i < 7; i++) attempts.push((await run()).alerts.length);
    expect(attempts).toEqual([1, 1, 1, 1, 1, 0, 0]);
  });

  it('reports a database outage as critical, escalating an earlier component warning at once', async () => {
    const net = fakeNet();
    const env: MonitorEnv = { WEB_URL: WEB, API_URL: API, ALERT_WEBHOOK_URL: HOOK, STATE: new MemoryKv() };
    let now = new Date('2026-11-07T20:00:00Z');
    const run = () => runMonitor(env, { fetch: net.f, failureThreshold: 1, now: () => now });
    const head = (i: number) => net.posts[i]!.body.text?.split('\n')[0];

    net.scenario.status = 'degraded';
    await run();
    expect(head(0)).toBe('🟠 WARNING: components check failing');
    // /healthz stays 200 (liveness only) while /statusz reports the database failing.
    now = new Date(now.getTime() + 5 * 60_000);
    net.scenario.status = 'dbdown';
    const r = await run();
    expect(r.results.find((c) => c.name === 'api')).toMatchObject({ ok: true });
    expect(head(1)).toBe('🔴 CRITICAL: components check failing');
    expect(net.posts[1]!.body.text).toContain('database unavailable; degraded: database=failing');
    now = new Date(now.getTime() + 5 * 60_000);
    await run();
    expect(net.posts).toHaveLength(2);

    // A fresh state sees the outage as critical straight away.
    const fresh = fakeNet();
    fresh.scenario.status = 'dbdown';
    await runMonitor({ ...env, STATE: new MemoryKv() }, { fetch: fresh.f, failureThreshold: 1 });
    expect(fresh.posts[0]!.body.text?.split('\n')[0]).toBe('🔴 CRITICAL: components check failing');
  });

  it('probes the canonical URLs, so the live /login -> /login/ redirect never reads as an outage', async () => {
    const net = fakeNet();
    const requested: string[] = [];
    // Production answers /login with 308 to /login/; redirects are not followed (redirect: manual),
    // so a probe of a redirecting URL would fail every run.
    const live = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url === `${WEB}/login`) return new Response(null, { status: 308, headers: { location: `${WEB}/login/` } });
      return net.f(input, init);
    }) as unknown as typeof fetch;
    const r = await runMonitor({ WEB_URL: `${WEB}/`, API_URL: `${API}/`, ALERT_WEBHOOK_URL: HOOK, STATE: new MemoryKv() }, { fetch: live, failureThreshold: 1 });
    expect(requested.sort()).toEqual([`${API}/healthz`, `${API}/statusz`, `${WEB}/login/`, `${WEB}/v1/openapi.json`]);
    expect(r.results.every((c) => c.ok)).toBe(true);
    expect(net.posts).toHaveLength(0);
  });

  it('treats an unexpected redirect as a failed check', async () => {
    const net = fakeNet();
    const redirecting = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === `${WEB}/login/` ? new Response(null, { status: 302, headers: { location: `${WEB}/maintenance` } }) : net.f(input, init))) as unknown as typeof fetch;
    const r = await runMonitor({ WEB_URL: WEB, API_URL: API, STATE: new MemoryKv() }, { fetch: redirecting, failureThreshold: 1 });
    expect(r.results.find((c) => c.name === 'web')).toMatchObject({ ok: false, detail: expect.stringContaining('unexpected status (HTTP 302') });
  });

  it('runs from the scheduled handler', async () => {
    const net = fakeNet();
    const original = globalThis.fetch;
    globalThis.fetch = net.f;
    try {
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({}, { WEB_URL: WEB, API_URL: API, STATE: new MemoryKv() }, { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending);
      expect(pending).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
