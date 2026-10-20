import { setTimeout as sleep } from 'node:timers/promises';
import { type ConnectorContext, configuredApiVersion, EXECUTORS, type ExecuteResult, type ProviderCredentials, ProviderHttpError } from '@futuregrow/connectors';
import { ActionRequestInputSchema, type ActionRisk, type ActionState, canonicalJson, type ExecutionProof, type ExecutionReceipt, getActionType, type PolicyDecision, TERMINAL_ACTION_STATES } from '@futuregrow/contracts';
import { actionRequests, actionTransitions, approvals, assets, connections, executionProofs, executions, savepoint, sequential, setTransitionReason, type Tx, withTenant } from '@futuregrow/db';
import { conflict, forbidden, invalid, notFound, sha256Canonical } from '@futuregrow/observability';
import { approvalsSatisfy, evaluatePolicy } from '@futuregrow/policies';
import { tenantKey } from '@futuregrow/storage';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { loadCredentials } from '../../secrets.js';
import { audit, emit, requireMfa } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { engagedKillSwitchesFor, getTenantPolicy, isSystemHalted, openIncident, raiseAlert } from '../m24-governance/index.js';
import { holdReservation, lockTenantBudget, settleReservation, takeToken } from './budget.js';
import { gatherPolicyFacts, loadCapability, objectRefs } from './facts.js';
import { type ActionRow, getHooks, getInternalExecutor, getResolver } from './registry.js';

const GATEWAY = systemActor('execution-gateway');
const TERMINAL_FAILURES: ActionState[] = ['FAILED', 'ROLLED_BACK', 'CANCELLED', 'DENIED', 'REJECTED'];

