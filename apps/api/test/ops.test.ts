import type { ops } from '@futuregrow/core';
import type { OpsAlert } from '@futuregrow/observability';
import { loadEnv } from '@futuregrow/runtime';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { buildApp } from '../src/app.js';

let h: CoreHarness;
let app: FastifyInstance;
const sent: OpsAlert[] = [];
const notifier: ops.Notifier = {
  configured: true,
  async send(a) {
    sent.push(a);
  },
};

beforeAll(async () => {
  h = await createCoreHarness();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url, API_BASE_URL: 'http://localhost:8080', APP_ORIGINS: 'http://localhost:4321' } as NodeJS.ProcessEnv);
  ({ app } = await buildApp({ env, deps: { ...h.deps, notifier }, environment: 'test-env' }));
  app.get('/boom', { config: { public: true } }, async () => {
    throw new Error('database exploded');
  });
});
afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('/statusz', () => {
  it('is public, coarse, uncached and 503 until the worker has run', async () => {
    const down = await app.inject({ method: 'GET', url: '/statusz' });
    expect(down.statusCode).toBe(503);
    expect(down.headers['cache-control']).toBe('no-store');
    const body = down.json();
    expect(body.ok).toBe(false);
    expect(Object.keys(body.components).sort()).toEqual(['analytics_queue', 'backups', 'database', 'media_queue', 'worker']);
    expect(body.components.worker).toEqual({ state: 'unknown' });
    // No internal detail strings leak through the public endpoint.
    expect(JSON.stringify(body)).not.toMatch(/detail/);
  });

  it('turns 200 once the worker schedule is running (after the 30 s cache)', async () => {
    await h.t.handle.db.execute(sql`insert into graphile_worker._private_known_crontabs (identifier, known_since, last_execution) values ('ops_monitor', now(), now())`);
    const { app: fresh } = await buildApp({ env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url } as NodeJS.ProcessEnv), deps: h.deps });
    const up = await fresh.inject({ method: 'GET', url: '/statusz' });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ ok: true, components: { database: { state: 'ok' }, worker: { state: 'ok' }, backups: { state: 'not_configured' } } });
    await fresh.close();
  });
});

describe('API 5xx alerts', () => {
  it('sends one throttled operator alert per route and error type, without leaking the response', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/boom' });
    const r2 = await app.inject({ method: 'GET', url: '/boom' });
    expect(r1.statusCode).toBe(500);
    expect(r1.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
    expect(r2.statusCode).toBe(500);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ severity: 'critical', title: 'API error on GET /boom', text: 'Error: database exploded', source: 'api', environment: 'test-env', dedupKey: 'api5xx:GET /boom:Error' });
    expect(sent[0]!.fields?.requestId).toBeTruthy();
  });
});
