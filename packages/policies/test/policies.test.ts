import { describe, expect, it } from 'vitest';
import { type PlatformCapability, type TenantPolicy, getActionType } from '@futuregrow/contracts';
import { type PolicyInput, approvalsSatisfy, defaultTenantPolicy, evaluatePolicy } from '../src/index.js';

const NOW = new Date('2026-10-19T12:00:00Z');
const EV = '11111111-1111-4111-8111-111111111111';
const CLAIM = '22222222-2222-4222-8222-222222222222';
const PERSONA = '33333333-3333-4333-8333-333333333333';

const configured: TenantPolicy = {
  ...defaultTenantPolicy(),
  configured: true,
  currency: 'USD',
  approvedJurisdictions: ['US'],
  categories: {
    SPEND: {
      autonomy: 'pre_authorized_within_limits',
      approverRoles: ['finance_approver'],
      requiresDistinctApprover: true,
      maxSpendDeltaMicrosPerAction: 50_000_000,
      maxSpendDeltaMicrosPerDay: 100_000_000,
      maxAudienceSize: null,
    },
    PUBLIC_PUBLISHING: {
      autonomy: 'pre_authorized_within_limits',
      approverRoles: ['approver'],
      requiresDistinctApprover: true,
      maxSpendDeltaMicrosPerAction: null,
      maxSpendDeltaMicrosPerDay: null,
      maxAudienceSize: null,
    },
    MESSAGING: {
      autonomy: 'pre_authorized_within_limits',
      approverRoles: ['approver'],
      requiresDistinctApprover: true,
      maxSpendDeltaMicrosPerAction: null,
      maxSpendDeltaMicrosPerDay: null,
      maxAudienceSize: 1,
    },
  },
};

const cap = (capability: string, platform: PlatformCapability['platform'], scopes: string[]): PlatformCapability => ({
  platform,
  apiVersion: 'v26',
  capability,
  supported: true,
  requiredScopes: scopes,
  requiredAccountType: null,
  appReviewRequired: 'true',
  rateLimitPolicy: { kind: 'token_bucket', capacity: 10, refillPerSecond: 1, notes: null },
  quota: {},
  regionalRestrictions: [],
  termsCheckedAt: '2026-10-19T00:00:00Z',
  termsVersion: null,
  connectorVersion: '1.0.0',
  fallback: 'queue_for_human',
  sourceUrl: null,
  notes: null,
});

function budgetInput(over: Partial<PolicyInput> = {}, factsOver: Partial<PolicyInput['facts']> = {}): PolicyInput {
  return {
    definition: getActionType('ads.google.update_campaign_budget'),
    actionType: 'ads.google.update_campaign_budget',
    params: {},
    risk: {
      spendDeltaMicros: 10_000_000,
      currency: 'USD',
      audienceSize: null,
      geographies: ['US'],
      usesSensitiveAttributes: false,
      involvesChildren: false,
      syntheticPersonaId: null,
      materialConnection: false,
      regulatedClaim: false,
    },
    proposedBy: { type: 'agent', id: 'brain', modelId: 'm', promptVersion: 'p' },
    evidenceIds: [EV],
    tenantPolicy: configured,
    now: NOW,
    ...over,
    facts: {
      systemHalted: false,
      engagedKillSwitches: [],
      capability: cap('google_ads_campaign_budget_mutate', 'google_ads', ['https://www.googleapis.com/auth/adwords']),
      configuredApiVersion: 'v26',
      connection: { provider: 'google_ads', status: 'active', grantedScopes: ['https://www.googleapis.com/auth/adwords'], appAudited: null, accessLevel: 'basic' },
      evidence: [{ id: EV, status: 'admitted', freshnessStatus: 'current', permittedUses: ['autonomous_execution'], prohibitedUses: [], ageHours: 2 }],
      missingEvidenceIds: [],
      claims: [],
      missingClaimIds: [],
      approvedJurisdictions: ['US'],
      rollingPreAuthorizedSpendMicros: 0,
      messaging: null,
      persona: null,
      assets: [],
      missingAssetIds: [],
      disclosure: null,
      ...factsOver,
    },
  };
}

const codes = (d: ReturnType<typeof evaluatePolicy>) => d.reasons.map((r) => r.code);