export interface ActionView {
  id: string;
  actionType: string;
  status: string;
  statusReason: string | null;
  provider: string;
  connectionId: string | null;
  params: Record<string, unknown>;
  target: Record<string, unknown>;
  risk: Record<string, unknown>;
  actionHash: string;
  evidenceIds: string[];
  decisionId: string | null;
  proposedBy: { type: string; id: string; modelId: string | null; promptVersion: string | null };
  policyDecision: PolicyDecision | null;
  attempts: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toView(a: ActionRow): ActionView {
  return {
    id: a.id,
    actionType: a.actionType,
    status: a.status,
    statusReason: a.statusReason,
    provider: a.provider,
    connectionId: a.connectionId,
    params: a.params,
    target: a.target,
    risk: a.risk,
    actionHash: a.actionHash,
    evidenceIds: a.evidenceIds,
    decisionId: a.decisionId,
    proposedBy: { type: a.proposedByType, id: a.proposedById, modelId: a.proposerModelId, promptVersion: a.proposerPromptVersion },
    policyDecision: a.policyDecision as PolicyDecision | null,
    attempts: a.attempts,
    expiresAt: a.expiresAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function computeActionHash(v: { actionType: string; connectionId: string | null; target: unknown; params: unknown; risk: unknown }): string {
  return sha256Canonical({ actionType: v.actionType, connectionId: v.connectionId, target: v.target, params: v.params, risk: v.risk });
}

async function transition(tx: Tx, tenantId: string, actor: Actor, a: ActionRow, to: ActionState, reason: string, extra: Partial<ActionRow> = {}, proofForHook: ExecutionProof | null = null): Promise<ActionRow> {
  await setTransitionReason(tx, reason);
  const [u] = await tx
    .update(actionRequests)
    .set({ status: to, statusReason: reason.slice(0, 2000), ...extra })
    .where(and(eq(actionRequests.id, a.id), eq(actionRequests.status, a.status)))
    .returning();
  if (!u) throw conflict(`action ${a.id} changed state concurrently`);
  await audit(tx, tenantId, actor, 'action.request.transitioned', { type: 'action', id: a.id }, { from: a.status, to, reason });
  await emit(tx, tenantId, actor, 'action.request.transitioned', { type: 'action', id: a.id }, { from: a.status, to, reason, actionType: a.actionType });
  if (TERMINAL_FAILURES.includes(to)) {
    for (const h of getHooks(a.actionType)) await h.onTerminalFailure?.(tx, u, to, reason, proofForHook);
  }
  return u;
}

/* ------------------------------------------------------------------ */
/* Proposal + evaluation                                               */
/* ------------------------------------------------------------------ */

export interface ProposeOptions {
  /** Ignore — set by the Growth Brain when converting a decision. */
  decisionId?: string | null;
}

/**
 * Create an ActionRequest and run it through evidence + policy checks in one transaction.
 * Idempotent on (tenant, idempotencyKey): replaying the same request returns the same action.
 */
export async function proposeAction(deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown): Promise<ActionView> {
  const input = ActionRequestInputSchema.parse(raw);
  const def = getActionType(input.actionType);
  if (!def) {
    await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => audit(tx, tenantId, actor, 'action.request.rejected_unknown_type', { type: 'action_type', id: input.actionType }, {}));
    throw invalid(`action type ${input.actionType} is not on the allowlist (deny by default)`);
  }
  const parsed = def.paramsSchema.safeParse(input.params);
  if (!parsed.success) throw invalid('action params failed validation', { issues: parsed.error.issues });
  const params = parsed.data as Record<string, unknown>;
  if (def.provider !== 'internal' && !input.connectionId) throw invalid(`${def.provider} actions require a connectionId`);
  const actionHash = computeActionHash({ actionType: input.actionType, connectionId: input.connectionId, target: input.target, params, risk: input.risk });

  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [existing] = await tx.select().from(actionRequests).where(eq(actionRequests.idempotencyKey, input.idempotencyKey));
    if (existing) {
      if (existing.actionHash !== actionHash) throw conflict('idempotency key reused with a different action payload');
      return toView(existing);
    }
    const [row] = await tx
      .insert(actionRequests)
      .values({
        tenantId,
        actionType: input.actionType,
        provider: def.provider,
        connectionId: input.connectionId,
        target: input.target,
        params,
        actionHash,
        proposedByType: actor.type,
        proposedById: actor.id,
        proposerModelId: actor.modelId ?? null,
        proposerPromptVersion: actor.promptVersion ?? null,
        decisionId: input.decisionId,
        evidenceIds: input.evidenceIds,
        risk: input.risk,
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning();
    await audit(tx, tenantId, actor, 'action.request.proposed', { type: 'action', id: row!.id }, { actionType: input.actionType, actionHash, evidenceIds: input.evidenceIds });
    await emit(tx, tenantId, actor, 'action.request.proposed', { type: 'action', id: row!.id }, { actionType: input.actionType });
    const evaluated = await evaluate(tx, deps, tenantId, actor, row!);
    for (const h of getHooks(input.actionType)) await h.onSubmitted?.(tx, evaluated);
    return toView(evaluated);
  });
}

async function evaluate(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, a: ActionRow): Promise<ActionRow> {
  const def = getActionType(a.actionType);
  const policy = await getTenantPolicy(tx, tenantId);
  const facts = await gatherPolicyFacts(
    tx,
    deps,
    {
      tenantId,
      actionId: a.id,
      definition: def,
      params: a.params,
      target: a.target,
      connectionId: a.connectionId,
      evidenceIds: a.evidenceIds,
      risk: a.risk as ActionRisk,
      proposer: { type: a.proposedByType, id: a.proposedById, modelId: a.proposerModelId },
    },
    policy,
  );
  const decision = evaluatePolicy({
    definition: def,
    actionType: a.actionType,
    params: a.params,
    risk: a.risk as ActionRisk,
    proposedBy: { type: a.proposedByType as Actor['type'], id: a.proposedById, modelId: a.proposerModelId, promptVersion: a.proposerPromptVersion },
    evidenceIds: a.evidenceIds,
    tenantPolicy: policy,
    facts,
    now: deps.clock.now(),
  });
  const summary = (filter: (r: PolicyDecision['reasons'][number]) => boolean) =>
    decision.reasons
      .filter(filter)
      .map((r) => `${r.code}: ${r.message}`)
      .join('; ');
  const evidenceDeny = summary((r) => r.rule === 'R-EVIDENCE' && r.effect === 'DENY');
  if (evidenceDeny) return transition(tx, tenantId, actor, a, 'DENIED', `evidence: ${evidenceDeny}`, { policyDecision: decision, policyVersion: decision.policyVersion });

  let cur = await transition(tx, tenantId, actor, a, 'EVIDENCE_READY', 'evidence resolved');
  cur = await transition(tx, tenantId, actor, cur, 'POLICY_CHECKED', `policy ${decision.policyVersion}: ${decision.outcome}`, { policyDecision: decision, policyVersion: decision.policyVersion });
  if (decision.outcome === 'DENY')
    return transition(
      tx,
      tenantId,
      actor,
      cur,
      'DENIED',
      summary((r) => r.effect === 'DENY'),
    );
  if (decision.outcome === 'REQUIRE_APPROVAL')
    return transition(
      tx,
      tenantId,
      actor,
      cur,
      'APPROVAL_REQUIRED',
      summary((r) => r.effect === 'REQUIRE_APPROVAL'),
    );
  return transition(tx, tenantId, actor, cur, 'APPROVED', 'pre-authorized within tenant policy limits');
}

/* ------------------------------------------------------------------ */
/* Human approval (D-020)                                              */
/* ------------------------------------------------------------------ */

export async function decideApproval(deps: CoreDeps, tenantId: string, actor: Actor, actionId: string, input: { decision: 'approved' | 'rejected'; comment?: string; expectedActionHash: string }): Promise<ActionView> {
  if (actor.type !== 'user') throw forbidden('only humans can approve actions');
  requireMfa(actor, 'approving consequential actions');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [a] = await tx.select().from(actionRequests).where(eq(actionRequests.id, actionId)).for('update');
    if (!a) throw notFound('action');
    if (a.status !== 'APPROVAL_REQUIRED') throw conflict(`action is ${a.status}, not awaiting approval`);
    // The approver must have seen exactly this payload.
    if (input.expectedActionHash !== a.actionHash) throw conflict('action payload hash does not match what was reviewed');
    if (a.expiresAt && a.expiresAt <= deps.clock.now()) {
      await transition(tx, tenantId, actor, a, 'CANCELLED', 'expired before approval');
      throw conflict('action expired');
    }
    const pd = a.policyDecision as PolicyDecision;
    const groupRoles = new Set(pd.approvalGroups.flatMap((g) => g.anyOfRoles));
    const relevant = actor.roles.filter((r) => groupRoles.has(r as never));
    if (relevant.length === 0) throw forbidden(`approver lacks a required role (${[...groupRoles].join(', ')})`);
    if (pd.requiresDistinctApprover && a.proposedByType === 'user' && a.proposedById === actor.id) {
      throw forbidden('separation of duties: the proposer cannot approve their own action');
    }
    const prior = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.actionId, a.id), eq(approvals.approverUserId, actor.id)));
    if (prior.length) throw conflict('you have already recorded a decision for this action');
    const ttl = (pd.constraints.approvalTtlHours as number | undefined) ?? null;
    await tx.insert(approvals).values({
      tenantId,
      actionId: a.id,
      actionHash: a.actionHash,
      decision: input.decision,
      approverUserId: actor.id,
      approverRoles: relevant,
      mfaVerified: actor.mfaVerified,
      comment: input.comment ?? null,
      expiresAt: ttl ? new Date(deps.clock.now().getTime() + ttl * 3_600_000) : null,
    });
    await audit(tx, tenantId, actor, 'action.approval.recorded', { type: 'action', id: a.id }, { decision: input.decision, roles: relevant, comment: input.comment ?? null });
    await emit(tx, tenantId, actor, 'action.approval.recorded', { type: 'action', id: a.id }, { decision: input.decision });
    if (input.decision === 'rejected') return toView(await transition(tx, tenantId, actor, a, 'REJECTED', `rejected by ${actor.id}${input.comment ? `: ${input.comment}` : ''}`));

    const all = await validApprovals(tx, a, deps.clock.now());
    const sat = approvalsSatisfy(
      pd.approvalGroups,
      all.map((x) => ({ approverUserId: x.approverUserId, roles: x.approverRoles })),
      {
        proposerId: a.proposedById,
        requiresDistinctApprover: pd.requiresDistinctApprover,
      },
    );
    if (!sat.satisfied) {
      await tx
        .update(actionRequests)
        .set({ statusReason: `awaiting approval groups: ${sat.missing.join(', ')}` })
        .where(eq(actionRequests.id, a.id));
      const [re] = await tx.select().from(actionRequests).where(eq(actionRequests.id, a.id));
      return toView(re!);
    }
    return toView(await transition(tx, tenantId, actor, a, 'APPROVED', `approved (${pd.approvalGroups.map((g) => g.name).join(', ')})`));
  });
}

