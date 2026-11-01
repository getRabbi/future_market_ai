import { randomUUID } from 'node:crypto';
import { ACTION_TYPES, jurisdictionDomainOf } from '@futuregrow/contracts';
import { jurisdictionRules, withSystem, withTenant } from '@futuregrow/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentActor, type CoreHarness, createCoreHarness, TEST_SIGN_OFF } from '../../../test/helpers/core.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { proposeAction } from '../src/modules/m23-execution/gateway.js';
import { approvedJurisdictionScopes, approvedJurisdictions, approveJurisdictionRules, draftJurisdictionRules, getTenantPolicy, listJurisdictionRules, setTenantPolicy } from '../src/modules/m24-governance/index.js';

/**
 * D-037: a jurisdiction rule pack approves its jurisdiction only for its own review domain, only
 * after an MFA-bound legal sign-off on the exact content, and never as a side effect of submitting it.
 */
let h: CoreHarness;
let metaConnId: string;
let evidenceId: string;

const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);
const bdPack = { jurisdiction: 'BD', domain: 'organic_social', rules: { scope: 'organic Facebook Page posts' }, sourceRefs: ['http://bdlaws.minlaw.gov.bd/act-1014/section-39152.html'] };

const proposePost = () =>
  proposeAction(h.deps, h.tenantId, agentActor('autopilot'), {
    actionType: 'social.facebook.publish_post',
    connectionId: metaConnId,
    params: { pageId: '123', message: 'নতুন লেসন যোগ হয়েছে।', postId: randomUUID(), claimIds: [], disclosure: { isAiGenerated: true, paidPartnership: false, syntheticPersonaId: null, disclosureText: null } },
    evidenceIds: [evidenceId],
    risk: { geographies: ['BD'] },
    idempotencyKey: `bd-post-${randomUUID()}`,
  });
const codes = (a: { policyDecision?: { reasons: { code: string }[] } | null }) => a.policyDecision?.reasons.map((r) => r.code) ?? [];

