import { connections, type DbOrTx, evidenceRecords, reaJobs, researchTargets, type Tx } from '@futuregrow/db';
import { conflict, forbidden, invalid, notFound } from '@futuregrow/observability';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, requireMfa, requireRole } from '../../util.js';
import { isComplianceApproved } from '../m24-governance/compliance.js';

/**
 * Isolated, authorized research sandbox for M05 (P3-09). Orchestration only: a job needs an
 * allowlisted target the tenant is authorized to analyse (ownership, analysis licence or written
 * authorization, with admitted evidence and an expiry), a counsel-approved research review
 * (P2-15), strict CPU/memory/time limits, the network off unless specific allowlisted hosts are
 * named, no production credentials or connection references, and a second legal approver. It then
 * runs only on a runner that provides hardware-level isolation (a microVM-class sandbox with no
 * network and a scratch filesystem). A subprocess, a JavaScript sandbox or a plain Docker
 * container is not malware-safe isolation; no such runner exists in this deployment (B-012), so an
 * approved job is refused and never executed. Untrusted binaries are never run here.
 */

const LEGAL_ROLES = ['owner', 'legal_approver'] as const;
const OPERATOR_ROLES = ['owner', 'admin', 'growth_operator', 'legal_approver'] as const;

export const HARD_LIMITS = { cpuSeconds: 600, memoryMb: 2048, wallSeconds: 1800, outputMb: 50 } as const;

export interface IsolationProfile {
  isolation: 'microvm' | 'none';
  networkDefault: 'none';
  filesystem: 'ephemeral_scratch' | 'none';
  credentials: 'none';
}

export interface IsolatedRunner {
  id: string;
  profile: IsolationProfile;
  available(): { ok: boolean; reason: string };
}

/** The only runner in this deployment: it reports why nothing can be executed. */
export const unavailableRunner: IsolatedRunner = {
  id: 'none',
  profile: { isolation: 'none', networkDefault: 'none', filesystem: 'none', credentials: 'none' },
  available: () => ({ ok: false, reason: 'No microVM-class isolated runner is configured (B-012). Subprocesses, JavaScript sandboxes and plain Docker containers are not accepted as malware-safe isolation.' }),
};

let runner: IsolatedRunner = unavailableRunner;
/** For a future approved runner (e.g. a dedicated Firecracker host); must declare microVM isolation. */
export function registerIsolatedRunner(r: IsolatedRunner) {
  if (r.profile.isolation !== 'microvm' || r.profile.networkDefault !== 'none' || r.profile.credentials !== 'none') throw invalid('a research runner must provide microVM isolation, no network by default and no credentials');
  runner = r;
}
export const currentRunner = () => runner;

export const TargetSchema = z
  .object({
    kind: z.enum(['artifact', 'package', 'domain']),
    value: z.string().trim().min(3).max(500),
    description: z.string().trim().min(10).max(2000),
    ownership: z.enum(['owned_by_tenant', 'licensed_with_analysis_rights', 'explicit_written_authorization']),
    authorizationEvidenceId: z.string().uuid(),
    allowedHosts: z
      .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/))
      .max(10)
      .default([]),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export async function addResearchTarget(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, [...LEGAL_ROLES], 'authorizing a research target');
  requireMfa(actor, 'authorizing a research target');
  const input = TargetSchema.parse(raw);
  const now = deps.clock.now();
  const expiresAt = new Date(input.expiresAt);
  if (expiresAt <= now || expiresAt.getTime() - now.getTime() > 366 * 86_400_000) throw invalid('an authorization must expire within a year');
  const [ev] = await t.select().from(evidenceRecords).where(eq(evidenceRecords.id, input.authorizationEvidenceId));
  if (!ev || ev.status !== 'admitted') throw invalid('the authorization must be admitted evidence (ownership record, licence or written authorization)');
  const [row] = await t
    .insert(researchTargets)
    .values({ tenantId, ...input, expiresAt, approvedBy: actorRef(actor), approvedAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('this target is already on the allowlist');
  await audit(t, tenantId, actor, 'research.target.authorized', { type: 'research_target', id: row.id }, { kind: input.kind, ownership: input.ownership, expiresAt: input.expiresAt });
  return row;
}

export const ResearchJobSchema = z
  .object({
    targetId: z.string().uuid(),
    purpose: z.string().trim().min(20).max(2000),
    limits: z
      .object({
        cpuSeconds: z.number().int().min(1).max(HARD_LIMITS.cpuSeconds),
        memoryMb: z.number().int().min(64).max(HARD_LIMITS.memoryMb),
        wallSeconds: z.number().int().min(1).max(HARD_LIMITS.wallSeconds),
        outputMb: z.number().int().min(1).max(HARD_LIMITS.outputMb).default(10),
        network: z.enum(['none', 'allowlisted_hosts']).default('none'),
        hosts: z.array(z.string()).max(10).default([]),
      })
      .strict(),
    /** Inputs are references to the target only; anything resembling a credential or connection is refused. */
    inputs: z.array(z.string().max(500)).max(10).default([]),
  })
  .strict();

const CREDENTIAL_LIKE = /(fgk_|sk[-_]|token|secret|password|api[-_]?key|bearer|connection:|-----BEGIN)/i;

export async function requestResearchJob(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, [...OPERATOR_ROLES], 'requesting a research job');
  const input = ResearchJobSchema.parse(raw);
  const now = deps.clock.now();
  const [target] = await t.select().from(researchTargets).where(eq(researchTargets.id, input.targetId));
  if (!target) throw notFound('research target');
  if (target.status !== 'active' || target.expiresAt <= now) throw forbidden('the target is not (or no longer) authorized');
  if (input.limits.network === 'allowlisted_hosts') {
    const extra = input.limits.hosts.filter((h) => !target.allowedHosts.includes(h));
    if (!input.limits.hosts.length || extra.length) throw forbidden(`network access is limited to the target's allowlisted hosts${extra.length ? `; not allowed: ${extra.join(', ')}` : ''}`);
  } else if (input.limits.hosts.length) throw invalid('hosts are only used with network = allowlisted_hosts');
  const connIds = new Set((await t.select({ id: connections.id }).from(connections)).map((c) => c.id));
  const bad = input.inputs.filter((i) => CREDENTIAL_LIKE.test(i) || [...connIds].some((id) => i.includes(id)));
  if (bad.length) throw forbidden('research jobs never receive credentials or connection references');
  const [row] = await t
    .insert(reaJobs)
    .values({
      tenantId,
      targetDescription: target.description,
      artifactRef: target.value,
      authorization: { targetId: target.id, ownership: target.ownership, authorizationEvidenceId: target.authorizationEvidenceId, targetApprovedBy: target.approvedBy, expiresAt: target.expiresAt.toISOString() },
      legalApproved: true,
      targetId: target.id,
      purpose: input.purpose,
      limits: { ...input.limits, inputs: input.inputs },
      status: 'pending_approval',
      statusReason: 'waiting for a second legal approver',
      createdBy: actorRef(actor),
    })
    .returning();
  await audit(t, tenantId, actor, 'research.job.requested', { type: 'rea_job', id: row!.id }, { targetId: target.id, limits: input.limits });
  return row!;
}

