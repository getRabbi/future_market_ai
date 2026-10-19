import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, createTestDatabase } from '../../../test/helpers/db.js';
import {
  actionRequests,
  appendAudit,
  auditLog,
  beginIdempotent,
  completeIdempotent,
  evidenceRecords,
  executionProofs,
  executions,
  experimentAssignments,
  experimentExposures,
  experimentOutcomes,
  experimentVariants,
  experiments,
  organization,
  outboxEvents,
  probeDatabase,
  savepoint,
  setTransitionReason,
  sources,
  verifyAuditChain,
  withSystem,
  withTenant,
} from '../src/index.js';

let t: TestDatabase;
const A = 'tenant_a';
const B = 'tenant_b';

beforeAll(async () => {
  t = await createTestDatabase();
  await t.handle.db.insert(organization).values([
    { id: A, name: 'Tenant A', slug: 'tenant-a' },
    { id: B, name: 'Tenant B', slug: 'tenant-b' },
  ]);
});

afterAll(async () => {
  await t?.drop();
});

const ctx = (tenantId: string) => ({ tenantId, actor: `user:test-${tenantId}` });

async function insertAction(tenantId: string, overrides: Record<string, unknown> = {}) {
  return withTenant(t.handle.db, ctx(tenantId), async (tx) => {
    const [row] = await tx
      .insert(actionRequests)
      .values({
        tenantId,
        actionType: 'experiment.start',
        provider: 'internal',
        target: {},
        params: { experimentId: randomUUID() },
        actionHash: 'a'.repeat(64),
        proposedByType: 'user',
        proposedById: 'u1',
        risk: {},
        idempotencyKey: `idem-${randomUUID()}`,
        ...overrides,
      })
      .returning();
    return row!;
  });
}

async function setStatus(tenantId: string, id: string, status: string) {
  return withTenant(t.handle.db, ctx(tenantId), async (tx) => {
    await setTransitionReason(tx, `test -> ${status}`);
    await tx.update(actionRequests).set({ status }).where(eq(actionRequests.id, id));
  });
}

describe('database capability probe', () => {
  it('reports the RLS role and pgvector state', async () => {
    const caps = await probeDatabase(t.handle.db);
    expect(caps.serverVersion.startsWith('17')).toBe(true);
    expect(caps.tenantRoleExists).toBe(true);
    expect(caps.canSetTenantRole).toBe(true);
    expect(typeof caps.pgvectorAvailable).toBe('boolean');
  });
});

