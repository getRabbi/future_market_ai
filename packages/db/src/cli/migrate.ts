import { runAllMigrations } from '../migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const result = await runAllMigrations(url);
console.log(JSON.stringify({ ok: true, ...result }));
