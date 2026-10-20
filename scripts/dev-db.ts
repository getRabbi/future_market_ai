/**
 * Local development database: real PostgreSQL 17 (embedded binaries), persistent under
 * .data/pg-dev. Prints the DATABASE_URL and keeps running until interrupted.
 */
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { runAllMigrations } from '../packages/db/src/migrate.js';

const port = Number(process.env.FG_DEV_PG_PORT ?? 54320);
const dir = path.resolve('.data', 'pg-dev');
const password = process.env.FG_DEV_PG_PASSWORD ?? 'futuregrow-dev';
const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'));

const pgi = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
if (fresh) await pgi.initialise();
await pgi.start();

const admin = new pg.Client({ connectionString: `postgres://postgres:${password}@localhost:${port}/postgres` });
await admin.connect();
const exists = await admin.query("select 1 from pg_database where datname = 'futuregrow'");
if (!exists.rowCount) await admin.query("create database futuregrow encoding 'UTF8' template template0");
await admin.end();

const url = `postgres://postgres:${password}@localhost:${port}/futuregrow`;
const result = await runAllMigrations(url);
console.log(JSON.stringify({ DATABASE_URL: url, migrated: result }));

const stop = async () => {
  await pgi.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
setInterval(() => {}, 1 << 30);
