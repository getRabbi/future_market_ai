import { type ApiVersions, type DeprecationSignal, detectDeprecationSignals, LIFECYCLE_KEY, LIFECYCLE_PROVIDERS, type LifecycleProvider, lifecycleRule, type ProviderEndpoints } from '@futuregrow/connectors';
import { apiDeprecationSignals, authUser, type Db, type DbOrTx, modelRegistry, withSystem } from '@futuregrow/db';
import { forbidden, invalid, type Logger, type OpsAlert } from '@futuregrow/observability';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { announce, type Notifier } from './ops.js';

/**
 * Provider API and model lifecycle (FG-P2-001): effective sunset per configured API version,
 * operator alerts at 90/30/7 days, the policy fact that blocks a version past its sunset, and
 * recording of deprecation signals observed on live provider responses.
 */

export async function recordDeprecationSignals(db: Db, signals: DeprecationSignal[], now = new Date()): Promise<void> {
  if (!signals.length) return;
  await withSystem(db, 'system:deprecation-monitor', async (tx) => {
    for (const s of signals) {
      await tx
        .insert(apiDeprecationSignals)
        .values({ provider: s.provider, apiVersion: s.apiVersion, signal: s.signal, endpoint: s.endpoint, sunsetAt: s.sunsetAt ? new Date(s.sunsetAt) : null, detail: s.detail, firstSeenAt: now, lastSeenAt: now })
        .onConflictDoUpdate({
          target: [apiDeprecationSignals.provider, apiDeprecationSignals.apiVersion, apiDeprecationSignals.signal, apiDeprecationSignals.endpoint],
          set: { occurrences: sql`${apiDeprecationSignals.occurrences} + 1`, lastSeenAt: now, detail: s.detail, sunsetAt: sql`coalesce(excluded.sunset_at, ${apiDeprecationSignals.sunsetAt})` },
        });
    }
  });
}

/**
 * Observes every connector response (HttpClient onResponse). Each distinct signal is written at
 * most once per 10 minutes per process; writes are asynchronous and never affect the request.
 */
export class DeprecationRecorder {
  private readonly lastWrite = new Map<string, number>();
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly endpoints: ProviderEndpoints,
    private readonly versions: ApiVersions,
    private readonly logger?: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  observe(info: { url: string; headers: Headers }): void {
    const signals = detectDeprecationSignals(info, this.endpoints, this.versions).filter((s) => {
      const key = `${s.provider}|${s.apiVersion}|${s.signal}|${s.endpoint}`;
      const t = this.now();
      if (t - (this.lastWrite.get(key) ?? 0) < 10 * 60_000) return false;
      this.lastWrite.set(key, t);
      return true;
    });
    if (!signals.length) return;
    this.logger?.warn({ signals: signals.map((s) => ({ provider: s.provider, version: s.apiVersion, signal: s.signal, endpoint: s.endpoint })) }, 'provider API deprecation signal');
    this.pending = this.pending.then(() => recordDeprecationSignals(this.db, signals).catch((err: unknown) => this.logger?.error({ err }, 'could not record deprecation signal')));
  }

  /** Resolves when queued writes are done (tests, shutdown). */
  flush(): Promise<void> {
    return this.pending;
  }
}

/** Operator-recorded sunset date from the provider's published schedule (platform admin + MFA). */
export async function recordApiSunset(db: Db, actor: { userId: string }, input: { provider: LifecycleProvider; apiVersion: string; sunsetAt: string; sourceUrl: string }): Promise<void> {
  if (!LIFECYCLE_PROVIDERS.includes(input.provider)) throw invalid(`unknown provider ${input.provider}`);
  await withSystem(db, `user:${actor.userId}`, async (tx) => {
    const [u] = await tx.select().from(authUser).where(eq(authUser.id, actor.userId));
    if (!u?.isPlatformAdmin) throw forbidden('recording API lifecycle dates requires a platform administrator');
    if (!u.twoFactorEnabled) throw forbidden('recording API lifecycle dates requires an MFA-enabled account');
    await tx
      .insert(apiDeprecationSignals)
      .values({ provider: input.provider, apiVersion: input.apiVersion, signal: 'registry_eol', endpoint: '*', sunsetAt: new Date(input.sunsetAt), detail: `recorded by ${actor.userId} from ${input.sourceUrl}` })
      .onConflictDoUpdate({
        target: [apiDeprecationSignals.provider, apiDeprecationSignals.apiVersion, apiDeprecationSignals.signal, apiDeprecationSignals.endpoint],
        set: { sunsetAt: new Date(input.sunsetAt), detail: `recorded by ${actor.userId} from ${input.sourceUrl}`, lastSeenAt: new Date(), occurrences: sql`${apiDeprecationSignals.occurrences} + 1` },
      });
  });
}