async function validApprovals(tx: Tx, a: ActionRow, now: Date) {
  const rows = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.actionId, a.id), eq(approvals.decision, 'approved'), eq(approvals.actionHash, a.actionHash)));
  return rows.filter((r) => !r.expiresAt || r.expiresAt > now);
}

export async function cancelAction(deps: CoreDeps, tenantId: string, actor: Actor, actionId: string, reason: string): Promise<ActionView> {
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [a] = await tx.select().from(actionRequests).where(eq(actionRequests.id, actionId)).for('update');
    if (!a) throw notFound('action');
    if (!['PROPOSED', 'EVIDENCE_READY', 'POLICY_CHECKED', 'APPROVAL_REQUIRED', 'APPROVED', 'PREFLIGHT_VERIFIED'].includes(a.status)) {
      throw conflict(`action is ${a.status}; only queued actions can be cancelled`);
    }
    const u = await transition(tx, tenantId, actor, a, 'CANCELLED', `cancelled by ${actorRef(actor)}: ${reason}`);
    await settleReservation(tx, a.id, 'released');
    return toView(u);
  });
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export type ExecutionOutcome = { kind: 'noop'; status: string } | { kind: 'stopped'; status: string; reason: string } | { kind: 'reschedule'; runAt: Date; reason: string } | { kind: 'executed'; status: string };

async function loadAssetBytes(deps: CoreDeps, tenantId: string, assetId: string) {
  const asset = await withTenant(deps.db, { tenantId, actor: actorRef(GATEWAY) }, async (tx) => {
    const [a] = await tx.select().from(assets).where(eq(assets.id, assetId));
    return a ?? null;
  });
  if (!asset) throw new ProviderHttpError(`asset ${assetId} not found`, { status: null, phase: 'before_send' });
  const bytes = await deps.store.get(asset.objectKey);
  if (!bytes) throw new ProviderHttpError(`asset ${assetId} bytes missing from storage`, { status: null, phase: 'before_send' });
  return { bytes, mime: asset.mime, sha256: asset.sha256, publicUrl: await deps.store.presign(asset.objectKey, 'GET', 3600) };
}

export function connectorContext(deps: CoreDeps, tenantId: string, creds: ProviderCredentials, conn: typeof connections.$inferSelect): ConnectorContext {
  return {
    http: deps.http,
    credentials: creds,
    connection: { id: conn.id, provider: conn.provider as never, externalAccountId: conn.externalAccountId, metadata: conn.metadata, appAudited: conn.appAudited },
    endpoints: deps.config.endpoints,
    versions: deps.config.versions,
    now: () => deps.clock.now(),
    loadAsset: (id) => loadAssetBytes(deps, tenantId, id),
    sleep: deps.sleep ?? ((ms) => sleep(ms).then(() => undefined)),
  };
}

const TRANSIENT_POLICY_CODES = new Set(['CONNECTION_NOT_ACTIVE']);

/**
 * Execute an APPROVED action: re-run policy, preflight (credentials, rate limit, budget, kill
 * switches), call the connector, archive the receipt and move to EXECUTED_UNVERIFIED. Success is
 * never declared here; verification is a separate step.
 */
