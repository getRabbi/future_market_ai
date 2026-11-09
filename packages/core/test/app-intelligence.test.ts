import { randomUUID } from 'node:crypto';
import { auditLog, campaignLinks, connections, contentPlanItems, evidenceRecords, metricPoints, metricSeries, organization, socialPosts, storeAccounts, storeApps, storeMetricObservations, storeReportCoverage, storeReportFiles, storeReportPartitions, storeSyncRuns, withTenant } from '@futuregrow/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { ascKey, csv, DOWNLOADS_HEADER, FakeApple, FakePlay, INSTALLS_HEADER, monthDays, serviceAccountKey, TRAFFIC_HEADER, tsv, utf16 } from '../../../test/helpers/store-fixtures.js';
import { classifyPlayError, clearPlayTokenCache, ProviderHttpError } from '../../connectors/src/index.js';
import { interpretForTenant, interpretGoal } from '../src/modules/autopilot/goals.js';
import { EXECUTORS, measureGoal, storeTrendLines } from '../src/modules/autopilot/steps.js';
import { assignProgram, bindApp, bindChannel, createBrand, registerCampaignLink } from '../src/modules/brands/index.js';
import { rotateConnectionCredentials } from '../src/modules/connections.js';
import { assertUserWritableSeries } from '../src/modules/m08-analytics/index.js';
import { recordInstall } from '../src/modules/m19-app-growth/index.js';
import {
  accountWarnings,
  appIntelligenceDetail,
  appIntelligenceOverview,
  appsTrendContext,
  connectStoreAccount,
  decideStoreApp,
  developerAccountsOverview,
  importParsedReport,
  PLAY_FAMILIES,
  parsePlayReport,
  requestAppleAnalytics,
  rotateStoreAccountKey,
  runStoreAccountSync,
  STORE_SYNC_TASK,
  storeKpiSignals,
  storeTrendContext,
  syncStoreKpiSeries,
} from '../src/modules/m19-app-growth/store/index.js';
import { postStoreAttribution, upsertProgram } from '../src/modules/studio/index.js';
import { loadCredentials } from '../src/secrets.js';

let h: CoreHarness;
let server: FixtureServer;
let play: FakePlay;
let apple: FakeApple;
let other: string;
const BUCKET = 'pubsite_prod_rev_01234567890987654321';
const ALPHA = 'com.example.alpha';
const BETA = 'com.example.beta';
const KEY = serviceAccountKey();
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2], tenantId = h.tenantId) => withTenant(h.deps.db, { tenantId, actor: 'test:app-intelligence' }, fn);
const sync = (accountId: string, tenantId = h.tenantId) => runStoreAccountSync(h.deps, tenantId, accountId, { mode: 'incremental', triggeredBy: 'test', owner: `test:${randomUUID().slice(0, 6)}` });

/** Daily user installs for a day/country, deterministic. */
const userInstalls = (day: string, country: string) => (Number(day.slice(8)) % 7) + (country === 'BD' ? 10 : 2);

function installsFile(pkg: string, month: string, upTo?: string, opts: { override?: Record<string, number>; blankUninstallsOn?: string; zeroUninstallsOn?: string } = {}) {
  const rows: (string | number)[][] = [INSTALLS_HEADER];
  for (const day of monthDays(month, upTo)) {
    for (const country of ['BD', 'IN']) {
      const ui = opts.override?.[`${day}|${country}`] ?? userInstalls(day, country);
      const uninstalls = day === opts.blankUninstallsOn && country === 'IN' ? '' : day === opts.zeroUninstallsOn ? 0 : 1;
      rows.push([day, pkg, country, 900, 850, ui + 1, uninstalls, 3, 880, 1200, ui, 1]);
    }
  }
  return utf16(csv(rows));
}

function trafficFile(pkg: string, month: string) {
  const rows: (string | number)[][] = [TRAFFIC_HEADER];
  for (const day of monthDays(month)) {
    rows.push([day, pkg, 'Third-party referrals', '', 'facebook', 'lessons_260815_ab12', day === '2026-08-15' ? 4 : 0, day === '2026-08-15' ? 9 : 1, day === '2026-08-15' ? 0.444 : 0]);
    rows.push([day, pkg, 'Third-party referrals', '', 'facebook', 'lessons_daily', 2, 6, 0.333]);
    rows.push([day, pkg, 'Google Play search', 'korean lessons', '', '', 5, 20, 0.25]);
  }
  return utf16(csv(rows));
}

beforeAll(async () => {
  server = new FixtureServer();
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  other = `org_${randomUUID().slice(0, 8)}`;
  await h.t.handle.db.insert(organization).values({ id: other, name: 'Other org', slug: other });
  play = new FakePlay(server, BUCKET).install();
  apple = new FakeApple(server).install();
  play.apps = [
    { packageName: ALPHA, displayName: 'Alpha Lessons' },
    { packageName: 'com.other.gamma', displayName: 'Gamma (another developer account)' },
  ];
  play.put(`stats/installs/installs_${ALPHA}_202608_country.csv`, installsFile(ALPHA, '2026-08', undefined, { blankUninstallsOn: '2026-08-20', zeroUninstallsOn: '2026-08-21' }), '2026-09-08T03:00:00Z');
  play.put(`stats/installs/installs_${ALPHA}_202610_country.csv`, installsFile(ALPHA, '2026-10', '2026-10-14'), '2026-10-17T03:00:00Z');
  play.put(`stats/installs/installs_${BETA}_202608_country.csv`, installsFile(BETA, '2026-08'), '2026-09-08T03:00:00Z');
  play.put(`stats/store_performance/store_performance_${ALPHA}_202608_traffic_source.csv`, trafficFile(ALPHA, '2026-08'), '2026-09-08T03:00:00Z');
  play.put(`stats/crashes/crashes_${ALPHA}_202608_app_version.csv`, utf16(csv([['Date', 'Package Name', 'App Version Code', 'Daily Crashes', 'Daily ANRs'], ...monthDays('2026-08').map((d) => [d, ALPHA, '42', 2, 0])])), '2026-09-08T03:00:00Z');
  // A dimension this account does not import by default (device) is listed but skipped.
  play.put(
    `stats/installs/installs_${ALPHA}_202608_device.csv`,
    utf16(
      csv([
        ['Date', 'Package Name', 'Device', 'Daily Device Installs'],
        ['2026-08-01', ALPHA, 'Pixel 9', 1],
      ]),
    ),
    '2026-09-08T03:00:00Z',
  );
  play.vitals.set(ALPHA, {
    latest: '2026-10-17',
    rows: [
      { date: '2026-10-15', crashRate: '0.0123', anrRate: '0.004' },
      { date: '2026-10-16', crashRate: '0.0101' },
    ],
  });
}, 180_000);
afterAll(async () => {
  await h?.close();
  await server?.stop();
});

