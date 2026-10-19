import {
  type ActionRisk,
  type ActionTypeDefinition,
  type ApprovalGroup,
  type CategoryPolicy,
  type DataPurpose,
  type PlatformCapability,
  type PolicyDecision,
  type PolicyOutcome,
  type Proposer,
  type RiskCategory,
  type TenantPolicy,
  type TenantRole,
} from '@futuregrow/contracts';

export const POLICY_VERSION = 'fg-policy-1.0.0';

/* ------------------------------------------------------------------ */
/* Inputs: facts are gathered by the caller from the database; the      */
/* engine itself is a pure, deterministic function (easy to audit/test) */
/* ------------------------------------------------------------------ */

export interface EvidenceFact {
  id: string;
  status: 'admitted' | 'quarantined' | 'rejected' | 'expired';
  freshnessStatus: 'current' | 'stale' | 'unknown';
  permittedUses: readonly string[];
  prohibitedUses: readonly string[];
  ageHours: number;
}

export interface ClaimFact {
  id: string;
  status: 'approved' | 'pending_review' | 'rejected' | 'expired';
  expiresAt: Date | null;
  regulated: boolean;
}

export interface ConnectionFact {
  provider: string;
  status: 'active' | 'reauth_required' | 'revoked' | 'disabled' | 'read_only';
  grantedScopes: readonly string[];
  appAudited: boolean | null;
  accessLevel: string | null;
}

export interface MessagingFact {
  category: 'transactional' | 'commercial';
  consentGranted: boolean;
  suppressed: boolean;
  isChild: boolean | null;
  senderIdentityComplete: boolean;
  /** null = could not be evaluated because the tenant has not configured a cap ([U]). */
  withinFrequencyCap: boolean | null;
  withinQuietHours: boolean | null;
}

export interface PersonaFact {
  id: string;
  status: 'draft' | 'approved' | 'suspended' | 'blocked';
}

export interface AssetFact {
  id: string;
  publishEligible: boolean;
  reasons: readonly string[];
}

export interface DisclosureFact {
  isAiGenerated: boolean;
  paidPartnership: boolean;
  syntheticPersonaId: string | null;
  disclosureText: string | null;
}

export interface PolicyFacts {
  systemHalted: boolean;
  /** Engaged kill switches relevant to this action (already filtered by scope/target). */
  engagedKillSwitches: readonly { scope: string; targetRef: string | null; reason: string }[];
  capability: PlatformCapability | null;
  configuredApiVersion: string | null;
  connection: ConnectionFact | null;
  evidence: readonly EvidenceFact[];
  missingEvidenceIds: readonly string[];
  claims: readonly ClaimFact[];
  missingClaimIds: readonly string[];
  /** Jurisdictions with a legal-approved rule pack AND enabled by the tenant. */
  approvedJurisdictions: readonly string[];
  /** Pre-authorised positive spend deltas in the trailing 24h (micros, tenant currency). */
  rollingPreAuthorizedSpendMicros: number;
  messaging: MessagingFact | null;
  persona: PersonaFact | null;
  assets: readonly AssetFact[];
  missingAssetIds: readonly string[];
  disclosure: DisclosureFact | null;
}

export interface PolicyInput {
  definition: ActionTypeDefinition | undefined;
  actionType: string;
  params: Record<string, unknown>;
  risk: ActionRisk;
  proposedBy: Proposer;
  evidenceIds: readonly string[];
  tenantPolicy: TenantPolicy;
  facts: PolicyFacts;
  now: Date;
}

interface Finding {
  rule: string;
  code: string;
  message: string;
  effect: PolicyOutcome;
  approvalGroup?: ApprovalGroup;
}

/* ------------------------------------------------------------------ */
/* Defaults used ONLY to name who may approve when a tenant has not   */
/* configured its matrix. They never grant autonomy (D-012).          */
/* ------------------------------------------------------------------ */

