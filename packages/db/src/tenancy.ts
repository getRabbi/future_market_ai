import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client.js';
import { normalizeDbError } from './errors.js';

export interface TenantContext {
  tenantId: string;
  /** Actor recorded by DB triggers (e.g. `user:abc`, `agent:brain`, `system:worker`). */
  actor: string;
  correlationId?: string | null;
}

let tenantRoleEnabled = true;

/**
 * Configure whether tenant transactions switch to the `fg_tenant` RLS role. Disabled only when
 * the database cannot host the role (B-004) and the process is not in production.
 */
export function configureTenantRole(enabled: boolean): void {
  tenantRoleEnabled = enabled;
}

export function isTenantRoleEnabled(): boolean {
  return tenantRoleEnabled;
}

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) throw new Error('invalid tenant id');
}

/**
 * Run `fn` in a transaction where PostgreSQL row-level security restricts every tenant table
 * to `ctx.tenantId`. Isolation is enforced by the database, not by remembering WHERE clauses.
 */
export async function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertTenantId(ctx.tenantId);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${ctx.tenantId}, true),
                   set_config('app.actor', ${ctx.actor}, true),
                   set_config('app.correlation_id', ${ctx.correlationId ?? ''}, true)`,
      );
      if (tenantRoleEnabled) await tx.execute(sql`set local role fg_tenant`);
      return fn(tx);
    });
  } catch (err) {
    throw normalizeDbError(err);
  }
}

/** Set the reason recorded by the action-state trigger for the next transition(s). */
export async function setTransitionReason(tx: Tx, reason: string): Promise<void> {
  await tx.execute(sql`select set_config('app.transition_reason', ${reason.slice(0, 2000)}, true)`);
}

/**
 * System transaction (no tenant role). Used only by the worker/control plane for cross-tenant
 * scans such as queue polling. Callers must switch into `withTenant` before touching tenant data.
 */
export async function withSystem<T>(db: Db, actor: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.actor', ${actor}, true)`);
      return fn(tx);
    });
  } catch (err) {
    throw normalizeDbError(err);
  }
}

/** Nested savepoint whose failure does not abort the enclosing transaction; errors normalised. */
export async function savepoint<T>(tx: Tx, fn: (sp: Tx) => Promise<T>): Promise<T> {
  try {
    return await tx.transaction(fn);
  } catch (err) {
    throw normalizeDbError(err);
  }
}

/**
 * `Promise.all` for queries on one transaction client: a pg client runs one query at a time, so
 * queries are awaited in order (Drizzle builders are lazy until awaited).
 */
export async function sequential<T extends readonly unknown[] | []>(queries: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const out: unknown[] = [];
  for (const q of queries) out.push(await q);
  return out as { -readonly [P in keyof T]: Awaited<T[P]> };
}
