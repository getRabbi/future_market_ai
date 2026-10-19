import { run } from 'graphile-worker';
import { createRuntime, loadEnv } from '@futuregrow/runtime';
import { CRONTAB, buildTaskList } from './tasks.js';
import './register-modules.js';

const env = loadEnv();
const runtime = await createRuntime(env, 'worker');
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

const runner = await run({
  pgPool: runtime.pool,
  concurrency,
  taskList: buildTaskList(runtime.deps),
  crontab: process.env.WORKER_CRONTAB ?? CRONTAB,
  noHandleSignals: false,
  pollInterval: 2000,
});
runtime.deps.logger.info({ concurrency }, 'worker started');

await runner.promise;
await runtime.close();