const DEFAULT_APPROVERS: Record<RiskCategory, TenantRole[]> = {
  SPEND: ['finance_approver', 'owner'],
  PRICING: ['finance_approver', 'owner'],
  PAYOUT: ['finance_approver', 'owner'],
  PUBLIC_PUBLISHING: ['approver', 'admin', 'owner'],
  MESSAGING: ['approver', 'admin', 'owner'],
  TARGETING: ['approver', 'privacy_officer', 'owner'],
  DATA_EXPORT: ['privacy_officer', 'owner'],
  SYNTHETIC_PERSONA: ['approver', 'legal_approver', 'owner'],
  EXPERIMENT: ['approver', 'admin', 'owner'],
  STORE_METADATA: ['approver', 'admin', 'owner'],
  INTERNAL: ['admin', 'owner'],
};

const LEGAL_GROUP: ApprovalGroup = { name: 'legal', anyOfRoles: ['legal_approver', 'owner'] };

export function categoryPolicy(policy: TenantPolicy, category: RiskCategory): CategoryPolicy | null {
  if (!policy.configured) return null;
  return policy.categories[category] ?? null;
}

const deny = (rule: string, code: string, message: string): Finding => ({ rule, code, message, effect: 'DENY' });
const approve = (rule: string, code: string, message: string, approvalGroup?: ApprovalGroup): Finding => ({
  rule,
  code,
  message,
  effect: 'REQUIRE_APPROVAL',
  ...(approvalGroup ? { approvalGroup } : {}),
});

/* ------------------------------------------------------------------ */
/* Rules                                                              */
/* ------------------------------------------------------------------ */

function ruleAllowlist(i: PolicyInput): Finding[] {
  if (!i.definition) return [deny('R-ALLOWLIST', 'UNKNOWN_ACTION_TYPE', `action type ${i.actionType} is not on the allowlist`)];
  if (!i.definition.supported) {
    return [deny('R-ALLOWLIST', 'UNSUPPORTED_ACTION_TYPE', `action type ${i.actionType} is not supported (${i.definition.blockerRef ?? 'blocked'})`)];
  }
  return [];
}

function ruleKillSwitches(i: PolicyInput): Finding[] {
  const out: Finding[] = [];
  if (i.facts.systemHalted) out.push(deny('R-KILL', 'SYSTEM_HALTED', 'system-wide kill switch is engaged'));
  for (const k of i.facts.engagedKillSwitches) {
    out.push(deny('R-KILL', 'KILL_SWITCH_ENGAGED', `kill switch engaged (${k.scope}${k.targetRef ? `:${k.targetRef}` : ''}): ${k.reason}`));
  }
  return out;
}

function ruleCapability(i: PolicyInput): Finding[] {
  const d = i.definition;
  if (!d || d.provider === 'internal') return [];
  const cap = i.facts.capability;
  if (!cap) return [deny('R-CAPABILITY', 'CAPABILITY_UNKNOWN', `no capability record for ${d.provider}/${d.capability}; unknown permission state means DENY`)];
  if (!cap.supported) return [deny('R-CAPABILITY', 'CAPABILITY_UNSUPPORTED', `${d.capability} is marked unsupported (fallback ${cap.fallback})`)];
  if (i.facts.configuredApiVersion && cap.apiVersion !== i.facts.configuredApiVersion) {
    return [deny('R-CAPABILITY', 'API_VERSION_UNREGISTERED', `configured API version ${i.facts.configuredApiVersion} has no capability record (registered ${cap.apiVersion})`)];
  }
  return [];
}

function ruleConnection(i: PolicyInput): Finding[] {
  const d = i.definition;
  if (!d || d.provider === 'internal') return [];
  const c = i.facts.connection;
  if (!c) return [deny('R-CONNECTION', 'NO_CONNECTION', 'an authorized connection is required')];
  if (c.provider !== d.provider) return [deny('R-CONNECTION', 'CONNECTION_PROVIDER_MISMATCH', `connection is for ${c.provider}, action needs ${d.provider}`)];
  if (c.status !== 'active') return [deny('R-CONNECTION', 'CONNECTION_NOT_ACTIVE', `connection status is ${c.status}`)];
  const missing = (i.facts.capability?.requiredScopes ?? []).filter((s) => !c.grantedScopes.includes(s));
  if (missing.length) return [deny('R-CONNECTION', 'MISSING_SCOPES', `connection lacks required scopes: ${missing.join(', ')}`)];
  return [];
}