export async function executeAction(deps: CoreDeps, tenantId: string, actionId: string): Promise<ExecutionOutcome> {
  const now = deps.clock.now();
  const ctxActor = { tenantId, actor: actorRef(GATEWAY) };

  type Prepared = {
    kind: 'execute';
    action: ActionRow;
    executionId: string;
    creds: ProviderCredentials | null;
    conn: typeof connections.$inferSelect | null;
    resolved: Record<string, unknown>;
  };
  const prep: ExecutionOutcome | Prepared = await withTenant(deps.db, ctxActor, async (tx) => {
    const [a] = await tx.select().from(actionRequests).where(eq(actionRequests.id, actionId)).for('update');
    if (!a) return { kind: 'noop', status: 'MISSING' };
    if (a.status !== 'APPROVED') return { kind: 'noop', status: a.status };
    if (a.expiresAt && a.expiresAt <= now) {
      const u = await transition(tx, tenantId, GATEWAY, a, 'CANCELLED', 'expired before execution');
      return { kind: 'stopped', status: u.status, reason: 'expired' };
    }
    const def = getActionType(a.actionType)!;
    const policy = await getTenantPolicy(tx, tenantId);
    const facts = await gatherPolicyFacts(
      tx,
      deps,
      {
        tenantId,
        actionId: a.id,
        definition: def,
        params: a.params,
        target: a.target,
        connectionId: a.connectionId,
        evidenceIds: a.evidenceIds,
        risk: a.risk as ActionRisk,
        proposer: { type: a.proposedByType, id: a.proposedById, modelId: a.proposerModelId },
      },
      policy,
    );
    const decision = evaluatePolicy({
      definition: def,
      actionType: a.actionType,
      params: a.params,
      risk: a.risk as ActionRisk,
      proposedBy: { type: a.proposedByType as Actor['type'], id: a.proposedById, modelId: a.proposerModelId, promptVersion: a.proposerPromptVersion },
      evidenceIds: a.evidenceIds,
      tenantPolicy: policy,
      facts,
      now,
    });
    await audit(tx, tenantId, GATEWAY, 'action.preflight.evaluated', { type: 'action', id: a.id }, { outcome: decision.outcome, reasons: decision.reasons });

    const denials = decision.reasons.filter((r) => r.effect === 'DENY');
    if (denials.length) {
      const transientOnly = denials.every((r) => TRANSIENT_POLICY_CODES.has(r.code)) && facts.connection?.status === 'reauth_required';
      if (transientOnly) {
        await raiseAlert(tx, tenantId, { kind: 'connector.reauth_required', severity: 'warning', message: `connection ${a.connectionId} needs re-authorization; action ${a.id} is queued`, refs: { actionId: a.id }, dedupKey: `reauth:${a.connectionId}` });
        return { kind: 'reschedule', runAt: new Date(now.getTime() + 3_600_000), reason: 'connection requires re-authorization; intent preserved' };
      }
      const killed = denials.some((r) => r.rule === 'R-KILL');
      const reason = `preflight: ${denials.map((r) => r.code).join(', ')}`;
      const u = await transition(tx, tenantId, GATEWAY, a, killed ? 'CANCELLED' : 'FAILED', reason);
      return { kind: 'stopped', status: u.status, reason };
    }
    if (decision.outcome === 'REQUIRE_APPROVAL') {
      const valid = await validApprovals(tx, a, now);
      const sat = approvalsSatisfy(
        decision.approvalGroups,
        valid.map((x) => ({ approverUserId: x.approverUserId, roles: x.approverRoles })),
        {
          proposerId: a.proposedById,
          requiresDistinctApprover: decision.requiresDistinctApprover,
        },
      );
      if (!sat.satisfied) {
        const reason = `preflight: policy now requires approval groups not covered (${sat.missing.join(', ')}); re-propose`;
        const u = await transition(tx, tenantId, GATEWAY, a, 'FAILED', reason);
        return { kind: 'stopped', status: u.status, reason };
      }
    }
    if (decision.constraints.deferUntilOutsideQuietHours) {
      return { kind: 'reschedule', runAt: new Date(now.getTime() + 30 * 60_000), reason: 'quiet hours' };
    }

    let creds: ProviderCredentials | null = null;
    let conn: typeof connections.$inferSelect | null = null;
    if (def.provider !== 'internal') {
      conn = (await tx.select().from(connections).where(eq(connections.id, a.connectionId!)))[0] ?? null;
      if (!conn) {
        const u = await transition(tx, tenantId, GATEWAY, a, 'FAILED', 'preflight: connection missing');
        return { kind: 'stopped', status: u.status, reason: 'connection missing' };
      }
      const loaded = await loadCredentials(tx, deps.config, tenantId, conn.id);
      if (!loaded || (loaded.expiresAt && loaded.expiresAt <= now)) {
        await tx.update(connections).set({ status: 'reauth_required', updatedAt: now }).where(eq(connections.id, conn.id));
        await raiseAlert(tx, tenantId, { kind: 'connector.reauth_required', severity: 'warning', message: `connection ${conn.id} credentials missing or expired`, refs: { actionId: a.id }, dedupKey: `reauth:${conn.id}` });
        return { kind: 'reschedule', runAt: new Date(now.getTime() + 3_600_000), reason: 'credentials missing/expired; intent preserved' };
      }
      creds = loaded.creds;
      const { capability } = await loadCapability(tx, deps, def);
      const rl = capability?.rateLimitPolicy;
      if (rl?.capacity && rl.refillPerSecond) {
        const wait = await takeToken(tx, { tenantId, key: `${def.provider}:${conn.id}:${def.capability}`, capacity: rl.capacity, refillPerSecond: rl.refillPerSecond, now });
        if (wait > 0) return { kind: 'reschedule', runAt: new Date(now.getTime() + wait), reason: 'local rate limit' };
      }
    }

    // Resolve the exact connector input (render the email, presign media) before anything is
    // reserved or sent. A resolution failure fails the action with nothing sent.
    const resolver = getResolver(a.actionType);
    let resolved: Record<string, unknown> = a.params;
    if (resolver) {
      try {
        resolved = await savepoint(tx, (sp) => resolver(deps, sp, a));
      } catch (err) {
        const reason = `preflight: parameter resolution failed; nothing was sent (${err instanceof Error ? err.message : String(err)})`.slice(0, 1500);
        const u = await transition(tx, tenantId, GATEWAY, a, 'FAILED', reason);
        return { kind: 'stopped', status: u.status, reason };
      }
    }

    const risk = a.risk as ActionRisk;
    if (def.affectsSpend && risk.spendDeltaMicros > 0) {
      await lockTenantBudget(tx, tenantId);
      await holdReservation(tx, { tenantId, actionId: a.id, connectionId: a.connectionId, currency: risk.currency ?? 'XXX', amountMicros: risk.spendDeltaMicros, now });
    }

    let cur = await transition(tx, tenantId, GATEWAY, a, 'PREFLIGHT_VERIFIED', 'preflight passed');
    const attempt = a.attempts + 1;
    const [ex] = await tx.insert(executions).values({ tenantId, actionId: a.id, attempt, outcome: 'in_flight' }).returning();
    cur = await transition(tx, tenantId, GATEWAY, cur, 'EXECUTING', `attempt ${attempt}`, { attempts: attempt });
    return { kind: 'execute', action: cur, executionId: ex!.id, creds, conn, resolved };
  });
  if (prep.kind !== 'execute') return prep;

  const { action, executionId, creds, conn, resolved } = prep;
  const def = getActionType(action.actionType)!;

  // D-021: re-check kill switches immediately before the provider call.
  const halted = await withTenant(
    deps.db,
    ctxActor,
    async (tx) =>
      (await isSystemHalted(tx)) ||
      (
        await engagedKillSwitchesFor(tx, {
          provider: def.provider,
          connectionId: action.connectionId,
          objectRefs: objectRefs(action.params, action.target),
          proposer: { type: action.proposedByType, id: action.proposedById, modelId: action.proposerModelId },
        })
      ).length > 0,
  );
  if (halted) {
    return withTenant(deps.db, ctxActor, async (tx) => {
      await tx
        .update(executions)
        .set({ outcome: 'failed', finishedAt: deps.clock.now(), error: { code: 'KILL_SWITCH_BEFORE_SEND', phase: 'before_send' } })
        .where(eq(executions.id, executionId));
      await settleReservation(tx, action.id, 'released');
      const u = await transition(tx, tenantId, GATEWAY, action, 'FAILED', 'kill switch engaged immediately before send; nothing was sent');
      return { kind: 'stopped', status: u.status, reason: 'kill switch' } as const;
    });
  }

  let result: ExecuteResult | null = null;
  let failure: unknown = null;
  try {
    if (def.provider === 'internal') {
      const ie = getInternalExecutor(action.actionType);
      if (!ie) throw new ProviderHttpError(`no internal executor for ${action.actionType}`, { status: null, phase: 'before_send' });
      result = await ie.execute(deps, action);
    } else {
      const ex = EXECUTORS[action.actionType];
      if (!ex) throw new ProviderHttpError(`no executor for ${action.actionType}`, { status: null, phase: 'before_send' });
      result = await ex.execute(connectorContext(deps, tenantId, creds!, conn!), resolved as never, { actionId: action.id, idempotencyKey: action.idempotencyKey });
    }
  } catch (err) {
    failure = err;
  }

  return withTenant(deps.db, ctxActor, async (tx) => {
    const [a] = await tx.select().from(actionRequests).where(eq(actionRequests.id, action.id)).for('update');
    if (result) {
      const archive = await deps.store.put(tenantKey(tenantId, 'executions', action.id, `${executionId}.json`), canonicalJson({ receipt: result.receipt, response: result.rawResponse ?? null }), 'application/json');
      await tx
        .update(executions)
        .set({
          outcome: 'executed',
          finishedAt: deps.clock.now(),
          providerRequestId: result.receipt.providerRequestId,
          providerObjectId: result.receipt.providerObjectId,
          receipt: result.receipt as unknown as Record<string, unknown>,
          receiptSha256: sha256Canonical(result.receipt),
          responseArchiveKey: archive.key,
          beforeState: result.beforeState,
        })
        .where(eq(executions.id, executionId));
      await audit(tx, tenantId, GATEWAY, 'action.executed', { type: 'action', id: action.id }, { executionId, providerObjectId: result.receipt.providerObjectId, responseSha256: archive.sha256 });
      const u = await transition(tx, tenantId, GATEWAY, a!, 'EXECUTED_UNVERIFIED', 'provider accepted; awaiting independent verification');
      return { kind: 'executed', status: u.status } as const;
    }

    const e = failure instanceof ProviderHttpError ? failure : null;
    const errInfo = {
      message: failure instanceof Error ? failure.message : String(failure),
      status: e?.status ?? null,
      phase: e?.phase ?? 'ambiguous',
      providerRequestId: e?.providerRequestId ?? null,
    };
    if (e && (e.phase === 'before_send' || e.phase === 'rejected')) {
      await tx.update(executions).set({ outcome: 'failed', finishedAt: deps.clock.now(), error: errInfo }).where(eq(executions.id, executionId));
      await settleReservation(tx, action.id, 'released');
      if (e.isAuthError && action.connectionId) {
        await tx.update(connections).set({ status: 'reauth_required', updatedAt: deps.clock.now() }).where(eq(connections.id, action.connectionId));
        await raiseAlert(tx, tenantId, { kind: 'connector.reauth_required', severity: 'warning', message: `provider rejected credentials for connection ${action.connectionId}`, refs: { actionId: action.id }, dedupKey: `reauth:${action.connectionId}` });
      }
      const u = await transition(tx, tenantId, GATEWAY, a!, 'FAILED', `not applied (${e.phase}): ${errInfo.message}`);
      await emit(tx, tenantId, GATEWAY, 'action.execution.failed', { type: 'action', id: action.id }, errInfo);
      return { kind: 'stopped', status: u.status, reason: errInfo.message } as const;
    }
    // Ambiguous: the provider may have applied the change. Never retry blindly; escalate and verify.
    await tx.update(executions).set({ outcome: 'ambiguous', finishedAt: deps.clock.now(), error: errInfo }).where(eq(executions.id, executionId));
    await openIncident(tx, tenantId, GATEWAY, {
      severity: def.affectsSpend || def.publicFacing ? 'sev2' : 'sev3',
      title: `Ambiguous execution of ${action.actionType}`,
      description: `The provider call may or may not have been applied: ${errInfo.message}. Verification will attempt to resolve the state; do not re-execute manually until resolved.`,
      refs: { actionId: action.id, executionId },
    });
    const u = await transition(tx, tenantId, GATEWAY, a!, 'ESCALATED', `ambiguous execution: ${errInfo.message}`);
    await emit(tx, tenantId, GATEWAY, 'action.execution.escalated', { type: 'action', id: action.id }, errInfo);
    return { kind: 'stopped', status: u.status, reason: 'ambiguous' } as const;
  });
}

