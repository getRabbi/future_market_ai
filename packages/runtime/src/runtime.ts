import { type WorkerUtils, makeWorkerUtils } from 'graphile-worker';
import { HttpClient } from '@futuregrow/connectors';
import { type CoreDeps, type JobQueue, buildCoreConfig, systemClock } from '@futuregrow/core';
import { configureTenantRole, createDb, probeDatabase } from '@futuregrow/db';
import { createLogger } from '@futuregrow/observability';
import { createObjectStore } from '@futuregrow/storage';
import type { Env } from './env.js';

export class GraphileJobQueue implements JobQueue {
  constructor(private readonly utils: WorkerUtils) {}
  async add(task: string, payload: Record<string, unknown>, opts: { runAt?: Date; jobKey?: string; maxAttempts?: number; queueName?: string } = {}) {
    await this.utils.addJob(task, payload, {
      ...(opts.runAt ? { runAt: opts.runAt } : {}),
      ...(opts.jobKey ? { jobKey: opts.jobKey } : {}),
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.queueName ? { queueName: opts.queueName } : {}),
    });
  }
}

export interface Runtime {
  deps: CoreDeps;
  pool: import('pg').Pool;
  close(): Promise<void>;
}

/**
 * Shared process runtime for api and worker. Refuses to run in production when PostgreSQL cannot
 * enforce tenant isolation through the fg_tenant role (D-008/B-004).
 */
export async function createRuntime(env: Env, service: string): Promise<Runtime> {
  const logger = createLogger(service, env.LOG_LEVEL);
  const handle = createDb({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    applicationName: `futuregrow-${service}`,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    onPoolError: (err) => logger.error({ err }, 'database pool error'),
  });
  const caps = await probeDatabase(handle.db);
  if (!caps.canSetTenantRole) {
    if (env.NODE_ENV === 'production') {
      await handle.close();
      throw new Error(`database user ${caps.currentUser} cannot SET ROLE fg_tenant; refusing to start without RLS isolation (B-004)`);
    }
    logger.warn({ caps }, 'fg_tenant role unavailable: RLS isolation disabled (development only)');
    configureTenantRole(false);
  }
  const utils = await makeWorkerUtils({ pgPool: handle.pool });
  const deps: CoreDeps = {
    db: handle.db,
    store: createObjectStore(env),
    jobs: new GraphileJobQueue(utils),
    http: new HttpClient(),
    logger,
    config: buildCoreConfig(env),
    clock: systemClock,
  };
  logger.info({ pg: caps.serverVersion, pgvector: caps.pgvectorInstalled || caps.pgvectorAvailable, storage: deps.store.kind }, 'runtime ready');
  return {
    deps,
    pool: handle.pool,
    async close() {
      await utils.release();
      await handle.close();
    },
  };
}