export type LifecycleStatus = 'ok' | 'warning' | 'critical' | 'sunset' | 'unverified';

export interface ApiLifecycleRow {
  provider: LifecycleProvider;
  apiVersion: string;
  kind: 'dated' | 'evergreen';
  sunsetAt: string | null;
  sunsetSource: 'operator' | 'provider_header' | 'provider_policy' | 'version_upgraded' | null;
  daysLeft: number | null;
  status: LifecycleStatus;
  basis: string;
  sourceUrl: string;
  signals: { id: string; signal: string; endpoint: string; detail: string | null; sunsetAt: string | null; occurrences: number; firstSeenAt: string; lastSeenAt: string }[];
}

export interface ModelLifecycleRow {
  provider: string;
  modelId: string;
  eolAt: string;
  daysLeft: number;
  status: LifecycleStatus;
}

const DAY = 86_400_000;

function statusFor(daysLeft: number | null): LifecycleStatus {
  if (daysLeft === null) return 'ok';
  if (daysLeft <= 0) return 'sunset';
  if (daysLeft <= 30) return 'critical';
  if (daysLeft <= 90) return 'warning';
  return 'ok';
}

export async function apiLifecycle(db: DbOrTx, versions: ApiVersions, now = new Date()): Promise<{ apis: ApiLifecycleRow[]; models: ModelLifecycleRow[] }> {
  const rows = await db.select().from(apiDeprecationSignals).orderBy(desc(apiDeprecationSignals.lastSeenAt));
  const apis = LIFECYCLE_PROVIDERS.map((provider): ApiLifecycleRow => {
    const apiVersion = versions[provider];
    const rule = lifecycleRule(provider, apiVersion);
    const mine = rows.filter((r) => r.provider === provider && r.apiVersion === apiVersion);
    const operator = mine.find((r) => r.signal === 'registry_eol' && r.sunsetAt);
    const upgraded = mine.find((r) => r.signal === 'version_upgraded');
    const header = mine
      .filter((r) => (r.signal === 'sunset_header' || r.signal === 'deprecation_header') && r.sunsetAt)
      .map((r) => r.sunsetAt!)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    let sunsetAt: Date | null = null;
    let sunsetSource: ApiLifecycleRow['sunsetSource'] = null;
    if (upgraded) [sunsetAt, sunsetSource] = [upgraded.firstSeenAt, 'version_upgraded'];
    else if (operator) [sunsetAt, sunsetSource] = [operator.sunsetAt, 'operator'];
    else if (header && (!rule.sunsetAt || header.getTime() < Date.parse(rule.sunsetAt))) [sunsetAt, sunsetSource] = [header, 'provider_header'];
    else if (rule.sunsetAt) [sunsetAt, sunsetSource] = [new Date(rule.sunsetAt), 'provider_policy'];
    const daysLeft = sunsetAt ? Math.floor((sunsetAt.getTime() - now.getTime()) / DAY) : null;
    let status = statusFor(daysLeft);
    if (status === 'ok' && mine.some((r) => r.signal === 'deprecation_header' || r.signal === 'provider_warning')) status = 'warning';
    if (status === 'ok' && rule.kind === 'dated' && !sunsetAt) status = 'unverified';
    return {
      provider,
      apiVersion,
      kind: rule.kind,
      sunsetAt: sunsetAt?.toISOString() ?? null,
      sunsetSource,
      daysLeft,
      status,
      basis: sunsetSource === 'operator' ? (operator?.detail ?? rule.basis) : rule.basis,
      sourceUrl: rule.sourceUrl,
      signals: mine.filter((r) => r.signal !== 'registry_eol').map((r) => ({ id: r.id, signal: r.signal, endpoint: r.endpoint, detail: r.detail, sunsetAt: r.sunsetAt?.toISOString() ?? null, occurrences: r.occurrences, firstSeenAt: r.firstSeenAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString() })),
    };
  });
  const modelRows = await db
    .select({ provider: modelRegistry.provider, modelId: modelRegistry.modelId, eolAt: modelRegistry.eolAt })
    .from(modelRegistry)
    .where(and(eq(modelRegistry.approvedForProduction, true), isNotNull(modelRegistry.eolAt)));
  const models = modelRows.map((m) => {
    const daysLeft = Math.floor((m.eolAt!.getTime() - now.getTime()) / DAY);
    return { provider: m.provider, modelId: m.modelId, eolAt: m.eolAt!.toISOString(), daysLeft, status: statusFor(daysLeft) };
  });
  return { apis, models };
}