function ruleEvidence(i: PolicyInput): Finding[] {
  const autonomous = i.proposedBy.type !== 'user';
  const out: Finding[] = [];
  const f = i.facts;
  const maxAge = i.tenantPolicy.evidenceMaxAgeHours;
  const purpose: DataPurpose = 'autonomous_execution';

  if (i.evidenceIds.length === 0) {
    if (autonomous) return [deny('R-EVIDENCE', 'NO_EVIDENCE', 'agent/system proposals require evidence')];
    return [approve('R-EVIDENCE', 'HUMAN_ATTESTED_NO_EVIDENCE', 'no evidence attached; human proposal requires approval')];
  }
  if (f.missingEvidenceIds.length) {
    out.push(deny('R-EVIDENCE', 'EVIDENCE_NOT_FOUND', `evidence not found: ${f.missingEvidenceIds.join(', ')}`));
  }
  for (const e of f.evidence) {
    const problems: string[] = [];
    if (e.status !== 'admitted') problems.push(`status ${e.status}`);
    if (e.freshnessStatus !== 'current') problems.push(`freshness ${e.freshnessStatus}`);
    if (maxAge !== null && e.ageHours > maxAge) problems.push(`older than ${maxAge}h`);
    if (e.prohibitedUses.includes(purpose)) problems.push('prohibited for autonomous execution');
    if (autonomous && !e.permittedUses.includes(purpose)) problems.push('not permitted for autonomous execution');
    if (problems.length === 0) continue;
    const msg = `evidence ${e.id}: ${problems.join('; ')}`;
    out.push(autonomous || e.prohibitedUses.includes(purpose) ? deny('R-EVIDENCE', 'EVIDENCE_NOT_TRUSTED', msg) : approve('R-EVIDENCE', 'EVIDENCE_NOT_TRUSTED', msg));
  }
  return out;
}

function ruleProtectedPopulations(i: PolicyInput): Finding[] {
  const out: Finding[] = [];
  if (i.risk.involvesChildren || i.facts.messaging?.isChild === true) {
    out.push(deny('R-CHILDREN', 'CHILDREN_DATA_BLOCKED', "children's data requires the separate COPPA policy path, which is not configured [BLOCK]"));
  }
  if (i.risk.usesSensitiveAttributes) {
    out.push(deny('R-SENSITIVE', 'SENSITIVE_TARGETING_BLOCKED', 'sensitive or proxy attributes may not drive targeting/personalization [BLOCK]'));
  }
  return out;
}

function ruleJurisdiction(i: PolicyInput): Finding[] {
  const d = i.definition;
  if (!d) return [];
  const needs = d.publicFacing || d.contactsPeople || d.category === 'SPEND' || d.category === 'PRICING' || d.category === 'DATA_EXPORT';
  if (!needs) return [];
  if (i.risk.geographies.length === 0) {
    return [approve('R-JURISDICTION', 'GEOGRAPHY_UNSPECIFIED', 'target geography unspecified; legal interpretation required', LEGAL_GROUP)];
  }
  const unapproved = i.risk.geographies.filter((g) => !i.facts.approvedJurisdictions.includes(g));
  if (unapproved.length) {
    return [approve('R-JURISDICTION', 'JURISDICTION_UNAPPROVED', `no legal-approved rule pack for: ${unapproved.join(', ')}`, LEGAL_GROUP)];
  }
  return [];
}

function ruleClaims(i: PolicyInput): Finding[] {
  const out: Finding[] = [];
  if (i.facts.missingClaimIds.length) out.push(deny('R-CLAIMS', 'CLAIM_NOT_FOUND', `claims not found: ${i.facts.missingClaimIds.join(', ')}`));
  for (const c of i.facts.claims) {
    if (c.status !== 'approved') out.push(deny('R-CLAIMS', 'CLAIM_NOT_APPROVED', `claim ${c.id} is ${c.status}`));
    else if (c.expiresAt && c.expiresAt.getTime() <= i.now.getTime()) out.push(deny('R-CLAIMS', 'CLAIM_EXPIRED', `claim ${c.id} expired`));
    else if (c.regulated) out.push(approve('R-CLAIMS', 'REGULATED_CLAIM', `claim ${c.id} is regulated`, LEGAL_GROUP));
  }
  if (i.risk.regulatedClaim) out.push(approve('R-CLAIMS', 'REGULATED_CLAIM', 'action declares a regulated claim', LEGAL_GROUP));
  return out;
}

