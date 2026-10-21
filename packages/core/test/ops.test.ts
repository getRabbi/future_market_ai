import { randomUUID } from 'node:crypto';
import { analyticsRequests, backupRuns, incidents, opsNotifications, withSystem, withTenant } from '@futuregrow/db';
import type { OpsAlert } from '@futuregrow/observability';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { raiseAlert } from '../src/modules/m24-governance/index.js';
import { AlertThrottle, type Notifier, platformStatus, runOpsMonitor, WebhookNotifier } from '../src/ops.js';

class RecordingNotifier implements Notifier {
  readonly configured = true;
  readonly sent: OpsAlert[] = [];
  fail = false;
  async send(a: OpsAlert) {
    if (this.fail) throw new Error('webhook down');
    this.sent.push(a);
  }
  take(prefix: string) {
    return this.sent.filter((a) => a.dedupKey.startsWith(prefix));
  }
}

let h: CoreHarness;
const db = () => h.t.handle.db;
const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

async function heartbeat(at: Date) {
  await db().execute(sql`insert into graphile_worker._private_known_crontabs (identifier, known_since, last_execution) values ('social_dispatch', ${at}, ${at})
                         on conflict (identifier) do update set last_execution = excluded.last_execution`);
}

beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await withSystem(db(), 'test', async (tx) => {
    await tx.delete(opsNotifications);
    await tx.delete(backupRuns);
  });
  await db().execute(sql`delete from graphile_worker._private_known_crontabs`);
});

describe('platform status (/statusz)', () => {
  it('derives worker liveness from Graphile cron executions', async () => {
    const now = new Date();
    let s = await platformStatus(db(), now);
    expect(s.components.database.state).toBe('ok');
    expect(s.components.worker.state).toBe('unknown');
    expect(s.ok).toBe(false);
    await heartbeat(minutesAgo(now, 1));
    s = await platformStatus(db(), now);
    expect(s.components.worker).toMatchObject({ state: 'ok' });
    expect(s.components.backups.state).toBe('not_configured');
    expect(s.ok).toBe(true);
    await heartbeat(minutesAgo(now, 9));
    s = await platformStatus(db(), now);
    expect(s.components.worker).toMatchObject({ state: 'stale', ageSeconds: 540 });
    expect(s.ok).toBe(false);
  });

  it('reports backups as ok, unverified, failing or stale', async () => {
    const now = new Date();
    await heartbeat(now);
    const backup = (finishedAt: Date, key: string, status = 'succeeded', kind = 'backup') => withSystem(db(), 'test', (tx) => tx.insert(backupRuns).values({ kind, status, objectKey: key, startedAt: finishedAt, finishedAt }));
    await backup(minutesAgo(now, 60), 'b1');
    expect((await platformStatus(db(), now)).components.backups.state).toBe('ok'); // within the verification grace
    expect((await platformStatus(db(), new Date(now.getTime() + 2 * 3_600_000))).components.backups).toMatchObject({ state: 'failing', detail: 'the latest backup has not been verified' });
    await backup(minutesAgo(now, 50), 'b1', 'succeeded', 'verification');
    expect((await platformStatus(db(), now)).components.backups.state).toBe('ok');
    expect((await platformStatus(db(), new Date(now.getTime() + 31 * 3_600_000))).components.backups.state).toBe('stale');
    await backup(minutesAgo(now, 5), 'b2', 'failed');
    expect((await platformStatus(db(), now)).components.backups).toMatchObject({ state: 'failing', detail: 'the latest backup or verification failed' });
  });

  it('flags analytics requests that wait longer than the job cadence allows', async () => {
    const now = new Date();
    await heartbeat(now);
    await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => tx.insert(analyticsRequests).values({ tenantId: h.tenantId, kind: 'forecast', params: {}, requestedBy: 'test', requestedAt: minutesAgo(now, 60) }));
    const s = await platformStatus(db(), now);
    expect(s.components.analytics_queue).toMatchObject({ state: 'stale', ageSeconds: 3600 });
    expect(s.components.media_queue.state).toBe('ok');
    await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => tx.update(analyticsRequests).set({ status: 'completed' }));
  });
});

