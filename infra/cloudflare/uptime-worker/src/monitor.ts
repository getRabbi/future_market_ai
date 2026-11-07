import { type OpsAlert, webhookFormat, webhookPayload } from '../../../../packages/observability/src/webhook.js';

/**
 * External uptime monitor for FUTUREGROW (runs on Cloudflare's free Workers cron, outside
 * Northflank, so it notices when the API, the worker or the whole project is down).
 *
 * Every run probes the web app, the Pages→API proxy, the API liveness and the API component
 * status. A check is reported after `failureThreshold` consecutive failures (no flapping alerts),
 * re-reported every `renotifyMs` while it stays down (at once when it turns critical, e.g. the
 * database fails behind a degraded status), and its recovery is reported once; an undelivered
 * recovery is retried on later runs, up to MAX_RECOVERY_ATTEMPTS.
 * State lives in one KV key and is written only when something changes.
 */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface MonitorEnv {
  WEB_URL: string;
  API_URL: string;
  ENVIRONMENT?: string;
  ALERT_WEBHOOK_URL?: string;
  STATE: KvLike;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  critical: boolean;
}

export interface CheckState {
  failures: number;
  /** ISO time of the first failure in the current streak. */
  since: string | null;
  alertedAt: string | null;
  detail: string;
  /** Whether the last problem announcement was critical (a later critical failure escalates). */
  alertedCritical?: boolean;
  /** Undelivered recovery announcements so far (the recovery stays pending until delivered). */
  recoveryAttempts?: number;
}

export type MonitorState = Record<string, CheckState>;

export interface MonitorOptions {
  fetch: typeof fetch;
  now?: () => Date;
  failureThreshold?: number;
  renotifyMs?: number;
  timeoutMs?: number;
}

const STATE_KEY = 'uptime-state:v1';
const MAX_RECOVERY_ATTEMPTS = 5;
/** Component states behind /statusz that mean the database itself is not usable. */
const DB_DOWN = new Set(['failing', 'stale', 'unknown']);

