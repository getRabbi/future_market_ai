import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';
import { type DbTlsSettings, resolveDbTls } from './tls.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  /** Effective TLS policy (tls.ts). */
  tls: Pick<DbTlsSettings, 'mode' | 'caSource' | 'host'>;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  connectionString: string;
  /** Pool size. Northflank Sandbox PostgreSQL has a small connection budget; keep this low. */
  max?: number;
  applicationName?: string;
  /** DATABASE_SSL (undefined when unset); see resolveDbTls for the full policy. */
  ssl?: boolean | undefined;
  /** DATABASE_SSL_CA: PEM bundle or path. */
  sslCa?: string | undefined;
  /** Production refuses unencrypted remote connections and defaults to TLS. */
  production?: boolean;
  /** Errors on idle clients (e.g. server restart). Without a handler they crash the process. */
  onPoolError?: (err: Error) => void;
}

// Return bigint/numeric as JS numbers only where safe; int8 (20) stays string by default in pg,
// Drizzle's bigint(mode:number) converts explicitly.
export function createDb(opts: CreateDbOptions): DbHandle {
  const tls = resolveDbTls({ connectionString: opts.connectionString, ssl: opts.ssl, ca: opts.sslCa, production: opts.production ?? false });
  const pool = new pg.Pool({
    connectionString: tls.connectionString,
    max: opts.max ?? 5,
    application_name: opts.applicationName ?? 'futuregrow',
    ssl: tls.ssl,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const onError = opts.onPoolError ?? ((err: Error) => console.error('[db] client error', err.message));
  pool.on('error', onError);
  // A checked-out client that loses its connection emits 'error' on the client itself; without a
  // listener Node would crash the process (Graphile Worker shares this pool).
  pool.on('connect', (client) => {
    client.on('error', onError);
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    tls: { mode: tls.mode, caSource: tls.caSource, host: tls.host },
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
  /** This session is TLS-encrypted (pg_stat_ssl). */
  ssl: boolean;
  sslVersion: string | null;
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
    ssl: boolean | null;
    ssl_version: string | null;
  }>(sql`
    select current_setting('server_version') as server_version,
           current_user as current_user,
           r.rolsuper, r.rolbypassrls,
           exists(select 1 from pg_roles where rolname = 'fg_tenant') as tenant_role_exists,
           (r.rolsuper or (exists(select 1 from pg_roles where rolname = 'fg_tenant')
                           and pg_has_role(current_user, 'fg_tenant', 'MEMBER'))) as can_set_role,
           exists(select 1 from pg_available_extensions where name = 'vector') as vector_available,
           exists(select 1 from pg_extension where extname = 'vector') as vector_installed,
           (select s.ssl from pg_stat_ssl s where s.pid = pg_backend_pid()) as ssl,
           (select s.version from pg_stat_ssl s where s.pid = pg_backend_pid()) as ssl_version
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
    ssl: row.ssl === true,
    sslVersion: row.ssl_version ?? null,
  };
}

export { schema };
