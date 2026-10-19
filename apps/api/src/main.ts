import { governance } from '@futuregrow/core';
import { createRuntime, loadEnv } from '@futuregrow/runtime';
import { buildApp } from './app.js';

const env = loadEnv();
const runtime = await createRuntime(env, 'api');
await governance.syncCapabilityRegistry(runtime.deps.db);
await governance.seedModelRegistry(runtime.deps.db);
const { app } = await buildApp({ env, deps: runtime.deps });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await runtime.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.PORT, host: env.HOST });
