import { runAllMigrations } from '../migrate.js';
import { dbTlsFromEnv } from '../tls.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const lockTimeoutMs = Number(process.env.FG_MIGRATION_LOCK_TIMEOUT_SECONDS ?? 600) * 1000;
const result = await runAllMigrations(url, {
  ...dbTlsFromEnv(),
  lockTimeoutMs,
  onLockWait: (ms) => console.log(JSON.stringify({ waitingForMigrationLock: true, waitedSeconds: Math.round(ms / 1000) })),
});
console.log(JSON.stringify({ ok: true, ...result }));
