import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq } from 'drizzle-orm';
import { AbstainError, type ApprovedModel, type GenerateResult, ModelGateway, type ModelProvider, type PromptDefinition, type StructuredRequest, type UsageRecord } from '@futuregrow/agent-kernel';
import { type Db, agentRuns, killSwitches, modelRegistry, withSystem, withTenant } from '@futuregrow/db';
import type { z } from 'zod';
import { type CoreDeps, actorRef, systemActor } from './deps.js';
import { recordCost } from './modules/m24-governance/index.js';
import { audit } from './util.js';

const usageScope = new AsyncLocalStorage<{ tenantId: string; runId: string }>();
let cache: { at: number; models: ApprovedModel[] } | null = null;

export async function approvedModels(db: Db): Promise<ApprovedModel[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.models;
  const rows = await withSystem(db, 'system:model-registry', (tx) =>
    tx.select().from(modelRegistry).where(and(eq(modelRegistry.approvedForProduction, true), eq(modelRegistry.status, 'active'))),
  );
  cache = {
    at: Date.now(),
    models: rows.map((r) => ({ provider: r.provider, modelId: r.modelId, purposes: r.purposes, inputUsdPerMtok: r.inputUsdPerMtok, outputUsdPerMtok: r.outputUsdPerMtok })),
  };
  return cache.models;
}

export function clearModelCache(): void {
  cache = null;
}

/** Gateway bound to the registry; usage of every attempt (incl. abstentions) goes to the cost ledger. */
export function createModelGateway(deps: Pick<CoreDeps, 'db'>, providers: Record<string, ModelProvider>, knownSecrets: string[] = []): ModelGateway {
  return new ModelGateway({
    providers,
    approvedModels: () => approvedModels(deps.db),
    knownSecrets,
    recordUsage: async (u: UsageRecord) => {
      const scope = usageScope.getStore();
      if (!scope) return;
      await withTenant(deps.db, { tenantId: scope.tenantId, actor: 'system:model-gateway' }, async (tx) => {
        await recordCost(tx, scope.tenantId, {
          category: 'llm',
          provider: u.provider,
          unit: 'tokens',
          quantity: u.usage.inputTokens + u.usage.outputTokens,
          unitCostUsd: u.costUsd === null ? null : u.costUsd / Math.max(1, u.usage.inputTokens + u.usage.outputTokens),
          refType: 'agent_run',
          refId: scope.runId,
          metadata: { model: u.modelId, purpose: u.purpose, outcome: u.outcome, requestId: u.requestId, ...u.usage },
        });
      });
    },
  });
}

export interface StageRecord {
  name: string;
  prompt: { name: string; version: string; hash: string } | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string;
  summary: Record<string, unknown>;
}

export interface AgentRunContext {
  runId: string;
  tenantId: string;
  agentId: string;
  /** Call the model for one stage; records prompt/model/usage on the run. */
  think<T>(stage: string, prompt: PromptDefinition, req: Omit<StructuredRequest<T>, 'system'>, validate?: z.ZodType<T>): Promise<GenerateResult<T>>;
  /** Record a deterministic stage (no model). */
  note(stage: string, summary: Record<string, unknown>): void;
}

export type AgentOutcome<R> = { status: 'completed'; result: R; runId: string } | { status: 'abstained'; reason: string; runId: string } | { status: 'failed'; error: string; runId: string };

/**
 * Run an agent workflow. Agent- and model-scoped kill switches are checked before the first
 * model call; abstentions are recorded, never converted into fabricated output.
 */
export async function runAgent<R>(
  deps: CoreDeps,
  tenantId: string,
  args: { kind: string; agentId: string; triggeredBy: string; input: Record<string, unknown> },
  fn: (ctx: AgentRunContext) => Promise<R>,
): Promise<AgentOutcome<R>> {
  const actor = systemActor(`agent:${args.agentId}`);
  const [run] = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) =>
    tx.insert(agentRuns).values({ tenantId, kind: args.kind, input: args.input, triggeredBy: args.triggeredBy }).returning(),
  );
  const stages: StageRecord[] = [];
  let inTok = 0;
  let outTok = 0;
  const finish = async (patch: Partial<typeof agentRuns.$inferInsert>) => {
    await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
      await tx
        .update(agentRuns)
        .set({ stages, inputTokens: inTok, outputTokens: outTok, finishedAt: deps.clock.now(), ...patch })
        .where(eq(agentRuns.id, run!.id));
      await audit(tx, tenantId, { ...actor, type: 'agent' }, `agent.run.${patch.status}`, { type: 'agent_run', id: run!.id }, { kind: args.kind, stages: stages.map((s) => s.name), abstainReason: patch.abstainReason ?? null });
    });
  };

  const engaged = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => tx.select().from(killSwitches).where(eq(killSwitches.engaged, true)));
  const blocked = engaged.find((k) => (k.scope === 'agent' && (k.targetRef === null || k.targetRef === args.agentId)) || k.scope === 'tenant');
  if (blocked) {
    await finish({ status: 'abstained', abstainReason: `kill switch engaged (${blocked.scope}): ${blocked.reason}` });
    return { status: 'abstained', reason: 'KILL_SWITCH', runId: run!.id };
  }

  const ctx: AgentRunContext = {
    runId: run!.id,
    tenantId,
    agentId: args.agentId,
    think: async (stage, prompt, req, validate) => {
      if (!deps.models) throw new AbstainError('MODEL_UNAVAILABLE', 'no model gateway configured (B-003)');
      const modelBlocked = engaged.find((k) => k.scope === 'model');
      if (modelBlocked) throw new AbstainError('MODEL_UNAVAILABLE', `model kill switch engaged: ${modelBlocked.reason}`);
      const startedAt = deps.clock.now().toISOString();
      const r = await usageScope.run({ tenantId, runId: run!.id }, () =>
        deps.models!.generate({ ...req, system: prompt.system } as StructuredRequest<unknown>, validate ? { validate: validate as z.ZodType<unknown> } : {}),
      );
      inTok += r.usage.inputTokens;
      outTok += r.usage.outputTokens;
      stages.push({
        name: stage,
        prompt: { name: prompt.name, version: prompt.version, hash: prompt.hash },
        model: r.servedBy,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        costUsd: r.costUsd,
        startedAt,
        finishedAt: deps.clock.now().toISOString(),
        summary: { attempts: r.attempts },
      });
      return r as GenerateResult<never>;
    },
    note: (stage, summary) => {
      const t = deps.clock.now().toISOString();
      stages.push({ name: stage, prompt: null, model: null, inputTokens: 0, outputTokens: 0, costUsd: null, startedAt: t, finishedAt: t, summary });
    },
  };

  try {
    const result = await fn(ctx);
    await finish({ status: 'completed', output: (result ?? {}) as Record<string, unknown> });
    return { status: 'completed', result, runId: run!.id };
  } catch (err) {
    if (err instanceof AbstainError) {
      await finish({ status: 'abstained', abstainReason: `${err.reason}: ${err.message}` });
      return { status: 'abstained', reason: err.reason, runId: run!.id };
    }
    await finish({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
    return { status: 'failed', error: err instanceof Error ? err.message : String(err), runId: run!.id };
  }
}