function ruleDisclosure(i: PolicyInput): Finding[] {
  const out: Finding[] = [];
  const d = i.facts.disclosure;
  const personaId = i.risk.syntheticPersonaId ?? d?.syntheticPersonaId ?? null;
  if (personaId) {
    const p = i.facts.persona;
    if (!p || p.id !== personaId) out.push(deny('R-PERSONA', 'PERSONA_NOT_FOUND', 'synthetic persona not found'));
    else if (p.status !== 'approved') out.push(deny('R-PERSONA', 'PERSONA_NOT_APPROVED', `synthetic persona is ${p.status}`));
    if (!d || !d.isAiGenerated || !d.disclosureText || d.disclosureText.trim().length < 3) {
      out.push(deny('R-PERSONA', 'SYNTHETIC_DISCLOSURE_MISSING', 'synthetic persona content must be disclosed as AI-generated'));
    }
  }
  if (i.risk.materialConnection) {
    if (!d || !d.paidPartnership || !d.disclosureText) {
      out.push(deny('R-ENDORSEMENT', 'MATERIAL_CONNECTION_UNDISCLOSED', 'material connection must be clearly disclosed (FTC endorsement rules)'));
    }
  }
  return out;
}

function ruleAssets(i: PolicyInput): Finding[] {
  const out: Finding[] = [];
  if (i.facts.missingAssetIds.length) out.push(deny('R-ASSETS', 'ASSET_NOT_FOUND', `assets not found: ${i.facts.missingAssetIds.join(', ')}`));
  for (const a of i.facts.assets) {
    if (!a.publishEligible) out.push(deny('R-ASSETS', 'ASSET_NOT_ELIGIBLE', `asset ${a.id} not publish-eligible: ${a.reasons.join('; ') || 'incomplete rights/QA manifest'}`));
  }
  return out;
}

function ruleMessaging(i: PolicyInput): Finding[] {
  const d = i.definition;
  if (!d || d.category !== 'MESSAGING') return [];
  const m = i.facts.messaging;
  if (!m) return [deny('R-MESSAGING', 'MESSAGING_FACTS_MISSING', 'recipient consent/suppression state could not be established')];
  const out: Finding[] = [];
  if (m.suppressed) out.push(deny('R-MESSAGING', 'RECIPIENT_SUPPRESSED', 'recipient is suppressed for this channel'));
  if (m.category === 'commercial') {
    if (!m.consentGranted) out.push(deny('R-MESSAGING', 'NO_MARKETING_CONSENT', 'no current marketing consent for this channel'));
    if (!m.senderIdentityComplete) out.push(deny('R-MESSAGING', 'SENDER_IDENTITY_INCOMPLETE', 'sender identity / postal address not configured (CAN-SPAM)'));
    if (m.withinFrequencyCap === null) out.push(deny('R-MESSAGING', 'FREQUENCY_CAP_UNCONFIGURED', 'tenant frequency caps/quiet hours are unspecified [U]'));
    else if (!m.withinFrequencyCap) out.push(deny('R-MESSAGING', 'FREQUENCY_CAP_EXCEEDED', 'frequency cap reached'));
  }
  return out;
}

