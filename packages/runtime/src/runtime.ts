import { type WorkerUtils, makeWorkerUtils } from 'graphile-worker';
import { AnthropicProvider, type ModelProvider, OpenAICompatibleEmbedder, OpenAICompatibleProvider } from '@futuregrow/agent-kernel';
import { HttpClient } from '@futuregrow/connectors';
import { type CoreDeps, type JobQueue, buildCoreConfig, createModelGateway, type knowledge, systemClock } from '@futuregrow/core';
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
  embedder?: knowledge.Embedder;
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
  // Model providers are configured only when credentials exist (B-003); models must also be
  // approved in the registry before the gateway will call them (D-002).
  const providers: Record<string, ModelProvider> = {};
  if (env.ANTHROPIC_API_KEY) providers.anthropic = new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY });
  if (env.OPENAI_COMPATIBLE_BASE_URL) providers.openai_compatible = new OpenAICompatibleProvider({ baseUrl: env.OPENAI_COMPATIBLE_BASE_URL, ...(env.OPENAI_COMPATIBLE_API_KEY ? { apiKey: env.OPENAI_COMPATIBLE_API_KEY } : {}) });
  if (Object.keys(providers).length) {
    const secrets = [env.ANTHROPIC_API_KEY, env.OPENAI_COMPATIBLE_API_KEY, env.BETTER_AUTH_SECRET, env.FG_SECRETS_KEY, env.R2_SECRET_ACCESS_KEY, env.META_APP_SECRET, env.SHOPIFY_WEBHOOK_SECRET].filter((x): x is string => Boolean(x));
    deps.models = createModelGateway(deps, providers, secrets);
  } else {
    logger.warn('no model provider configured: agent stages will abstain (B-003)');
  }
  const embedder = env.EMBEDDINGS_BASE_URL && env.EMBEDDINGS_MODEL
    ? new OpenAICompatibleEmbedder({ baseUrl: env.EMBEDDINGS_BASE_URL, model: env.EMBEDDINGS_MODEL, ...(env.EMBEDDINGS_API_KEY ? { apiKey: env.EMBEDDINGS_API_KEY } : {}) })
    : undefined;
  logger.info({ pg: caps.serverVersion, pgvector: caps.pgvectorInstalled || caps.pgvectorAvailable, storage: deps.store.kind, models: Object.keys(providers), embeddings: Boolean(embedder) }, 'runtime ready');
  return {
    deps,
    pool: handle.pool,
    ...(embedder ? { embedder } : {}),
    async close() {
      await utils.release();
      await handle.close();
    },
  };
}
