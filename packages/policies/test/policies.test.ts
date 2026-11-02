import { getActionType, type PlatformCapability, type TenantPolicy } from '@futuregrow/contracts';
import { describe, expect, it } from 'vitest';
import { approvalsSatisfy, defaultTenantPolicy, evaluatePolicy, type PolicyInput } from '../src/index.js';

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
    // FG-P2-001: a configured version past its effective sunset is blocked; before it, allowed.
    const now = new Date('2026-10-21T00:00:00Z');
    expect(codes(evaluatePolicy(budgetInput({ now }, { apiVersionSunset: { at: '2026-10-20T00:00:00.000Z', basis: 'test' } })))).toContain('API_VERSION_SUNSET');
    expect(codes(evaluatePolicy(budgetInput({ now }, { apiVersionSunset: { at: '2026-12-01T00:00:00.000Z', basis: 'test' } })))).not.toContain('API_VERSION_SUNSET');
    expect(codes(evaluatePolicy(budgetInput({}, { connection: { provider: 'google_ads', status: 'active', grantedScopes: [], appAudited: null, accessLevel: null } })))).toContain('MISSING_SCOPES');
    expect(codes(evaluatePolicy(budgetInput({}, { connection: { provider: 'google_ads', status: 'reauth_required', grantedScopes: [], appAudited: null, accessLevel: null } })))).toContain('CONNECTION_NOT_ACTIVE');
  });

  it('agents need admitted, current, execution-permitted evidence; humans fall back to approval', () => {
    expect(codes(evaluatePolicy(budgetInput({ evidenceIds: [] }, { evidence: [] })))).toContain('NO_EVIDENCE');
    const quarantined = budgetInput(
      {},
      {
        evidence: [{ id: EV, status: 'quarantined', freshnessStatus: 'current', permittedUses: ['autonomous_execution'], prohibitedUses: [], ageHours: 1 }],
      },
    );
    expect(evaluatePolicy(quarantined).outcome).toBe('DENY');
    expect(evaluatePolicy({ ...quarantined, proposedBy: { type: 'user', id: 'u1', modelId: null, promptVersion: null } }).outcome).toBe('REQUIRE_APPROVAL');
    const notPermitted = budgetInput(
      {},
      {
        evidence: [{ id: EV, status: 'admitted', freshnessStatus: 'current', permittedUses: ['analytics'], prohibitedUses: [], ageHours: 1 }],
      },
    );
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
    const draft = publishInput({ persona: { id: PERSONA, status: 'draft' }, disclosure: { isAiGenerated: true, paidPartnership: false, syntheticPersonaId: PERSONA, disclosureText: 'AI-generated virtual brand character' } }, { syntheticPersonaId: PERSONA });
    expect(codes(evaluatePolicy(draft))).toContain('PERSONA_NOT_APPROVED');
    const ok = publishInput({ persona: { id: PERSONA, status: 'approved' }, disclosure: { isAiGenerated: true, paidPartnership: false, syntheticPersonaId: PERSONA, disclosureText: 'AI-generated virtual brand character' } }, { syntheticPersonaId: PERSONA });
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

  // D-039: the Autopilot's organic Bangla Page post for BD, with no BD rule pack approved.
  const BANGLA = 'হাঙ্গুলের অক্ষর শিখুন—অ্যাপে হাঙ্গুল বর্ণমালা ও উচ্চারণের লেসন আছে। গেমের মাধ্যমে অক্ষরগুলোকে স্মরণ করুন।';
  const fbInput = (o: { message?: string; params?: Record<string, unknown>; risk?: Partial<PolicyInput['risk']>; facts?: Partial<PolicyInput['facts']>; proposedBy?: PolicyInput['proposedBy']; tenantPolicy?: TenantPolicy } = {}) =>
    budgetInput(
      {
        definition: getActionType('social.facebook.publish_post'),
        actionType: 'social.facebook.publish_post',
        params: { pageId: '777', message: o.message ?? BANGLA, assetIds: [], claimIds: [CLAIM], ...o.params },
        risk: { ...budgetInput().risk, spendDeltaMicros: 0, currency: null, geographies: ['BD'], ...o.risk },
        ...(o.proposedBy ? { proposedBy: o.proposedBy } : {}),
        ...(o.tenantPolicy ? { tenantPolicy: o.tenantPolicy } : {}),
      },
      {
        capability: cap('facebook_page_publish', 'meta', ['pages_manage_posts']),
        connection: { provider: 'meta', status: 'active', grantedScopes: ['pages_manage_posts'], appAudited: null, accessLevel: null },
        approvedJurisdictions: [],
        claims: [{ id: CLAIM, status: 'approved', expiresAt: null, regulated: false }],
        disclosure: { isAiGenerated: false, paidPartnership: false, syntheticPersonaId: null, disclosureText: null },
        organicPost: { copyLintPassed: true, lintCodes: [] },
        ...o.facts,
      },
    );
  const USER = { type: 'user', id: 'u1', modelId: null, promptVersion: null } as const;

  it('auto-allows an ordinary organic Bangla educational Page post without a jurisdiction rule pack (D-039)', () => {
    const d = evaluatePolicy(fbInput());
    expect(d.outcome).toBe('PRE_AUTHORIZED');
    expect(d.reasons).toEqual([expect.objectContaining({ rule: 'R-JURISDICTION', code: 'ORGANIC_EDUCATIONAL_POST', effect: 'PRE_AUTHORIZED' })]);
    expect(d.approvalGroups).toEqual([]);
    // With an approved pack for the market nothing is waived, so nothing is recorded.
    expect(evaluatePolicy(fbInput({ facts: { approvedJurisdictions: ['BD'] } })).reasons).toEqual([]);
    // The same Page post proposed by a person is auto-allowed too.
    expect(evaluatePolicy(fbInput({ proposedBy: USER })).outcome).toBe('PRE_AUTHORIZED');
  });

  it('blocks restricted or unsupported organic Autopilot posts instead of asking for approval (D-039)', () => {
    for (const message of ['কোরিয়ায় চাকরির জন্য এখনই প্রস্তুতি নিন', 'ভিসা প্রসেসিংয়ে আমরা সাহায্য করি', 'EPS-TOPIK পাস নিশ্চিত!', 'HRD Korea অনুমোদিত কোর্স', 'Get a job in Korea fast', 'Our official partner for visas']) {
      const d = evaluatePolicy(fbInput({ message }));
      expect(d.outcome, message).toBe('DENY');
      expect(codes(d), message).toContain('ORGANIC_POST_RESTRICTED');
    }
    // Both encodings of Bangla য় are caught.
    expect(evaluatePolicy(fbInput({ message: 'নিয়োগ চলছে' })).outcome).toBe('DENY');
    expect(evaluatePolicy(fbInput({ message: 'নিয়োগ চলছে' })).outcome).toBe('DENY');
    const lint = evaluatePolicy(fbInput({ facts: { organicPost: { copyLintPassed: false, lintCodes: ['UNSUBSTANTIATED_SUPERLATIVE'] } } }));
    expect(lint.outcome).toBe('DENY');
    expect(lint.reasons.find((r) => r.code === 'ORGANIC_POST_RESTRICTED')!.message).toMatch(/UNSUBSTANTIATED_SUPERLATIVE/);
    expect(codes(evaluatePolicy(fbInput({ facts: { claims: [{ id: CLAIM, status: 'pending_review', expiresAt: null, regulated: false }] } })))).toContain('CLAIM_NOT_APPROVED');
    // A person's restricted post keeps the legal path (rule pack or legal approval), unchanged.
    const human = evaluatePolicy(fbInput({ message: 'ভিসা তথ্য', proposedBy: USER }));
    expect(human.outcome).toBe('REQUIRE_APPROVAL');
    expect(codes(human)).toEqual(['JURISDICTION_UNAPPROVED']);
  });

  it('keeps the jurisdiction rule for everything outside the narrow organic path (D-039)', () => {
    const legal = (i: PolicyInput) => {
      const d = evaluatePolicy(i);
      expect(d.outcome).toBe('REQUIRE_APPROVAL');
      expect(codes(d)).toContain('JURISDICTION_UNAPPROVED');
      expect(d.approvalGroups.map((g) => g.name)).toContain('legal');
    };
    legal(fbInput({ params: { link: 'https://example.org/apply' } }));
    legal(fbInput({ facts: { claims: [] }, params: { claimIds: [] } }));
    legal(fbInput({ facts: { organicPost: null } }));
    legal(fbInput({ risk: { materialConnection: true }, facts: { disclosure: { isAiGenerated: false, paidPartnership: true, syntheticPersonaId: null, disclosureText: 'Paid partnership' } } }));
    legal(fbInput({ tenantPolicy: { ...configured, categories: { ...configured.categories, PUBLIC_PUBLISHING: { ...configured.categories.PUBLIC_PUBLISHING!, autonomy: 'approval_required' } } } }));
    const regulated = evaluatePolicy(fbInput({ facts: { claims: [{ id: CLAIM, status: 'approved', expiresAt: null, regulated: true }] } }));
    expect(codes(regulated)).toEqual(expect.arrayContaining(['JURISDICTION_UNAPPROVED', 'REGULATED_CLAIM']));
    expect(codes(evaluatePolicy(fbInput({ risk: { geographies: [] } })))).toContain('GEOGRAPHY_UNSPECIFIED');
    // Paid advertising, other publishing channels and outreach in BD still need the legal-approved pack.
    legal(budgetInput({ risk: { ...budgetInput().risk, geographies: ['BD'] } }));
    legal(publishInput({}, { geographies: ['BD'] }));
    legal({ ...emailInput(), risk: { ...emailInput().risk, geographies: ['BD'] } });
    // Kill switches still stop the organic post.
    expect(codes(evaluatePolicy(fbInput({ facts: { engagedKillSwitches: [{ scope: 'connector', targetRef: 'c1', reason: 'r' }] } })))).toContain('KILL_SWITCH_ENGAGED');
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
          quietHoursOk: true,
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
    expect(evaluatePolicy(emailInput({ quietHoursOk: false })).constraints.deferUntilOutsideQuietHours).toBe(true);
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
      approvalsSatisfy(
        groups,
        [
          { approverUserId: 'u1', roles: ['finance_approver', 'legal_approver'] },
          { approverUserId: 'u2', roles: ['finance_approver'] },
        ],
        opts,
      ).satisfied,
    ).toBe(true);
    expect(approvalsSatisfy(groups.slice(0, 1), [{ approverUserId: 'p', roles: ['finance_approver'] }], opts)).toEqual({ satisfied: false, missing: ['finance'] });
  });
});