describe('policy engine', () => {
  it('pre-authorizes a small, evidenced budget increase within configured ceilings', () => {
    const d = evaluatePolicy(budgetInput());
    expect(d.outcome).toBe('PRE_AUTHORIZED');
    expect(d.reasons).toEqual([]);
    expect(d.constraints.spendDeltaMicros).toBe(10_000_000);
  });

  it('never pre-authorizes while the tenant policy is unconfigured (D-012)', () => {
    const d = evaluatePolicy(budgetInput({ tenantPolicy: { ...defaultTenantPolicy(), approvedJurisdictions: ['US'] } }));
    expect(d.outcome).toBe('REQUIRE_APPROVAL');
    expect(codes(d)).toContain('TENANT_POLICY_UNCONFIGURED');
    expect(d.approvalGroups[0]).toMatchObject({ name: 'finance', anyOfRoles: ['finance_approver', 'owner'] });
  });

  it('denies unknown and unsupported action types', () => {
    expect(evaluatePolicy(budgetInput({ definition: undefined, actionType: 'social.buy_followers' })).outcome).toBe('DENY');
    const sms = evaluatePolicy(budgetInput({ definition: getActionType('sms.send'), actionType: 'sms.send' }));
    expect(sms.outcome).toBe('DENY');
    expect(codes(sms)).toContain('UNSUPPORTED_ACTION_TYPE');
  });

  it('requires approval above per-action and rolling daily ceilings', () => {
    expect(codes(evaluatePolicy(budgetInput({ risk: { ...budgetInput().risk, spendDeltaMicros: 60_000_000 } })))).toContain('SPEND_ABOVE_ACTION_CEILING');
    expect(codes(evaluatePolicy(budgetInput({}, { rollingPreAuthorizedSpendMicros: 95_000_000 })))).toContain('SPEND_ABOVE_DAILY_CEILING');
  });

  it('spend decreases are not blocked by spend ceilings', () => {
    const d = evaluatePolicy(budgetInput({ risk: { ...budgetInput().risk, spendDeltaMicros: -40_000_000 } }, { rollingPreAuthorizedSpendMicros: 99_000_000 }));
    expect(d.outcome).toBe('PRE_AUTHORIZED');
  });

  it('denies on kill switch, missing capability, missing scope, inactive connection', () => {
    expect(evaluatePolicy(budgetInput({}, { systemHalted: true })).outcome).toBe('DENY');
    expect(codes(evaluatePolicy(budgetInput({}, { engagedKillSwitches: [{ scope: 'connector', targetRef: 'x', reason: 'r' }] })))).toContain('KILL_SWITCH_ENGAGED');
    expect(codes(evaluatePolicy(budgetInput({}, { capability: null })))).toContain('CAPABILITY_UNKNOWN');
    expect(codes(evaluatePolicy(budgetInput({}, { configuredApiVersion: 'v27' })))).toContain('API_VERSION_UNREGISTERED');
    expect(
      codes(evaluatePolicy(budgetInput({}, { connection: { provider: 'google_ads', status: 'active', grantedScopes: [], appAudited: null, accessLevel: null } }))),
    ).toContain('MISSING_SCOPES');
    expect(
      codes(evaluatePolicy(budgetInput({}, { connection: { provider: 'google_ads', status: 'reauth_required', grantedScopes: [], appAudited: null, accessLevel: null } }))),
    ).toContain('CONNECTION_NOT_ACTIVE');
  });

  it('agents need admitted, current, execution-permitted evidence; humans fall back to approval', () => {
    expect(codes(evaluatePolicy(budgetInput({ evidenceIds: [] }, { evidence: [] })))).toContain('NO_EVIDENCE');
    const quarantined = budgetInput({}, {
      evidence: [{ id: EV, status: 'quarantined', freshnessStatus: 'current', permittedUses: ['autonomous_execution'], prohibitedUses: [], ageHours: 1 }],
    });
    expect(evaluatePolicy(quarantined).outcome).toBe('DENY');
    expect(evaluatePolicy({ ...quarantined, proposedBy: { type: 'user', id: 'u1', modelId: null, promptVersion: null } }).outcome).toBe('REQUIRE_APPROVAL');
    const notPermitted = budgetInput({}, {
      evidence: [{ id: EV, status: 'admitted', freshnessStatus: 'current', permittedUses: ['analytics'], prohibitedUses: [], ageHours: 1 }],
    });
    expect(evaluatePolicy(notPermitted).outcome).toBe('DENY');
    const human = budgetInput({ evidenceIds: [], proposedBy: { type: 'user', id: 'u1', modelId: null, promptVersion: null } }, { evidence: [] });
    expect(codes(evaluatePolicy(human))).toContain('HUMAN_ATTESTED_NO_EVIDENCE');
    expect(evaluatePolicy(budgetInput({}, { missingEvidenceIds: [EV] })).outcome).toBe('DENY');
  });

  it('blocks children and sensitive targeting outright', () => {
    expect(codes(evaluatePolicy(budgetInput({ risk: { ...budgetInput().risk, involvesChildren: true } })))).toContain('CHILDREN_DATA_BLOCKED');
    expect(codes(evaluatePolicy(budgetInput({ risk: { ...budgetInput().risk, usesSensitiveAttributes: true } })))).toContain('SENSITIVE_TARGETING_BLOCKED');
  });

  it('routes unapproved or unspecified jurisdictions to legal approval', () => {
    const eu = evaluatePolicy(budgetInput({ risk: { ...budgetInput().risk, geographies: ['US', 'DE'] } }));
    expect(eu.outcome).toBe('REQUIRE_APPROVAL');
    expect(eu.approvalGroups.map((g) => g.name)).toContain('legal');
    expect(codes(evaluatePolicy(budgetInput({ risk: { ...budgetInput().risk, geographies: [] } })))).toContain('GEOGRAPHY_UNSPECIFIED');
  });

  const publishInput = (factsOver: Partial<PolicyInput['facts']> = {}, riskOver: Partial<PolicyInput['risk']> = {}, params: Record<string, unknown> = {}) =>
    budgetInput(
      {
        definition: getActionType('social.tiktok.publish_video'),
        actionType: 'social.tiktok.publish_video',
        params: { privacyLevel: 'SELF_ONLY', ...params },
        risk: { ...budgetInput().risk, spendDeltaMicros: 0, ...riskOver },
      },
      {
        capability: cap('tiktok_direct_post', 'tiktok', ['video.publish']),
        connection: { provider: 'tiktok', status: 'active', grantedScopes: ['video.publish'], appAudited: false, accessLevel: null },
        assets: [{ id: 'a1', publishEligible: true, reasons: [] }],
        disclosure: { isAiGenerated: false, paidPartnership: false, syntheticPersonaId: null, disclosureText: null },
        ...factsOver,
      },
    );

  it('unaudited TikTok clients may only publish SELF_ONLY', () => {
    expect(evaluatePolicy(publishInput()).outcome).toBe('PRE_AUTHORIZED');
    expect(codes(evaluatePolicy(publishInput({}, {}, { privacyLevel: 'PUBLIC_TO_EVERYONE' })))).toContain('TIKTOK_UNAUDITED_PUBLIC');
    const audited = publishInput({ connection: { provider: 'tiktok', status: 'active', grantedScopes: ['video.publish'], appAudited: true, accessLevel: null } }, {}, { privacyLevel: 'PUBLIC_TO_EVERYONE' });
    expect(evaluatePolicy(audited).outcome).toBe('PRE_AUTHORIZED');
  });

  it('synthetic personas must be approved and disclosed; material connections disclosed', () => {
    const undisclosed = publishInput({ persona: { id: PERSONA, status: 'approved' } }, { syntheticPersonaId: PERSONA });
    expect(codes(evaluatePolicy(undisclosed))).toContain('SYNTHETIC_DISCLOSURE_MISSING');
    const draft = publishInput(
      { persona: { id: PERSONA, status: 'draft' }, disclosure: { isAiGenerated: true, paidPartnership: false, syntheticPersonaId: PERSONA, disclosureText: 'AI-generated virtual brand character' } },
      { syntheticPersonaId: PERSONA },
    );
    expect(codes(evaluatePolicy(draft))).toContain('PERSONA_NOT_APPROVED');
    const ok = publishInput(
      { persona: { id: PERSONA, status: 'approved' }, disclosure: { isAiGenerated: true, paidPartnership: false, syntheticPersonaId: PERSONA, disclosureText: 'AI-generated virtual brand character' } },
      { syntheticPersonaId: PERSONA },
    );
    expect(evaluatePolicy(ok).outcome).toBe('PRE_AUTHORIZED');
    expect(codes(evaluatePolicy(publishInput({}, { materialConnection: true })))).toContain('MATERIAL_CONNECTION_UNDISCLOSED');
  });

  it('claims must be approved and unexpired; regulated claims need legal approval', () => {
    expect(codes(evaluatePolicy(publishInput({ claims: [{ id: CLAIM, status: 'pending_review', expiresAt: null, regulated: false }] })))).toContain('CLAIM_NOT_APPROVED');
    expect(codes(evaluatePolicy(publishInput({ claims: [{ id: CLAIM, status: 'approved', expiresAt: new Date('2026-01-01'), regulated: false }] })))).toContain('CLAIM_EXPIRED');
    const regulated = evaluatePolicy(publishInput({ claims: [{ id: CLAIM, status: 'approved', expiresAt: null, regulated: true }] }));
    expect(regulated.outcome).toBe('REQUIRE_APPROVAL');
    expect(regulated.approvalGroups.map((g) => g.name)).toEqual(['legal']);
    expect(codes(evaluatePolicy(publishInput({ missingClaimIds: [CLAIM] })))).toContain('CLAIM_NOT_FOUND');
  });

  it('assets must be publish-eligible', () => {
    expect(codes(evaluatePolicy(publishInput({ assets: [{ id: 'a1', publishEligible: false, reasons: ['music rights unknown'] }] })))).toContain('ASSET_NOT_ELIGIBLE');
  });

  const emailInput = (m: Partial<NonNullable<PolicyInput['facts']['messaging']>> = {}, audienceSize: number | null = 1) =>
    budgetInput(
      {
        definition: getActionType('email.send'),
        actionType: 'email.send',
        risk: { ...budgetInput().risk, spendDeltaMicros: 0, audienceSize },
      },
      {
        capability: cap('email_send', 'resend', []),
        connection: { provider: 'resend', status: 'active', grantedScopes: [], appAudited: null, accessLevel: null },
        messaging: {
          category: 'commercial',
          consentGranted: true,
          suppressed: false,
          isChild: null,
          senderIdentityComplete: true,
          withinFrequencyCap: true,
          withinQuietHours: true,
          ...m,
        },
      },
    );

  it('messaging: suppression, consent, sender identity and frequency caps', () => {
    expect(evaluatePolicy(emailInput()).outcome).toBe('PRE_AUTHORIZED');
    expect(codes(evaluatePolicy(emailInput({ suppressed: true })))).toContain('RECIPIENT_SUPPRESSED');
    expect(codes(evaluatePolicy(emailInput({ consentGranted: false })))).toContain('NO_MARKETING_CONSENT');
    expect(codes(evaluatePolicy(emailInput({ senderIdentityComplete: false })))).toContain('SENDER_IDENTITY_INCOMPLETE');
    expect(codes(evaluatePolicy(emailInput({ withinFrequencyCap: null })))).toContain('FREQUENCY_CAP_UNCONFIGURED');
    expect(codes(evaluatePolicy(emailInput({ isChild: true })))).toContain('CHILDREN_DATA_BLOCKED');
    // transactional mail does not need marketing consent but still honours suppression
    expect(evaluatePolicy(emailInput({ category: 'transactional', consentGranted: false })).outcome).toBe('PRE_AUTHORIZED');
    expect(evaluatePolicy(emailInput({}, 5)).outcome).toBe('REQUIRE_APPROVAL');
    expect(evaluatePolicy(emailInput({ withinQuietHours: false })).constraints.deferUntilOutsideQuietHours).toBe(true);
  });

  it('is deterministic', () => {
    const a = evaluatePolicy(budgetInput({ risk: { ...budgetInput().risk, geographies: ['US', 'DE'] } }));
    const b = evaluatePolicy(budgetInput({ risk: { ...budgetInput().risk, geographies: ['US', 'DE'] } }));
    expect(a).toEqual(b);
  });
});

describe('approvalsSatisfy (separation of duties)', () => {
  const groups = [
    { name: 'finance', anyOfRoles: ['finance_approver'] as const },
    { name: 'legal', anyOfRoles: ['legal_approver'] as const },
  ].map((g) => ({ ...g, anyOfRoles: [...g.anyOfRoles] }));

  it('requires distinct people per group and excludes the proposer', () => {
    const opts = { proposerId: 'p', requiresDistinctApprover: true };
    expect(approvalsSatisfy(groups, [{ approverUserId: 'u1', roles: ['finance_approver', 'legal_approver'] }], opts).satisfied).toBe(false);
    expect(
      approvalsSatisfy(groups, [
        { approverUserId: 'u1', roles: ['finance_approver', 'legal_approver'] },
        { approverUserId: 'u2', roles: ['finance_approver'] },
      ], opts).satisfied,
    ).toBe(true);
    expect(approvalsSatisfy(groups.slice(0, 1), [{ approverUserId: 'p', roles: ['finance_approver'] }], opts)).toEqual({ satisfied: false, missing: ['finance'] });
  });
});
