import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TRANSITIONS } from '@futuregrow/contracts';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { runMigrations as runGraphileMigrations } from 'graphile-worker';
import type pg from 'pg';
import { type CreateDbOptions, createDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = process.env.FG_MIGRATIONS_FOLDER ?? path.resolve(here, '../drizzle');

/** Session advisory lock serialising migrators across processes: ('FG', 1). */
export const MIGRATION_LOCK = [0x4647, 1] as const;

export interface MigrateResult {
  graphile: boolean;
  transitions: number;
  /** Milliseconds spent waiting for another migrator. */
  lockWaitMs: number;
}

export type MigrateOptions = Pick<CreateDbOptions, 'ssl' | 'sslCa' | 'production'> & {
  /** Give up waiting for the migration lock after this long (default 10 min). */
  lockTimeoutMs?: number;
  /** Called while another process holds the lock. */
  onLockWait?: (waitedMs: number) => void;
};

export class MigrationLockTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`another migrator held the migration lock for ${Math.round(waitedMs / 1000)} s; giving up`);
    this.name = 'MigrationLockTimeoutError';
  }
}

async function acquireMigrationLock(client: pg.PoolClient, timeoutMs: number, onWait?: (ms: number) => void): Promise<number> {
  const started = Date.now();
  let notified = 0;
  for (;;) {
    const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1, $2) as ok', [...MIGRATION_LOCK]);
    if (r.rows[0]?.ok) return Date.now() - started;
    const waited = Date.now() - started;
    if (waited >= timeoutMs) throw new MigrationLockTimeoutError(waited);
    if (waited - notified >= 5_000) {
      notified = waited;
      onWait?.(waited);
    }
    await new Promise((res) => setTimeout(res, 250 + Math.random() * 250));
  }
}

/**
 * Apply all migrations: Graphile Worker schema first (the outbox trigger enqueues into it),
 * then application migrations, then idempotent security/reference-data sync.
 *
 * Concurrent starts (several api instances, a deploy overlapping a restart) are serialised by a
 * session-level advisory lock held on a dedicated connection for the whole run; PostgreSQL
 * releases it automatically if the process dies. Later migrators find nothing to apply.
 */
export async function runAllMigrations(connectionString: string, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const { lockTimeoutMs = 10 * 60_000, onLockWait, ...tls } = opts;
  // One pool (with the TLS policy) for Graphile and Drizzle, so both verify the server the same
  // way: one connection holds the lock, the other runs the migrations.
  const handle = createDb({ connectionString, max: 2, applicationName: 'futuregrow-migrate', ...tls });
  try {
    const lock = await handle.pool.connect();
    let locked = false;
    try {
      const lockWaitMs = await acquireMigrationLock(lock, lockTimeoutMs, onLockWait);
      locked = true;
      await runGraphileMigrations({ pgPool: handle.pool });
      await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
      const pairs = Object.entries(ACTION_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => [from, to] as const));
      await handle.db.transaction(async (tx) => {
        await tx.execute(sql`delete from action_state_transitions`);
        for (const [from, to] of pairs) {
          await tx.execute(sql`insert into action_state_transitions (from_status, to_status) values (${from}, ${to})`);
        }
        await tx.execute(sql`select fg_apply_security()`);
      });
      return { graphile: true, transitions: pairs.length, lockWaitMs };
    } finally {
      if (locked) await lock.query('select pg_advisory_unlock($1, $2)', [...MIGRATION_LOCK]).catch(() => {});
      lock.release();
    }
  } finally {
    await handle.close();
  }
}