describe('tenant isolation via row-level security (D-008)', () => {
  it('every table with tenant_id has RLS enabled and the isolation policy', async () => {
    const res = await t.handle.db.execute<{ table_name: string; rls: boolean; has_policy: boolean }>(sql`
      select c.table_name,
             cls.relrowsecurity as rls,
             exists(select 1 from pg_policies p where p.tablename = c.table_name and p.policyname = 'fg_tenant_isolation') as has_policy
      from information_schema.columns c
      join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
      join pg_class cls on cls.relname = c.table_name and cls.relnamespace = 'public'::regnamespace
      where c.table_schema = 'public' and c.column_name = 'tenant_id' and tb.table_type = 'BASE TABLE'`);
    expect(res.rows.length).toBeGreaterThan(60);
    const missing = res.rows.filter((r) => !r.rls || !r.has_policy).map((r) => r.table_name);
    expect(missing).toEqual([]);
  });

  it('a tenant cannot read, update or forge another tenant’s rows', async () => {
    await withTenant(t.handle.db, ctx(A), (tx) =>
      tx.insert(sources).values({ tenantId: A, name: 'crm', sourceType: 'primary', owner: 'A', uri: 'crm://a' }),
    );
    const seenByB = await withTenant(t.handle.db, ctx(B), (tx) => tx.select().from(sources));
    expect(seenByB).toHaveLength(0);

    const updated = await withTenant(t.handle.db, ctx(B), (tx) =>
      tx.update(sources).set({ name: 'hijacked' }).returning({ id: sources.id }),
    );
    expect(updated).toHaveLength(0);

    await expect(
      withTenant(t.handle.db, ctx(B), (tx) =>
        tx.insert(sources).values({ tenantId: A, name: 'forged', sourceType: 'primary', owner: 'B', uri: 'crm://forged' }),
      ),
    ).rejects.toThrow(/row-level security/);

    const seenByA = await withTenant(t.handle.db, ctx(A), (tx) => tx.select().from(sources));
    expect(seenByA.map((s) => s.name)).toEqual(['crm']);
  });

  it('the tenant role cannot touch auth tables or the webhook inbox', async () => {
    await expect(
      withTenant(t.handle.db, ctx(A), (tx) => tx.execute(sql`select count(*) from auth_user`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(t.handle.db, ctx(A), (tx) => tx.execute(sql`select count(*) from webhook_inbox`)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('immutable hash-chained audit (M24)', () => {
  it('appends a verifiable chain and detects tampering and truncation', async () => {
    for (let i = 0; i < 5; i++) {
      await withTenant(t.handle.db, ctx(A), (tx) =>
        appendAudit(tx, {
          tenantId: A,
          actorType: 'user',
          actorId: 'u1',
          action: 'test.append',
          subjectType: 'thing',
          subjectId: String(i),
          payload: { i, nested: { z: 1, a: [1, 2] } },
        }),
      );
    }
    const ok = await withTenant(t.handle.db, ctx(A), (tx) => verifyAuditChain(tx, A));
    expect(ok).toMatchObject({ valid: true, checked: 5 });

    // Even the owner cannot update or delete audit rows.
    await expect(withSystem(t.handle.db, 'system:test', (tx) => tx.execute(sql`update audit_log set action = 'x' where tenant_id = ${A}`))).rejects.toThrow(/FG_IMMUTABLE/);
    await expect(withSystem(t.handle.db, 'system:test', (tx) => tx.execute(sql`delete from audit_log where tenant_id = ${A}`))).rejects.toThrow(/FG_IMMUTABLE/);

    // Simulate an attacker with superuser rights who disables the trigger and edits a record.
    await t.handle.db.execute(sql`alter table audit_log disable trigger fg_immutable_row`);
    await t.handle.db.execute(sql`update audit_log set payload = '{"i": 99}'::jsonb where tenant_id = ${A} and seq = 3`);
    const tampered = await verifyAuditChain(t.handle.db, A);
    expect(tampered.valid).toBe(false);
    expect(tampered.firstInvalidSeq).toBe(3);

    await t.handle.db.execute(sql`delete from audit_log where tenant_id = ${A} and seq >= 3`);
    const truncated = await verifyAuditChain(t.handle.db, A);
    expect(truncated.valid).toBe(false);
    expect(truncated.reason).toMatch(/truncation/);
    await t.handle.db.execute(sql`alter table audit_log enable trigger fg_immutable_row`);
  });

  it('concurrent appends never fork the chain', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withTenant(t.handle.db, ctx(B), (tx) =>
          appendAudit(tx, { tenantId: B, actorType: 'system', actorId: 's', action: 'concurrent', subjectType: 'x', subjectId: String(i) }),
        ),
      ),
    );
    const v = await verifyAuditChain(t.handle.db, B);
    expect(v).toMatchObject({ valid: true, checked: 12 });
  });
});

describe('execution state machine enforced by the database (D-011)', () => {
  it('rejects creation outside PROPOSED and illegal transitions', async () => {
    await expect(insertAction(A, { status: 'APPROVED' })).rejects.toThrow(/FG_STATE/);
    const a = await insertAction(A);
    await expect(setStatus(A, a.id, 'EXECUTING')).rejects.toThrow(/illegal transition PROPOSED -> EXECUTING/);
  });

  it('refuses APPROVED without a hash-bound approval and VERIFIED without a proof', async () => {
    const a = await insertAction(A);
    for (const s of ['EVIDENCE_READY', 'POLICY_CHECKED', 'APPROVAL_REQUIRED']) await setStatus(A, a.id, s);
    await expect(setStatus(A, a.id, 'APPROVED')).rejects.toThrow(/approval bound to the action hash/);

    await withTenant(t.handle.db, ctx(A), (tx) =>
      tx.execute(sql`insert into approvals (tenant_id, action_id, action_hash, decision, approver_user_id, approver_roles, mfa_verified)
                     values (${A}, ${a.id}, ${'a'.repeat(64)}, 'approved', 'u2', '{approver}', true)`),
    );
    for (const s of ['APPROVED', 'PREFLIGHT_VERIFIED', 'EXECUTING', 'EXECUTED_UNVERIFIED']) await setStatus(A, a.id, s);
    await expect(setStatus(A, a.id, 'VERIFIED')).rejects.toThrow(/VERIFIED requires an execution proof/);

    await withTenant(t.handle.db, ctx(A), async (tx) => {
      const [ex] = await tx.insert(executions).values({ tenantId: A, actionId: a.id, attempt: 1, outcome: 'executed' }).returning();
      await tx.insert(executionProofs).values({
        tenantId: A,
        actionId: a.id,
        executionId: ex!.id,
        verdict: 'PENDING',
        method: 'database_readback',
        expected: {},
        diff: [],
        evidenceSha256: 'b'.repeat(64),
        attempt: 1,
      });
    });
    await expect(setStatus(A, a.id, 'VERIFIED')).rejects.toThrow(/VERIFIED requires/);

    await withTenant(t.handle.db, ctx(A), async (tx) => {
      const [ex] = await tx.select().from(executions).where(eq(executions.actionId, a.id));
      await tx.insert(executionProofs).values({
        tenantId: A,
        actionId: a.id,
        executionId: ex!.id,
        verdict: 'VERIFIED',
        method: 'database_readback',
        expected: {},
        diff: [],
        evidenceSha256: 'c'.repeat(64),
        attempt: 2,
      });
    });
    await setStatus(A, a.id, 'VERIFIED');

    const history = await withTenant(t.handle.db, ctx(A), (tx) =>
      tx.execute<{ to_status: string; actor: string }>(sql`select to_status, actor from action_transitions where action_id = ${a.id} order by id`),
    );
    expect(history.rows.map((r) => r.to_status)).toEqual([
      'EVIDENCE_READY',
      'POLICY_CHECKED',
      'APPROVAL_REQUIRED',
      'APPROVED',
      'PREFLIGHT_VERIFIED',
      'EXECUTING',
      'EXECUTED_UNVERIFIED',
      'VERIFIED',
    ]);
    expect(history.rows.every((r) => r.actor === `user:test-${A}`)).toBe(true);

    // Terminal: nothing leaves VERIFIED, and the payload is immutable.
    await expect(setStatus(A, a.id, 'FAILED')).rejects.toThrow(/illegal transition/);
    await expect(
      withTenant(t.handle.db, ctx(A), (tx) => tx.update(actionRequests).set({ params: { x: 1 } }).where(eq(actionRequests.id, a.id))),
    ).rejects.toThrow(/immutable after proposal/);
  });
});

describe('transactional outbox (D-009)', () => {
  it('enqueues a Graphile job atomically with the event and not on rollback', async () => {
    const committedId = randomUUID();
    await withTenant(t.handle.db, ctx(A), (tx) =>
      tx.insert(outboxEvents).values({
        id: committedId,
        tenantId: A,
        eventType: 'evidence.record.admitted',
        eventVersion: 1,
        aggregateType: 'evidence',
        aggregateId: 'e1',
        occurredAt: new Date(),
        actorType: 'user',
        actorId: 'u1',
        payload: {},
      }),
    );
    const rolledBackId = randomUUID();
    await expect(
      withTenant(t.handle.db, ctx(A), async (tx) => {
        await tx.insert(outboxEvents).values({
          id: rolledBackId,
          tenantId: A,
          eventType: 'evidence.record.admitted',
          eventVersion: 1,
          aggregateType: 'evidence',
          aggregateId: 'e2',
          occurredAt: new Date(),
          actorType: 'user',
          actorId: 'u1',
          payload: {},
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const jobs = await t.handle.db.execute<{ key: string }>(
      sql`select key from graphile_worker.jobs where task_identifier = 'dispatch_event'`,
    );
    const keys = jobs.rows.map((r) => r.key);
    expect(keys).toContain(`evt:${committedId}`);
    expect(keys).not.toContain(`evt:${rolledBackId}`);
  });
});

describe('idempotency store', () => {
  it('replays completed responses and rejects reuse with a different body', async () => {
    const key = `key-${randomUUID()}`;
    const first = await withTenant(t.handle.db, ctx(A), async (tx) => {
      const r = await beginIdempotent(tx, { tenantId: A, scope: 'api', key, requestHash: 'h1' });
      await completeIdempotent(tx, { tenantId: A, scope: 'api', key, status: 201, body: { id: 1 } });
      return r;
    });
    expect(first.state).toBe('new');
    const replay = await withTenant(t.handle.db, ctx(A), (tx) => beginIdempotent(tx, { tenantId: A, scope: 'api', key, requestHash: 'h1' }));
    expect(replay).toEqual({ state: 'replay', status: 201, body: { id: 1 } });
    const conflict = await withTenant(t.handle.db, ctx(A), (tx) => beginIdempotent(tx, { tenantId: A, scope: 'api', key, requestHash: 'h2' }));
    expect(conflict.state).toBe('conflict');
    // keys are tenant-scoped
    const other = await withTenant(t.handle.db, ctx(B), (tx) => beginIdempotent(tx, { tenantId: B, scope: 'api', key, requestHash: 'h2' }));
    expect(other.state).toBe('new');
  });
});

describe('evidence integrity guards', () => {
  it('rejects admitted evidence with unresolved rights/PII/confidence, forbids content edits, allows erasure', async () => {
    const base = {
      tenantId: A,
      sourceType: 'primary',
      sourceOwner: 'A',
      sourceUriOrObjectId: 'crm://record/1',
      retrievedAt: new Date(),
      schemaVersion: '1',
      freshnessStatus: 'current',
      kind: 'observation',
      content: { email: 'x@example.com' },
      contentSha256: 'd'.repeat(64),
    };
    await expect(
      withTenant(t.handle.db, ctx(A), (tx) => tx.insert(evidenceRecords).values({ ...base, status: 'admitted' })),
    ).rejects.toThrow(/evidence_admitted_complete_chk/);

    const [row] = await withTenant(t.handle.db, ctx(A), (tx) =>
      tx
        .insert(evidenceRecords)
        .values({ ...base, status: 'admitted', licenseOrUsageRights: 'first-party', piiClassification: 'personal', confidence: 0.9 })
        .returning(),
    );
    await expect(
      withTenant(t.handle.db, ctx(A), (tx) => tx.update(evidenceRecords).set({ content: { email: 'y@example.com' } }).where(eq(evidenceRecords.id, row!.id))),
    ).rejects.toThrow(/FG_IMMUTABLE/);
    await withTenant(t.handle.db, ctx(A), (tx) =>
      tx.update(evidenceRecords).set({ content: null, status: 'expired' }).where(eq(evidenceRecords.id, row!.id)),
    );
  });
});

describe('experiment logging order (M10 AC)', () => {
  it('requires assignment before exposure and exposure before outcome', async () => {
    await withTenant(t.handle.db, ctx(A), async (tx) => {
      const [exp] = await tx
        .insert(experiments)
        .values({
          tenantId: A,
          name: 'cta copy',
          hypothesis: 'h',
          design: 'ab_fixed',
          unit: 'profile',
          targetMetric: 'signup',
          metricType: 'binary',
          riskTier: 'low',
          assignmentSalt: 'salt',
          createdBy: 'u1',
        })
        .returning();
      const [v] = await tx.insert(experimentVariants).values({ tenantId: A, experimentId: exp!.id, key: 'control', description: 'c', isControl: true }).returning();
      await expect(
        savepoint(tx, (sp) => sp.insert(experimentExposures).values({ tenantId: A, experimentId: exp!.id, variantId: v!.id, unitId: 'p1' })),
      ).rejects.toThrow(/exposure without a prior matching assignment/);
      await tx.insert(experimentAssignments).values({ tenantId: A, experimentId: exp!.id, variantId: v!.id, unitId: 'p1', allocationSnapshot: {} });
      await expect(
        savepoint(tx, (sp) =>
          sp.insert(experimentOutcomes).values({ tenantId: A, experimentId: exp!.id, variantId: v!.id, unitId: 'p1', metric: 'signup', value: 1, observedAt: new Date() }),
        ),
      ).rejects.toThrow(/outcome without a prior logged exposure/);
      await tx.insert(experimentExposures).values({ tenantId: A, experimentId: exp!.id, variantId: v!.id, unitId: 'p1' });
      await tx.insert(experimentOutcomes).values({
        tenantId: A,
        experimentId: exp!.id,
        variantId: v!.id,
        unitId: 'p1',
        metric: 'signup',
        value: 1,
        observedAt: new Date(Date.now() + 1000),
      });
    });
    const n = await withTenant(t.handle.db, ctx(A), (tx) => tx.select().from(auditLog));
    expect(Array.isArray(n)).toBe(true);
  });
});