function rulePlatformSpecific(i: PolicyInput): Finding[] {
  if (i.actionType === 'social.tiktok.publish_video') {
    const audited = i.facts.connection?.appAudited === true;
    if (!audited && i.params.privacyLevel !== 'SELF_ONLY') {
      return [deny('R-PLATFORM', 'TIKTOK_UNAUDITED_PUBLIC', 'unaudited TikTok clients may only post SELF_ONLY (private)')];
    }
    if (i.facts.disclosure && i.facts.disclosure.isAiGenerated === false && i.risk.syntheticPersonaId) {
      return [deny('R-PLATFORM', 'TIKTOK_AIGC_FLAG', 'AI-generated content must set is_aigc')];
    }
  }
  if (i.actionType === 'social.youtube.upload_video' && i.facts.disclosure?.isAiGenerated && i.params.containsSyntheticMedia !== true) {
    return [deny('R-PLATFORM', 'YOUTUBE_SYNTHETIC_FLAG', 'realistic synthetic media must set containsSyntheticMedia')];
  }
  return [];
}

function positiveSpend(risk: ActionRisk): number {
  return Math.max(0, risk.spendDeltaMicros);
}

function ruleAutonomy(i: PolicyInput): { findings: Finding[]; group: ApprovalGroup; distinct: boolean } {
  const d = i.definition;
  const category: RiskCategory = d?.category ?? 'INTERNAL';
  const cp = categoryPolicy(i.tenantPolicy, category);
  const group: ApprovalGroup = {
    name: category === 'SPEND' || category === 'PRICING' || category === 'PAYOUT' ? 'finance' : category === 'DATA_EXPORT' ? 'privacy' : 'operational',
    anyOfRoles: cp?.approverRoles ?? DEFAULT_APPROVERS[category],
  };
  const distinct = cp?.requiresDistinctApprover ?? true;
  if (!cp) {
    return {
      findings: [approve('R-AUTONOMY', 'TENANT_POLICY_UNCONFIGURED', `no tenant autonomy policy for ${category}; human approval required [U]`, group)],
      group,
      distinct,
    };
  }
  if (cp.autonomy === 'deny') return { findings: [deny('R-AUTONOMY', 'CATEGORY_DENIED', `tenant policy denies ${category} actions`)], group, distinct };
  if (cp.autonomy === 'approval_required') {
    return { findings: [approve('R-AUTONOMY', 'CATEGORY_REQUIRES_APPROVAL', `tenant policy requires approval for ${category}`, group)], group, distinct };
  }

  // pre_authorized_within_limits: every relevant limit must be configured and satisfied.
  const out: Finding[] = [];
  const delta = positiveSpend(i.risk);
  if (d?.affectsSpend && delta > 0) {
    const perAction = cp.maxSpendDeltaMicrosPerAction ?? 0;
    const perDay = cp.maxSpendDeltaMicrosPerDay ?? 0;
    if (!i.risk.currency || (i.tenantPolicy.currency && i.risk.currency !== i.tenantPolicy.currency)) {
      out.push(approve('R-SPEND', 'CURRENCY_MISMATCH', 'spend currency differs from tenant policy currency', group));
    } else if (delta > perAction) {
      out.push(approve('R-SPEND', 'SPEND_ABOVE_ACTION_CEILING', `spend increase ${delta} exceeds per-action ceiling ${perAction}`, group));
    } else if (i.facts.rollingPreAuthorizedSpendMicros + delta > perDay) {
      out.push(approve('R-SPEND', 'SPEND_ABOVE_DAILY_CEILING', `24h pre-authorized spend would exceed ${perDay}`, group));
    }
  }
  if (d?.contactsPeople || category === 'TARGETING') {
    const size = i.risk.audienceSize;
    if (cp.maxAudienceSize === null) out.push(approve('R-AUDIENCE', 'AUDIENCE_LIMIT_UNCONFIGURED', 'audience size limit unconfigured [U]', group));
    else if (size === null || size > cp.maxAudienceSize) out.push(approve('R-AUDIENCE', 'AUDIENCE_ABOVE_LIMIT', `audience ${size ?? 'unknown'} exceeds ${cp.maxAudienceSize}`, group));
  }
  if (i.proposedBy.type === 'user' && i.evidenceIds.length === 0) {
    // already handled by R-EVIDENCE; nothing extra
  }
  return { findings: out, group, distinct };
}

