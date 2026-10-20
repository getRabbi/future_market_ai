import { canonicalJson } from '@futuregrow/contracts';
import { sha256Hex } from '@futuregrow/observability';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from './client.js';
import { auditChainHeads, auditLog } from './schema/index.js';

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  tenantId: string;
  actorType: 'user' | 'agent' | 'system' | 'connector';
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
}

interface CanonicalAuditRecord {
  tenantId: string;
  seq: number;
  prevHash: string;
  occurredAt: string;
  actorType: string;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
}

export function computeAuditHash(record: CanonicalAuditRecord): string {
  // tech stack: record_hash = SHA256(previous_record_hash || canonical_current_record)
  return sha256Hex(record.prevHash + canonicalJson(record));
}

/**
 * Append an entry to the tenant's tamper-evident audit chain. Serialised per tenant by a row lock
 * on the chain head, so concurrent writers cannot fork the chain.
 */
export async function appendAudit(tx: Tx, entry: AuditEntry): Promise<{ seq: number; recordHash: string }> {
  await tx.insert(auditChainHeads).values({ tenantId: entry.tenantId, lastSeq: 0, lastHash: AUDIT_GENESIS_HASH }).onConflictDoNothing();
  const [head] = await tx.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, entry.tenantId)).for('update');
  if (!head) throw new Error('audit chain head missing');

  const record: CanonicalAuditRecord = {
    tenantId: entry.tenantId,
    seq: head.lastSeq + 1,
    prevHash: head.lastHash,
    occurredAt: new Date().toISOString(),
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    payload: entry.payload ?? {},
    correlationId: entry.correlationId ?? null,
  };
  const recordHash = computeAuditHash(record);
  await tx.insert(auditLog).values({ ...record, recordHash });
  await tx.update(auditChainHeads).set({ lastSeq: record.seq, lastHash: recordHash }).where(eq(auditChainHeads.tenantId, entry.tenantId));
  return { seq: record.seq, recordHash };
}

export interface AuditVerification {
  valid: boolean;
  checked: number;
  headSeq: number;
  firstInvalidSeq: number | null;
  reason: string | null;
}

/** Recompute the whole chain for a tenant and compare with stored hashes and the chain head. */
export async function verifyAuditChain(db: DbOrTx, tenantId: string, batchSize = 1000): Promise<AuditVerification> {
  let prevHash = AUDIT_GENESIS_HASH;
  let expectedSeq = 1;
  let checked = 0;
  let lastSeq = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), gt(auditLog.seq, lastSeq)))
      .orderBy(asc(auditLog.seq))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { valid: false, checked, headSeq: lastSeq, firstInvalidSeq: row.seq, reason: `sequence gap: expected ${expectedSeq}` };
      }
      if (row.prevHash !== prevHash) {
        return { valid: false, checked, headSeq: lastSeq, firstInvalidSeq: row.seq, reason: 'prev_hash does not link to previous record' };
      }
      const recomputed = computeAuditHash({
        tenantId: row.tenantId,
        seq: row.seq,
        prevHash: row.prevHash,
        occurredAt: row.occurredAt,
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        payload: row.payload,
        correlationId: row.correlationId,
      });
      if (recomputed !== row.recordHash) {
        return { valid: false, checked, headSeq: lastSeq, firstInvalidSeq: row.seq, reason: 'record hash mismatch (content altered)' };
      }
      prevHash = row.recordHash;
      expectedSeq += 1;
      checked += 1;
      lastSeq = row.seq;
    }
  }
  const [head] = await db.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, tenantId));
  if (head && (head.lastSeq !== lastSeq || head.lastHash !== prevHash)) {
    return { valid: false, checked, headSeq: lastSeq, firstInvalidSeq: lastSeq + 1, reason: 'chain head does not match last record (truncation)' };
  }
  if (!head && checked > 0) {
    return { valid: false, checked, headSeq: lastSeq, firstInvalidSeq: null, reason: 'chain head missing' };
  }
  return { valid: true, checked, headSeq: lastSeq, firstInvalidSeq: null, reason: null };
}

export async function auditCount(db: DbOrTx, tenantId: string): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`select count(*)::text as n from audit_log where tenant_id = ${tenantId}`);
  return Number(res.rows[0]?.n ?? 0);
}
