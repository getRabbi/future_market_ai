import { type MonitorEnv, runMonitor } from './monitor.js';

/** Cloudflare Worker entry: cron only (no public route; workers_dev is off in wrangler.toml). */
export default {
  async scheduled(_controller: unknown, env: MonitorEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(
      runMonitor(env, { fetch: (input, init) => fetch(input, init) }).then((r) => {
        console.log(JSON.stringify({ checks: r.results.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })), alerts: r.alerts.length, delivered: r.delivered }));
      }),
    );
  },
};
