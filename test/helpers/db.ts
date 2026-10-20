import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb, type DbHandle } from '../../packages/db/src/client.js';

export interface TestDatabase {
  url: string;
  name: string;
  handle: DbHandle;
  drop(): Promise<void>;
}

/** Create an isolated database cloned from the migrated template (real PostgreSQL 17). */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('pgAdminUrl');
  const template = inject('pgTemplateDb');
  const name = `fg_t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query(`create database ${name} template ${template}`);
      break;
    } catch (err) {
      if (attempt >= 20 || !String(err).includes('being accessed by other users')) throw err;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  await admin.end();
  const url = adminUrl.replace(/\/[^/]*$/, `/${name}`);
  const handle = createDb({ connectionString: url, max: 6, applicationName: 'futuregrow-test' });
  return {
    url,
    name,
    handle,
    async drop() {
      await handle.close();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