describe('ops monitor (operator alerts)', () => {
  it('announces a component problem once, re-announces after the interval, and reports recovery once', async () => {
    const n = new RecordingNotifier();
    const t0 = new Date();
    await heartbeat(minutesAgo(t0, 20));
    await runOpsMonitor(db(), n, { environment: 'test', now: t0 });
    expect(n.take('component:worker')).toHaveLength(1);
    expect(n.take('component:worker')[0]).toMatchObject({ severity: 'warning', title: 'Background worker: stale', status: 'problem' });
    await runOpsMonitor(db(), n, { environment: 'test', now: new Date(t0.getTime() + 5 * 60_000) });
    expect(n.take('component:worker')).toHaveLength(1);
    await runOpsMonitor(db(), n, { environment: 'test', now: new Date(t0.getTime() + 7 * 3_600_000) });
    expect(n.take('component:worker')).toHaveLength(2);
    const t1 = new Date(t0.getTime() + 8 * 3_600_000);
    await heartbeat(t1);
    await runOpsMonitor(db(), n, { environment: 'test', now: t1 });
    await runOpsMonitor(db(), n, { environment: 'test', now: new Date(t1.getTime() + 60_000) });
    const worker = n.take('component:worker');
    expect(worker).toHaveLength(3);
    expect(worker[2]).toMatchObject({ status: 'recovery', title: 'Background worker: healthy' });
    // Healthy components that never had a problem stay silent.
    expect(n.take('component:database')).toHaveLength(0);
  });

  it('announces critical tenant alerts and severe incidents exactly once', async () => {
    const n = new RecordingNotifier();
    const now = new Date();
    await heartbeat(now);
    await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, async (tx) => {
      await raiseAlert(tx, h.tenantId, { kind: 'spend_drift', severity: 'critical', message: 'campaign 42 spent 3x its budget', dedupKey: `drift-${randomUUID()}` });
      await raiseAlert(tx, h.tenantId, { kind: 'info_only', severity: 'info', message: 'not paged' });
      await tx.insert(incidents).values({ tenantId: h.tenantId, severity: 'sev1', title: 'Wrong discount published', description: 'rolled back', openedBy: 'user:test' });
      await tx.insert(incidents).values({ tenantId: h.tenantId, severity: 'sev4', title: 'Cosmetic', description: 'minor', openedBy: 'user:test' });
    });
    await runOpsMonitor(db(), n, { environment: 'test', now });
    await runOpsMonitor(db(), n, { environment: 'test', now: new Date(now.getTime() + 60_000) });
    expect(n.take('alert:').map((a) => a.text)).toEqual(['campaign 42 spent 3x its budget']);
    expect(n.take('incident:').map((a) => a.title)).toEqual(['Incident sev1: Wrong discount published']);
  });

  it('summarises background jobs that exhausted their retries, once', async () => {
    const n = new RecordingNotifier();
    const now = new Date();
    await heartbeat(now);
    const [job] = (await db().execute<{ id: string }>(sql`select id::text as id from graphile_worker.add_job('connector_health', '{}'::json, max_attempts := 1)`)).rows;
    await db().execute(sql`update graphile_worker._private_jobs set attempts = 1, last_error = 'Error: provider timeout\n    at stack', updated_at = now() where id = ${job!.id}::bigint`);
    await runOpsMonitor(db(), n, { environment: 'test', now });
    await runOpsMonitor(db(), n, { environment: 'test', now: new Date(now.getTime() + 60_000) });
    const jobs = n.take('jobs:');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.title).toBe('1 background job(s) failed permanently');
    expect(jobs[0]!.text).toContain('connector_health');
    expect(jobs[0]!.text).toContain('provider timeout');
    expect(jobs[0]!.text).not.toContain('at stack');
    await db().execute(sql`delete from graphile_worker._private_jobs where id = ${job!.id}::bigint`);
  });

  it('retries undelivered alerts on later runs', async () => {
    const n = new RecordingNotifier();
    const now = new Date();
    await heartbeat(minutesAgo(now, 30));
    n.fail = true;
    const first = await runOpsMonitor(db(), n, { environment: 'test', now });
    expect(first.failed).toBeGreaterThanOrEqual(1);
    n.fail = false;
    await runOpsMonitor(db(), n, { environment: 'test', now: new Date(now.getTime() + 60_000) });
    expect(n.take('component:worker')).toHaveLength(1);
    const [row] = await withSystem(db(), 'test', (tx) => tx.select().from(opsNotifications).where(sql`${opsNotifications.dedupKey} = 'component:worker'`));
    expect(row).toMatchObject({ delivered: true, attempts: 2, lastError: null });
  });
});

describe('webhook delivery', () => {
  const alert: OpsAlert = { severity: 'critical', title: 'API error on POST /v1/x', text: 'token sk-live-0123456789abcdef leaked?', source: 'api', environment: 'test', dedupKey: 'k', fields: { requestId: 'r1' } };
  const capture = () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, f };
  };

  it('formats for Slack, Discord and generic JSON and redacts known secrets', async () => {
    const { calls, f } = capture();
    await new WebhookNotifier('https://hooks.slack.com/services/T/B/x', { fetch: f, knownSecrets: ['sk-live-0123456789abcdef'] }).send(alert);
    await new WebhookNotifier('https://discord.com/api/webhooks/1/abc', { fetch: f }).send(alert);
    await new WebhookNotifier('https://alerts.example.com/hook', { fetch: f }).send(alert);
    expect(calls[0]!.body).toEqual({ text: expect.stringContaining('CRITICAL: API error on POST /v1/x') });
    expect(String(calls[0]!.body.text)).toContain('[REDACTED]');
    expect(String(calls[0]!.body.text)).not.toContain('sk-live');
    expect(calls[1]!.body).toMatchObject({ content: expect.stringContaining('requestId: r1'), allowed_mentions: { parse: [] } });
    expect(calls[2]!.body).toMatchObject({ severity: 'critical', dedupKey: 'k', source: 'api', rendered: expect.any(String) });
  });

  it('rejects non-https destinations and reports failed deliveries', async () => {
    expect(() => new WebhookNotifier('http://hooks.slack.com/x')).toThrow(/https/);
    const f = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(new WebhookNotifier('https://alerts.example.com/hook', { fetch: f }).send(alert)).rejects.toThrow(/HTTP 500/);
  });

  it('throttles hot-path alerts per key and per hour', () => {
    let t = 0;
    const th = new AlertThrottle(60_000, 3, () => t);
    expect([th.allow('a'), th.allow('a'), th.allow('b'), th.allow('c'), th.allow('d')]).toEqual([true, false, true, true, false]);
    t = 61_000;
    expect(th.allow('a')).toBe(false); // hourly cap reached
    t = 3_600_001;
    expect(th.allow('a')).toBe(true);
  });
});