describe('developer accounts and discovery (Google Play)', () => {
  it('refuses a key the report bucket does not accept and stores nothing', async () => {
    play.denyBucket = true;
    await expect(connectStoreAccount(h.deps, h.tenantId, h.users.owner, { provider: 'google_play', displayName: 'Main Play account', bucket: `gs://${BUCKET}/`, serviceAccountKey: KEY.json })).rejects.toThrow(/View app information/);
    play.denyBucket = false;
    expect(await tx((t) => t.select().from(storeAccounts))).toHaveLength(0);
    expect(await tx((t) => t.select().from(connections).where(eq(connections.provider, 'google_play')))).toHaveLength(0);
  });

  it('requires an admin with two-factor and a real service-account key file', async () => {
    await expect(connectStoreAccount(h.deps, h.tenantId, h.users.operator, { provider: 'google_play', displayName: 'x', bucket: BUCKET, serviceAccountKey: KEY.json })).rejects.toThrow();
    await expect(connectStoreAccount(h.deps, h.tenantId, h.users.owner, { provider: 'google_play', displayName: 'x', bucket: BUCKET, serviceAccountKey: { ...KEY.json, type: 'authorized_user' } })).rejects.toThrow(/service account key/);
    await expect(connectStoreAccount(h.deps, h.tenantId, h.users.owner, { provider: 'google_play', displayName: 'x', bucket: 'gs://my-own-bucket-name', serviceAccountKey: KEY.json })).rejects.toThrow(/pubsite_prod/);
  });

  let accountId = '';
  it('connects one account and discovers every app in its reports without app-specific code', async () => {
    const acct = await connectStoreAccount(h.deps, h.tenantId, h.users.owner, { provider: 'google_play', displayName: 'Main Play account', bucket: `gs://${BUCKET}/`, serviceAccountKey: JSON.stringify(KEY.json) });
    accountId = acct.id;
    expect(acct).toMatchObject({ provider: 'google_play', accountRef: BUCKET, health: 'ok' });
    expect(JSON.stringify(acct)).not.toContain('PRIVATE KEY');
    expect(h.jobs.take(STORE_SYNC_TASK).at(-1)).toMatchObject({ payload: { accountId: acct.id }, opts: { jobKey: `store-sync:${acct.id}` } });
    const r = await sync(acct.id);
    expect(r).toMatchObject({ skipped: false, outcome: 'succeeded', health: 'ok' });
    const apps = await tx((t) => t.select().from(storeApps).where(eq(storeApps.storeAccountId, acct.id)));
    const byId = Object.fromEntries(apps.map((a) => [a.appId, a]));
    // Apps in the account's own bucket are confirmed; one the key only sees through the API waits for the owner.
    expect(byId[ALPHA]).toMatchObject({ status: 'confirmed', displayName: 'Alpha Lessons' });
    expect(byId[BETA]).toMatchObject({ status: 'confirmed' });
    expect(byId['com.other.gamma']).toMatchObject({ status: 'discovered', discoveredVia: ['play_reporting_api'] });
    // The token exchange used the documented JWT bearer grant; the key itself never left the server.
    const tokenReq = server.find('POST', '/oauth/token')[0]!;
    expect(tokenReq.form?.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(tokenReq.body).not.toContain('PRIVATE KEY');
    const files = await tx((t) => t.select().from(storeReportFiles).where(eq(storeReportFiles.storeAccountId, acct.id)));
    expect(files.map((f) => `${f.family}:${f.dimension}:${f.period}:${f.status}`).sort()).toEqual([
      'play.crashes:app_version:2026-08:imported',
      'play.installs:country:2026-08:imported',
      'play.installs:country:2026-08:imported',
      'play.installs:country:2026-10:imported',
      'play.store_performance:traffic_source:2026-08:imported',
      'play.vitals:anr_rate:2026-10-17:imported',
      'play.vitals:crash_rate:2026-10-17:imported',
    ]);
    expect(files.every((f) => f.encoding === 'utf-16le' || f.family === 'play.vitals')).toBe(true);
  });

  it('keeps unknown values null and real zeros zero', async () => {
    const alpha = (await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, ALPHA))))[0]!;
    const obs = await tx((t) =>
      t
        .select()
        .from(storeMetricObservations)
        .where(and(eq(storeMetricObservations.storeAppId, alpha.id), eq(storeMetricObservations.metricKey, 'play.daily_device_uninstalls'), sql`${storeMetricObservations.observationDate} in ('2026-08-20', '2026-08-21')`)),
    );
    const v = Object.fromEntries(obs.map((o) => [`${o.observationDate}|${o.dims.country}`, o.value]));
    expect(v['2026-08-20|IN']).toBeNull();
    expect(v['2026-08-21|IN']).toBe(0);
    const detail = await tx((t) => appIntelligenceDetail(t, alpha.id, { from: '2026-08-19', to: '2026-08-22' }, h.clock.now()));
    const series = detail.series['play.daily_device_uninstalls']!;
    expect(series.find((b) => b.bucket === '2026-08-20')).toMatchObject({ value: null, daysWithData: 0 });
    expect(series.find((b) => b.bucket === '2026-08-21')).toMatchObject({ value: 0, daysWithData: 1 });
    // Google's conversion rate exists only per breakdown row here; no app-level rate is derived from them.
    expect(detail.series['play.store_listing_conversion_rate']).toBeUndefined();
    // Vitals rates are single reported values per Pacific day; weekly buckets do not average them.
    const weekly = await tx((t) => appIntelligenceDetail(t, alpha.id, { from: '2026-10-12', to: '2026-10-18', granularity: 'week' }, h.clock.now()));
    expect(weekly.series['play.vitals.crash_rate']!.every((b) => b.value === null)).toBe(true);
    const daily = await tx((t) => appIntelligenceDetail(t, alpha.id, { from: '2026-10-15', to: '2026-10-16' }, h.clock.now()));
    expect(daily.series['play.vitals.crash_rate']!.map((b) => b.value)).toEqual([0.0123, 0.0101]);
    expect(daily.series['play.vitals.anr_rate']!.map((b) => b.value)).toEqual([0.004, null]);
  });

  it('records coverage per month: complete, in progress, not published', async () => {
    const alpha = (await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, ALPHA))))[0]!;
    const cov = await tx((t) =>
      t
        .select()
        .from(storeReportCoverage)
        .where(and(eq(storeReportCoverage.storeAppId, alpha.id), eq(storeReportCoverage.family, 'play.installs'), eq(storeReportCoverage.dimension, 'country'))),
    );
    const status = Object.fromEntries(cov.map((c) => [c.period, c.status]));
    expect(status['2026-08']).toBe('complete');
    expect(status['2026-09']).toBe('unavailable');
    expect(status['2026-10']).toBe('partial');
    const traffic = await tx((t) =>
      t
        .select()
        .from(storeReportCoverage)
        .where(and(eq(storeReportCoverage.family, 'play.store_performance'), eq(storeReportCoverage.dimension, 'country'), eq(storeReportCoverage.period, '2026-10'))),
    );
    expect(traffic.every((c) => c.status === 'not_yet_published')).toBe(true);
  });

  it('imports the same report version only once', async () => {
    const before = (await tx((t) => t.select({ n: sql<number>`count(*)::int` }).from(storeMetricObservations)))[0]!.n;
    const r = await sync(accountId);
    expect(r).toMatchObject({ outcome: 'succeeded' });
    if (r.skipped) throw new Error('skipped');
    expect(r.stats.filesImported).toBe(0);
    expect((await tx((t) => t.select({ n: sql<number>`count(*)::int` }).from(storeMetricObservations)))[0]!.n).toBe(before);
  });

  it('replaces a restated day instead of adding to it, and marks the month revised', async () => {
    const alpha = (await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, ALPHA))))[0]!;
    const total = async () => (await tx((t) => appIntelligenceOverview(t, { from: '2026-08-01', to: '2026-08-31', accountId }, h.clock.now()))).apps.find((a) => a.appId === ALPHA)!.metrics['play.daily_user_installs']!.value;
    const original = await total();
    play.put(`stats/installs/installs_${ALPHA}_202608_country.csv`, installsFile(ALPHA, '2026-08', undefined, { override: { '2026-08-15|BD': 100 }, blankUninstallsOn: '2026-08-20', zeroUninstallsOn: '2026-08-21' }), '2026-09-10T03:00:00Z');
    await sync(accountId);
    expect(await total()).toBe(original! - userInstalls('2026-08-15', 'BD') + 100);
    const [p] = await tx((t) =>
      t
        .select()
        .from(storeReportPartitions)
        .where(and(eq(storeReportPartitions.storeAppId, alpha.id), eq(storeReportPartitions.family, 'play.installs'), eq(storeReportPartitions.observationDate, '2026-08-15'))),
    );
    expect(p!.revision).toBe(2);
    const [cov] = await tx((t) =>
      t
        .select()
        .from(storeReportCoverage)
        .where(and(eq(storeReportCoverage.storeAppId, alpha.id), eq(storeReportCoverage.family, 'play.installs'), eq(storeReportCoverage.dimension, 'country'), eq(storeReportCoverage.period, '2026-08'))),
    );
    expect(cov!.status).toBe('revised');
    expect(await tx((t) => t.select().from(auditLog).where(eq(auditLog.action, 'store.report.revised')))).not.toHaveLength(0);
  });

  it('never lets an older source overwrite a newer one', async () => {
    const alpha = (await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, ALPHA))))[0]!;
    const fam = PLAY_FAMILIES.find((f) => f.family === 'play.installs')!;
    const parsed = parsePlayReport(Buffer.from(installsFile(ALPHA, '2026-08', undefined, { override: { '2026-08-15|BD': 1 } }).subarray(2)).toString('utf16le'), fam, fam.dimensions.find((d) => d.key === 'country')!, ALPHA);
    const r = await tx((t) =>
      importParsedReport(
        t,
        { tenantId: h.tenantId, storeAccountId: accountId, storeAppId: alpha.id, platform: 'android', appId: ALPHA, provider: 'google_play' },
        { uri: `gs://${BUCKET}/stats/installs/installs_${ALPHA}_202608_country.csv`, version: '1', rank: 1, period: '2026-08', updatedAt: new Date('2026-09-01T00:00:00Z'), checksum: null, sizeBytes: 1, sha256: 'x', encoding: 'utf-16le', objectKey: null },
        parsed,
        { now: h.clock.now(), completeAfterDays: 7, evidence: { uri: 'gs://test#1', license: 'test', freshnessSlaHours: 24 } },
      ),
    );
    expect(r).toMatchObject({ partitionsChanged: 0, partitionsSkipped: 31 });
  });

  it('rejects a changed schema and wrong-package rows instead of guessing', async () => {
    play.put(
      `stats/installs/installs_${ALPHA}_202607_country.csv`,
      utf16(
        csv([
          ['Day', 'Package Name', 'Country', 'Daily User Installs'],
          ['2026-07-01', ALPHA, 'BD', 3],
        ]),
      ),
      '2026-08-08T03:00:00Z',
    );
    play.put(`stats/installs/installs_${BETA}_202607_country.csv`, utf16(csv([INSTALLS_HEADER, ['2026-07-01', BETA, 'BD', 1, 1, 1, 1, 1, 1, 1, 1, 1], ['2026-07-02', 'com.intruder.app', 'BD', 1, 1, 1, 1, 1, 1, 1, 999, 1]])), '2026-08-08T03:00:00Z');
    const r = await sync(accountId);
    expect(r).toMatchObject({ outcome: 'partial' });
    const files = await tx((t) => t.select().from(storeReportFiles).where(eq(storeReportFiles.period, '2026-07')));
    const byName = Object.fromEntries(files.map((f) => [f.sourceUri.split('/').at(-1), f]));
    expect(byName[`installs_${ALPHA}_202607_country.csv`]).toMatchObject({ status: 'rejected', error: { code: 'schema' } });
    expect(byName[`installs_${BETA}_202607_country.csv`]).toMatchObject({ status: 'partial', rowsRejected: 1, error: { rejectReasons: { package_mismatch: 1 } } });
    expect(await tx((t) => t.select().from(storeMetricObservations).where(eq(storeMetricObservations.value, 999)))).toHaveLength(0);
  });

  it('serializes syncs per account and resumes after a crashed worker', async () => {
    // The first sync is held inside its lease (at the bucket listing) while the second one runs, so the two
    // always overlap; with Promise.all alone a loaded machine could finish the first before the second started.
    let release!: () => void;
    play.hold = new Promise<void>((r) => {
      release = r;
    });
    const listings = () => server.find('GET', new RegExp(`^/storage/v1/b/${BUCKET}/o$`)).length;
    const before = listings();
    const first = sync(accountId);
    await vi.waitFor(() => expect(listings()).toBeGreaterThan(before), { timeout: 10_000 });
    const b = await sync(accountId);
    release();
    play.hold = null;
    const a = await first;
    expect([a.skipped, b.skipped]).toEqual([false, true]);
    await tx((t) =>
      t
        .update(storeAccounts)
        .set({ leaseOwner: 'worker:dead', leaseUntil: new Date(h.clock.now().getTime() - 1000) })
        .where(eq(storeAccounts.id, accountId)),
    );
    const [stale] = await tx((t) => t.insert(storeSyncRuns).values({ tenantId: h.tenantId, storeAccountId: accountId, mode: 'incremental', triggeredBy: 'test' }).returning());
    expect((await sync(accountId)).skipped).toBe(false);
    const [after] = await tx((t) => t.select().from(storeSyncRuns).where(eq(storeSyncRuns.id, stale!.id)));
    expect(after).toMatchObject({ status: 'failed' });
  });

  it('backs off and reports permission loss without inventing data', async () => {
    play.denyBucket = true;
    clearPlayTokenCache();
    const r = await sync(accountId);
    play.denyBucket = false;
    expect(r).toMatchObject({ outcome: 'failed', health: 'permission_denied' });
    const [a] = await tx((t) => t.select().from(storeAccounts).where(eq(storeAccounts.id, accountId)));
    expect(a!.consecutiveFailures).toBe(1);
    expect(a!.nextSyncAt!.getTime() - h.clock.now().getTime()).toBe(30 * 60_000);
    const cov = await tx((t) =>
      t
        .select()
        .from(storeReportCoverage)
        .where(and(eq(storeReportCoverage.period, '2026-10'), eq(storeReportCoverage.status, 'permission_denied'))),
    );
    expect(cov.length).toBeGreaterThan(0);
    await sync(accountId);
  });

  it('turns the same app in a second account into a conflict the owner resolves; history is not reassigned', async () => {
    const BUCKET2 = 'pubsite_prod_rev_99999999999999999999';
    const play2 = new FakePlay(server, BUCKET2).install();
    play2.put(`stats/installs/installs_${ALPHA}_202608_country.csv`, installsFile(ALPHA, '2026-08'), '2026-09-08T03:00:00Z');
    const acct2 = await connectStoreAccount(h.deps, h.tenantId, h.users.owner, { provider: 'google_play', displayName: 'Transferred apps', bucket: BUCKET2, serviceAccountKey: KEY.json, settings: { vitals: false } });
    await sync(acct2.id);
    const [dup] = await tx((t) =>
      t
        .select()
        .from(storeApps)
        .where(and(eq(storeApps.storeAccountId, acct2.id), eq(storeApps.appId, ALPHA))),
    );
    expect(dup).toMatchObject({ status: 'conflict', conflictDetail: { confirmedUnderAccountId: accountId } });
    expect(await tx((t) => t.select().from(storeReportFiles).where(eq(storeReportFiles.storeAccountId, acct2.id)))).toHaveLength(0);
    await expect(decideStoreApp(h.deps, h.tenantId, h.users.owner, dup!.id, { decision: 'confirm' })).rejects.toThrow(/take over/);
    const before = (await tx((t) => t.select({ n: sql<number>`count(*)::int` }).from(storeMetricObservations).where(eq(storeMetricObservations.storeAccountId, accountId))))[0]!.n;
    await decideStoreApp(h.deps, h.tenantId, h.users.owner, dup!.id, { decision: 'take_over' });
    const rows = await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, ALPHA)));
    expect(rows.find((r) => r.storeAccountId === accountId)!.status).toBe('ignored');
    expect(rows.find((r) => r.storeAccountId === acct2.id)!.status).toBe('confirmed');
    expect((await tx((t) => t.select({ n: sql<number>`count(*)::int` }).from(storeMetricObservations).where(eq(storeMetricObservations.storeAccountId, accountId))))[0]!.n).toBe(before);
    // Move it back for the remaining tests.
    await decideStoreApp(h.deps, h.tenantId, h.users.owner, rows.find((r) => r.storeAccountId === accountId)!.id, { decision: 'take_over' });
  });

  it('isolates reports between organizations', async () => {
    const alpha = (
      await tx((t) =>
        t
          .select()
          .from(storeApps)
          .where(and(eq(storeApps.appId, ALPHA), eq(storeApps.status, 'confirmed'))),
      )
    )[0]!;
    expect(await tx((t) => t.select().from(storeMetricObservations), other)).toHaveLength(0);
    expect(await tx((t) => t.select().from(storeAccounts), other)).toHaveLength(0);
    await expect(tx((t) => appIntelligenceDetail(t, alpha.id, { from: '2026-08-01', to: '2026-08-31' }, h.clock.now()), other)).rejects.toThrow(/not found/);
    // The other organization can connect the same bucket independently (its own key, its own rows).
    expect((await tx((t) => developerAccountsOverview(t), other)).accounts).toHaveLength(0);
  });
});

