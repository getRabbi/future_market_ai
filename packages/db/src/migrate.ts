import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TRANSITIONS } from '@futuregrow/contracts';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { runMigrations as runGraphileMigrations } from 'graphile-worker';
import { createDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = process.env.FG_MIGRATIONS_FOLDER ?? path.resolve(here, '../drizzle');

export interface MigrateResult {
  graphile: boolean;
  transitions: number;
}

/**
 * Apply all migrations: Graphile Worker schema first (the outbox trigger enqueues into it),
 * then application migrations, then idempotent security/reference-data sync.
 */
export async function runAllMigrations(connectionString: string): Promise<MigrateResult> {
  await runGraphileMigrations({ connectionString });
  const handle = createDb({ connectionString, max: 1, applicationName: 'futuregrow-migrate' });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
    const pairs = Object.entries(ACTION_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => [from, to] as const));
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`delete from action_state_transitions`);
      for (const [from, to] of pairs) {
        await tx.execute(sql`insert into action_state_transitions (from_status, to_status) values (${from}, ${to})`);
      }
      await tx.execute(sql`select fg_apply_security()`);
    });
    return { graphile: true, transitions: pairs.length };
  } finally {
    await handle.close();
  }
}