async function probe(f: typeof fetch, url: string, timeoutMs: number, accept: (res: Response, body: string) => string | null): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now();
  try {
    const res = await f(url, { headers: { 'user-agent': 'futuregrow-uptime/1', accept: 'application/json, text/html' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    const problem = accept(res, body);
    return problem ? { ok: false, detail: `${problem} (HTTP ${res.status}, ${Date.now() - started} ms)` } : { ok: true, detail: `HTTP ${res.status} in ${Date.now() - started} ms` };
  } catch (err) {
    const e = err as Error;
    return { ok: false, detail: e.name === 'TimeoutError' ? `no response within ${timeoutMs} ms` : `request failed: ${e.message}` };
  }
}

export async function runChecks(env: Pick<MonitorEnv, 'WEB_URL' | 'API_URL'>, f: typeof fetch, timeoutMs = 10_000): Promise<CheckResult[]> {
  const web = env.WEB_URL.replace(/\/$/, '');
  const api = env.API_URL.replace(/\/$/, '');
  // A degraded status is a warning, unless the database itself is down: that is an outage
  // (/healthz is liveness only and stays 200 while the database is unreachable).
  let databaseDown = false;
  const checks = await Promise.all([
    probe(f, `${web}/login/`, timeoutMs, (r, b) => (r.status !== 200 ? 'unexpected status' : b.includes('FUTUREGROW') ? null : 'unexpected page content')).then((r) => ({ name: 'web', critical: true, ...r })),
    probe(f, `${web}/v1/openapi.json`, timeoutMs, (r, b) => (r.status !== 200 ? 'unexpected status' : /"openapi"\s*:/.test(b) ? null : 'not the API document')).then((r) => ({ name: 'pages-proxy', critical: true, ...r })),
    probe(f, `${api}/healthz`, timeoutMs, (r) => (r.status === 200 ? null : 'unexpected status')).then((r) => ({ name: 'api', critical: true, ...r })),
    probe(f, `${api}/statusz`, timeoutMs, (r, b) => {
      let s: { ok?: boolean; components?: Record<string, { state: string }> } = {};
      try {
        s = JSON.parse(b);
      } catch {
        return 'unreadable status document';
      }
      if (r.status === 200 && s.ok) return null;
      databaseDown = DB_DOWN.has(s.components?.database?.state ?? '');
      const bad = Object.entries(s.components ?? {})
        .filter(([, c]) => !['ok', 'not_configured'].includes(c.state))
        .map(([k, c]) => `${k}=${c.state}`);
      return `${databaseDown ? 'database unavailable; ' : ''}${bad.length ? `degraded: ${bad.join(', ')}` : 'status not ok'}`;
    }).then((r) => ({ name: 'components', critical: databaseDown, ...r })),
  ]);
  return checks;
}

export function evaluate(prev: MonitorState, results: CheckResult[], now: Date, threshold: number, renotifyMs: number, environment: string): { next: MonitorState; alerts: OpsAlert[]; changed: boolean } {
  const next: MonitorState = {};
  const alerts: OpsAlert[] = [];
  let changed = false;
  for (const r of results) {
    const p = prev[r.name] ?? { failures: 0, since: null, alertedAt: null, detail: '' };
    const base = { source: 'uptime-monitor', environment, dedupKey: `uptime:${r.name}`, occurredAt: now.toISOString() };
    if (r.ok) {
      if (p.alertedAt) alerts.push({ ...base, severity: r.critical ? 'critical' : 'warning', status: 'recovery', title: `${r.name} is back`, text: r.detail, fields: { downSince: p.since } });
      next[r.name] = { failures: 0, since: null, alertedAt: null, detail: r.detail };
      if (p.failures || p.alertedAt) changed = true;
      continue;
    }
    const s: CheckState = { failures: p.failures + 1, since: p.since ?? now.toISOString(), alertedAt: p.alertedAt, detail: r.detail, ...(p.alertedCritical === undefined ? {} : { alertedCritical: p.alertedCritical }) };
    // Announced as a warning and now critical (e.g. degraded, then the database fails): say so at once.
    const escalated = Boolean(p.alertedAt) && r.critical && p.alertedCritical === false;
    const due = s.failures >= threshold && (!p.alertedAt || escalated || now.getTime() - Date.parse(p.alertedAt) >= renotifyMs);
    if (due) {
      alerts.push({ ...base, severity: r.critical ? 'critical' : 'warning', status: 'problem', title: `${r.name} check failing`, text: r.detail, fields: { failingSince: s.since, consecutiveFailures: s.failures } });
      s.alertedAt = now.toISOString();
      s.alertedCritical = r.critical;
    }
    next[r.name] = s;
    changed = true;
  }
  return { next, alerts, changed };
}

export async function runMonitor(env: MonitorEnv, opts: MonitorOptions): Promise<{ results: CheckResult[]; alerts: OpsAlert[]; delivered: number }> {
  const now = opts.now?.() ?? new Date();
  const prev = JSON.parse((await env.STATE.get(STATE_KEY)) ?? '{}') as MonitorState;
  const results = await runChecks(env, opts.fetch, opts.timeoutMs);
  const { next, alerts, changed } = evaluate(prev, results, now, opts.failureThreshold ?? 2, opts.renotifyMs ?? 6 * 3_600_000, env.ENVIRONMENT ?? 'production');
  let delivered = 0;
  for (const a of alerts) {
    if (!env.ALERT_WEBHOOK_URL) {
      console.log(JSON.stringify({ alert: a }));
      continue;
    }
    try {
      const res = await opts.fetch(env.ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(webhookPayload(webhookFormat(env.ALERT_WEBHOOK_URL), a)), signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      delivered++;
    } catch (err) {
      // Not delivered: a problem is forgotten so the next run announces it again; a recovery stays
      // pending (the previous alert state is kept) so the next healthy run announces it again.
      const name = a.dedupKey.replace(/^uptime:/, '');
      const s = next[name];
      const p = prev[name];
      if (s && a.status === 'problem') s.alertedAt = null;
      if (s && p?.alertedAt && a.status === 'recovery') {
        const attempts = (p.recoveryAttempts ?? 0) + 1;
        if (attempts < MAX_RECOVERY_ATTEMPTS) Object.assign(s, { since: p.since, alertedAt: p.alertedAt, recoveryAttempts: attempts, ...(p.alertedCritical === undefined ? {} : { alertedCritical: p.alertedCritical }) });
      }
      console.log(JSON.stringify({ alertDeliveryFailed: a.dedupKey, error: (err as Error).message }));
    }
  }
  if (changed) await env.STATE.put(STATE_KEY, JSON.stringify(next));
  return { results, alerts, delivered };
}
