import { randomUUID } from 'node:crypto';
import { withTenant } from '@futuregrow/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import * as RS from '../src/modules/m05-competitors/sandbox.js';
import { createCreator } from '../src/modules/m22-creators/index.js';
import { payoutReadiness } from '../src/modules/m22-creators/payouts.js';
import { COMPLIANCE_DEFINITIONS, complianceChecklist, isComplianceApproved, recordComplianceReview } from '../src/modules/m24-governance/compliance.js';

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);
const SHA = 'a'.repeat(64);

async function evidence(status: 'admitted' | 'quarantined' = 'admitted') {
  const e = await tx((t) =>
    admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'internal',
        sourceOwner: 'counsel',
        sourceUriOrObjectId: `doc://${randomUUID()}`,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'privileged legal memo',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: status === 'admitted' ? 1 : 0.1,
        freshnessSlaHours: 24 * 365,
        permittedUses: ['analytics'],
        kind: 'document',
        summary: 'review',
        content: { n: randomUUID() },
      } as never,
      { now: h.clock.now() },
    ),
  );
  return e.evidenceId;
}
const counsel = (evidenceId: string) => ({ status: 'approved', reviewerName: 'Dana Counsel', reviewerRole: 'external_counsel', reviewedAt: h.clock.now().toISOString().slice(0, 10), documentRef: 'MEMO-2026-11', evidenceId, contentSha256: SHA });