describe('App Store Connect Analytics Reports', () => {
  let accountId = '';
  it('connects with an existing team key and discovers apps', async () => {
    apple.apps = [
      { id: '1234567890', bundleId: 'com.example.alpha.ios', name: 'Alpha Lessons' },
      { id: '1234567891', bundleId: 'com.example.locked', name: 'Locked' },
    ];
    const acct = await connectStoreAccount(h.deps, h.tenantId, h.users.owner, { provider: 'app_store_connect', displayName: 'Apple team', issuerId: randomUUID(), keyId: 'ABCDE12345', privateKeyPem: ascKey() });
    accountId = acct.id;
    apple.requests.set('1234567890', [{ id: 'req-ongoing', accessType: 'ONGOING', stoppedDueToInactivity: false }]);
    apple.reports.set('req-ongoing', [
      { id: 'rep-dl', name: 'App Downloads Standard', category: 'COMMERCE' },
      { id: 'rep-dl-detailed', name: 'App Downloads Detailed', category: 'COMMERCE' },
    ]);
    apple.instances.set('rep-dl', [
      { id: 'inst-1', granularity: 'DAILY', processingDate: '2026-10-10' },
      { id: 'inst-2', granularity: 'DAILY', processingDate: '2026-10-11' },
    ]);
    const row = (date: string, type: string, territory: string, source: string, counts: number | string) => [date, 'Alpha Lessons', '1234567890', type, '2.0', 'iPhone', 'iOS 26.0', source, 'Product page', 'No', territory, counts];
    apple.segment('inst-1', 'seg-a', tsv([DOWNLOADS_HEADER, row('2026-10-08', 'First-time download', 'BD', 'App Store search', 3), row('2026-10-09', 'First-time download', 'BD', 'App Store search', 5)]));
    apple.segment('inst-1', 'seg-b', tsv([DOWNLOADS_HEADER, row('2026-10-09', 'Redownload', 'BD', 'Web referrer', 2), row('2026-10-09', 'Gift', 'BD', 'Web referrer', 1)]));
    // The newer instance restates 10-09 (Apple: newer instances overwrite older ones; never merge).
    apple.segment(
      'inst-2',
      'seg-a',
      tsv([DOWNLOADS_HEADER, row('2026-10-09', 'First-time download', 'BD', 'App Store search', 4), row('2026-10-09', 'First-time download', 'BD', 'App Store search', 3), row('2026-10-10', 'First-time download', 'IN', 'App Store browse', 6), row('2026-10-10', 'First-time download', 'IN', 'App referrer', '')]),
    );
    apple.denyRequests = false;
    const r = await sync(acct.id);
    expect(r).toMatchObject({ outcome: 'succeeded' });
    const apps = await tx((t) => t.select().from(storeApps).where(eq(storeApps.storeAccountId, acct.id)));
    expect(apps.map((a) => [a.appId, a.status, a.storeAppId])).toEqual(expect.arrayContaining([['com.example.alpha.ios', 'confirmed', '1234567890']]));
    expect(server.find('GET', /^\/segment-files\//).every((q) => !q.headers.authorization)).toBe(true);
  });

  it('uses the newest instance per day, keeps Apple definitions, and lists unmapped values', async () => {
    const ios = (await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, 'com.example.alpha.ios'))))[0]!;
    const d = await tx((t) => appIntelligenceDetail(t, ios.id, { from: '2026-10-08', to: '2026-10-10' }, h.clock.now()));
    const ftd = Object.fromEntries(d.series['asc.first_time_downloads']!.map((b) => [b.bucket, b.value]));
    expect(ftd).toEqual({ '2026-10-08': 3, '2026-10-09': 7, '2026-10-10': null });
    // 10-09's redownloads came from the older instance only; the newer one replaced that day without them.
    expect(d.series['asc.redownloads']).toBeUndefined();
    expect(d.definitions['asc.first_time_downloads']).toMatchObject({ population: 'Apple accounts', provider: 'app_store_connect' });
    const files = await tx((t) => t.select().from(storeReportFiles).where(eq(storeReportFiles.storeAppId, ios.id)));
    expect(files.find((f) => f.sourceUri.endsWith('inst-1'))).toMatchObject({ partitionsSkipped: 1, error: { skippedValues: ['Download Type: gift'] } });
  });

  it('reports a key that cannot read report requests as permission denied', async () => {
    apple.denyRequests = true;
    await sync(accountId);
    apple.denyRequests = false;
    const locked = (await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, 'com.example.locked'))))[0]!;
    const cov = await tx((t) => t.select().from(storeReportCoverage).where(eq(storeReportCoverage.storeAppId, locked.id)));
    expect(cov.length).toBeGreaterThan(0);
    expect(cov.every((c) => c.status === 'permission_denied')).toBe(true);
  });

  it('requests Apple reports once (admin + two-factor) and reuses an active request', async () => {
    const locked = (await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, 'com.example.locked'))))[0]!;
    await expect(requestAppleAnalytics(h.deps, h.tenantId, h.users.analyst, locked.id, {})).rejects.toThrow();
    await requestAppleAnalytics(h.deps, h.tenantId, h.users.owner, locked.id, {});
    await requestAppleAnalytics(h.deps, h.tenantId, h.users.owner, locked.id, {});
    expect(server.find('POST', '/v1/analyticsReportRequests')).toHaveLength(1);
    const [u] = await tx((t) => t.select().from(storeApps).where(eq(storeApps.id, locked.id)));
    expect(u!.settings).toMatchObject({ analytics: { ONGOING: { requestId: 'req-1234567891-ongoing' } } });
  });
});

