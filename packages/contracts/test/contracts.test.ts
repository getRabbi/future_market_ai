import { describe, expect, it } from 'vitest';
import { ACTION_STATES, ACTION_TRANSITIONS, ACTION_TYPES, canonicalJson, canTransition, GrowthDecisionSchema, MODULES, TERMINAL_ACTION_STATES } from '../src/index.js';

describe('canonical module registry (FG-P0-001)', () => {
  it('has exactly 24 active modules with unique ids M01..M24', () => {
    const active = MODULES.filter((m) => m.active);
    expect(active).toHaveLength(24);
    const ids = active.map((m) => m.id);
    expect(new Set(ids).size).toBe(24);
    expect(ids).toEqual(Array.from({ length: 24 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
  });

  it('only depends on registered modules and never on itself', () => {
    const ids = new Set<string>(MODULES.map((m) => m.id));
    for (const m of MODULES) {
      for (const dep of m.dependsOn) {
        expect(ids.has(dep), `${m.id} -> ${dep}`).toBe(true);
        expect(dep).not.toBe(m.id);
      }
    }
  });
});

describe('execution state machine (D-011)', () => {
  it('has no SUCCESS state', () => {
    expect(ACTION_STATES as readonly string[]).not.toContain('SUCCESS');
  });

  it('cannot reach VERIFIED without passing EXECUTED_UNVERIFIED', () => {
    const preds = ACTION_STATES.filter((s) => ACTION_TRANSITIONS[s].includes('VERIFIED'));
    expect(new Set(preds)).toEqual(new Set(['EXECUTED_UNVERIFIED', 'ESCALATED']));
    // ESCALATED itself is only reachable after execution started
    const escalatedPreds = ACTION_STATES.filter((s) => ACTION_TRANSITIONS[s].includes('ESCALATED'));
    expect(new Set(escalatedPreds)).toEqual(new Set(['EXECUTING', 'EXECUTED_UNVERIFIED', 'ROLLBACK_REQUIRED']));
  });

  it('does not allow skipping policy or approval', () => {
    expect(canTransition('PROPOSED', 'APPROVED')).toBe(false);
    expect(canTransition('PROPOSED', 'EXECUTING')).toBe(false);
    expect(canTransition('APPROVAL_REQUIRED', 'EXECUTING')).toBe(false);
    expect(canTransition('POLICY_CHECKED', 'PREFLIGHT_VERIFIED')).toBe(false);
  });

  it('terminal states have no exits and every state is reachable from PROPOSED', () => {
    for (const t of TERMINAL_ACTION_STATES) expect(ACTION_TRANSITIONS[t]).toHaveLength(0);
    const seen = new Set<string>(['PROPOSED']);
    const queue: string[] = ['PROPOSED'];
    while (queue.length) {
      const s = queue.shift() as (typeof ACTION_STATES)[number];
      for (const n of ACTION_TRANSITIONS[s]) if (!seen.has(n)) seen.add(n), queue.push(n);
    }
    expect(seen.size).toBe(ACTION_STATES.length);
  });
});

describe('action type allowlist', () => {
  it('has unique types and unsupported entries reference a blocker', () => {
    const types = ACTION_TYPES.map((a) => a.type);
    expect(new Set(types).size).toBe(types.length);
    for (const a of ACTION_TYPES) {
      if (!a.supported) expect((a as { blockerRef?: string }).blockerRef).toBeTruthy();
    }
  });

  it('spend-affecting actions are never verified by assumption', () => {
    for (const a of ACTION_TYPES.filter((x) => x.affectsSpend)) {
      expect(['read_after_write', 'reconciliation', 'status_poll']).toContain(a.verification);
    }
  });
});

describe('canonicalJson', () => {
  it('is key-order independent and stable', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
  });

  it('rejects ambiguous values', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
  });
});

describe('GrowthDecision contract', () => {
  const base = {
    decisionId: '00000000-0000-4000-8000-000000000001',
    objective: 'increase trial starts',
    tenantId: 't1',
    market: 'US',
    horizon: { value: 4, unit: 'week' },
    proposedAction: null,
    evidenceIds: ['00000000-0000-4000-8000-000000000002'],
    predictedOutcomes: {
      metric: 'trial_starts',
      distribution: { family: 'normal', mean: 100, sd: 10 },
      pointSummary: 100,
      interval: { level: 0.8, low: 87, high: 113 },
      calibrationReference: 'forecast_run:x',
    },
    estimatedIncrementalEffect: { value: null, method: 'unknown', uncertainty: null, sourceRef: null },
    expectedCost: { amount: 0, currency: 'USD', basis: 'none' },
    downsideRisk: { description: 'none', p10Outcome: null, riskScore: 0.1 },
    assumptions: ['stationary seasonality'],
    counterfactualBaseline: null,
    policyResult: { outcome: 'REQUIRE_APPROVAL', reasons: [], policyVersion: 'v1' },
    approvalRequirement: { required: true, roles: ['approver'] },
    modelVersions: {},
    utility: { status: 'UNSCORED_LAMBDAS_UNCONFIGURED', value: null, components: null },
    status: 'PROPOSED',
  };

  it('accepts a well-formed decision', () => {
    expect(GrowthDecisionSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an incremental effect without uncertainty or method', () => {
    const noUnc = { ...base, estimatedIncrementalEffect: { value: 5, method: 'mmm', uncertainty: null, sourceRef: null } };
    expect(GrowthDecisionSchema.safeParse(noUnc).success).toBe(false);
    const noMethod = {
      ...base,
      estimatedIncrementalEffect: { value: 5, method: 'unknown', uncertainty: { level: 0.9, low: 1, high: 9 }, sourceRef: null },
    };
    expect(GrowthDecisionSchema.safeParse(noMethod).success).toBe(false);
  });

  it('rejects a decision without evidence', () => {
    expect(GrowthDecisionSchema.safeParse({ ...base, evidenceIds: [] }).success).toBe(false);
  });
});
