import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { customerEvents, withTenant } from '@futuregrow/db';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { attributionReport } from '../src/modules/m19-app-growth/attribution.js';
import { AppEventSchema, InstallSchema, MAX_APP_EVENT_AGE_DAYS, recordAppEvent, recordInstall } from '../src/modules/m19-app-growth/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(here, '../../../examples/flutter/futuregrow_telemetry/fixtures');
const install = JSON.parse(fs.readFileSync(path.join(FIX, 'install.json'), 'utf8'));
const events = JSON.parse(fs.readFileSync(path.join(FIX, 'events.json'), 'utf8')) as Record<string, unknown>[];

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test:telemetry' }, fn);

beforeAll(async () => {
  h = await createCoreHarness();
  h.clock.advance(Date.parse('2026-10-25T00:00:00Z') - h.clock.now().getTime());
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('app telemetry from the Flutter client (P3-07)', () => {
  it('the example client’s payloads are exactly what the server accepts', () => {
    expect(InstallSchema.safeParse(install).success).toBe(true);
    for (const e of events) expect(AppEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  });

  it('records install, first open, activation and a conversion with app version; retries are the same event', async () => {
    const i = await recordInstall(h.deps, h.tenantId, 'key:backend', install);
    expect(i).toBeTruthy();
    for (const e of events) expect(await recordAppEvent(h.deps, h.tenantId, 'key:backend', e), JSON.stringify(e)).toMatchObject({ recorded: true });
    // A retried request (same event id and data) is not stored twice.
    expect(await recordAppEvent(h.deps, h.tenantId, 'key:backend', events[0]!)).toMatchObject({ recorded: false });
    const stored = await tx((t) => t.select().from(customerEvents).where(like(customerEvents.messageId, 'app-event:%')));
    expect(stored.map((s) => s.eventName).sort()).toEqual(['app_activation', 'app_conversion', 'app_first_open']);
    const conv = stored.find((s) => s.eventName === 'app_conversion')!;
    expect(conv).toMatchObject({ revenueMicros: 4_990_000, currency: 'USD', properties: { appVersion: '2.2.0+7', conversion: 'subscription_started' } });
  });

  it('refuses replays, malformed conversions and events without consent', async () => {
    await expect(recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...events[0]!, occurredAt: '2026-10-21T00:00:00.000Z' })).rejects.toThrow(/reused with different data/);
    const old = new Date(h.clock.now().getTime() - (MAX_APP_EVENT_AGE_DAYS + 1) * 86_400_000).toISOString();
    await expect(recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...events[1]!, eventId: 'activation-old-0001', occurredAt: old })).rejects.toThrow(/older than 30 days/);
    await expect(recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...events[2]!, eventId: 'conv-0002', conversion: undefined })).rejects.toThrow();
    await expect(recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...events[2]!, eventId: 'conv-0003', conversion: { name: 'x_y', valueMicros: 100 } })).rejects.toThrow();
    expect(await recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...events[1]!, eventId: 'activation-nc-0004', consent: { analytics: false } })).toMatchObject({ recorded: false, reason: 'analytics consent denied' });
  });
});

describe('advanced attribution (P3-08)', () => {
  it('shows telemetry beside the store report without adding them, and calls the result descriptive', async () => {
    const r = await tx((t) => attributionReport(t, { appId: 'com.example.lessons', platform: 'android', from: '2026-10-01T00:00:00Z', to: '2026-10-25T00:00:00Z' }, h.clock.now()));
    const c = r.campaigns.find((x) => x.campaign === 'lessons_261020_ab12')!;
    expect(c.telemetry).toMatchObject({ installs: 1, firstOpens: 1, activations: 1, methods: ['play_install_referrer'] });
    // Google Play has no final day for this campaign in this database: unknown, not zero, and no coverage ratio.
    expect(c.storeReported).toMatchObject({ available: true, acquisitions: null, reportedDays: 0, note: expect.stringMatching(/unknown, not zero/) });
    expect(c.telemetryCoverageOfStore).toBeNull();
    expect(Object.keys(c)).not.toContain('total');
    expect(r.incrementality).toMatchObject({ basis: 'none', note: expect.stringMatching(/describe what was observed, not what the campaigns caused/) });
    expect(r.notes[0]).toMatch(/never added/);
    const ios = await tx((t) => attributionReport(t, { appId: 'com.example.lessons', platform: 'ios', from: '2026-10-01T00:00:00Z', to: '2026-10-25T00:00:00Z' }, h.clock.now()));
    expect(ios.campaigns).toEqual([]);
  });
});