describe('dashboard, campaigns, telemetry and the Growth Brain', () => {
  it('adds the same metric across apps of one platform only, and never across platforms', async () => {
    const o = await tx((t) => appIntelligenceOverview(t, { from: '2026-08-01', to: '2026-08-31' }, h.clock.now()));
    const alpha = o.apps.find((a) => a.appId === ALPHA)!;
    const beta = o.apps.find((a) => a.appId === BETA)!;
    expect(o.totals.android!['play.daily_user_installs']!.value).toBe(alpha.metrics['play.daily_user_installs']!.value! + beta.metrics['play.daily_user_installs']!.value!);
    // Beta has no traffic-source report: the Android acquisition total stays unknown, not partial.
    expect(o.totals.android!['play.store_listing_acquisitions']).toMatchObject({ value: null, apps: 2, appsComplete: 1 });
    expect(o.totals.ios).toBeDefined();
    expect(Object.keys(o.totals.ios!)).not.toContain('play.daily_user_installs');
    expect(alpha.metrics['play.daily_device_uninstalls']).toMatchObject({ complete: false, daysWithData: 30 });
  });

  it('a reported window ends on the latest day every app has reported; open totals name the apps missing days (D-047)', async () => {
    const q = { from: '2026-08-05', to: '2026-09-04', platform: 'android' };
    // Calendar days past the last published report leave every app incomplete: no total, and it says why.
    const calendar = await tx((t) => appIntelligenceOverview(t, q, h.clock.now()));
    expect(calendar.range).toMatchObject({ from: '2026-08-05', to: '2026-09-04', window: 'calendar', reportedThrough: '2026-08-31', unpublishedDaysExcluded: 0 });
    expect(calendar.totals.android!['play.daily_user_installs']).toMatchObject({ value: null, appsComplete: 0, incomplete: expect.arrayContaining([{ appId: BETA, name: expect.any(String), daysWithData: 27, expectedDays: 31 }]) });
    // The same 31 days ending on the common reported day are complete for both apps, so the total is stated.
    const reported = await tx((t) => appIntelligenceOverview(t, { ...q, window: 'reported' }, h.clock.now()));
    expect(reported.range).toMatchObject({ from: '2026-08-01', to: '2026-08-31', days: 31, window: 'reported', requested: { from: '2026-08-05', to: '2026-09-04' }, reportedThrough: '2026-08-31', unpublishedDaysExcluded: 4 });
    const alpha = reported.apps.find((a) => a.appId === ALPHA)!;
    const beta = reported.apps.find((a) => a.appId === BETA)!;
    expect(reported.totals.android!['play.daily_user_installs']).toMatchObject({ value: alpha.metrics['play.daily_user_installs']!.value! + beta.metrics['play.daily_user_installs']!.value!, appsComplete: 2, incomplete: [] });
    // Strictness is unchanged: Beta has no traffic-source report, so acquisitions stay open, never zero-filled.
    expect(reported.totals.android!['play.store_listing_acquisitions']).toMatchObject({ value: null, incomplete: [{ appId: BETA, name: expect.any(String), daysWithData: 0, expectedDays: 31 }] });
    expect(beta.metrics['play.store_listing_acquisitions']).toMatchObject({ value: null, daysWithData: 0 });
    // Freshness is the app's latest reported day whatever the period, and the import time is ISO.
    expect(alpha.freshness.latestDay! >= '2026-10-14').toBe(true);
    expect(beta.freshness.latestDay).toBe('2026-08-31');
    expect(alpha.freshness.lastImportAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(reported.notes[0]).toMatch(/never counted as zero/);
    // A window that already ends on or before the reported day is not moved.
    const past = await tx((t) => appIntelligenceOverview(t, { from: '2026-08-01', to: '2026-08-10', platform: 'android', window: 'reported' }, h.clock.now()));
    expect(past.range).toMatchObject({ from: '2026-08-01', to: '2026-08-10', unpublishedDaysExcluded: 0 });
  });

  it('maps reported UTM campaigns through the registry: post, program or unregistered', async () => {
    const LISTING = `https://play.google.com/store/apps/details?id=${ALPHA}`;
    const brand = await tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'alpha', name: 'Alpha', profile: { visual: { palette: { background: '#0F1E45', ink: '#FFFFFF', accent: '#FFC845', onAccent: '#0B3A2F' } }, audience: { countries: ['BD'], languages: ['bn'] }, objectives: ['installs'] } }));
    const [conn] = await tx((t) => t.insert(connections).values({ tenantId: h.tenantId, provider: 'meta', externalAccountId: 'page-alpha', displayName: 'Alpha Page', createdBy: 'test' }).returning());
    await tx((t) => bindChannel(t, h.tenantId, h.users.owner, brand.id, conn!.id));
    await tx((t) => bindApp(t, h.tenantId, h.users.owner, brand.id, { platform: 'android', listingUrl: LISTING }));
    const program = await tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: conn!.id, pack: 'eps-topik-bn', settings: { appCtaPerWeek: 2, linkPerWeek: 1, campaign: 'lessons' } }));
    expect(program.settings).toMatchObject({ campaignIdentity: 'per_post' });
    await tx((t) => assignProgram(t, h.tenantId, h.users.owner, brand.id, program.id));
    const item = async (day: string) =>
      tx(async (t) => {
        const [i] = await t.insert(contentPlanItems).values({ tenantId: h.tenantId, programId: program.id, day, kind: 'feature', packVersion: 'v1', objective: 'INSTALL_APP', segment: 'learners', template: 'feature', palette: 'navy', rationale: 'test' }).returning();
        const [p] = await t.insert(socialPosts).values({ tenantId: h.tenantId, connectionId: conn!.id, platform: 'facebook', caption: 'install', assetIds: [], claimIds: [], disclosure: {}, status: 'draft', scheduledAt: h.clock.now(), createdBy: 'test' }).returning();
        return { item: i!, post: p! };
      });
    const url = (campaign: string, content: string) => `${LISTING}&referrer=${encodeURIComponent(`utm_source=facebook&utm_medium=organic_social&utm_campaign=${campaign}&utm_content=${content}`)}`;
    const a = await item('2026-08-15');
    const reg = { programId: program.id, connectionId: conn!.id, channelPlatform: 'facebook', createdBy: 'test' };
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, { ...reg, planItemId: a.item.id, postId: a.post.id, url: url('lessons_260815_ab12', 'feature-20260815'), reportScope: 'campaign' }))).toMatchObject({ registered: true });
    // A second post may not reuse a campaign that identifies one post in the store report.
    const b = await item('2026-08-16');
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, { ...reg, planItemId: b.item.id, postId: b.post.id, url: url('lessons_260815_ab12', 'feature-20260816'), reportScope: 'campaign' }))).toMatchObject({ registered: false, reason: expect.stringMatching(/could not tell them apart/) });
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, { ...reg, planItemId: b.item.id, postId: b.post.id, url: url('lessons_260815_ab12', 'feature-20260816') }))).toMatchObject({ registered: false });
    // Legacy shared campaign: several posts, one campaign name.
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, { ...reg, planItemId: b.item.id, postId: b.post.id, url: url('lessons_daily', 'feature-20260816') }))).toMatchObject({ registered: true });
    await expect(tx((t) => t.insert(campaignLinks).values({ tenantId: h.tenantId, brandId: brand.id, channelPlatform: 'facebook', appPlatform: 'android', appId: ALPHA, campaign: 'lessons_260815_ab12', content: 'other', url: 'x', reportScope: 'campaign', createdBy: 'test' }))).rejects.toThrow();
    const alpha = (
      await tx((t) =>
        t
          .select()
          .from(storeApps)
          .where(and(eq(storeApps.appId, ALPHA), eq(storeApps.status, 'confirmed'))),
      )
    )[0]!;
    const d = await tx((t) => appIntelligenceDetail(t, alpha.id, { from: '2026-08-01', to: '2026-08-31' }, h.clock.now()));
    const rows = Object.fromEntries(d.campaigns!.rows.map((r) => [r.utmCampaign, r]));
    expect(rows.lessons_260815_ab12).toMatchObject({ acquisitions: 4, identity: { status: 'post', postId: a.post.id } });
    expect(rows.lessons_daily).toMatchObject({ acquisitions: 62, identity: { status: 'program', programId: program.id } });
    expect(d.campaigns!.basis).toBe('provider_reported_attribution');
    expect(rows.lessons_260815_ab12).toMatchObject({ visitors: 39, days: 31, excludedDays: 0, firstDay: '2026-08-01', lastDay: '2026-08-31' });
    // A provisional day is left out and counted, never added (the KPI rule of D-046 applies to campaigns too).
    const day15 = and(eq(storeReportPartitions.storeAppId, alpha.id), eq(storeReportPartitions.dimension, 'traffic_source'), eq(storeReportPartitions.observationDate, '2026-08-15'));
    await tx((t) => t.update(storeReportPartitions).set({ status: 'provisional' }).where(day15));
    const pending = Object.fromEntries((await tx((t) => appIntelligenceDetail(t, alpha.id, { from: '2026-08-01', to: '2026-08-31' }, h.clock.now()))).campaigns!.rows.map((r) => [r.utmCampaign, r]));
    expect(pending.lessons_260815_ab12).toMatchObject({ acquisitions: 0, visitors: 30, days: 30, excludedDays: 1 });
    await tx((t) => t.update(storeReportPartitions).set({ status: 'complete' }).where(day15));
    // Studio (P1-05): each post with its own campaign gets Google-reported results over a settled 14-day window.
    const c = await item('2026-08-10');
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, { ...reg, planItemId: c.item.id, postId: c.post.id, url: url('lessons_260810_ab12', 'feature-20260810'), reportScope: 'campaign' }))).toMatchObject({ registered: true });
    const e = await item('2026-08-25');
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, { ...reg, planItemId: e.item.id, postId: e.post.id, url: url('lessons_260825_ab12', 'feature-20260825'), reportScope: 'campaign' }))).toMatchObject({ registered: true });
    const att = await tx((t) =>
      postStoreAttribution(
        t,
        program.id,
        [a, b, c, e].map((x) => ({ id: x.item.id, day: x.item.day })),
      ),
    );
    expect(att.get(a.item.id)).toMatchObject({ basis: 'provider_reported_attribution', status: 'reported', campaign: 'lessons_260815_ab12', windowStart: '2026-08-15', windowEnd: '2026-08-28', reportedThrough: '2026-08-31', acquisitions: 4, visitors: 22, daysListed: 14 });
    // The shared campaign cannot be split per post, so that post gets nothing (program level only).
    expect(att.has(b.item.id)).toBe(false);
    // Reported window, but Google listed no row for the campaign: unknown, not zero.
    expect(att.get(c.item.id)).toMatchObject({ status: 'not_listed', acquisitions: null, visitors: null, daysListed: 0 });
    // The window ends after the newest final report day: nothing is shown yet.
    expect(att.get(e.item.id)).toMatchObject({ status: 'awaiting_reports', windowEnd: '2026-09-07', acquisitions: null });
    expect(d.breakdowns.sources.map((s) => s.value).sort()).toEqual(['Google Play search', 'Third-party referrals']);
  });

  it('shows optional app telemetry as a separate layer, never added to store counts', async () => {
    const alpha = (
      await tx((t) =>
        t
          .select()
          .from(storeApps)
          .where(and(eq(storeApps.appId, ALPHA), eq(storeApps.status, 'confirmed'))),
      )
    )[0]!;
    const before = await tx((t) => appIntelligenceDetail(t, alpha.id, { from: '2026-10-01', to: '2026-10-14' }, h.clock.now()));
    expect(before.telemetry.available).toBe(false);
    await recordInstall(h.deps, h.tenantId, 'key:backend', { appId: ALPHA, platform: 'android', installId: randomUUID(), installedAt: '2026-10-05T10:00:00Z', consent: { analytics: true } });
    const after = await tx((t) => appIntelligenceDetail(t, alpha.id, { from: '2026-10-01', to: '2026-10-14' }, h.clock.now()));
    expect(after.telemetry).toMatchObject({ available: true, installsByDay: [{ day: '2026-10-05', installs: 1 }] });
    expect(after.series['play.daily_user_installs']).toEqual(before.series['play.daily_user_installs']);
  });

  it('feeds evidence-backed KPI series to M08 and abstains on stale data', async () => {
    const written = await tx((t) => syncStoreKpiSeries(t, h.tenantId, h.clock.now()));
    const keys = written.map((w) => w.key);
    expect(keys).toEqual(expect.arrayContaining(['app.store.android.user_installs', `app.store.android.user_installs:${ALPHA}`, 'app.store.ios.first_time_downloads:com.example.alpha.ios']));
    // The second confirmed iOS app (com.example.locked) has no report: no all-apps iOS total is published.
    expect(keys).not.toContain('app.store.ios.first_time_downloads');
    const [series] = await tx((t) => t.select().from(metricSeries).where(eq(metricSeries.key, 'app.store.android.user_installs')));
    const pts = await tx((t) => t.select().from(metricPoints).where(eq(metricPoints.seriesId, series!.id)));
    expect(pts.length).toBeGreaterThan(30);
    expect(pts.every((p) => p.evidenceId)).toBe(true);
    const { signals } = await tx((t) => storeKpiSignals(t, h.clock.now()));
    const alpha = signals.filter((s) => s.appId === ALPHA);
    expect(alpha.length).toBeGreaterThan(0);
    // Latest final Play day is weeks old here: no trend is claimed.
    expect(alpha.every((s) => s.status === 'stale' || s.status === 'insufficient_data')).toBe(true);
    // Freshness follows the analysed metric: installs are final through 10-10 (10-11..10-14 are provisional),
    // listing acquisitions only through 08-31; the fresher vitals partitions (10-16) do not count for either.
    expect(alpha.find((s) => s.metricKey === 'play.daily_user_installs')).toMatchObject({ status: 'insufficient_data', latestFinalDay: '2026-10-10' });
    expect(alpha.find((s) => s.metricKey === 'play.store_listing_acquisitions')).toMatchObject({ status: 'stale', latestFinalDay: '2026-08-31' });
  });

  it('resolves an all-apps install goal to one platform series and says why', () => {
    const draft = interpretGoal('Grow organic installs for all my apps by 20% over the next 90 days with zero ad spend', {
      now: h.clock.now(),
      market: 'BD',
      series: [
        { key: 'app.store.android.user_installs', name: 'Google Play user installs (all apps)', unit: 'installs' },
        { key: 'app.store.ios.first_time_downloads', name: 'App Store first-time downloads, Analytics Reports (all apps)', unit: 'downloads' },
      ],
    });
    expect(draft.draft.kpi).toMatchObject({ metricKey: 'app.store.android.user_installs', targetChangePct: 20 });
    expect(draft.draft.adBudget.amountMicros).toBe(0);
    expect(draft.assumptions.join(' ')).toMatch(/not added together/);
  });
});

