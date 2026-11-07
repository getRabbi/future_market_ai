/**
 * Post-restore checks for a restore drill (RUNBOOK §9). READ-ONLY against the restored database:
 * every tenant's audit hash chain, row-level-security tenant separation, and that nothing in the
 * restored copy would run by itself (no Graphile queue is restored).
 *
 *   FG_DRILL_DATABASE_URL=postgres://…/fg_restore_drill npx tsx scripts/restore-drill-check.ts
 *
 * Uses its own variable (never DATABASE_URL) and refuses non-local hosts unless
 * FG_DRILL_ALLOW_REMOTE=1, so it cannot be pointed at production by accident. Exit 1 on any failure.
 */

import { sql } from 'drizzle-orm';
import { configureTenantRole, createDb, probeDatabase, verifyAuditChain, withSystem, withTenant } from '../packages/db/src/index.js';

const url = process.env.FG_DRILL_DATABASE_URL;
if (!url) {
  console.error('FG_DRILL_DATABASE_URL (the restored, disposable database) is required');
  process.exit(2);
}
const host = new URL(url.replace(/^postgres(ql)?:/, 'http:')).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && process.env.FG_DRILL_ALLOW_REMOTE !== '1') {
  console.error(`refusing: ${host} is not local; a restore drill runs against a disposable local database (set FG_DRILL_ALLOW_REMOTE=1 for an isolated remote one)`);
  process.exit(2);
}

const handle = createDb({ connectionString: url, max: 2, applicationName: 'futuregrow-restore-drill-check' });
const problems: string[] = [];
try {
  const caps = await probeDatabase(handle.db);
  if (!caps.canSetTenantRole) problems.push('cannot SET ROLE fg_tenant: tenant separation cannot be checked');
  configureTenantRole(caps.canSetTenantRole);

  const tenants = (await withSystem(handle.db, 'system:restore-drill', (tx) => tx.execute<{ id: string }>(sql`select id from organization union select distinct tenant_id from audit_log order by 1`))).rows.map((r) => r.id);
  const perTenant: Record<string, { auditValid: boolean; auditChecked: number; visible: number; foreignVisible: number }> = {};
  for (const tenantId of tenants) {
    const chain = await withTenant(handle.db, { tenantId, actor: 'system:restore-drill' }, (tx) => verifyAuditChain(tx, tenantId));
    const own = Number((await withSystem(handle.db, 'system:restore-drill', (tx) => tx.execute<{ n: string }>(sql`select count(*)::text as n from audit_log where tenant_id = ${tenantId}`))).rows[0]!.n);
    const seen = (await withTenant(handle.db, { tenantId, actor: 'system:restore-drill' }, (tx) => tx.execute<{ visible: string; foreign: string }>(sql`select count(*)::text as visible, count(*) filter (where tenant_id <> ${tenantId})::text as foreign from audit_log`))).rows[0]!;
    perTenant[tenantId] = { auditValid: chain.valid, auditChecked: chain.checked, visible: Number(seen.visible), foreignVisible: Number(seen.foreign) };
    if (!chain.valid) problems.push(`${tenantId}: audit chain invalid at seq ${chain.firstInvalidSeq} (${chain.reason})`);
    if (Number(seen.foreign) > 0) problems.push(`${tenantId}: sees ${seen.foreign} audit rows of other tenants`);
    if (Number(seen.visible) !== own) problems.push(`${tenantId}: sees ${seen.visible} of its ${own} audit rows`);
  }

  const inert = (
    await withSystem(handle.db, 'system:restore-drill', (tx) =>
      tx.execute<{ jobs: string | null; pending_actions: string }>(
        sql`select case when to_regclass('graphile_worker._private_jobs') is null then null else (select count(*)::text from graphile_worker._private_jobs) end as jobs,
                   (select count(*)::text from action_requests where status in ('APPROVED', 'PREFLIGHT_VERIFIED', 'EXECUTING', 'EXECUTED_UNVERIFIED', 'ESCALATED')) as pending_actions`,
      ),
    )
  ).rows[0]!;
  // Migrations create an empty Graphile schema; backups never include queue state (RUNBOOK §9).
  if (inert.jobs !== null && Number(inert.jobs) > 0) problems.push(`${inert.jobs} queued Graphile jobs in the restored database`);

  console.log(
    JSON.stringify(
      {
        ok: problems.length === 0,
        tenants: tenants.length,
        auditRowsChecked: Object.values(perTenant).reduce((n, t) => n + t.auditChecked, 0),
        perTenant,
        queuedJobs: inert.jobs === null ? 0 : Number(inert.jobs),
        // In-flight M23 actions a worker would pick up: never attach a worker or provider credentials.
        inFlightActions: Number(inert.pending_actions),
        problems,
      },
      null,
      1,
    ),
  );
} finally {
  await handle.close();
}
process.exit(problems.length ? 1 : 0);
