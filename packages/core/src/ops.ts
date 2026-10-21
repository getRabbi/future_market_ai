import { type Db, opsNotifications, withSystem } from '@futuregrow/db';
import { assertWebhookUrl, type Logger, type OpsAlert, webhookFormat, webhookPayload } from '@futuregrow/observability';
import { eq, sql } from 'drizzle-orm';

/**
 * Operations monitoring (free-tier): component status for /statusz and the external uptime
 * monitor, and operator alerts through one webhook (Slack, Discord or generic JSON) with durable
 * de-duplication in ops_notifications.
 */

/* ------------------------------------------------------------------ */
/* Notifiers                                                           */
/* ------------------------------------------------------------------ */

export interface Notifier {
  /** False when no webhook is configured: alerts then go to the log only. */
  readonly configured: boolean;
  /** Deliver one alert; throws when delivery failed. */
  send(alert: OpsAlert): Promise<void>;
}

function scrub(alert: OpsAlert, secrets: readonly string[]): OpsAlert {
  const clean = (s: string) => secrets.reduce((acc, sec) => (sec.length >= 8 ? acc.replaceAll(sec, '[REDACTED]') : acc), s);
  const fields = alert.fields ? Object.fromEntries(Object.entries(alert.fields).map(([k, v]) => [k, typeof v === 'string' ? clean(v) : v])) : undefined;
  return { ...alert, title: clean(alert.title), text: clean(alert.text), ...(fields ? { fields } : {}) };
}

export class WebhookNotifier implements Notifier {
  readonly configured = true;

  constructor(
    private readonly url: string,
    private readonly opts: { fetch?: typeof fetch; timeoutMs?: number; knownSecrets?: readonly string[]; logger?: Logger } = {},
  ) {
    assertWebhookUrl(url);
  }

  async send(alert: OpsAlert): Promise<void> {
    const body = JSON.stringify(webhookPayload(webhookFormat(this.url), scrub(alert, this.opts.knownSecrets ?? [])));
    const res = await (this.opts.fetch ?? fetch)(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000) });
    if (!res.ok) throw new Error(`alert webhook answered HTTP ${res.status}`);
    this.opts.logger?.info({ alert: { severity: alert.severity, title: alert.title, dedupKey: alert.dedupKey, status: alert.status ?? 'problem' } }, 'operator alert sent');
  }
}

/** No webhook configured: the structured log line is the alert. */
export class LogNotifier implements Notifier {
  readonly configured = false;
  constructor(private readonly logger: Logger) {}
  async send(alert: OpsAlert): Promise<void> {
    const line = { alert: { severity: alert.severity, title: alert.title, text: alert.text, dedupKey: alert.dedupKey, status: alert.status ?? 'problem', fields: alert.fields } };
    if (alert.severity === 'critical') this.logger.error(line, 'operator alert (no ALERT_WEBHOOK_URL configured)');
    else this.logger.warn(line, 'operator alert (no ALERT_WEBHOOK_URL configured)');
  }
}

/** In-memory throttle for hot paths (API 5xx, crashes) where a database write may itself fail. */
export class AlertThrottle {
  private readonly last = new Map<string, number>();
  private window: number[] = [];