/** Policy fact: the effective sunset of the configured version for an action's provider. */
export async function effectiveSunset(tx: DbOrTx, provider: string, versions: ApiVersions, now = new Date()): Promise<{ at: string; basis: string } | null> {
  const key = LIFECYCLE_KEY[provider];
  if (!key) return null;
  const row = (await apiLifecycle(tx, versions, now)).apis.find((a) => a.provider === key);
  if (!row?.sunsetAt) return null;
  const why = { operator: 'date recorded by an operator', provider_header: 'Sunset header from the provider', provider_policy: 'provider support policy', version_upgraded: 'the provider no longer serves this version' } as const;
  return { at: row.sunsetAt, basis: why[row.sunsetSource!] };
}

const LABEL: Record<LifecycleProvider, string> = { meta: 'Meta Graph API', googleAds: 'Google Ads API', shopify: 'Shopify Admin API', tiktok: 'TikTok API', youtube: 'YouTube Data API', appStoreConnect: 'App Store Connect API' };

/** Worker cron: announce lifecycle milestones and newly observed deprecation signals once each. */
export async function checkApiLifecycle(db: Db, notifier: Notifier, versions: ApiVersions, environment: string, now = new Date()): Promise<{ sent: number; failed: number; skipped: number }> {
  const counts = { sent: 0, failed: 0, skipped: 0 };
  const send = async (alert: OpsAlert) => {
    counts[await announce(db, notifier, 'lifecycle', alert, 'once', now)] += 1;
  };
  const base = { source: 'worker:api-lifecycle', environment, occurredAt: now.toISOString() };
  const { apis, models } = await withSystem(db, 'system:api-lifecycle', (tx) => apiLifecycle(tx, versions, now));
  for (const a of apis) {
    const fields = { provider: a.provider, version: a.apiVersion, sunset: a.sunsetAt?.slice(0, 10) ?? null, daysLeft: a.daysLeft, source: a.sourceUrl };
    if (a.status === 'unverified') {
      await send({ ...base, severity: 'info', title: `${LABEL[a.provider]} ${a.apiVersion}: record its sunset date`, text: `${a.basis} Record it with PUT /v1/platform/api-lifecycle.`, dedupKey: `lifecycle:${a.provider}:${a.apiVersion}:unverified`, fields });
    } else if (a.status !== 'ok') {
      // Milestones: 90 days, 30 days, 7 days, past. Each is announced once.
      const milestone = a.status === 'sunset' ? 'past' : a.daysLeft !== null && a.daysLeft <= 7 ? '7d' : a.status === 'critical' ? '30d' : '90d';
      const title = a.status === 'sunset' ? `${LABEL[a.provider]} ${a.apiVersion} is past its sunset: actions are blocked` : `${LABEL[a.provider]} ${a.apiVersion} sunsets in ${a.daysLeft ?? '?'} days`;
      await send({ ...base, severity: a.status === 'warning' ? 'warning' : 'critical', title, text: `Upgrade the connector and set the new version (capability registry + env). ${a.basis}`, dedupKey: `lifecycle:${a.provider}:${a.apiVersion}:${milestone}`, fields });
    }
    for (const s of a.signals) {
      await send({
        ...base,
        severity: s.signal === 'version_upgraded' ? 'critical' : 'warning',
        title: `${LABEL[a.provider]} deprecation signal: ${s.signal.replace('_', ' ')}`,
        text: s.detail ?? '',
        dedupKey: `deprecation-signal:${s.id}`,
        fields: { provider: a.provider, version: a.apiVersion, endpoint: s.endpoint, sunset: s.sunsetAt?.slice(0, 10) ?? null },
      });
    }
  }
  for (const m of models) {
    if (m.status === 'ok') continue;
    const milestone = m.status === 'sunset' ? 'past' : m.daysLeft <= 7 ? '7d' : m.status === 'critical' ? '30d' : '90d';
    await send({
      ...base,
      severity: m.status === 'warning' ? 'warning' : 'critical',
      title: m.status === 'sunset' ? `Model ${m.modelId} is past end of life: no longer called` : `Model ${m.modelId} reaches end of life in ${m.daysLeft} days`,
      text: 'Approve a successor in the model registry before the date; past it the gateway fails over or abstains.',
      dedupKey: `model-eol:${m.provider}:${m.modelId}:${milestone}`,
      fields: { provider: m.provider, eol: m.eolAt.slice(0, 10) },
    });
  }
  return counts;
}