beforeAll(async () => {
  h = await createCoreHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('legal, policy and licensing readiness (P2-15)', () => {
  it('starts with nothing approved and states that tests are not a legal review', async () => {
    const c = await tx((t) => complianceChecklist(t, h.clock.now()));
    expect(c.items.map((i) => i.key)).toEqual(COMPLIANCE_DEFINITIONS.map((d) => d.key));
    expect(c.items.every((i) => i.status === 'not_started')).toBe(true);
    expect(c.approved).toBe(0);
    expect(c.note).toMatch(/not legal advice or a substitute for counsel/);
    expect(c.items.find((i) => i.key === 'creator_payouts')!.enforcedBy.join(' ')).toMatch(/legal_approval/);
  });

  it('approves only with a reviewer, an admitted document, two-factor and the right reviewer; approvals expire', async () => {
    const ev = await evidence();
    await expect(tx((t) => recordComplianceReview(t, h.tenantId, h.users.analyst, 'creator_payouts', counsel(ev), h.clock.now()))).rejects.toThrow(/roles/);
    await expect(tx((t) => recordComplianceReview(t, h.tenantId, { ...h.users.legal, mfaVerified: false }, 'creator_payouts', counsel(ev), h.clock.now()))).rejects.toThrow();
    await expect(tx((t) => recordComplianceReview(t, h.tenantId, h.users.legal, 'creator_payouts', { ...counsel(ev), evidenceId: randomUUID() }, h.clock.now()))).rejects.toThrow(/admitted evidence/);
    await expect(tx((t) => recordComplianceReview(t, h.tenantId, h.users.owner, 'creator_payouts', { ...counsel(ev), reviewerRole: 'owner' }, h.clock.now()))).rejects.toThrow(/needs counsel/);
    await expect(tx((t) => recordComplianceReview(t, h.tenantId, h.users.legal, 'no_such_item', counsel(ev), h.clock.now()))).rejects.toThrow(/unknown compliance item/);

    const creator = await tx((t) => createCreator(t, h.tenantId, h.users.operator, { name: 'Riley' }));
    const legalCheck = async () => (await tx((t) => payoutReadiness(t, creator.id, h.clock.now()))).checks.find((c) => c.key === 'legal_approval')!.ok;
    expect(await legalCheck()).toBe(false);
    const row = await tx((t) => recordComplianceReview(t, h.tenantId, h.users.legal, 'creator_payouts', counsel(ev), h.clock.now()));
    expect(row).toMatchObject({ status: 'approved', reviewerRole: 'external_counsel', documentRef: 'MEMO-2026-11' });
    expect(await tx((t) => isComplianceApproved(t, 'creator_payouts', h.clock.now()))).toBe(true);
    // The payout readiness check now sees counsel's approval; execution is still disabled (B-015).
    expect(await legalCheck()).toBe(true);
    const later = new Date(h.clock.now().getTime() + 400 * 86_400_000);
    expect(await tx((t) => isComplianceApproved(t, 'creator_payouts', later))).toBe(false);
    expect((await tx((t) => complianceChecklist(t, later))).items.find((i) => i.key === 'creator_payouts')!.status).toBe('expired');
  });
});

describe('authorized research sandbox (P3-09)', () => {
  let target: string;
  it('allowlists a target only with legal authorization, admitted evidence and an expiry within a year', async () => {
    const ev = await evidence();
    const t0 = { kind: 'artifact', value: 'acme-app-v2.3.1.apk', description: 'Our own Android build for a dependency licence audit', ownership: 'owned_by_tenant', authorizationEvidenceId: ev, allowedHosts: ['updates.acme.example'], expiresAt: new Date(h.clock.now().getTime() + 30 * 86_400_000).toISOString() };
    await expect(tx((t) => RS.addResearchTarget(t, h.deps, h.tenantId, h.users.operator, t0))).rejects.toThrow(/roles/);
    await expect(tx((t) => RS.addResearchTarget(t, h.deps, h.tenantId, h.users.legal, { ...t0, expiresAt: new Date(h.clock.now().getTime() + 400 * 86_400_000).toISOString() }))).rejects.toThrow(/within a year/);
    target = (await tx((t) => RS.addResearchTarget(t, h.deps, h.tenantId, h.users.legal, t0))).id;
  });

  it('refuses unsafe job requests: unlisted hosts, credentials, limits above the hard caps', async () => {
    const base = { targetId: target, purpose: 'List third-party libraries and their licences in our own build.', limits: { cpuSeconds: 120, memoryMb: 512, wallSeconds: 300 } };
    await expect(tx((t) => RS.requestResearchJob(t, h.deps, h.tenantId, h.users.operator, { ...base, limits: { ...base.limits, network: 'allowlisted_hosts', hosts: ['evil.example'] } }))).rejects.toThrow(/not allowed: evil\.example/);
    await expect(tx((t) => RS.requestResearchJob(t, h.deps, h.tenantId, h.users.operator, { ...base, inputs: ['api_key=sk-live-123'] }))).rejects.toThrow(/never receive credentials/);
    await expect(tx((t) => RS.requestResearchJob(t, h.deps, h.tenantId, h.users.operator, { ...base, limits: { ...base.limits, memoryMb: 64_000 } }))).rejects.toThrow();
    await expect(tx((t) => RS.requestResearchJob(t, h.deps, h.tenantId, h.users.analyst, base))).rejects.toThrow(/roles/);
  });

  it('a second legal approver is required; without the research review and an isolated runner the job is refused, never run', async () => {
    const job = await tx((t) => RS.requestResearchJob(t, h.deps, h.tenantId, h.users.legal, { targetId: target, purpose: 'List third-party libraries and their licences in our own build.', limits: { cpuSeconds: 120, memoryMb: 512, wallSeconds: 300 } }));
    expect(job).toMatchObject({ status: 'pending_approval', limits: { network: 'none' } });
    await expect(tx((t) => RS.approveResearchJob(t, h.deps, h.tenantId, h.users.legal, job.id))).rejects.toThrow(/other than the requester/);
    const refused = await tx((t) => RS.approveResearchJob(t, h.deps, h.tenantId, h.users.owner, job.id));
    expect(refused.status).toBe('refused');
    expect(refused.statusReason).toMatch(/no counsel-approved research review/);
    expect(refused.statusReason).toMatch(/No microVM-class isolated runner is configured \(B-012\)/);
    expect(refused.startedAt).toBeNull();

    // With counsel's approval the runner is still the blocker.
    await tx((t) => recordComplianceReview(t, h.tenantId, h.users.legal, 'research_sandbox', counsel(job.authorization.authorizationEvidenceId as string), h.clock.now()));
    const job2 = await tx((t) => RS.requestResearchJob(t, h.deps, h.tenantId, h.users.legal, { targetId: target, purpose: 'Second pass: confirm the licence list after an update.', limits: { cpuSeconds: 60, memoryMb: 256, wallSeconds: 120 } }));
    const r2 = await tx((t) => RS.approveResearchJob(t, h.deps, h.tenantId, h.users.owner, job2.id));
    expect(r2.status).toBe('refused');
    expect(r2.statusReason).not.toMatch(/no counsel-approved/);
    expect(r2.statusReason).toMatch(/B-012/);
    // A runner without real isolation cannot be registered.
    expect(() => RS.registerIsolatedRunner({ id: 'docker', profile: { isolation: 'none', networkDefault: 'none', filesystem: 'ephemeral_scratch', credentials: 'none' }, available: () => ({ ok: true, reason: '' }) })).toThrow(/microVM isolation/);
    const ov = await tx((t) => RS.researchOverview(t));
    expect(ov.runner).toMatchObject({ id: 'none', ok: false });
  });

  it('a revoked target refuses new jobs; a pending job can be terminated', async () => {
    const job = await tx((t) => RS.requestResearchJob(t, h.deps, h.tenantId, h.users.legal, { targetId: target, purpose: 'Pending job that will be terminated by the admin.', limits: { cpuSeconds: 10, memoryMb: 128, wallSeconds: 30 } }));
    const term = await tx((t) => RS.terminateResearchJob(t, h.tenantId, h.users.admin, job.id, 'no longer needed'));
    expect(term).toMatchObject({ status: 'terminated', quarantine: { released: false } });
    await tx((t) => RS.revokeResearchTarget(t, h.tenantId, h.users.legal, target));
    await expect(tx((t) => RS.requestResearchJob(t, h.deps, h.tenantId, h.users.legal, { targetId: target, purpose: 'After revocation this must be refused outright.', limits: { cpuSeconds: 10, memoryMb: 128, wallSeconds: 30 } }))).rejects.toThrow(/not \(or no longer\) authorized/);
  });
});