/* ------------------------------------------------------------------ */
/* Engine                                                             */
/* ------------------------------------------------------------------ */

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const findings: Finding[] = [
    ...ruleAllowlist(input),
    ...ruleKillSwitches(input),
    ...ruleCapability(input),
    ...ruleConnection(input),
    ...ruleEvidence(input),
    ...ruleProtectedPopulations(input),
    ...ruleJurisdiction(input),
    ...ruleClaims(input),
    ...ruleDisclosure(input),
    ...ruleAssets(input),
    ...ruleMessaging(input),
    ...rulePlatformSpecific(input),
  ];
  const autonomy = ruleAutonomy(input);
  findings.push(...autonomy.findings);

  const outcome: PolicyOutcome = findings.some((f) => f.effect === 'DENY')
    ? 'DENY'
    : findings.some((f) => f.effect === 'REQUIRE_APPROVAL')
      ? 'REQUIRE_APPROVAL'
      : 'PRE_AUTHORIZED';

  const groups = new Map<string, ApprovalGroup>();
  if (outcome === 'REQUIRE_APPROVAL') {
    for (const f of findings) {
      if (f.effect !== 'REQUIRE_APPROVAL') continue;
      const g = f.approvalGroup ?? autonomy.group;
      const existing = groups.get(g.name);
      groups.set(g.name, existing ? { name: g.name, anyOfRoles: [...new Set([...existing.anyOfRoles, ...g.anyOfRoles])] } : g);
    }
  }

  const constraints: Record<string, unknown> = {};
  if (input.facts.messaging?.withinQuietHours === false) constraints.deferUntilOutsideQuietHours = true;
  if (input.definition?.affectsSpend) constraints.spendDeltaMicros = positiveSpend(input.risk);
  if (input.tenantPolicy.approvalTtlHours) constraints.approvalTtlHours = input.tenantPolicy.approvalTtlHours;

  return {
    outcome,
    reasons: findings.map(({ rule, code, message, effect }) => ({ rule, code, message, effect })),
    approvalGroups: [...groups.values()],
    requiresDistinctApprover: autonomy.distinct,
    policyVersion: POLICY_VERSION,
    evaluatedAt: input.now.toISOString(),
    constraints,
  };
}

/** The unconfigured default policy (D-012): nothing is pre-authorised. */
export function defaultTenantPolicy(): TenantPolicy {
  return {
    version: 1,
    configured: false,
    categories: {},
    lambdas: null,
    currency: null,
    approvalTtlHours: null,
    messaging: null,
    forecastGates: null,
    mmmGates: null,
    approvedJurisdictions: [],
    evidenceMaxAgeHours: null,
  };
}

/**
 * Check whether a set of approvals satisfies every approval group of a policy decision.
 * Separation of duties: each group must be satisfied by a different person, so a user holding
 * both finance and legal roles cannot clear both groups alone. Uses backtracking (groups are few)
 * so a valid assignment is found whenever one exists.
 */
export function approvalsSatisfy(
  groups: readonly ApprovalGroup[],
  approvals: readonly { approverUserId: string; roles: readonly string[] }[],
  opts: { proposerId: string; requiresDistinctApprover: boolean },
): { satisfied: boolean; missing: string[] } {
  const byUser = new Map<string, Set<string>>();
  for (const a of approvals) {
    if (opts.requiresDistinctApprover && a.approverUserId === opts.proposerId) continue;
    const roles = byUser.get(a.approverUserId) ?? new Set<string>();
    for (const r of a.roles) roles.add(r);
    byUser.set(a.approverUserId, roles);
  }
  const users = [...byUser.entries()];
  const canCover = (g: ApprovalGroup, roles: Set<string>) => g.anyOfRoles.some((r) => roles.has(r));

  const assign = (gi: number, used: Set<string>): boolean => {
    if (gi === groups.length) return true;
    const g = groups[gi]!;
    for (const [user, roles] of users) {
      if (used.has(user) || !canCover(g, roles)) continue;
      used.add(user);
      if (assign(gi + 1, used)) return true;
      used.delete(user);
    }
    return false;
  };
  if (assign(0, new Set())) return { satisfied: true, missing: [] };
  const missing = groups.filter((g) => !users.some(([, roles]) => canCover(g, roles))).map((g) => g.name);
  return { satisfied: false, missing: missing.length ? missing : groups.map((g) => g.name) };
}