/* ------------------------------------------------------------------ */
/* Verification (M24)                                                  */
/* ------------------------------------------------------------------ */

/** Executors whose readback is keyed by the provider object id returned at execution time. */
const NEEDS_OBJECT_ID = new Set(['social.facebook.publish_post', 'social.facebook.reply_comment', 'social.instagram.publish_media', 'social.tiktok.publish_video', 'social.youtube.upload_video', 'email.send']);

export type VerificationOutcome = { kind: 'noop'; status: string } | { kind: 'reschedule'; runAt: Date; attempt: number } | { kind: 'done'; status: string; verdict: string };

async function connectorFor(deps: CoreDeps, tx: Tx, tenantId: string, action: ActionRow) {
  const [conn] = await tx.select().from(connections).where(eq(connections.id, action.connectionId!));
  if (!conn) return null;
  const loaded = await loadCredentials(tx, deps.config, tenantId, conn.id);
  if (!loaded) return null;
  return connectorContext(deps, tenantId, loaded.creds, conn);
}

export async function verifyAction(deps: CoreDeps, tenantId: string, actionId: string): Promise<VerificationOutcome> {
  const ctxActor = { tenantId, actor: actorRef(GATEWAY) };
  const loaded = await withTenant(deps.db, ctxActor, async (tx) => {
    const [a] = await tx.select().from(actionRequests).where(eq(actionRequests.id, actionId));
    if (!a) return null;
    const [ex] = await tx.select().from(executions).where(eq(executions.actionId, a.id)).orderBy(desc(executions.attempt)).limit(1);
    const def = getActionType(a.actionType)!;
    const ctx = def.provider === 'internal' ? null : await connectorFor(deps, tx, tenantId, a);
    const resolver = getResolver(a.actionType);
    let params: Record<string, unknown> = a.params;
    if (resolver && ex) {
      try {
        params = await savepoint(tx, (sp) => resolver(deps, sp, a));
      } catch (err) {
        // Verification reads provider state by receipt; stored params are a safe fallback.
        deps.logger.warn({ actionId: a.id, err: err instanceof Error ? err.message : String(err) }, 'param resolution failed during verification; using stored params');
      }
    }
    const prior = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(executionProofs)
      .where(and(eq(executionProofs.actionId, a.id), eq(executionProofs.purpose, 'postcondition')));
    return { a, ex, def, ctx, params, attempt: (prior[0]?.n ?? 0) + 1 };
  });
  if (!loaded) return { kind: 'noop', status: 'MISSING' };
  const { a, ex, def, ctx, params, attempt } = loaded;
  const ambiguous = a.status === 'ESCALATED' && ex?.outcome === 'ambiguous';
  if (!ex || !(a.status === 'EXECUTED_UNVERIFIED' || ambiguous)) return { kind: 'noop', status: a.status };

  const receipt = (ex.receipt ?? {
    providerRequestId: ex.providerRequestId,
    providerObjectId: ex.providerObjectId,
    httpStatus: null,
    responseSha256: null,
    observedAt: ex.startedAt.toISOString(),
    details: {},
  }) as ExecutionReceipt;

  let p: ExecutionProof;
  try {
    if (!receipt.providerObjectId && NEEDS_OBJECT_ID.has(a.actionType)) {
      p = { verdict: 'UNVERIFIABLE', method: def.verification, expected: {}, observed: null, diff: [], checkedAt: deps.clock.now().toISOString(), notes: 'no provider object id to read back' };
    } else if (def.provider === 'internal') {
      p = await getInternalExecutor(a.actionType)!.verify(deps, a, receipt);
    } else if (!ctx) {
      p = { verdict: 'PENDING', method: def.verification, expected: {}, observed: null, diff: [], checkedAt: deps.clock.now().toISOString(), notes: 'credentials unavailable for verification' };
    } else {
      p = await EXECUTORS[a.actionType]!.verify(ctx, params as never, receipt);
    }
  } catch (err) {
    p = { verdict: 'PENDING', method: def.verification, expected: {}, observed: null, diff: [], checkedAt: deps.clock.now().toISOString(), notes: `verification read failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const outcome = await withTenant(deps.db, ctxActor, async (tx): Promise<VerificationOutcome | { kind: 'rollback' }> => {
    const [cur] = await tx.select().from(actionRequests).where(eq(actionRequests.id, a.id)).for('update');
    if (!cur || cur.status !== a.status) return { kind: 'noop', status: cur?.status ?? 'MISSING' };
    const ev = await admitInternalEvidence(tx, tenantId, GATEWAY, {
      kind: 'api_response',
      sourceType: def.provider === 'internal' ? 'internal' : 'primary',
      owner: def.provider,
      uri: `${def.provider}://${receipt.providerObjectId ?? a.id}`,
      content: { actionId: a.id, verdict: p.verdict, observed: p.observed, diff: p.diff },
      summary: `Verification ${p.verdict} for ${a.actionType}`,
      confidence: p.verdict === 'VERIFIED' || p.verdict === 'MISMATCH' ? 1 : 0.5,
      license: 'first-party data via authorized API',
      permittedUses: ['analytics', 'autonomous_execution', 'forecasting', 'causal_measurement'],
      externalPlatformTerms: def.provider === 'internal' ? null : `${def.provider}:${configuredApiVersion(def.provider, deps.config.versions) ?? 'unversioned'}`,
      now: deps.clock.now(),
    });
    await tx.insert(executionProofs).values({
      tenantId,
      actionId: a.id,
      executionId: ex.id,
      verdict: p.verdict,
      method: p.method,
      purpose: 'postcondition',
      expected: p.expected,
      observed: p.observed,
      diff: p.diff,
      evidenceSha256: sha256Canonical(p),
      evidenceId: ev.evidenceId,
      attempt,
      notes: p.notes,
    });
    await audit(tx, tenantId, GATEWAY, 'action.verification.recorded', { type: 'action', id: a.id }, { verdict: p.verdict, attempt, diff: p.diff });

    if (p.verdict === 'VERIFIED') {
      const u = await transition(tx, tenantId, GATEWAY, cur, 'VERIFIED', `verified by ${p.method}`);
      await settleReservation(tx, a.id, 'committed');
      for (const h of getHooks(a.actionType)) await h.onVerified?.(tx, u, receipt, p);
      await emit(tx, tenantId, GATEWAY, 'action.execution.verified', { type: 'action', id: a.id }, { actionType: a.actionType, evidenceId: ev.evidenceId });
      return { kind: 'done', status: u.status, verdict: p.verdict };
    }
    if (p.verdict === 'PENDING') {
      const max = deps.config.verification.maxAttempts;
      if (attempt < max) {
        const delay = Math.min(deps.config.verification.baseDelaySeconds * 2 ** (attempt - 1), 3600) * 1000;
        return { kind: 'reschedule', runAt: new Date(deps.clock.now().getTime() + delay), attempt };
      }
      if (cur.status !== 'ESCALATED') {
        await openIncident(tx, tenantId, GATEWAY, { severity: def.affectsSpend ? 'sev2' : 'sev3', title: `Verification timed out for ${a.actionType}`, description: `No independent proof after ${attempt} attempts.`, refs: { actionId: a.id } });
        const u = await transition(tx, tenantId, GATEWAY, cur, 'ESCALATED', `verification timed out after ${attempt} attempts`);
        return { kind: 'done', status: u.status, verdict: p.verdict };
      }
      return { kind: 'done', status: cur.status, verdict: p.verdict };
    }
    if (p.verdict === 'UNVERIFIABLE') {
      if (cur.status !== 'ESCALATED') {
        await openIncident(tx, tenantId, GATEWAY, { severity: 'sev3', title: `Unverifiable execution of ${a.actionType}`, description: p.notes ?? 'unverifiable', refs: { actionId: a.id } });
        const u = await transition(tx, tenantId, GATEWAY, cur, 'ESCALATED', 'execution cannot be independently verified');
        return { kind: 'done', status: u.status, verdict: p.verdict };
      }
      return { kind: 'done', status: cur.status, verdict: p.verdict };
    }
    // MISMATCH
    if (cur.status === 'ESCALATED') {
      await audit(tx, tenantId, GATEWAY, 'action.verification.mismatch_on_ambiguous', { type: 'action', id: a.id }, { diff: p.diff });
      return { kind: 'done', status: cur.status, verdict: p.verdict };
    }
    if (def.rollback === 'impossible' || def.category === 'MESSAGING') {
      const u = await transition(tx, tenantId, GATEWAY, cur, 'FAILED', `postcondition not met: ${p.notes ?? JSON.stringify(p.diff)}`, {}, p);
      await settleReservation(tx, a.id, 'released');
      return { kind: 'done', status: u.status, verdict: p.verdict };
    }
    await transition(tx, tenantId, GATEWAY, cur, 'ROLLBACK_REQUIRED', `postcondition mismatch: ${JSON.stringify(p.diff).slice(0, 500)}`);
    return { kind: 'rollback' };
  });
  if (outcome.kind === 'rollback') return rollbackAction(deps, tenantId, actionId);
  return outcome;
}

