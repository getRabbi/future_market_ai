import { runAllMigrations } from '../migrate.js';
import { dbTlsFromEnv } from '../tls.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const result = await runAllMigrations(url, dbTlsFromEnv());
console.log(JSON.stringify({ ok: true, ...result }));