describe('final completion: KPI correctness, store context for the Growth Brain, connection maintenance', () => {
  const ALL = 'app.store.android.user_installs';
  const A = `app.store.android.user_installs:${ALPHA}`;
  const B = `app.store.android.user_installs:${BETA}`;
  const resync = (tenantId = h.tenantId) => tx((t) => syncStoreKpiSeries(t, tenantId, h.clock.now()), tenantId);
  const points = async (key: string, tenantId = h.tenantId) => {
    const [s] = await tx((t) => t.select().from(metricSeries).where(eq(metricSeries.key, key)), tenantId);
    if (!s) return new Map<string, { value: number; evidenceId: string | null }>();
    const pts = await tx((t) => t.select().from(metricPoints).where(eq(metricPoints.seriesId, s.id)), tenantId);
    return new Map(pts.map((p) => [p.ts.toISOString().slice(0, 10), { value: p.value, evidenceId: p.evidenceId }]));
  };
  const confirmedApp = async (appId: string) =>
    (
      await tx((t) =>
        t
          .select()
          .from(storeApps)
          .where(and(eq(storeApps.appId, appId), eq(storeApps.status, 'confirmed'))),
      )
    )[0]!;
  const playAccount = async () => (await tx((t) => t.select().from(storeAccounts).where(eq(storeAccounts.accountRef, BUCKET))))[0]!;
  const invalidations = async () => (await tx((t) => t.select().from(auditLog).where(eq(auditLog.action, 'analytics.series.points_invalidated')))).length;

  it('publishes an all-apps value only on days every confirmed app has a final value; Android and iOS stay apart', async () => {
    await resync();
    const [all, a, b] = [await points(ALL), await points(A), await points(B)];
    for (const d of ['2026-08-01', '2026-08-15', '2026-08-31']) expect(all.get(d)!.value).toBe(a.get(d)!.value + b.get(d)!.value);
    // October: only Alpha reported. Beta's missing days make the total unknown, never Alpha alone.
    expect(a.get('2026-10-05')).toBeDefined();
    expect(all.has('2026-10-05')).toBe(false);
    // July: Beta alone has one day: no total either.
    expect(b.has('2026-07-01')).toBe(true);
    expect(all.has('2026-07-01')).toBe(false);
    // Provisional days (fewer than 7 days old when the file was posted) are not KPI values.
    expect(a.has('2026-10-10')).toBe(true);
    expect(a.has('2026-10-11')).toBe(false);
    // iOS values live only in iOS series.
    expect([...(await points('app.store.ios.first_time_downloads:com.example.alpha.ios')).keys()]).toEqual(['2026-10-08', '2026-10-09']);
    expect((await points('app.store.ios.first_time_downloads')).size).toBe(0);
  });

  it("cites the admitted evidence of the winning report version of the metric's own family", async () => {
    const alpha = await confirmedApp(ALPHA);
    const files = await tx((t) => t.select({ id: storeReportFiles.id, family: storeReportFiles.family, evidenceId: storeReportFiles.evidenceId }).from(storeReportFiles).where(eq(storeReportFiles.storeAppId, alpha.id)));
    const familyOf = new Map(files.map((f) => [f.evidenceId, f.family]));
    const a = await points(A);
    // Alpha also has store-performance, crash and vitals reports for these days; none of them is cited for installs.
    expect([...a.values()].every((p) => familyOf.get(p.evidenceId) === 'play.installs')).toBe(true);
    const [part] = await tx((t) =>
      t
        .select()
        .from(storeReportPartitions)
        .where(and(eq(storeReportPartitions.storeAppId, alpha.id), eq(storeReportPartitions.family, 'play.installs'), eq(storeReportPartitions.dimension, 'country'), eq(storeReportPartitions.observationDate, '2026-08-15'))),
    );
    expect(a.get('2026-08-15')!.evidenceId).toBe(files.find((f) => f.id === part!.reportFileId)!.evidenceId);
  });

  it('is idempotent, serializes concurrent runs and isolates organizations', async () => {
    const before = await points(ALL);
    const audits = await invalidations();
    const runs = await Promise.all([resync(), resync()]);
    expect(runs.every((w) => w.every((x) => x.removed === 0))).toBe(true);
    expect(await points(ALL)).toEqual(before);
    expect(await invalidations()).toBe(audits);
    // Another organization has no confirmed apps: its run writes nothing and touches nothing here.
    expect(await resync(other)).toEqual([]);
    expect(await tx((t) => t.select().from(metricSeries), other)).toHaveLength(0);
    expect(await points(ALL)).toEqual(before);
  });

  it('updates a revised day in place (value and evidence) and ignores an older replay', async () => {
    const before = await points(A);
    const allBefore = await points(ALL);
    play.put(`stats/installs/installs_${ALPHA}_202608_country.csv`, installsFile(ALPHA, '2026-08', undefined, { override: { '2026-08-15|BD': 100, '2026-08-16|BD': 50 }, blankUninstallsOn: '2026-08-20', zeroUninstallsOn: '2026-08-21' }), '2026-09-12T03:00:00Z');
    expect(await sync((await playAccount()).id)).toMatchObject({ outcome: 'succeeded' });
    const written = await resync();
    const after = await points(A);
    const delta = 50 - userInstalls('2026-08-16', 'BD');
    expect(after.get('2026-08-16')!.value).toBe(before.get('2026-08-16')!.value + delta);
    expect(after.get('2026-08-16')!.evidenceId).not.toBe(before.get('2026-08-16')!.evidenceId);
    expect(after.get('2026-08-17')!.value).toBe(before.get('2026-08-17')!.value);
    expect((await points(ALL)).get('2026-08-16')!.value).toBe(allBefore.get('2026-08-16')!.value + delta);
    expect(written.find((w) => w.key === A)).toMatchObject({ removed: 0 });
    // An older version of the same file never overwrites the newer one, so the KPI does not move.
    const alpha = await confirmedApp(ALPHA);
    const fam = PLAY_FAMILIES.find((f) => f.family === 'play.installs')!;
    const old = parsePlayReport(Buffer.from(installsFile(ALPHA, '2026-08', undefined, { override: { '2026-08-16|BD': 1 } }).subarray(2)).toString('utf16le'), fam, fam.dimensions.find((d) => d.key === 'country')!, ALPHA);
    await tx((t) =>
      importParsedReport(
        t,
        { tenantId: h.tenantId, storeAccountId: alpha.storeAccountId, storeAppId: alpha.id, platform: 'android', appId: ALPHA, provider: 'google_play' },
        { uri: `gs://${BUCKET}/stats/installs/installs_${ALPHA}_202608_country.csv`, version: 'replay-1', rank: 2, period: '2026-08', updatedAt: new Date('2026-09-02T00:00:00Z'), checksum: null, sizeBytes: 1, sha256: 'y', encoding: 'utf-16le', objectKey: null },
        old,
        { now: h.clock.now(), completeAfterDays: 7, evidence: { uri: 'gs://test#replay', license: 'test', freshnessSlaHours: 24 } },
      ),
    );
    await resync();
    expect(await points(A)).toEqual(after);
  });

  it('removes points whose report evidence is no longer admitted, keeps raw reports, and restores them', async () => {
    const alpha = await confirmedApp(ALPHA);
    const [oct] = await tx((t) =>
      t
        .select()
        .from(storeReportFiles)
        .where(and(eq(storeReportFiles.storeAppId, alpha.id), eq(storeReportFiles.family, 'play.installs'), eq(storeReportFiles.period, '2026-10'))),
    );
    const observations = async () => (await tx((t) => t.select({ n: sql<number>`count(*)::int` }).from(storeMetricObservations).where(eq(storeMetricObservations.reportFileId, oct!.id))))[0]!.n;
    const obsBefore = await observations();
    const audits = await invalidations();
    await tx((t) => t.update(evidenceRecords).set({ status: 'rejected' }).where(eq(evidenceRecords.id, oct!.evidenceId!)));
    const written = await resync();
    const a = await points(A);
    expect([...a.keys()].filter((d) => d.startsWith('2026-10'))).toEqual([]);
    expect(a.has('2026-08-15')).toBe(true);
    expect(written.find((w) => w.key === A)).toMatchObject({ removed: 10 });
    expect(await invalidations()).toBe(audits + 1);
    expect(await observations()).toBe(obsBefore);
    await tx((t) => t.update(evidenceRecords).set({ status: 'admitted' }).where(eq(evidenceRecords.id, oct!.evidenceId!)));
    await resync();
    expect([...(await points(A)).keys()].filter((d) => d.startsWith('2026-10'))).toHaveLength(10);
  });

  it('makes all-apps days unknown when a confirmed app has no data, and clears an ignored app; both are reversible', async () => {
    const gamma = (await tx((t) => t.select().from(storeApps).where(eq(storeApps.appId, 'com.other.gamma'))))[0]!;
    await decideStoreApp(h.deps, h.tenantId, h.users.owner, gamma.id, { decision: 'confirm' });
    let w = await resync();
    expect((await points(ALL)).size).toBe(0);
    expect(w.find((x) => x.key === ALL)!.removed).toBeGreaterThanOrEqual(31);
    expect((await points(A)).size).toBeGreaterThan(30);
    await decideStoreApp(h.deps, h.tenantId, h.users.owner, gamma.id, { decision: 'ignore' });
    const beta = await confirmedApp(BETA);
    await decideStoreApp(h.deps, h.tenantId, h.users.owner, beta.id, { decision: 'ignore' });
    w = await resync();
    // Beta is no longer reported: its own series keeps no current points, and the total is Alpha's alone.
    expect((await points(B)).size).toBe(0);
    expect(w.find((x) => x.key === B)!.removed).toBeGreaterThan(30);
    expect((await points(ALL)).get('2026-08-15')!.value).toBe((await points(A)).get('2026-08-15')!.value);
    await decideStoreApp(h.deps, h.tenantId, h.users.owner, beta.id, { decision: 'confirm' });
    await resync();
    expect((await points(B)).size).toBeGreaterThan(30);
    expect((await points(ALL)).get('2026-08-15')!.value).toBe((await points(A)).get('2026-08-15')!.value + (await points(B)).get('2026-08-15')!.value);
  });

  it('keeps store series system-owned: the public series API cannot write them', async () => {
    const [s] = await tx((t) => t.select().from(metricSeries).where(eq(metricSeries.key, ALL)));
    await expect(tx((t) => assertUserWritableSeries(t, { key: ALL }))).rejects.toThrow(/official store reports/);
    await expect(tx((t) => assertUserWritableSeries(t, { seriesId: s!.id }))).rejects.toThrow(/official store reports/);
    await expect(tx((t) => assertUserWritableSeries(t, { key: 'kpi.signups' }))).resolves.toBeUndefined();
  });

  it('resolves a goal that names one app to that app only, and an all-apps goal to the complete platform series', async () => {
    const draft = (text: string) => tx((t) => interpretForTenant(t, h.deps, text, 'BD'));
    const one = await draft('Grow installs of Alpha Lessons by 20% in 60 days with no ads');
    expect(one.draft.kpi).toMatchObject({ metricKey: A, targetChangePct: 20 });
    expect(one.assumptions.join(' ')).toMatch(/Only Alpha Lessons \(com\.example\.alpha\) is measured.*second goal for the iOS app/);
    // The brand linked to the Android listing names the same app.
    expect((await draft('Grow Alpha installs by 10% in 30 days')).draft.kpi.metricKey).toBe(A);
    expect((await draft('Grow iPhone downloads of Alpha Lessons by 10% in 30 days')).draft.kpi.metricKey).toBe('app.store.ios.first_time_downloads:com.example.alpha.ios');
    const all = await draft('Grow organic installs for all my apps by 20% over the next 90 days');
    expect(all.draft.kpi.metricKey).toBe(ALL);
    const two = await draft(`Grow installs of ${ALPHA} and ${BETA} by 20% in 30 days`);
    expect(two.check).toContain('kpi');
    expect(two.assumptions.join(' ')).toMatch(/Several apps match/);
  });

  it('measures an app goal from final store values, and states no change when the baseline is incomplete', async () => {
    const goal = (startsAt: string, targetDate: string) => ({ id: randomUUID(), kpi: { metricKey: A, label: 'Alpha installs', unit: 'installs', direction: 'increase', target: null, targetChangePct: 20 }, startsAt: new Date(startsAt), targetDate: new Date(targetDate) }) as unknown as Parameters<typeof measureGoal>[1];
    const a = await points(A);
    const m = await tx((t) => measureGoal(t, goal('2026-08-16T00:00:00Z', '2026-08-31T00:00:00Z'), h.clock.now()));
    const expected = [...a.entries()].filter(([d]) => d >= '2026-08-16' && d < '2026-08-31').reduce((s, [, p]) => s + p.value, 0);
    expect(m).toMatchObject({ status: 'measured', daysObserved: 15, actual: expected });
    expect(m.baselinePerDay).not.toBeNull();
    expect(m.changeVsBaselinePct).not.toBeNull();
    // Starting 2026-10-05: the 20-day baseline has only 4 final days (10-01..10-04), so nothing is claimed against it.
    const partial = await tx((t) => measureGoal(t, goal('2026-10-05T00:00:00Z', '2026-10-25T00:00:00Z'), h.clock.now()));
    expect(partial).toMatchObject({ status: 'measured', daysObserved: 6, baselinePerDay: null, changeVsBaselinePct: null, target: null });
    expect(partial.note).toMatch(/baseline has 4 of the 16 daily values/);
    expect(partial.note).toMatch(/missing days are not counted as zero/);
  });

  it('gives the Growth Brain only supported store trends, and does not forecast a stale store series', async () => {
    const ctx = await tx((t) => storeTrendContext(t, ALL, h.clock.now()));
    expect(ctx).toMatchObject({ scope: 'all_apps', stated: [] });
    expect(ctx!.withheld.map((w) => [w.appId, w.status]).sort()).toEqual([
      [ALPHA, 'insufficient_data'],
      [BETA, 'stale'],
    ]);
    expect((await tx((t) => storeTrendContext(t, A, h.clock.now())))!.withheld.map((w) => w.appId)).toEqual([ALPHA]);
    const lines = storeTrendLines({ observe: { output: { storeTrend: ctx } } as never });
    // An organic Page goal gets only its brand's own app (P1-03): never another app of the developer account.
    const own = await tx((t) => appsTrendContext(t, [{ platform: 'android', appId: ALPHA }], h.clock.now()));
    expect(own).toMatchObject({ scope: 'brand_apps', apps: [ALPHA] });
    expect([...own!.stated, ...own!.withheld].every((x) => x.appId === ALPHA)).toBe(true);
    expect(new Set(own!.withheld.map((w) => w.metricKey))).toEqual(new Set(['play.daily_user_installs', 'play.store_listing_acquisitions']));
    const ownLines = storeTrendLines({ observe: { output: { storeTrend: own } } as never });
    expect(ownLines).toMatch(/for this brand's own app \(com\.example\.alpha; other apps of the developer account are excluded\)/);
    expect(ownLines).toMatch(/User installs of com\.example\.alpha \(insufficient data\)/);
    expect(ownLines).not.toMatch(/com\.example\.beta/);
    expect(ownLines).toMatch(/no post is credited with installs/);
    expect(await tx((t) => appsTrendContext(t, [], h.clock.now()))).toBeNull();
    expect(lines).toMatch(/No trend is stated for .*com\.example\.alpha \(insufficient data\)/);
    expect(lines).toMatch(/no post is credited with installs/);
    const step = (now: Date) => EXECUTORS.forecast({ deps: h.deps, tenantId: h.tenantId, goal: { id: randomUUID(), kpi: { metricKey: A, label: 'Alpha installs', unit: 'installs' }, targetDate: new Date(now.getTime() + 30 * 86_400_000) }, cycle: {}, task: { refs: {} }, prior: {}, aiCallsLeft: 0, now } as never);
    const stale = await step(new Date('2026-11-30T12:00:00Z'));
    expect(stale).toMatchObject({ kind: 'blocked', needs: 'data', detail: expect.stringMatching(/newest final .* is from 2026-10-10/) });
    expect((await step(h.clock.now())).kind).toBe('waiting');
  });

  it('classifies provider failures with actionable, sanitized messages', () => {
    const e = (status: number | null, body: unknown = null, phase: 'rejected' | 'ambiguous' | 'before_send' = 'rejected') => new ProviderHttpError(`provider responded ${status}`, { status, phase, body, retryAfterMs: status === 429 ? 30_000 : null });
    expect(classifyPlayError(e(401))).toMatchObject({ access: 'auth_failed', message: expect.stringMatching(/new JSON key/) });
    expect(classifyPlayError(e(403))).toMatchObject({ access: 'permission_denied', message: expect.stringMatching(/View app information/) });
    expect(classifyPlayError(e(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }], message: 'secret-ish free text' } }), 'reporting')).toMatchObject({
      access: 'permission_denied',
      reason: 'SERVICE_DISABLED',
      message: expect.stringMatching(/not enabled.*bulk reports are not affected/),
    });
    expect(classifyPlayError(e(404))).toMatchObject({ access: 'not_found', message: expect.stringMatching(/Copy|Cloud Storage URI/) });
    expect(classifyPlayError(e(429))).toMatchObject({ access: 'rate_limited', message: expect.stringMatching(/retry after 30 s/) });
    expect(classifyPlayError(e(503, null, 'ambiguous'))).toMatchObject({ access: 'error', status: 503, message: expect.stringMatching(/server error \(HTTP 503\)/) });
    expect(classifyPlayError(e(null, null, 'before_send'))).toMatchObject({ access: 'error', status: null, message: expect.stringMatching(/could not reach Google/) });
    const all = [401, 403, 404, 429, 500].map((s) => classifyPlayError(e(s, { error: { message: `-----BEGIN PRIVATE KEY----- ya29.token ${KEY.json.client_email}` } })).message).join(' ');
    expect(all).not.toMatch(/PRIVATE KEY|ya29|secret-ish/);
  });

  it('turns the Reporting API state into one specific warning, never a blocker', () => {
    const play = (healthDetail: Record<string, unknown>) => accountWarnings({ provider: 'google_play', healthDetail });
    expect(play({ reporting: 'ok' })).toEqual([]);
    expect(play({})).toEqual([]);
    expect(play({ reporting: 'permission_denied', appsInReportingApi: 0 })).toEqual([expect.objectContaining({ code: 'PLAY_REPORTING_API_PERMISSION_DENIED', blocking: false })]);
    expect(play({ reporting: 'permission_denied', reportingReason: 'SERVICE_DISABLED' })).toEqual([expect.objectContaining({ code: 'PLAY_REPORTING_API_DISABLED', action: expect.stringMatching(/enable the "Google Play Developer Reporting API"/) })]);
    expect(play({ reporting: 'rate_limited' })).toEqual([expect.objectContaining({ code: 'PLAY_REPORTING_API_UNAVAILABLE' })]);
    expect(play({ reportingError: 'access denied', reportingHttpStatus: 403 })).toEqual([expect.objectContaining({ code: 'PLAY_REPORTING_API_PERMISSION_DENIED' })]);
    expect(accountWarnings({ provider: 'app_store_connect', healthDetail: { reporting: 'permission_denied' } })).toEqual([]);
    const text = JSON.stringify(play({ reporting: 'permission_denied', reportingError: 'ya29.token' }));
    expect(text).not.toMatch(/ya29/);
  });

  it('connects when bulk reports work even if the optional Reporting API is unavailable, and names each failure', async () => {
    play.install(); // its routes answer again (a later fixture registered its own Reporting API route)
    play.denyReporting = true;
    clearPlayTokenCache();
    const acct = await connectStoreAccount(h.deps, other, h.users.owner, { provider: 'google_play', displayName: 'Reports only', bucket: BUCKET, serviceAccountKey: KEY.json, settings: { vitals: false } });
    play.denyReporting = false;
    expect(acct).toMatchObject({ health: 'ok', healthDetail: { reportingError: expect.stringMatching(/Reporting API/) } });
    // B-023: a specific, non-blocking warning with the fix; bulk reports are unaffected.
    expect(acct.warnings).toEqual([expect.objectContaining({ code: 'PLAY_REPORTING_API_PERMISSION_DENIED', severity: 'warning', blocking: false, action: expect.stringMatching(/Google Play Developer Reporting API.*View app information/) })]);
    expect(acct.warnings[0]!.detail).toMatch(/never estimated and never shown as zero/);
    const [conn] = await tx((t) => t.select().from(connections).where(eq(connections.id, acct.connectionId)), other);
    expect(conn).toMatchObject({ healthStatus: 'degraded', grantedScopes: ['https://www.googleapis.com/auth/devstorage.read_only'] });
    play.denyBucket = true;
    clearPlayTokenCache();
    const err = await connectStoreAccount(h.deps, other, h.users.owner, { provider: 'google_play', displayName: 'Denied', bucket: BUCKET, serviceAccountKey: KEY.json }).catch((x: unknown) => x);
    play.denyBucket = false;
    expect(err).toMatchObject({ code: 'PROVIDER_PERMISSION_DENIED', httpStatus: 422, details: { reports: 'permission_denied', httpStatus: 403 } });
    expect(JSON.stringify(err)).not.toContain('PRIVATE KEY');
  });

  it('replaces a Play key in place: tested first, same account and history, admin with two-factor only', async () => {
    const a = await playAccount();
    const count = async (q: typeof storeAccounts | typeof storeMetricObservations) => (await tx((t) => t.select({ n: sql<number>`count(*)::int` }).from(q)))[0]!.n;
    const [accounts, observations, kpi] = [await count(storeAccounts), await count(storeMetricObservations), await points(A)];
    const next = serviceAccountKey('fg-reports-2@fixture-project.iam.gserviceaccount.com');
    await expect(rotateStoreAccountKey(h.deps, h.tenantId, h.users.operator, a.id, { serviceAccountKey: next.json })).rejects.toThrow();
    await expect(rotateStoreAccountKey(h.deps, h.tenantId, { ...h.users.admin, mfaVerified: false }, a.id, { serviceAccountKey: next.json })).rejects.toThrow();
    await expect(rotateStoreAccountKey(h.deps, h.tenantId, h.users.admin, a.id, { serviceAccountKey: { ...next.json, type: 'authorized_user' } })).rejects.toThrow(/service account key/);
    // A key that cannot read the bucket is refused and nothing is stored.
    play.denyBucket = true;
    clearPlayTokenCache();
    await expect(rotateStoreAccountKey(h.deps, h.tenantId, h.users.admin, a.id, { serviceAccountKey: next.json })).rejects.toMatchObject({ code: 'PROVIDER_PERMISSION_DENIED' });
    play.denyBucket = false;
    const stored = async () => (await tx((t) => loadCredentials(t, h.deps.config, h.tenantId, a.connectionId)))!.creds as { clientEmail: string };
    expect((await stored()).clientEmail).toBe(KEY.json.client_email);
    const view = await rotateStoreAccountKey(h.deps, h.tenantId, h.users.admin, a.id, { serviceAccountKey: JSON.stringify(next.json) });
    expect(view).toMatchObject({ id: a.id, connectionId: a.connectionId, accountRef: BUCKET, health: 'ok', consecutiveFailures: 0 });
    expect(JSON.stringify(view)).not.toContain('PRIVATE KEY');
    expect((await stored()).clientEmail).toBe('fg-reports-2@fixture-project.iam.gserviceaccount.com');
    const [conn] = await tx((t) => t.select().from(connections).where(eq(connections.id, a.connectionId)));
    expect(conn!.metadata).toMatchObject({ bucket: BUCKET, serviceAccount: 'fg-reports-2@fixture-project.iam.gserviceaccount.com' });
    expect([await count(storeAccounts), await count(storeMetricObservations)]).toEqual([accounts, observations]);
    expect(await tx((t) => t.select().from(auditLog).where(eq(auditLog.action, 'store.account.key_rotated')))).toHaveLength(1);
    // The new key syncs; nothing is imported twice and the KPI history is unchanged.
    expect(await sync(a.id)).toMatchObject({ outcome: 'succeeded', stats: { filesImported: 0 } });
    await resync();
    expect(await points(A)).toEqual(kpi);
    // The generic credential route cannot store an untested Play key.
    await expect(rotateConnectionCredentials(h.deps, h.tenantId, h.users.admin, a.connectionId, { credentials: { clientEmail: 'x@y.iam.gserviceaccount.com', privateKeyPem: 'nope' } })).rejects.toThrow(/Replace key/);
  });
});
