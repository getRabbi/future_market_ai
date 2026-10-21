import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ACTION_TRANSITIONS } from '@futuregrow/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MIGRATION_LOCK, MIGRATIONS_FOLDER, MigrationLockTimeoutError, runAllMigrations } from '../src/migrate.js';

const adminUrl = () => inject('pgAdminUrl');
const created: string[] = [];

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** An EMPTY database (not the migrated template), as on a first deploy. */
async function emptyDatabase(): Promise<string> {
  const name = `fg_mig_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin((c) => c.query(`create database ${name} encoding 'UTF8' template template0`));
  created.push(name);
  return adminUrl().replace(/\/[^/]*$/, `/${name}`);
}

const expectedTransitions = Object.values(ACTION_TRANSITIONS).reduce((n, tos) => n + tos.length, 0);
const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] };

afterAll(async () => {
  await admin(async (c) => {
    for (const name of created) await c.query(`drop database if exists ${name} with (force)`);
  });
});

describe('concurrent migrations', () => {
  let url: string;
  beforeAll(async () => {
    url = await emptyDatabase();
  });

  it('serialises simultaneous migrators on an empty database; each succeeds and the schema is applied once', async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => runAllMigrations(url)));
    const failures = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
    expect(failures).toEqual([]);
    // At least three of the four had to wait for the lock holder.
    const waited = results.filter((r) => r.status === 'fulfilled' && r.value.lockWaitMs > 0).length;
    expect(waited).toBeGreaterThanOrEqual(3);

    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      const applied = await db.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations');
      expect(applied.rows[0]!.n).toBe(journal.entries.length);
      const transitions = await db.query<{ n: number; d: number }>('select count(*)::int as n, count(distinct (from_status, to_status))::int as d from action_state_transitions');
      expect(transitions.rows[0]).toEqual({ n: expectedTransitions, d: expectedTransitions });
      const graphile = await db.query<{ n: number }>("select count(*)::int as n from information_schema.schemata where schema_name = 'graphile_worker'");
      expect(graphile.rows[0]!.n).toBe(1);
      // The lock is released afterwards.
      const held = await db.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = $1 and objid = $2", [...MIGRATION_LOCK]);
      expect(held.rows[0]!.n).toBe(0);
    } finally {
      await db.end();
    }
  }, 180_000);

  it('waits for a lock held elsewhere and gives up after the timeout without touching the schema', async () => {
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock($1, $2)', [...MIGRATION_LOCK]);
      const waits: number[] = [];
      const err = await runAllMigrations(url, { lockTimeoutMs: 1_500, onLockWait: (ms) => waits.push(ms) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationLockTimeoutError);
      // Releasing the lock lets the next migrator proceed (nothing left to apply).
      await holder.query('select pg_advisory_unlock($1, $2)', [...MIGRATION_LOCK]);
      const again = await runAllMigrations(url, { lockTimeoutMs: 5_000 });
      expect(again.transitions).toBe(expectedTransitions);
    } finally {
      await holder.end();
    }
  }, 120_000);

  it('releases the lock when a migrator dies mid-run (session lock ends with the connection)', async () => {
    const victim = new pg.Client({ connectionString: url });
    await victim.connect();
    await victim.query('select pg_advisory_lock($1, $2)', [...MIGRATION_LOCK]);
    const pid = (await victim.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    victim.on('error', () => {});
    const pending = runAllMigrations(url, { lockTimeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 500));
    await admin((c) => c.query('select pg_terminate_backend($1)', [pid]));
    const r = await pending;
    expect(r.lockWaitMs).toBeGreaterThan(0);
    await victim.end().catch(() => {});
  }, 120_000);
});
