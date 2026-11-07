/**
 * Safe end-to-end test of operator alert delivery: no outage, no production change, nothing stored.
 * Sends through the same code as the api/worker (WebhookNotifier: formatting, redaction, https-only)
 * and, with --uptime, the Cloudflare uptime monitor (runMonitor: problem, then recovery).
 *
 *   ALERT_WEBHOOK_URL=… npx tsx scripts/alert-test.ts            # one info test alert (backend path)
 *   ALERT_WEBHOOK_URL=… npx tsx scripts/alert-test.ts --uptime   # plus uptime problem + recovery
 *
 * The URL comes from the environment and is never printed. Every message is labelled as a test.
 * --uptime runs the four live probes (read-only GETs, as the Worker does every 5 minutes) with the
 * API address replaced by one that cannot answer, so only this local run sees the API as down.
 */
import { type KvLike, runMonitor } from '../infra/cloudflare/uptime-worker/src/monitor.js';
import { WebhookNotifier } from '../packages/core/src/ops.js';

const url = process.env.ALERT_WEBHOOK_URL;
if (!url) {
  console.error('ALERT_WEBHOOK_URL is not set: alert delivery is NOT_CONFIGURED');
  process.exit(2);
}
const hide = (s: string) => s.replaceAll(url, '[ALERT_WEBHOOK_URL]');
const environment = `ALERT TEST, not an incident (${process.env.ALERT_ENVIRONMENT ?? 'production futuregrow.scalemyprints.com'})`;

try {
  await new WebhookNotifier(url, { knownSecrets: [url] }).send({
    severity: 'info',
    title: 'Test alert (scripts/alert-test.ts)',
    text: 'Delivery check of the api/worker alert path. No action needed.',
    source: 'alert-test',
    environment,
    dedupKey: `alert-test:${Date.now()}`,
    fields: { sentAt: new Date().toISOString() },
  });
  console.log('backend notifier: delivered (1 message)');
} catch (err) {
  console.error(`backend notifier: NOT delivered: ${hide(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
}

if (process.argv.includes('--uptime')) {
  const mem = new Map<string, string>();
  const kv: KvLike = { get: async (k) => mem.get(k) ?? null, put: async (k, v) => void mem.set(k, v) };
  const base = { WEB_URL: process.env.WEB_URL ?? 'https://futuregrow.scalemyprints.com', ALERT_WEBHOOK_URL: url, ENVIRONMENT: environment, STATE: kv };
  const down = await runMonitor({ ...base, API_URL: 'https://127.0.0.1:9' }, { fetch, failureThreshold: 1, timeoutMs: 5_000 });
  const up = await runMonitor({ ...base, API_URL: process.env.API_URL ?? 'https://http--api--mjmcf2c5fbyt.code.run' }, { fetch, failureThreshold: 1 });
  console.log(`uptime monitor: ${down.delivered}/${down.alerts.length} problem and ${up.delivered}/${up.alerts.length} recovery messages delivered`);
  const still = up.results.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  if (still.length) console.log(`note: live checks not ok in the recovery run (real problem?): ${still.join('; ')}`);
  if (down.delivered !== down.alerts.length || up.delivered !== up.alerts.length) process.exit(1);
}