  constructor(
    private readonly perKeyMs = 15 * 60_000,
    private readonly maxPerHour = 10,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    this.window = this.window.filter((x) => t - x < 3_600_000);
    const prev = this.last.get(key);
    if ((prev !== undefined && t - prev < this.perKeyMs) || this.window.length >= this.maxPerHour) return false;
    this.last.set(key, t);
    this.window.push(t);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Component status                                                    */
/* ------------------------------------------------------------------ */

export type ComponentState = 'ok' | 'stale' | 'failing' | 'unknown' | 'not_configured';
export const COMPONENTS = ['database', 'worker', 'backups', 'analytics_queue', 'media_queue'] as const;
export type Component = (typeof COMPONENTS)[number];

export interface ComponentStatus {
  state: ComponentState;
  detail?: string;
  ageSeconds?: number;
}

export interface PlatformStatus {
  ok: boolean;
  checkedAt: string;
  components: Record<Component, ComponentStatus>;
}

export interface StatusThresholds {
  /** Worker crons fire every minute; no execution for this long = stale. */
  workerStaleSeconds: number;
  /** FG_BACKUP_INTERVAL_HOURS plus grace. */
  backupMaxAgeHours: number;
  /** A finished backup must be verified within this window. */
  verificationGraceHours: number;
  /** The analytics/media cron jobs run every 10–15 minutes. */
  queueMaxWaitMinutes: number;
  runningMaxMinutes: number;
}

export const DEFAULT_THRESHOLDS: StatusThresholds = { workerStaleSeconds: 300, backupMaxAgeHours: 30, verificationGraceHours: 2, queueMaxWaitMinutes: 45, runningMaxMinutes: 120 };

const PROBLEM_STATES: ReadonlySet<ComponentState> = new Set(['stale', 'failing', 'unknown']);
const secondsBetween = (a: Date, b: Date) => Math.max(0, Math.round((a.getTime() - b.getTime()) / 1000));

async function queueStatus(db: Db, table: 'analytics_requests' | 'render_jobs', now: Date, t: StatusThresholds): Promise<ComponentStatus> {
  const r = await withSystem(db, 'system:status', (tx) =>
    tx.execute<{ oldest_queued: Date | null; oldest_running: Date | null; queued: number }>(
      sql`select min(requested_at) filter (where status = 'queued') as oldest_queued,
                 min(started_at) filter (where status in ('running', 'rendering')) as oldest_running,
                 count(*) filter (where status = 'queued')::int as queued
          from ${sql.identifier(table)} where status in ('queued', 'running', 'rendering')`,
    ),
  );
  const row = r.rows[0];
  const queued = row?.oldest_queued ? new Date(row.oldest_queued) : null;
  const running = row?.oldest_running ? new Date(row.oldest_running) : null;
  if (running && secondsBetween(now, running) > t.runningMaxMinutes * 60) return { state: 'stale', detail: 'a run has not finished', ageSeconds: secondsBetween(now, running) };
  if (queued && secondsBetween(now, queued) > t.queueMaxWaitMinutes * 60) return { state: 'stale', detail: `${row?.queued ?? 0} request(s) waiting; is the job running?`, ageSeconds: secondsBetween(now, queued) };
  return { state: 'ok', ...(queued ? { ageSeconds: secondsBetween(now, queued) } : {}) };
}

export async function platformStatus(db: Db, now = new Date(), t: StatusThresholds = DEFAULT_THRESHOLDS): Promise<PlatformStatus> {
  const components = {} as Record<Component, ComponentStatus>;
  try {
    await db.execute(sql`select 1`);
    components.database = { state: 'ok' };
  } catch (err) {
    for (const c of COMPONENTS) components[c] = { state: 'unknown' };
    components.database = { state: 'failing', detail: err instanceof Error ? err.message.slice(0, 200) : 'unreachable' };
    return { ok: false, checkedAt: now.toISOString(), components };
  }

  const settle = async (c: Component, fn: () => Promise<ComponentStatus>) => {
    try {
      components[c] = await fn();
    } catch (err) {
      components[c] = { state: 'unknown', detail: err instanceof Error ? err.message.slice(0, 200) : 'check failed' };
    }
  };

  await settle('worker', async () => {
    const r = await db.execute<{ last: Date | null }>(sql`select max(last_execution) as last from graphile_worker._private_known_crontabs`);
    const last = r.rows[0]?.last ? new Date(r.rows[0].last) : null;
    if (!last) return { state: 'unknown', detail: 'the worker has not run its schedule yet' };
    const age = secondsBetween(now, last);
    return age > t.workerStaleSeconds ? { state: 'stale', detail: 'no scheduled task has run recently', ageSeconds: age } : { state: 'ok', ageSeconds: age };
  });

  await settle('backups', async () => {
    const r = await withSystem(db, 'system:status', (tx) =>
      tx.execute<{ last_ok: Date | null; last_ok_key: string | null; last_failed: Date | null; verified: boolean | null }>(sql`
        with ok as (select finished_at, object_key from backup_runs where kind = 'backup' and status = 'succeeded' order by finished_at desc limit 1)
        select (select finished_at from ok) as last_ok, (select object_key from ok) as last_ok_key,
               (select max(finished_at) from backup_runs where kind in ('backup', 'verification') and status = 'failed') as last_failed,
               exists(select 1 from backup_runs v, ok where v.kind = 'verification' and v.status = 'succeeded' and v.object_key = ok.object_key) as verified`),
    );
    const row = r.rows[0];
    const lastOk = row?.last_ok ? new Date(row.last_ok) : null;
    const lastFailed = row?.last_failed ? new Date(row.last_failed) : null;
    if (!lastOk) return lastFailed ? { state: 'failing', detail: 'no successful backup yet; the last attempt failed' } : { state: 'not_configured' };
    const age = secondsBetween(now, lastOk);
    if (lastFailed && lastFailed > lastOk) return { state: 'failing', detail: 'the latest backup or verification failed', ageSeconds: age };
    if (age > t.backupMaxAgeHours * 3600) return { state: 'stale', detail: 'no recent successful backup', ageSeconds: age };
    if (!row?.verified && age > t.verificationGraceHours * 3600) return { state: 'failing', detail: 'the latest backup has not been verified', ageSeconds: age };
    return { state: 'ok', ageSeconds: age };
  });

  await settle('analytics_queue', () => queueStatus(db, 'analytics_requests', now, t));
  await settle('media_queue', () => queueStatus(db, 'render_jobs', now, t));
  return { ok: !Object.values(components).some((c) => PROBLEM_STATES.has(c.state)), checkedAt: now.toISOString(), components };
}

/* ------------------------------------------------------------------ */
/* Durable announcements                                               */
/* ------------------------------------------------------------------ */

const MAX_DELIVERY_ATTEMPTS = 5;

export type AnnounceMode = 'once' | { renotifyMs: number };

/**
 * Send an alert at most once per dedup key (or again after renotifyMs while unresolved).
 * Undelivered alerts are retried on later runs, up to 5 attempts.
 */
export async function announce(db: Db, notifier: Notifier, kind: string, alert: OpsAlert, mode: AnnounceMode, now = new Date()): Promise<'sent' | 'skipped' | 'failed'> {
  const due = await withSystem(db, 'system:ops-monitor', async (tx) => {
    const [row] = await tx.select().from(opsNotifications).where(eq(opsNotifications.dedupKey, alert.dedupKey)).for('update');
    const values = { kind, severity: alert.severity, title: alert.title, body: alert.text, payload: { fields: alert.fields ?? {}, source: alert.source } };
    if (!row) {
      await tx.insert(opsNotifications).values({ dedupKey: alert.dedupKey, ...values, firstSentAt: now, lastSentAt: now });
      return true;
    }
    if (row.resolvedAt) {
      await tx
        .update(opsNotifications)
        .set({ ...values, resolvedAt: null, firstSentAt: now, lastSentAt: now, delivered: false, attempts: 0, lastError: null })
        .where(eq(opsNotifications.dedupKey, alert.dedupKey));
      return true;
    }
    if (!row.delivered) return row.attempts < MAX_DELIVERY_ATTEMPTS;
    if (mode !== 'once' && now.getTime() - row.lastSentAt.getTime() >= mode.renotifyMs) {
      await tx.update(opsNotifications).set({ lastSentAt: now }).where(eq(opsNotifications.dedupKey, alert.dedupKey));
      return true;
    }
    return false;
  });
  if (!due) return 'skipped';
  return deliver(db, notifier, alert);
}

async function deliver(db: Db, notifier: Notifier, alert: OpsAlert): Promise<'sent' | 'failed'> {
  let error: string | null = null;
  try {
    await notifier.send(alert);
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 500) : String(err);
  }
  await withSystem(db, 'system:ops-monitor', (tx) =>
    tx
      .update(opsNotifications)
      .set({ delivered: error === null, attempts: sql`${opsNotifications.attempts} + 1`, lastError: error })
      .where(eq(opsNotifications.dedupKey, alert.dedupKey)),
  );
  return error === null ? 'sent' : 'failed';
}

/** Close an open problem and announce the recovery once. */
export async function resolve(db: Db, notifier: Notifier, alert: OpsAlert, now = new Date()): Promise<'sent' | 'skipped' | 'failed'> {
  const open = await withSystem(db, 'system:ops-monitor', async (tx) => {
    const [row] = await tx.select().from(opsNotifications).where(eq(opsNotifications.dedupKey, alert.dedupKey)).for('update');
    if (!row || row.resolvedAt) return null;
    await tx.update(opsNotifications).set({ resolvedAt: now }).where(eq(opsNotifications.dedupKey, alert.dedupKey));
    return row;
  });
  // Nothing was ever announced for an undelivered problem; stay quiet about its recovery.
  if (!open?.delivered) return 'skipped';
  try {
    await notifier.send({ ...alert, status: 'recovery' });
    return 'sent';
  } catch {
    return 'failed';
  }
}

/* ------------------------------------------------------------------ */
/* Monitor (worker cron)                                               */
/* ------------------------------------------------------------------ */

export interface OpsMonitorOptions {
  environment: string;
  now?: Date;
  thresholds?: StatusThresholds;
  /** Re-announce an unresolved component problem after this long (default 6 h). */
  renotifyMs?: number;
}

export interface OpsMonitorResult {
  status: PlatformStatus;
  sent: number;
  failed: number;
  skipped: number;
}

const LABEL: Record<Component, string> = { database: 'Database', worker: 'Background worker', backups: 'Backups', analytics_queue: 'Analytics job queue', media_queue: 'Media render queue' };

export async function runOpsMonitor(db: Db, notifier: Notifier, opts: OpsMonitorOptions): Promise<OpsMonitorResult> {
  const now = opts.now ?? new Date();
  const counts = { sent: 0, failed: 0, skipped: 0 };
  const tally = (r: 'sent' | 'failed' | 'skipped') => {
    counts[r] += 1;
  };
  const base = { source: 'worker:ops-monitor', environment: opts.environment, occurredAt: now.toISOString() };

  const status = await platformStatus(db, now, opts.thresholds);
  for (const c of COMPONENTS) {
    const s = status.components[c];
    const alert: OpsAlert = {
      ...base,
      severity: c === 'database' || s.state === 'failing' ? 'critical' : 'warning',
      status: 'problem',
      title: `${LABEL[c]}: ${s.state === 'ok' ? 'healthy' : s.state}`,
      text: s.detail ?? '',
      dedupKey: `component:${c}`,
      fields: { component: c, state: s.state, ageMinutes: s.ageSeconds === undefined ? null : Math.round(s.ageSeconds / 60) },
    };
    if (PROBLEM_STATES.has(s.state)) tally(await announce(db, notifier, 'component', alert, { renotifyMs: opts.renotifyMs ?? 6 * 3_600_000 }, now));
    else tally(await resolve(db, notifier, alert, now));
  }

  // Critical tenant alerts and severe incidents: announced once each.
  const critical = await withSystem(db, 'system:ops-monitor', (tx) =>
    tx.execute<{ id: string; tenant_id: string; kind: string; message: string; created_at: Date }>(
      sql`select id, tenant_id, kind, message, created_at from alerts
          where severity = 'critical' and acknowledged_at is null and created_at > ${new Date(now.getTime() - 86_400_000)}
          order by created_at limit 50`,
    ),
  );
  for (const a of critical.rows) {
    tally(await announce(db, notifier, 'alert', { ...base, severity: 'critical', title: `Critical alert: ${a.kind}`, text: a.message, dedupKey: `alert:${a.id}`, fields: { tenant: a.tenant_id, alertId: a.id } }, 'once', now));
  }
  const severe = await withSystem(db, 'system:ops-monitor', (tx) =>
    tx.execute<{ id: string; tenant_id: string; severity: string; title: string; description: string }>(sql`select id, tenant_id, severity, title, description from incidents where status = 'open' and severity in ('sev1', 'sev2') order by opened_at limit 50`),
  );
  for (const i of severe.rows) {
    tally(await announce(db, notifier, 'incident', { ...base, severity: 'critical', title: `Incident ${i.severity}: ${i.title}`, text: i.description, dedupKey: `incident:${i.id}`, fields: { tenant: i.tenant_id, incidentId: i.id } }, 'once', now));
  }

  // Background jobs that exhausted their retries (Graphile Worker): one summary per new batch.
  const failedJobs = await db.execute<{ id: string; task_identifier: string; attempts: number; last_error: string | null }>(
    sql`select j.id::text as id, j.task_identifier, j.attempts, j.last_error from graphile_worker.jobs j
        where j.attempts >= j.max_attempts and j.last_error is not null and j.updated_at > ${new Date(now.getTime() - 86_400_000)}
          and not exists (select 1 from ops_notifications n where n.dedup_key = 'job:' || j.id::text)
        order by j.updated_at limit 20`,
  );
  if (failedJobs.rows.length) {
    const jobs = failedJobs.rows;
    const summary: OpsAlert = {
      ...base,
      severity: 'warning',
      title: `${jobs.length} background job(s) failed permanently`,
      text: jobs.map((j) => `${j.task_identifier} #${j.id} after ${j.attempts} attempts: ${(j.last_error ?? '').split('\n')[0]!.slice(0, 160)}`).join('\n'),
      dedupKey: `jobs:${jobs.map((j) => j.id).join(',')}`,
      fields: { tasks: [...new Set(jobs.map((j) => j.task_identifier))].join(', ') },
    };
    const r = await announce(db, notifier, 'jobs', summary, 'once', now);
    tally(r);
    // Mark the jobs only once announced; an undelivered summary is rebuilt and retried next run.
    if (r === 'sent') {
      await withSystem(db, 'system:ops-monitor', async (tx) => {
        for (const j of jobs) {
          await tx
            .insert(opsNotifications)
            .values({ dedupKey: `job:${j.id}`, kind: 'job', severity: 'warning', title: `job ${j.task_identifier} failed`, body: (j.last_error ?? '').slice(0, 2000), delivered: true, attempts: 1, firstSentAt: now, lastSentAt: now })
            .onConflictDoNothing();
        }
      });
    }
  }
  return { status, ...counts };
}
