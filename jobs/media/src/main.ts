import { createRuntime, loadEnv } from '@futuregrow/runtime';
import { RemotionRenderer, processNextRender } from './runner.js';

/** Northflank media job: drain queued renders within a time budget, then exit (D-016). */
const env = loadEnv();
const runtime = await createRuntime(env, 'media-job');
const budgetMs = Number(process.env.MEDIA_MAX_SECONDS ?? 1200) * 1000;
const started = Date.now();
const renderer = new RemotionRenderer();
const counts = { completed: 0, failed: 0, blocked: 0 };
try {
  while (Date.now() - started < budgetMs) {
    const r = await processNextRender(runtime.deps, renderer);
    if (r.kind === 'none') break;
    counts[r.kind] += 1;
    runtime.deps.logger.info(r, 'render processed');
  }
} finally {
  await runtime.close();
}
console.log(JSON.stringify({ ...counts, seconds: Math.round((Date.now() - started) / 1000) }));
