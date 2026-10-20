import { createRuntime, loadEnv } from '@futuregrow/runtime';
import { run } from 'graphile-worker';
import { CHANNEL_CRONTAB } from './register-channels.js';
import { MODULE_CRONTAB } from './register-modules.js';
import { buildTaskList, CRONTAB } from './tasks.js';

const env = loadEnv();
const runtime = await createRuntime(env, 'worker');
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

const runner = await run({
  pgPool: runtime.pool,
  concurrency,
  taskList: buildTaskList(runtime.deps),
  crontab: process.env.WORKER_CRONTAB ?? [CRONTAB, ...MODULE_CRONTAB, ...CHANNEL_CRONTAB].join('\n'),
  noHandleSignals: false,
  pollInterval: 2000,
});
runtime.deps.logger.info({ concurrency }, 'worker started');

await runner.promise;
await runtime.close();
