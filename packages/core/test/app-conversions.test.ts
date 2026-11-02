import { randomUUID } from 'node:crypto';
import { appInstalls, customerEvents, customerProfiles, evidenceRecords, organization, withTenant } from '@futuregrow/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { createDsar, executeDsarDeletion, ingestEvents, verifyDsarIdentity } from '../src/modules/m02-customers/index.js';
import { campaignConversions, recordAppEvent, recordInstall } from '../src/modules/m19-app-growth/index.js';

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2], tenantId = h.tenantId) => withTenant(h.deps.db, { tenantId, actor: 'test:conversions' }, fn);
const day = 86_400_000;
const ago = (days: number) => new Date(h.clock.now().getTime() - days * day).toISOString();
const install = (appId = 'com.example.lessons', installId: string = randomUUID()) => ({ appId, platform: 'android' as const, installId, installedAt: ago(20), installReferrer: 'utm_source=facebook&utm_medium=organic_social&utm_campaign=lessons&utm_content=lesson-1&gclid=discard', consent: { analytics: true } });
const report = (appId: string, tenantId = h.tenantId) => tx((t) => campaignConversions(t, { appId, platform: 'android', from: ago(30), to: h.clock.now().toISOString() }, h.clock.now()), tenantId);

beforeAll(async () => {
  h = await createCoreHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('application-scoped conversion evidence', () => {
  it('accepts maximum-length app and installation IDs without dropping the underlying event', async () => {
    const input = install('a'.repeat(200), 'i'.repeat(200));
    expect(await recordInstall(h.deps, h.tenantId, 'key:backend', input)).toMatchObject({ recorded: true, profileLinked: true });
    expect(await recordAppEvent(h.deps, h.tenantId, 'key:backend', { appId: input.appId, platform: input.platform, installId: input.installId, eventId: randomUUID(), event: 'first_open', occurredAt: ago(19), consent: { analytics: true } })).toMatchObject({ recorded: true });
    expect((await report(input.appId)).campaigns[0]!.metrics.firstOpens).toBe(1);
  });
  it('serializes concurrent installation retries and returns the stored attribution on replay', async () => {
    const input = install('com.example.concurrent');
    const outcomes = await Promise.allSettled([recordInstall(h.deps, h.tenantId, 'key:backend', input), recordInstall(h.deps, h.tenantId, 'key:backend', input)]);
    const results = outcomes.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    const replay = await recordInstall(h.deps, h.tenantId, 'key:backend', { ...input, installReferrer: undefined });
    expect(replay).toMatchObject({ recorded: false, attributionMethod: 'play_install_referrer' });
    const rows = await tx((t) => t.select().from(appInstalls).where(eq(appInstalls.appId, input.appId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ingestionSource: 'key:backend', campaignRef: 'lessons' });
    expect(rows[0]!.evidenceId).toBeTruthy();
    expect(rows[0]!.referrer).not.toHaveProperty('gclid');
    expect((await report(input.appId)).campaigns[0]!.metrics).toEqual({ installs: 1, linkClicks: null, firstOpens: null, activations: null, retainedWeek1: null });
  });

  it('keeps applications and tenants separate even with the same installation identifier', async () => {
    const a = install('com.example.alpha', 'shared-install-id');
    const b = { ...a, appId: 'com.example.beta' };
    await recordInstall(h.deps, h.tenantId, 'key:backend', a);
    await recordInstall(h.deps, h.tenantId, 'key:backend', b);
    const otherTenant = `org_${randomUUID()}`;
    await h.deps.db.insert(organization).values({ id: otherTenant, name: 'Other tenant', slug: otherTenant });
    expect((await report(a.appId, otherTenant)).campaigns).toEqual([]);
    expect((await recordInstall(h.deps, otherTenant, 'key:other', a)).recorded).toBe(true);
    expect((await report(a.appId)).campaigns[0]!.metrics.installs).toBe(1);
    expect((await report(b.appId)).campaigns[0]!.metrics.installs).toBe(1);
    const rows = await tx((t) => t.select().from(appInstalls).where(sql`${appInstalls.appId} in (${a.appId}, ${b.appId})`));
    expect(rows[0]!.installId).not.toBe(rows[1]!.installId);
  });

  it('uses actual first-open, activation and mature retention events with replay-safe evidence', async () => {
    const input = install('com.example.funnel');
    await recordInstall(h.deps, h.tenantId, 'key:backend', input);
    const first = { appId: input.appId, platform: input.platform, installId: input.installId, eventId: randomUUID(), event: 'first_open', occurredAt: ago(19), consent: { analytics: true } };
    const one = await recordAppEvent(h.deps, h.tenantId, 'key:backend', first);
    expect(one.recorded).toBe(true);
    expect(await recordAppEvent(h.deps, h.tenantId, 'key:backend', first)).toMatchObject({ recorded: false, evidenceId: one.evidenceId });
    await expect(recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...first, event: 'activation' })).rejects.toThrow(/reused/);
    await recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...first, eventId: randomUUID(), event: 'activation', occurredAt: ago(18) });
    await recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...first, eventId: randomUUID(), event: 'session', occurredAt: ago(11) });
    const campaign = (await report(input.appId)).campaigns[0]!;
    expect(campaign.metrics).toEqual({ linkClicks: null, installs: 1, firstOpens: 1, activations: 1, retainedWeek1: 1 });
    expect(campaign.matureWeek1Installs).toBe(1);
    expect(campaign.evidenceIds).toHaveLength(4);
    expect(campaign.evidenceIds).toContain(one.evidenceId);
  });

  it('does not call early retention a mature outcome or accept unbacked generic events', async () => {
    const input = { ...install('com.example.immature'), installedAt: ago(10) };
    await recordInstall(h.deps, h.tenantId, 'key:backend', input);
    const event = { appId: input.appId, platform: input.platform, installId: input.installId, eventId: randomUUID(), event: 'session', occurredAt: ago(1), consent: { analytics: true } };
    await recordAppEvent(h.deps, h.tenantId, 'key:backend', event);
    const [row] = await tx((t) => t.select().from(appInstalls).where(eq(appInstalls.appId, input.appId)));
    await ingestEvents(h.deps, h.tenantId, 'browser', [
      { messageId: randomUUID(), event: 'app_activation', timestamp: ago(1), deviceId: `app:${row!.installId}`, properties: { appId: input.appId, platform: 'android', installHash: row!.installId, evidenceId: row!.evidenceId }, context: { consent: { analytics: true } } },
    ]);
    const campaign = (await report(input.appId)).campaigns[0]!;
    expect(campaign.metrics.activations).toBeNull();
    expect(campaign.metrics.retainedWeek1).toBeNull();
    expect(campaign.matureWeek1Installs).toBe(0);
  });

  it('excludes denied-consent and legacy installs from scoped reports', async () => {
    const input = { ...install('com.example.private'), consent: { analytics: false } };
    await recordInstall(h.deps, h.tenantId, 'key:backend', input);
    await recordInstall(h.deps, h.tenantId, 'key:backend', { ...input, appId: undefined, consent: { analytics: true } });
    const event = { appId: input.appId, platform: input.platform, installId: input.installId, eventId: randomUUID(), event: 'first_open', occurredAt: ago(19), consent: { analytics: true } };
    expect(await recordAppEvent(h.deps, h.tenantId, 'key:backend', event)).toMatchObject({ recorded: false });
    expect((await report(input.appId)).campaigns).toEqual([]);
    const [row] = await tx((t) => t.select().from(appInstalls).where(eq(appInstalls.appId, input.appId)));
    expect(row).toMatchObject({ profileId: null, evidenceId: null, referrer: {}, campaignRef: null });
  });

  it('rejects future, reversed and pre-install timestamps', async () => {
    await expect(recordInstall(h.deps, h.tenantId, 'key:backend', { ...install(), installedAt: ago(-1) })).rejects.toThrow(/future/);
    await expect(recordInstall(h.deps, h.tenantId, 'key:backend', { ...install(), referrerClickAt: ago(19) })).rejects.toThrow(/click/);
    const input = install('com.example.timestamps');
    await recordInstall(h.deps, h.tenantId, 'key:backend', input);
    const event = { appId: input.appId, platform: input.platform, installId: input.installId, eventId: randomUUID(), event: 'first_open', occurredAt: ago(21), consent: { analytics: true } };
    await expect(recordAppEvent(h.deps, h.tenantId, 'key:backend', event)).rejects.toThrow(/precedes/);
    await expect(recordAppEvent(h.deps, h.tenantId, 'key:backend', { ...event, occurredAt: ago(-1) })).rejects.toThrow(/future/);
  });

  it('rolls back event, identity and evidence side effects if the install write fails', async () => {
    const before = await tx((t) => t.select({ id: evidenceRecords.id }).from(evidenceRecords));
    const eventsBefore = await tx((t) => t.select({ id: customerEvents.id }).from(customerEvents));
    const profilesBefore = await tx((t) => t.select({ id: customerProfiles.id }).from(customerProfiles));
    await h.deps.db.execute(
      sql`create function test_reject_install() returns trigger language plpgsql as $$ begin if NEW.app_id = 'com.example.failure' then raise exception 'fixture install failure'; end if; return NEW; end $$; create trigger test_reject_install before insert on app_installs for each row execute function test_reject_install()`,
    );
    try {
      await expect(recordInstall(h.deps, h.tenantId, 'key:backend', install('com.example.failure'))).rejects.toThrow();
      expect(await tx((t) => t.select({ id: evidenceRecords.id }).from(evidenceRecords))).toHaveLength(before.length);
      expect(await tx((t) => t.select({ id: customerEvents.id }).from(customerEvents))).toHaveLength(eventsBefore.length);
      expect(await tx((t) => t.select({ id: customerProfiles.id }).from(customerProfiles))).toHaveLength(profilesBefore.length);
      expect((await report('com.example.failure')).campaigns).toEqual([]);
    } finally {
      await h.deps.db.execute(sql`drop trigger test_reject_install on app_installs; drop function test_reject_install()`);
    }
  });

  it('removes conversion evidence and campaign linkage when the subject is deleted', async () => {
    const input = { ...install('com.example.deletion'), userId: 'conversion-delete-subject' };
    await recordInstall(h.deps, h.tenantId, 'key:backend', input);
    await recordAppEvent(h.deps, h.tenantId, 'key:backend', { appId: input.appId, platform: input.platform, installId: input.installId, eventId: randomUUID(), event: 'first_open', occurredAt: ago(19), consent: { analytics: true } });
    expect((await report(input.appId)).campaigns[0]!.metrics.firstOpens).toBe(1);
    const request = await tx((t) => createDsar(t, h.deps, h.tenantId, h.users.owner, { kind: 'delete', identifier: { kind: 'user_id', value: input.userId } }));
    await tx((t) => verifyDsarIdentity(t, h.tenantId, h.users.owner, request.id, 'fixture identity verified'));
    await executeDsarDeletion(h.deps, h.tenantId, h.users.owner, request.id);
    expect((await report(input.appId)).campaigns).toEqual([]);
    const [row] = await tx((t) => t.select().from(appInstalls).where(eq(appInstalls.appId, input.appId)));
    expect(row).toMatchObject({ profileId: null, evidenceId: null, referrer: {}, campaignRef: null, sourceRef: null, consentAnalytics: false });
    expect(await recordAppEvent(h.deps, h.tenantId, 'key:backend', { appId: input.appId, platform: input.platform, installId: input.installId, eventId: randomUUID(), event: 'session', occurredAt: ago(1), consent: { analytics: true } })).toMatchObject({ recorded: false });
  });
});