/** Compensate a mismatched execution where the connector supports it; otherwise escalate. */
export async function rollbackAction(deps: CoreDeps, tenantId: string, actionId: string): Promise<VerificationOutcome> {
  const ctxActor = { tenantId, actor: actorRef(GATEWAY) };
  const loaded = await withTenant(deps.db, ctxActor, async (tx) => {
    const [a] = await tx.select().from(actionRequests).where(eq(actionRequests.id, actionId));
    const [ex] = a ? await tx.select().from(executions).where(eq(executions.actionId, a.id)).orderBy(desc(executions.attempt)).limit(1) : [];
    if (!a || !ex || a.status !== 'ROLLBACK_REQUIRED') return null;
    const def = getActionType(a.actionType)!;
    const ctx = def.provider === 'internal' ? null : await connectorFor(deps, tx, tenantId, a);
    return { a, ex, def, ctx };
  });
  if (!loaded) return { kind: 'noop', status: 'NOT_ROLLBACK_REQUIRED' };
  const { a, ex, def, ctx } = loaded;
  const executor = EXECUTORS[a.actionType];
  const receipt = ex.receipt as unknown as ExecutionReceipt;

  let rbProof: ExecutionProof | null = null;
  let error: string | null = null;
  if (def.rollback === 'supported' && executor?.rollback && executor.verifyRollback && ctx) {
    try {
      await executor.rollback(ctx, a.params as never, receipt, ex.beforeState);
      for (let i = 0; i < 5; i++) {
        rbProof = await executor.verifyRollback(ctx, a.params as never, receipt, ex.beforeState);
        if (rbProof.verdict !== 'PENDING') break;
        await (deps.sleep ?? ((ms: number) => sleep(ms).then(() => undefined)))(2000 * (i + 1));
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    error = `rollback is ${def.rollback} for ${a.actionType}`;
  }

  return withTenant(deps.db, ctxActor, async (tx) => {
    const [cur] = await tx.select().from(actionRequests).where(eq(actionRequests.id, a.id)).for('update');
    if (!cur || cur.status !== 'ROLLBACK_REQUIRED') return { kind: 'noop', status: cur?.status ?? 'MISSING' } as const;
    if (rbProof) {
      await tx.insert(executionProofs).values({
        tenantId,
        actionId: a.id,
        executionId: ex.id,
        verdict: rbProof.verdict,
        method: rbProof.method,
        purpose: 'rollback',
        expected: rbProof.expected,
        observed: rbProof.observed,
        diff: rbProof.diff,
        evidenceSha256: sha256Canonical(rbProof),
        attempt: 1,
        notes: 'rollback verification',
      });
    }
    if (rbProof?.verdict === 'VERIFIED') {
      await settleReservation(tx, a.id, 'released');
      const u = await transition(tx, tenantId, GATEWAY, cur, 'ROLLED_BACK', 'compensation applied and verified', {}, rbProof);
      return { kind: 'done', status: u.status, verdict: 'ROLLED_BACK' } as const;
    }
    await openIncident(tx, tenantId, GATEWAY, {
      severity: def.affectsSpend || def.publicFacing ? 'sev1' : 'sev2',
      title: `Rollback required but not completed for ${a.actionType}`,
      description: error ?? `rollback verification verdict ${rbProof?.verdict ?? 'none'}`,
      refs: { actionId: a.id },
    });
    const u = await transition(tx, tenantId, GATEWAY, cur, 'ESCALATED', `rollback not verified: ${error ?? rbProof?.verdict}`);
    return { kind: 'done', status: u.status, verdict: 'ESCALATED' } as const;
  });
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export async function listActions(tx: Tx, filter: { status?: string[]; limit?: number }) {
  const rows = await tx
    .select()
    .from(actionRequests)
    .where(filter.status?.length ? inArray(actionRequests.status, filter.status) : undefined)
    .orderBy(desc(actionRequests.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500));
  return rows.map(toView);
}

export async function getActionDetail(tx: Tx, id: string) {
  const [a] = await tx.select().from(actionRequests).where(eq(actionRequests.id, id));
  if (!a) throw notFound('action');
  const [history, appr, execs, proofs] = await sequential([
    tx.select().from(actionTransitions).where(eq(actionTransitions.actionId, id)).orderBy(asc(actionTransitions.id)),
    tx.select().from(approvals).where(eq(approvals.actionId, id)).orderBy(asc(approvals.decidedAt)),
    tx.select().from(executions).where(eq(executions.actionId, id)).orderBy(asc(executions.attempt)),
    tx.select().from(executionProofs).where(eq(executionProofs.actionId, id)).orderBy(asc(executionProofs.checkedAt)),
  ]);
  return { action: toView(a), transitions: history, approvals: appr, executions: execs, proofs, terminal: TERMINAL_ACTION_STATES.includes(a.status as ActionState) };
}