beforeAll(async () => {
  h = await createCoreHarness();
  metaConnId = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: 'page-123', displayName: 'Topik Page', grantedScopes: ['pages_manage_posts', 'pages_read_engagement'], credentials: { accessToken: 'PAGE_TOKEN' } })).id;
  evidenceId = (
    await tx((t) =>
      admitEvidence(
        t,
        h.tenantId,
        h.users.owner,
        {
          sourceType: 'primary',
          kind: 'snapshot',
          sourceOwner: 'topik',
          sourceUriOrObjectId: 'meta://page/123/posts@2026-11-01',
          retrievedAt: h.clock.now().toISOString(),
          licenseOrUsageRights: 'first-party',
          schemaVersion: '1',
          piiClassification: 'none',
          confidence: 0.9,
          permittedUses: ['autonomous_execution', 'publishing'],
          freshnessSlaHours: 24 * 90,
          content: { posts: 3 },
        },
        { now: h.clock.now() },
      ),
    )
  ).evidenceId;
  // The tenant enables BD and pre-authorizes publishing; only the legal pack is still missing.
  await tx((t) =>
    setTenantPolicy(t, h.tenantId, h.users.owner, {
      configured: true,
      currency: 'USD',
      approvedJurisdictions: ['BD'],
      categories: {
        PUBLIC_PUBLISHING: { autonomy: 'pre_authorized_within_limits', approverRoles: ['approver'], requiresDistinctApprover: true, maxSpendDeltaMicrosPerAction: null, maxSpendDeltaMicrosPerDay: null, maxAudienceSize: null },
      },
    }),
  );
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('jurisdiction rule packs: drafts, MFA-bound legal approval and domain scope (D-037)', () => {
  it('maps every action type the jurisdiction rule applies to onto exactly one review domain', () => {
    for (const d of ACTION_TYPES) {
      const needs = d.publicFacing || d.contactsPeople || ['SPEND', 'PRICING', 'DATA_EXPORT'].includes(d.category);
      if (needs) expect(jurisdictionDomainOf(d.type), d.type).not.toBeNull();
    }
  });

  it('a submitted draft never unlocks its jurisdiction, and a submission cannot approve itself', async () => {
    await expect(draftJurisdictionRules(h.t.handle.db, h.tenantId, h.users.owner, { ...bdPack, approve: true })).rejects.toThrow();
    await expect(draftJurisdictionRules(h.t.handle.db, h.tenantId, h.users.owner, { ...bdPack, sourceRefs: [] })).rejects.toThrow();
    await expect(draftJurisdictionRules(h.t.handle.db, h.tenantId, h.users.owner, { ...bdPack, domain: 'everything' })).rejects.toThrow();
    await expect(draftJurisdictionRules(h.t.handle.db, h.tenantId, h.users.approver, bdPack)).rejects.toThrow(/platform administrator/);

    const draft = await draftJurisdictionRules(h.t.handle.db, h.tenantId, h.users.owner, bdPack);
    expect(draft).toMatchObject({ status: 'draft', approvedByLegal: false, approvedBy: null, signOff: null, createdBy: h.users.owner.id });
    expect(await tx(async (t) => approvedJurisdictionScopes(t, await getTenantPolicy(t, h.tenantId)))).toEqual({});

    const post = await proposePost();
    expect(post.status).toBe('APPROVAL_REQUIRED');
    expect(codes(post)).toContain('JURISDICTION_UNAPPROVED');
    expect(codes(post)).not.toContain('TENANT_POLICY_UNCONFIGURED');

    // The database refuses an approval flag without sign-off provenance, whatever path writes it.
    await expect(withSystem(h.t.handle.db, 'user:test', (t) => t.execute(sql`update jurisdiction_rules set approved_by_legal = true, approved_by = 'x', approved_at = now() where id = ${draft.id}`))).rejects.toThrow(/jurisdiction_rules_approval_chk/);
  });

  it('approval needs a platform administrator in an MFA session, the reviewed content hash and a complete sign-off', async () => {
    const draft = (await listJurisdictionRules(h.t.handle.db, h.users.owner)).find((r) => r.jurisdiction === 'BD' && r.status === 'draft')!;
    const approve = (actor: typeof h.users.owner, body: unknown) => approveJurisdictionRules(h.t.handle.db, h.tenantId, actor, draft.id, body);
    const valid = { expectedRulesHash: draft.contentHash, signOff: TEST_SIGN_OFF };

    await expect(approve({ ...h.users.owner, mfaVerified: false }, valid)).rejects.toThrow(/multi-factor/);
    await expect(approve(h.users.approver, valid)).rejects.toThrow(/platform administrator/);
    await expect(approve(h.users.owner, { ...valid, expectedRulesHash: 'f'.repeat(64) })).rejects.toThrow(/hash mismatch/);
    await expect(approve(h.users.owner, { expectedRulesHash: draft.contentHash })).rejects.toThrow();
    await expect(approve(h.users.owner, { ...valid, signOff: { ...TEST_SIGN_OFF, statement: 'ok' } })).rejects.toThrow();
    await expect(approve(h.users.owner, { ...valid, signOff: { ...TEST_SIGN_OFF, reviewedAt: '2999-01-01' } })).rejects.toThrow(/future/);
    expect((await withSystem(h.t.handle.db, 'user:test', (t) => t.select().from(jurisdictionRules).where(eq(jurisdictionRules.id, draft.id))))[0]!.approvedByLegal).toBe(false);

    const approved = await approve(h.users.owner, valid);
    expect(approved).toMatchObject({ status: 'approved', approvedByLegal: true, approvedBy: h.users.owner.id, rulesHash: draft.contentHash, signOff: TEST_SIGN_OFF });
    await expect(approve(h.users.owner, valid)).rejects.toThrow(/already approved/);

    const events = await tx((t) => t.execute<{ action: string; payload: { rulesHash: string; signOff: { reviewerName: string } } }>(sql`select action, payload from audit_log where subject_id = ${draft.id} order by seq`));
    expect(events.rows.map((e) => e.action)).toEqual(['governance.jurisdiction_rules.drafted', 'governance.jurisdiction_rules.approved']);
    expect(events.rows[1]!.payload).toMatchObject({ rulesHash: draft.contentHash, signOff: { reviewerName: TEST_SIGN_OFF.reviewerName } });
  });

  it('an approved organic-social BD pack authorizes organic posts only, never other BD activity', async () => {
    const post = await proposePost();
    expect(codes(post)).not.toContain('JURISDICTION_UNAPPROVED');
    expect(post.status).not.toBe('APPROVAL_REQUIRED');

    const reply = await proposeAction(h.deps, h.tenantId, agentActor('autopilot'), {
      actionType: 'social.facebook.reply_comment',
      connectionId: metaConnId,
      params: { commentId: '123_456', message: 'ধন্যবাদ!', interactionId: randomUUID(), claimIds: [] },
      evidenceIds: [evidenceId],
      risk: { geographies: ['BD'] },
      idempotencyKey: `bd-reply-${randomUUID()}`,
    });
    expect(codes(reply)).toContain('JURISDICTION_UNAPPROVED');

    // M23 reads the same per-action-type facts for every other action type.
    const covered = await tx(async (t) => {
      const policy = await getTenantPolicy(t, h.tenantId);
      const out: Record<string, boolean> = {};
      for (const d of ACTION_TYPES) out[d.type] = (await approvedJurisdictions(t, policy, d.type)).includes('BD');
      return out;
    });
    for (const d of ACTION_TYPES) expect(covered[d.type], d.type).toBe(jurisdictionDomainOf(d.type) === 'organic_social');
    for (const unrelated of ['ads.meta.update_campaign_budget', 'ads.google.update_campaign_budget', 'email.send', 'sms.send', 'whatsapp.send', 'commerce.shopify.create_discount', 'store.app_store.update_localization', 'data.export_customer_data', 'social.facebook.reply_comment']) {
      expect(covered[unrelated], unrelated).toBe(false);
    }
  });
});
