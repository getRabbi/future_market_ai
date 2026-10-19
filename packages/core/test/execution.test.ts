import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { type CoreHarness, agentActor, createCoreHarness } from '../../../test/helpers/core.js';
import { budgetReservations, connections, evidenceRecords, executionProofs, incidents, withTenant } from '@futuregrow/db';
import { clearGoogleTokenCache } from '@futuregrow/connectors';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { cancelAction, decideApproval, executeAction, getActionDetail, proposeAction, verifyAction } from '../src/modules/m23-execution/gateway.js';
import { engageKillSwitch, setTenantPolicy, upsertJurisdictionRules } from '../src/modules/m24-governance/index.js';

const server = new FixtureServer();
let h: CoreHarness;
let metaConnId: string;
let googleConnId: string;
let evidenceId: string;

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  metaConnId = (
    await createConnection(h.deps, h.tenantId, h.users.owner, {
      provider: 'meta',
      externalAccountId: 'page-123',
      displayName: 'Acme Page',
      grantedScopes: ['pages_manage_posts', 'pages_read_engagement', 'ads_management', 'ads_read'],
      credentials: { accessToken: 'PAGE_TOKEN' },
    })
  ).id;
  googleConnId = (
    await createConnection(h.deps, h.tenantId, h.users.owner, {
      provider: 'google_ads',
      externalAccountId: '1234567890',
      displayName: 'Acme Ads',
      grantedScopes: ['https://www.googleapis.com/auth/adwords'],
      credentials: { clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' },
    })
  ).id;
  await upsertJurisdictionRules(h.t.handle.db, { userId: h.users.owner.id }, { jurisdiction: 'US', domain: 'advertising', rules: { ftc: true }, sourceRefs: ['https://www.ftc.gov'], approve: true });
  const ev = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) =>
    admitEvidence(
      tx,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'primary',
        sourceOwner: 'acme',
        sourceUriOrObjectId: 'crm://launch-plan',
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'first-party',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 0.9,
        permittedUses: ['autonomous_execution', 'publishing'],
        freshnessSlaHours: 24 * 90,
        kind: 'document',
        content: { plan: 'announce launch' },
      },
      { now: h.clock.now() },
    ),
  );
  evidenceId = ev.evidenceId;
});

afterAll(async () => {
  await h?.close();
  await server.stop();
});

beforeEach(() => {
  server.reset();
  clearGoogleTokenCache();
});

const postParams = (message = 'We launched!') => ({
  pageId: '123',
  message,
  postId: randomUUID(),
  claimIds: [],
  disclosure: { isAiGenerated: false, paidPartnership: false, syntheticPersonaId: null, disclosureText: null },
});

const usRisk = { geographies: ['US'] };

/** Unconfigured tenants need an operational AND a legal approval (two different people). */
async function approveAll(a: { id: string; actionHash: string }) {
  await decideApproval(h.deps, h.tenantId, h.users.approver, a.id, { decision: 'approved', expectedActionHash: a.actionHash });
  return decideApproval(h.deps, h.tenantId, h.users.legal, a.id, { decision: 'approved', expectedActionHash: a.actionHash });
}

