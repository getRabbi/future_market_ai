import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { analyticsRequests, conversationMessages, conversations, customerEvents, customerProfiles, evidenceRecords, experimentResults, forecastPoints, forecastRuns, outboxEvents, propensityModels, propensityScores, topicClusters, trends, withSystem, withTenant } from '@futuregrow/db';
import { EventBus, rowToEnvelope } from '@futuregrow/events';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { wireEventHandlers } from '../src/event-handlers.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import * as analytics from '../src/modules/m08-analytics/index.js';
import * as exps from '../src/modules/m10-experiments/index.js';
import { decideApproval, executeAction, verifyAction } from '../src/modules/m23-execution/gateway.js';
import { setTenantPolicy } from '../src/modules/m24-governance/index.js';

const root = path.resolve(__dirname, '../../..');
const py = [path.join(root, 'jobs/analytics/.venv/Scripts/python.exe'), path.join(root, 'jobs/analytics/.venv/bin/python')].find((p) => fs.existsSync(p));

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

function runJob() {
  const r = spawnSync(py!, ['-m', 'futuregrow_analytics.runner'], {
    cwd: path.join(root, 'jobs/analytics'),
    env: { ...process.env, DATABASE_URL: h.t.url, ANALYTICS_MAX_SECONDS: '300', PYTHONPATH: path.join(root, 'jobs/analytics') },
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (r.status !== 0) throw new Error(`analytics job failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

describe.skipIf(!py)('analytics job (Python) against real PostgreSQL', () => {
  let seriesId: string;
  let experimentId: string;

  beforeAll(async () => {
    h = await createCoreHarness();
    await tx((t) =>
      setTenantPolicy(t, h.tenantId, h.users.owner, {
        configured: true,
        currency: 'USD',
        approvedJurisdictions: [],
        categories: {},
        forecastGates: { maxMaseRatioToBaseline: 1.0, intervalCoverageTolerance: 0.2, minBacktestFolds: 10 },
      }),
    );
    const ev = await tx((t) =>
      admitEvidence(
        t,
        h.tenantId,
        h.users.owner,
        {
          sourceType: 'primary',
          sourceOwner: 'acme',
          sourceUriOrObjectId: 'warehouse://daily_signups',
          retrievedAt: h.clock.now().toISOString(),
          licenseOrUsageRights: 'first-party',
          schemaVersion: '1',
          piiClassification: 'none',
          confidence: 0.95,
          freshnessSlaHours: 48,
          permittedUses: ['analytics', 'forecasting', 'autonomous_execution'],
          kind: 'metric',
          content: { table: 'signups_daily' },
        },
        { now: h.clock.now() },
      ),
    );
    const s = await tx((t) => analytics.upsertSeries(t, h.tenantId, h.users.owner, { key: 'kpi.signups', name: 'Daily signups', unit: 'count', granularity: 'day', kind: 'kpi', sourceEvidenceId: ev.evidenceId }));
    seriesId = s.id;
    const start = Date.parse('2026-06-01T00:00:00Z');
    const pts = Array.from({ length: 140 }, (_, i) => ({ ts: new Date(start + i * 86_400_000).toISOString(), value: 200 + 0.6 * i + 25 * Math.sin((2 * Math.PI * i) / 7) + ((i * 7919) % 13) - 6 }));
    await tx((t) => analytics.appendPoints(t, h.tenantId, seriesId, pts));

    // Experiment with logged assignment -> exposure -> outcome.
    const e = await tx((t) =>
      exps.createExperiment(t, h.tenantId, h.users.operator, {
        name: 'Onboarding checklist',
        hypothesis: 'A checklist increases activation within 7 days',
        design: 'ab_fixed',
        unit: 'profile',
        targetMetric: 'activated',
        metricType: 'binary',
        riskTier: 'low',
        variants: [
          { key: 'control', description: 'current', isControl: true },
          { key: 'checklist', description: 'checklist' },
        ],
        decisionRules: { probBestThreshold: 0.95, maxExpectedLoss: 0.01 },
      }),
    );
    experimentId = e.id;
    const a = await exps.proposeStart(h.deps, h.tenantId, h.users.operator, experimentId);
    expect(a.status).toBe('APPROVAL_REQUIRED');
    await decideApproval(h.deps, h.tenantId, h.users.admin, a.id, { decision: 'approved', expectedActionHash: a.actionHash });
    await executeAction(h.deps, h.tenantId, a.id);
    expect(await verifyAction(h.deps, h.tenantId, a.id)).toMatchObject({ status: 'VERIFIED' });
    await tx(async (t) => {
      for (let i = 0; i < 2000; i++) {
        const unit = `u-${i}`;
        const r = await exps.assign(t, experimentId, unit);
        await exps.logExposure(t, experimentId, unit);
        const p = r.variant === 'checklist' ? 0.3 : 0.2;
        if (((i * 2654435761) % 1000) / 1000 < p) await exps.logOutcome(t, experimentId, unit, 'activated', 1);
      }
    });

    // Customers + events for propensity, conversations for topics.
    await tx(async (t) => {
      const created = new Date(Date.now() - 200 * 86_400_000);
      for (let i = 0; i < 300; i++) {
        const [p] = await t.insert(customerProfiles).values({ tenantId: h.tenantId, createdAt: created }).returning();
        const active = i % 3 === 0;
        const evs = Array.from({ length: active ? 12 : 2 }, (_, k) => ({
          tenantId: h.tenantId,
          messageId: `pe-${i}-${k}`,
          profileId: p!.id,
          eventName: 'page_viewed',
          occurredAt: new Date(Date.now() - (35 + k * 3) * 86_400_000),
          source: 'test',
        }));
        await t.insert(customerEvents).values(evs);
        if ((active && i % 2 === 0) || i % 17 === 0) {
          await t.insert(customerEvents).values({ tenantId: h.tenantId, messageId: `buy-${i}`, profileId: p!.id, eventName: 'purchase', occurredAt: new Date(Date.now() - 5 * 86_400_000), source: 'test' });
        }
      }
      const [conv] = await t.insert(conversations).values({ tenantId: h.tenantId, channel: 'web_chat' }).returning();
      const msgs = [...Array.from({ length: 15 }, (_, i) => `I want a refund for order ${i}, refund my money please`), ...Array.from({ length: 15 }, (_, i) => `cannot login, password reset email never arrives ${i}`)];
      for (const m of msgs) await t.insert(conversationMessages).values({ tenantId: h.tenantId, conversationId: conv!.id, role: 'customer', text: m, redactedText: m });
    });

    await tx(async (t) => {
      await analytics.requestAnalytics(t, h.tenantId, h.users.analyst, 'forecast', { seriesId, horizon: 7 });
      await exps.requestAnalysis(t, h.tenantId, h.users.analyst, experimentId);
      await analytics.requestAnalytics(t, h.tenantId, h.users.analyst, 'trend_detection', { seriesIds: [seriesId] });
      await analytics.requestAnalytics(t, h.tenantId, h.users.analyst, 'propensity_training', { horizonDays: 30, gates: { minAuc: 0.6, maxEce: 0.2 } });
      await analytics.requestAnalytics(t, h.tenantId, h.users.analyst, 'topic_clustering', { corpus: 'conversations', sinceDays: 30 });
      await analytics.requestAnalytics(t, h.tenantId, h.users.analyst, 'anomaly_scan', { seriesIds: [seriesId] });
    });
  }, 600_000);

  afterAll(async () => {
    await h?.close();
  });

  it('drains the queue and writes tenant-scoped results', async () => {
    const out = runJob();
    const reqs = await tx((t) => t.select().from(analyticsRequests));
    expect(reqs.filter((r) => r.status !== 'completed').map((r) => `${r.kind}: ${r.error}`)).toEqual([]);
    expect(out).toMatchObject({ processed: 6, failed: 0 });
    expect(reqs.every((r) => r.status === 'completed')).toBe(true);

    const [run] = await tx((t) => t.select().from(forecastRuns).where(eq(forecastRuns.seriesId, seriesId)));
    expect(run!.tenantId).toBe(h.tenantId);
    expect(['champion_selected', 'fallback_baseline']).toContain(run!.status);
    expect(run!.datasetSha256).toMatch(/^[a-f0-9]{64}$/);
    const pts = await tx((t) => t.select().from(forecastPoints).where(eq(forecastPoints.runId, run!.id)));
    expect(pts).toHaveLength(7);
    expect(pts.every((p) => p.q025 <= p.q50 && p.q50 <= p.q975)).toBe(true);

    const [res] = await tx((t) => t.select().from(experimentResults).where(eq(experimentResults.experimentId, experimentId)));
    expect(res!.srm).toMatchObject({ mismatch: false });
    expect(res!.probBest.checklist).toBeGreaterThan(0.95);
    expect(res!.recommendation).toBe('ship_candidate');
    expect(res!.inferenceKind).toBe('randomized_test');

    const tr = await tx((t) => t.select().from(trends));
    expect(tr[0]).toMatchObject({ direction: 'rising', inferenceKind: 'correlation' });

    const [model] = await tx((t) => t.select().from(propensityModels));
    expect(model!.featurePolicy).toMatchObject({ allowed: true });
    const scores = await tx((t) => t.select().from(propensityScores).where(eq(propensityScores.modelId, model!.id)));
    expect(scores.length).toBeGreaterThan(100);
    expect(scores.every((s) => s.intervalLow <= s.score && s.score <= s.intervalHigh)).toBe(true);

    const topics = await tx((t) => t.select().from(topicClusters));
    expect(topics.length).toBeGreaterThanOrEqual(2);
  }, 600_000);

  it('feeds validated model outputs back into the evidence ledger', async () => {
    const events = await withSystem(h.t.handle.db, 'system:test', (t) => t.select().from(outboxEvents).where(sql`${outboxEvents.eventType} = 'analytics.request.completed' and ${outboxEvents.tenantId} = ${h.tenantId}`));
    expect(events).toHaveLength(6);
    const bus = wireEventHandlers(new EventBus(), h.deps);
    for (const e of events) expect(await bus.dispatch(rowToEnvelope(e))).toEqual([]);
    // redelivery is idempotent
    for (const e of events) await bus.dispatch(rowToEnvelope(e));
    const mo = await tx((t) => t.select().from(evidenceRecords).where(eq(evidenceRecords.kind, 'model_output')));
    // anomaly scans emit alerts, not result rows, so they produce no model-output evidence
    expect(mo).toHaveLength(5);
    expect(mo.some((m) => m.sourceUriOrObjectId.includes('anomaly_scan'))).toBe(false);
    const fc = mo.find((m) => m.sourceUriOrObjectId.startsWith('analytics://forecast/'))!;
    expect(fc.status).toBe('admitted');
    expect(fc.lineageParentIds).toHaveLength(1);
    expect(fc.confidence).toBeGreaterThan(0);
  });

  it('isolates analytics results from other tenants', async () => {
    const other = `org_${randomUUID().slice(0, 8)}`;
    const rows = await withTenant(h.t.handle.db, { tenantId: other, actor: 'user:x' }, (t) => t.select().from(forecastRuns));
    expect(rows).toHaveLength(0);
  });
});
