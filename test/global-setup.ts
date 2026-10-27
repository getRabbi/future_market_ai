import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runAllMigrations } from '../packages/db/src/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplateDb: string;
  }
}

const PORT = Number(process.env.FG_TEST_PG_PORT ?? 54331);
const PASSWORD = 'fg-test-only';
let instance: EmbeddedPostgres | undefined;

export default async function setup(project: TestProject) {
  const externalUrl = process.env.FG_TEST_DATABASE_ADMIN_URL;
  let adminUrl: string;
  if (externalUrl) {
    adminUrl = externalUrl;
  } else {
    const dir = path.resolve('.data', `pg-test-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    instance = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: PASSWORD,
      port: PORT,
      persistent: true,
      // Production Postgres is UTF-8; Windows initdb would otherwise default to WIN1252.
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      // Throwaway cluster: without fsync, the checkpoint each DROP DATABASE waits for no longer
      // queues behind Windows data-file syncs (measured 87-107 s per drop under parallel load,
      // past the 120 s hook timeout at times). Durability is irrelevant here; production is unaffected.
      postgresFlags: ['-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off'],
      onLog: () => {},
      onError: () => {},
    });
    await instance.initialise();
    await instance.start();
    adminUrl = `postgres://postgres:${PASSWORD}@localhost:${PORT}/postgres`;
  }

  const template = 'fg_template';
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${template}`);
  await admin.query(`create database ${template} encoding 'UTF8' template template0`);
  await admin.end();
  await runAllMigrations(adminUrl.replace(/\/[^/]*$/, `/${template}`));

  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgTemplateDb', template);

  return async () => {
    if (instance) {
      await instance.stop();
      // Windows may hold file handles briefly after postmaster exit; best-effort cleanup.
      for (let i = 0; i < 10; i++) {
        try {
          fs.rmSync(path.resolve('.data', `pg-test-${process.pid}`), { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  };
}