describe('vertical slice: Facebook post read -> propose -> approve -> execute -> verify -> learn', () => {
  it('requires approval while tenant policy is unconfigured, then executes and verifies independently', async () => {
    let published: { id: string; message: string } | null = null;
    server.on('POST', '/v26.0/123/feed', (req) => {
      published = { id: '123_999', message: req.form!.get('message')! };
      return { json: { id: published.id } };
    });
    server.on('GET', '/v26.0/123_999', () => ({ json: { id: '123_999', message: published?.message, is_published: true, permalink_url: 'https://fb.example/123_999' } }));

    const proposed = await proposeAction(h.deps, h.tenantId, agentActor(), {
      actionType: 'social.facebook.publish_post',
      connectionId: metaConnId,
      params: postParams(),
      evidenceIds: [evidenceId],
      risk: usRisk,
      idempotencyKey: `fb-${randomUUID()}`,
    });
    expect(proposed.status).toBe('APPROVAL_REQUIRED');
    expect(proposed.policyDecision?.reasons.map((r) => r.code)).toContain('TENANT_POLICY_UNCONFIGURED');

    // Nothing reaches the provider before approval.
    expect(await executeAction(h.deps, h.tenantId, proposed.id)).toEqual({ kind: 'noop', status: 'APPROVAL_REQUIRED' });
    expect(server.requests).toHaveLength(0);

    await expect(
      decideApproval(h.deps, h.tenantId, { ...h.users.approver, mfaVerified: false }, proposed.id, { decision: 'approved', expectedActionHash: proposed.actionHash }),
    ).rejects.toThrow(/multi-factor/);
    await expect(
      decideApproval(h.deps, h.tenantId, h.users.approver, proposed.id, { decision: 'approved', expectedActionHash: 'f'.repeat(64) }),
    ).rejects.toThrow(/hash/);
    await expect(
      decideApproval(h.deps, h.tenantId, h.users.finance, proposed.id, { decision: 'approved', expectedActionHash: proposed.actionHash }),
    ).rejects.toThrow(/required role/);

    const partial = await decideApproval(h.deps, h.tenantId, h.users.approver, proposed.id, { decision: 'approved', expectedActionHash: proposed.actionHash });
    expect(partial.status).toBe('APPROVAL_REQUIRED');
    expect(partial.statusReason).toBe('awaiting approval groups: legal');
    const approved = await decideApproval(h.deps, h.tenantId, h.users.legal, proposed.id, { decision: 'approved', expectedActionHash: proposed.actionHash });
    expect(approved.status).toBe('APPROVED');

    const exec = await executeAction(h.deps, h.tenantId, proposed.id);
    expect(exec).toEqual({ kind: 'executed', status: 'EXECUTED_UNVERIFIED' });
    expect(server.find('POST', '/v26.0/123/feed')).toHaveLength(1);

    const ver = await verifyAction(h.deps, h.tenantId, proposed.id);
    expect(ver).toMatchObject({ kind: 'done', status: 'VERIFIED', verdict: 'VERIFIED' });

    const detail = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => getActionDetail(tx, proposed.id));
    expect(detail.transitions.map((x) => x.toStatus)).toEqual([
      'EVIDENCE_READY',
      'POLICY_CHECKED',
      'APPROVAL_REQUIRED',
      'APPROVED',
      'PREFLIGHT_VERIFIED',
      'EXECUTING',
      'EXECUTED_UNVERIFIED',
      'VERIFIED',
    ]);
    expect(detail.executions[0]!.responseArchiveKey).toMatch(new RegExp(`^t/${h.tenantId}/executions/`));
    // learn: the proof is admitted as primary evidence linked from the proof row
    const proof = detail.proofs[0]!;
    const [ev] = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, proof.evidenceId!)));
    expect(ev).toMatchObject({ sourceType: 'primary', status: 'admitted', kind: 'api_response' });
  });

  it('replays an idempotent proposal and rejects key reuse with a different payload', async () => {
    const key = `fb-${randomUUID()}`;
    const p = postParams('same');
    const a = await proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: p, evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: key });
    const b = await proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: p, evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: key });
    expect(b.id).toBe(a.id);
    await expect(
      proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams('other'), evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: key }),
    ).rejects.toThrow(/idempotency key reused/);
  });

  it('denies agent proposals without trusted evidence, and unknown action types', async () => {
    const denied = await proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams(), evidenceIds: [], risk: usRisk, idempotencyKey: `fb-${randomUUID()}` });
    expect(denied.status).toBe('DENIED');
    await expect(proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.buy_followers', connectionId: null, params: {}, idempotencyKey: `x-${randomUUID()}` })).rejects.toThrow(/allowlist/);
  });

  it('enforces separation of duties for human proposals', async () => {
    const a = await proposeAction(h.deps, h.tenantId, h.users.approver, { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams(), evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: `fb-${randomUUID()}` });
    expect(a.status).toBe('APPROVAL_REQUIRED');
    await expect(decideApproval(h.deps, h.tenantId, h.users.approver, a.id, { decision: 'approved', expectedActionHash: a.actionHash })).rejects.toThrow(/separation of duties/);
    const rejected = await decideApproval(h.deps, h.tenantId, h.users.admin, a.id, { decision: 'rejected', comment: 'not now', expectedActionHash: a.actionHash });
    expect(rejected.status).toBe('REJECTED');
  });

  it('rolls back a post whose readback does not match, and proves the rollback', async () => {
    let deleted = false;
    server.on('POST', '/v26.0/123/feed', { json: { id: '123_777' } });
    server.on('GET', '/v26.0/123_777', () =>
      deleted ? { status: 400, json: { error: { code: 100, message: 'does not exist' } } } : { json: { id: '123_777', message: 'TAMPERED', is_published: true } },
    );
    server.on('DELETE', '/v26.0/123_777', () => {
      deleted = true;
      return { json: { success: true } };
    });
    const a = await proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams('original'), evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: `fb-${randomUUID()}` });
    await approveAll(a);
    await executeAction(h.deps, h.tenantId, a.id);
    const v = await verifyAction(h.deps, h.tenantId, a.id);
    expect(v).toMatchObject({ status: 'ROLLED_BACK' });
    expect(deleted).toBe(true);
    const proofs = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => tx.select().from(executionProofs).where(eq(executionProofs.actionId, a.id)));
    expect(proofs.map((p) => `${p.purpose}:${p.verdict}`).sort()).toEqual(['postcondition:MISMATCH', 'rollback:VERIFIED']);
  });

  it('keeps EXECUTED_UNVERIFIED while readback is eventually consistent, then escalates on timeout', async () => {
    server.on('POST', '/v26.0/123/feed', { json: { id: '123_555' } });
    server.on('GET', '/v26.0/123_555', { status: 400, json: { error: { code: 100, message: 'not yet' } } });
    const a = await proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams('slow'), evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: `fb-${randomUUID()}` });
    await approveAll(a);
    await executeAction(h.deps, h.tenantId, a.id);
    for (let i = 1; i < h.deps.config.verification.maxAttempts; i++) {
      const r = await verifyAction(h.deps, h.tenantId, a.id);
      expect(r.kind).toBe('reschedule');
    }
    const last = await verifyAction(h.deps, h.tenantId, a.id);
    expect(last).toMatchObject({ kind: 'done', status: 'ESCALATED' });
    const inc = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => tx.select().from(incidents));
    expect(inc.some((i) => i.title.includes('Verification timed out'))).toBe(true);
  });

  it('a provider rejection is FAILED (not applied) and auth failures mark the connection for re-authorization', async () => {
    server.on('POST', '/v26.0/123/feed', { status: 400, json: { error: { code: 190, message: 'token expired' } } });
    const a = await proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams('x'), evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: `fb-${randomUUID()}` });
    await approveAll(a);
    expect(await executeAction(h.deps, h.tenantId, a.id)).toMatchObject({ kind: 'stopped', status: 'FAILED' });
    const [c] = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => tx.select().from(connections).where(eq(connections.id, metaConnId)));
    expect(c!.status).toBe('reauth_required');

    // While re-authorization is pending, approved intent is preserved (rescheduled, not failed).
    const b = await proposeAction(h.deps, h.tenantId, h.users.operator, { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams('queued'), evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: `fb-${randomUUID()}` });
    expect(b.status).toBe('DENIED'); // new proposals against an inactive connection are denied
    await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => tx.update(connections).set({ status: 'active' }).where(eq(connections.id, metaConnId)));
  });
});