/**
 * A second legal approver (not the requester) approves; then the job is handed to the isolated
 * runner. Without the research review (P2-15) or a microVM runner it is refused, with the reason.
 */
export async function approveResearchJob(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, [...LEGAL_ROLES], 'approving a research job');
  requireMfa(actor, 'approving a research job');
  const now = deps.clock.now();
  const [job] = await t.select().from(reaJobs).where(eq(reaJobs.id, id)).for('update');
  if (!job) throw notFound('research job');
  if (job.status !== 'pending_approval') throw conflict(`the job is ${job.status}`);
  if (job.createdBy === actorRef(actor)) throw forbidden('a research job is approved by someone other than the requester');
  const reasons: string[] = [];
  if (!(await isComplianceApproved(t, 'research_sandbox', now))) reasons.push('no counsel-approved research review (compliance item research_sandbox)');
  const [target] = job.targetId ? await t.select().from(researchTargets).where(eq(researchTargets.id, job.targetId)) : [];
  if (!target || target.status !== 'active' || target.expiresAt <= now) reasons.push('the target authorization expired or was revoked');
  const r = runner.available();
  if (!r.ok) reasons.push(r.reason);
  const refused = reasons.length > 0;
  const [row] = await t
    .update(reaJobs)
    .set({ status: refused ? 'refused' : 'approved', statusReason: refused ? clipText(reasons.join(' '), 2000) : `approved; queued for runner ${runner.id}`, approvedBy: actorRef(actor), approvedAt: now, runner: runner.id })
    .where(eq(reaJobs.id, id))
    .returning();
  await audit(t, tenantId, actor, refused ? 'research.job.refused' : 'research.job.approved', { type: 'rea_job', id }, { reasons, runner: runner.id });
  return row!;
}

export async function terminateResearchJob(t: Tx, tenantId: string, actor: Actor, id: string, reason: string) {
  requireRole(actor, [...LEGAL_ROLES, 'admin'], 'terminating a research job');
  const [job] = await t.select().from(reaJobs).where(eq(reaJobs.id, id));
  if (!job) throw notFound('research job');
  if (!['pending_approval', 'approved', 'running'].includes(job.status)) throw conflict(`the job is already ${job.status}`);
  const [row] = await t
    .update(reaJobs)
    .set({ status: 'terminated', statusReason: clipText(`terminated: ${reason}`, 500), terminatedBy: actorRef(actor), finishedAt: new Date(), quarantine: { outputs: [], released: false, note: 'nothing was produced; scratch storage discarded' } })
    .where(eq(reaJobs.id, id))
    .returning();
  await audit(t, tenantId, actor, 'research.job.terminated', { type: 'rea_job', id }, { from: job.status, reason: clipText(reason, 200) });
  return row!;
}

export async function revokeResearchTarget(t: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, [...LEGAL_ROLES], 'revoking a research target');
  const [row] = await t.update(researchTargets).set({ status: 'revoked', revokedAt: new Date() }).where(eq(researchTargets.id, id)).returning();
  if (!row) throw notFound('research target');
  await audit(t, tenantId, actor, 'research.target.revoked', { type: 'research_target', id }, {});
  return row;
}

export async function researchOverview(t: DbOrTx) {
  const [targets, jobs] = await Promise.all([t.select().from(researchTargets).orderBy(desc(researchTargets.approvedAt)), t.select().from(reaJobs).orderBy(desc(reaJobs.createdAt)).limit(100)]);
  return { runner: { id: runner.id, ...runner.profile, ...runner.available() }, hardLimits: HARD_LIMITS, targets, jobs };
}
