import { sql } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  connectionString: string;
  /** Pool size. Northflank Sandbox PostgreSQL has a small connection budget; keep this low. */
  max?: number;
  applicationName?: string;
  ssl?: boolean | { rejectUnauthorized: boolean; ca?: string };
}

// Return bigint/numeric as JS numbers only where safe; int8 (20) stays string by default in pg,
// Drizzle's bigint(mode:number) converts explicitly.
export function createDb(opts: CreateDbOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 5,
    application_name: opts.applicationName ?? 'futuregrow',
    ssl: opts.ssl,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export interface DatabaseCapabilities {
  serverVersion: string;
  currentUser: string;
  isSuperuser: boolean;
  bypassRls: boolean;
  tenantRoleExists: boolean;
  canSetTenantRole: boolean;
  pgvectorAvailable: boolean;
  pgvectorInstalled: boolean;
}

/** Runtime capability probe (tech stack pgvector probe + RLS role probe, B-004). */
export async function probeDatabase(db: DbOrTx): Promise<DatabaseCapabilities> {
  const res = await db.execute<{
    server_version: string;
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    tenant_role_exists: boolean;
    can_set_role: boolean;
    vector_available: boolean;
    vector_installed: boolean;
  }>(sql`
    select current_setting('server_version') as server_version,
           current_user as current_user,
           r.rolsuper, r.rolbypassrls,
           exists(select 1 from pg_roles where rolname = 'fg_tenant') as tenant_role_exists,
           (r.rolsuper or (exists(select 1 from pg_roles where rolname = 'fg_tenant')
                           and pg_has_role(current_user, 'fg_tenant', 'MEMBER'))) as can_set_role,
           exists(select 1 from pg_available_extensions where name = 'vector') as vector_available,
           exists(select 1 from pg_extension where extname = 'vector') as vector_installed
    from pg_roles r where r.rolname = current_user`);
  const row = res.rows[0];
  if (!row) throw new Error('database probe returned no rows');
  return {
    serverVersion: row.server_version,
    currentUser: row.current_user,
    isSuperuser: row.rolsuper,
    bypassRls: row.rolbypassrls,
    tenantRoleExists: row.tenant_role_exists,
    canSetTenantRole: row.can_set_role,
    pgvectorAvailable: row.vector_available,
    pgvectorInstalled: row.vector_installed,
  };
}

export { schema };