describe('spend controls (M17/M24)', () => {
  const budgetParams = (prev: number, next: number) => ({
    customerId: '1234567890',
    campaignBudgetId: '77',
    campaignRef: 'c-1',
    newDailyBudget: { amountMicros: next, currency: 'USD' },
    previousDailyBudget: { amountMicros: prev, currency: 'USD' },
  });
  let liveMicros = 30_000_000;

  function mountGoogle(opts: { failMutate?: number } = {}) {
    server.on('POST', '/oauth/token', { json: { access_token: 'AT', expires_in: 3600 } });
    server.on('POST', '/v26/customers/1234567890/googleAds:search', (req) => {
      const q = (req.json as { query: string }).query;
      if (q.includes('FROM customer')) return { json: { results: [{ customer: { currencyCode: 'USD' } }] } };
      return { json: { results: [{ campaignBudget: { amountMicros: String(liveMicros) } }] } };
    });
    server.on('POST', '/v26/customers/1234567890/campaignBudgets:mutate', (req) => {
      const body = req.json as { validateOnly: boolean; operations: { update: { amountMicros: string } }[] };
      if (!body.validateOnly) {
        liveMicros = Number(body.operations[0]!.update.amountMicros);
        if (opts.failMutate) return { status: opts.failMutate, text: 'upstream error' };
      }
      return { json: { results: [{ resourceName: 'customers/1234567890/campaignBudgets/77' }] } };
    });
  }

  beforeAll(async () => {
    await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) =>
      setTenantPolicy(tx, h.tenantId, h.users.owner, {
        configured: true,
        currency: 'USD',
        approvedJurisdictions: ['US'],
        categories: {
          SPEND: {
            autonomy: 'pre_authorized_within_limits',
            approverRoles: ['finance_approver'],
            requiresDistinctApprover: true,
            maxSpendDeltaMicrosPerAction: 25_000_000,
            maxSpendDeltaMicrosPerDay: 30_000_000,
            maxAudienceSize: null,
          },
        },
      }),
    );
  });

  it('pre-authorizes within ceilings, reserves budget, and commits it on verification', async () => {
    liveMicros = 30_000_000;
    mountGoogle();
    const a = await proposeAction(h.deps, h.tenantId, agentActor(), {
      actionType: 'ads.google.update_campaign_budget',
      connectionId: googleConnId,
      params: budgetParams(30_000_000, 50_000_000),
      evidenceIds: [evidenceId],
      risk: { spendDeltaMicros: 20_000_000, currency: 'USD', geographies: ['US'] },
      idempotencyKey: `gb-${randomUUID()}`,
    });
    expect(a.status).toBe('APPROVED');
    expect(await executeAction(h.deps, h.tenantId, a.id)).toMatchObject({ status: 'EXECUTED_UNVERIFIED' });
    const [held] = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => tx.select().from(budgetReservations).where(eq(budgetReservations.actionId, a.id)));
    expect(held).toMatchObject({ status: 'held', amountMicros: 20_000_000 });
    expect(await verifyAction(h.deps, h.tenantId, a.id)).toMatchObject({ status: 'VERIFIED' });
    const [committed] = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => tx.select().from(budgetReservations).where(eq(budgetReservations.actionId, a.id)));
    expect(committed!.status).toBe('committed');
  });

  it('requires finance approval once the rolling 24h ceiling would be exceeded', async () => {
    const a = await proposeAction(h.deps, h.tenantId, agentActor(), {
      actionType: 'ads.google.update_campaign_budget',
      connectionId: googleConnId,
      params: budgetParams(50_000_000, 65_000_000),
      evidenceIds: [evidenceId],
      risk: { spendDeltaMicros: 15_000_000, currency: 'USD', geographies: ['US'] },
      idempotencyKey: `gb-${randomUUID()}`,
    });
    expect(a.status).toBe('APPROVAL_REQUIRED');
    expect(a.policyDecision?.reasons.map((r) => r.code)).toContain('SPEND_ABOVE_DAILY_CEILING');
    expect(a.policyDecision?.approvalGroups).toEqual([{ name: 'finance', anyOfRoles: ['finance_approver'] }]);
    await cancelAction(h.deps, h.tenantId, h.users.owner, a.id, 'test cleanup');
  });

  it('an ambiguous 5xx write escalates with an incident, and verification can still prove the outcome', async () => {
    liveMicros = 50_000_000;
    mountGoogle({ failMutate: 502 });
    h.clock.advance(25 * 3_600_000); // new 24h window
    const a = await proposeAction(h.deps, h.tenantId, agentActor(), {
      actionType: 'ads.google.update_campaign_budget',
      connectionId: googleConnId,
      params: budgetParams(50_000_000, 60_000_000),
      evidenceIds: [evidenceId],
      risk: { spendDeltaMicros: 10_000_000, currency: 'USD', geographies: ['US'] },
      idempotencyKey: `gb-${randomUUID()}`,
    });
    expect(a.status).toBe('APPROVED');
    expect(await executeAction(h.deps, h.tenantId, a.id)).toMatchObject({ kind: 'stopped', status: 'ESCALATED' });
    // The write was never retried automatically.
    expect(server.find('POST', '/v26/customers/1234567890/campaignBudgets:mutate').filter((r) => !(r.json as any).validateOnly)).toHaveLength(1);
    expect(await verifyAction(h.deps, h.tenantId, a.id)).toMatchObject({ status: 'VERIFIED' });
  });

  it('a stale precondition (budget changed since proposal) fails without writing', async () => {
    liveMicros = 41_000_000;
    mountGoogle();
    h.clock.advance(25 * 3_600_000);
    const a = await proposeAction(h.deps, h.tenantId, agentActor(), {
      actionType: 'ads.google.update_campaign_budget',
      connectionId: googleConnId,
      params: budgetParams(40_000_000, 45_000_000),
      evidenceIds: [evidenceId],
      risk: { spendDeltaMicros: 5_000_000, currency: 'USD', geographies: ['US'] },
      idempotencyKey: `gb-${randomUUID()}`,
    });
    expect(await executeAction(h.deps, h.tenantId, a.id)).toMatchObject({ status: 'FAILED' });
    expect(server.find('POST', '/v26/customers/1234567890/campaignBudgets:mutate')).toHaveLength(0);
    const [r] = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => tx.select().from(budgetReservations).where(eq(budgetReservations.actionId, a.id)));
    expect(r!.status).toBe('released');
  });
});

describe('kill switches (D-021)', () => {
  it('cancels queued actions in scope and denies new ones', async () => {
    const queued = await proposeAction(h.deps, h.tenantId, h.users.operator, { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams('q'), evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: `fb-${randomUUID()}` });
    expect(queued.status).toBe('APPROVAL_REQUIRED');
    const res = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) =>
      engageKillSwitch(tx, h.tenantId, h.users.operator, { scope: 'connector', targetRef: 'meta', reason: 'brand incident' }),
    );
    expect(res.cancelledActions).toContain(queued.id);
    const fresh = await proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: postParams('blocked'), evidenceIds: [evidenceId], risk: usRisk, idempotencyKey: `fb-${randomUUID()}` });
    expect(fresh.status).toBe('DENIED');
    expect(fresh.policyDecision?.reasons.map((r) => r.code)).toContain('KILL_SWITCH_ENGAGED');
    const n = await h.t.handle.db.execute<{ n: number }>(sql`select count(*)::int as n from action_requests where status = 'CANCELLED' and id = ${queued.id}`);
    expect(n.rows[0]!.n).toBe(1);
  });
});
