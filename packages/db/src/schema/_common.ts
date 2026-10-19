import { type SQL, sql } from 'drizzle-orm';
import { bigint, check, doublePrecision, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export const pk = () => uuid('id').primaryKey().defaultRandom();
export const tenantId = () => text('tenant_id').notNull();
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const createdAt = () => ts('created_at').notNull().defaultNow();
export const updatedAt = () => ts('updated_at').notNull().defaultNow();
export const micros = (name: string) => bigint(name, { mode: 'number' });
export const dbl = (name: string) => doublePrecision(name);
export const json = <T>(name: string) => jsonb(name).$type<T>();
export const uuidArray = (name: string) => uuid(name).array();
export const textArray = (name: string) => text(name).array();

function quote(v: string): string {
  return `'${v.replaceAll("'", "''")}'`;
}

/** CHECK (col IN (...)) built from the contract's const tuples (DDL cannot take bind params). */
export function oneOf(name: string, column: AnyPgColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${sql.raw(values.map(quote).join(', '))})`);
}

export function rawCheck(name: string, expr: SQL) {
  return check(name, expr);
}
