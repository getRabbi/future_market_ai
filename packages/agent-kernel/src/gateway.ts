import { z } from 'zod';
import { findSecrets } from './safety.js';
import {
  AbstainError,
  type ApprovedModel,
  type ModelProvider,
  type ProviderOutcome,
  type ProviderUsage,
  ProviderUnavailableError,
  type StructuredRequest,
} from './types.js';

/** Default routing (D-024): the current Opus for every reasoning purpose. */
export const PREFERRED_MODELS: Record<string, string[]> = {
  anthropic: ['claude-opus-5-5'],
};

const EFFORT_BY_PURPOSE = { planning: 'high', critic: 'high', generation: 'medium', extraction: 'low', classification: 'low' } as const;

export interface UsageRecord {
  provider: string;
  modelId: string;
  purpose: string;
  usage: ProviderUsage;
  costUsd: number | null;
  requestId: string | null;
  outcome: string;
}

export interface GatewayOptions {
  providers: Record<string, ModelProvider>;
  /** Registry lookup of approved models (cached by the caller if needed). */
  approvedModels: () => Promise<ApprovedModel[]>;
  recordUsage?: (u: UsageRecord) => Promise<void>;
  knownSecrets?: readonly string[];
  now?: () => number;
  breaker?: { failureThreshold: number; cooldownMs: number };
}

export interface GenerateResult<T> {
  output: T;
  provider: string;
  modelId: string;
  servedBy: string;
  usage: ProviderUsage;
  attempts: number;
  costUsd: number | null;
}

interface BreakerState {
  failures: number;
  openUntil: number;
}

/**
 * Provider-neutral model gateway (D-002). It never executes anything: models only return typed
 * proposals that deterministic code validates. Unapproved models are never called and never
 * silently substituted; failures abstain with a reason.
 */
export class ModelGateway {
  private readonly breakers = new Map<string, BreakerState>();

  constructor(private readonly opts: GatewayOptions) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  async select(purpose: string): Promise<{ primary: ApprovedModel; fallbacks: ApprovedModel[] }> {
    const approved = (await this.opts.approvedModels()).filter((m) => this.opts.providers[m.provider]);
    const eligible = approved.filter((m) => m.purposes.includes(purpose));
    if (!eligible.length) throw new AbstainError('NO_APPROVED_MODEL', `no approved model for purpose ${purpose} (B-003)`);
    const ranked = [...eligible].sort((a, b) => rank(a) - rank(b));
    const primary = ranked[0]!;
    const fallbacks = approved.filter((m) => m.provider === primary.provider && m.purposes.includes('fallback') && m.modelId !== primary.modelId);
    return { primary, fallbacks };
  }

  async generate<T>(req: StructuredRequest<T>, opts: { validate?: z.ZodType<T>; repair?: boolean } = {}): Promise<GenerateResult<T>> {
    const { primary, fallbacks } = await this.select(req.purpose);
    const provider = this.opts.providers[primary.provider]!;
    const br = this.breakers.get(primary.provider) ?? { failures: 0, openUntil: 0 };
    if (br.openUntil > this.now()) throw new AbstainError('CIRCUIT_OPEN', `${primary.provider} circuit open after repeated failures`);
    const approvedIds = new Set([primary.modelId, ...fallbacks.map((f) => f.modelId)]);
    const totals: ProviderUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let messages = [...req.messages];
    let lastIssues = '';
    const maxAttempts = opts.repair === false ? 1 : 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let outcome: ProviderOutcome<T>;
      try {
        outcome = await provider.generateStructured({ ...req, messages, effort: req.effort ?? EFFORT_BY_PURPOSE[req.purpose] }, { model: primary.modelId, fallbackModels: fallbacks.map((f) => f.modelId) });
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          this.trip(primary.provider);
          throw new AbstainError('MODEL_UNAVAILABLE', err.message);
        }
        throw err;
      }
      this.breakers.set(primary.provider, { failures: 0, openUntil: 0 });
      addUsage(totals, outcome.usage);
      const served = approved(outcome.servedBy, approvedIds);
      await this.opts.recordUsage?.({
        provider: primary.provider,
        modelId: outcome.servedBy,
        purpose: req.purpose,
        usage: outcome.usage,
        costUsd: cost(served ? (fallbacks.find((f) => outcome.servedBy.startsWith(f.modelId)) ?? primary) : primary, outcome.usage),
        requestId: outcome.requestId,
        outcome: outcome.kind,
      });
      if (!served) throw new AbstainError('UNAPPROVED_SERVING_MODEL', `response served by ${outcome.servedBy}, which is not approved`);
      if (outcome.kind === 'refusal') throw new AbstainError('MODEL_REFUSAL', `model declined (${outcome.category ?? 'unspecified'})`);
      if (outcome.kind === 'truncated') throw new AbstainError('OUTPUT_TRUNCATED', 'model output hit max_tokens');
      if (outcome.kind === 'invalid_output') {
        lastIssues = outcome.issues;
      } else {
        const serialized = JSON.stringify(outcome.output);
        const secrets = findSecrets(serialized, this.opts.knownSecrets ?? []);
        if (secrets.length) throw new AbstainError('SECRET_IN_OUTPUT', `output contained credential-like content (${secrets.join(', ')})`);
        const check = (opts.validate ?? req.outputSchema).safeParse(outcome.output);
        if (check.success) {
          return { output: check.data, provider: primary.provider, modelId: primary.modelId, servedBy: outcome.servedBy, usage: totals, attempts: attempt, costUsd: cost(primary, totals) };
        }
        lastIssues = check.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        messages = [
          ...messages,
          { role: 'assistant', content: serialized },
          { role: 'user', content: `That JSON failed validation: ${lastIssues}. Return a corrected JSON object that satisfies every constraint.` },
        ];
      }
    }
    throw new AbstainError('OUTPUT_INVALID', `model output failed validation: ${lastIssues}`);
  }

  private trip(provider: string) {
    const cfg = this.opts.breaker ?? { failureThreshold: 3, cooldownMs: 60_000 };
    const st = this.breakers.get(provider) ?? { failures: 0, openUntil: 0 };
    st.failures += 1;
    if (st.failures >= cfg.failureThreshold) {
      st.openUntil = this.now() + cfg.cooldownMs;
      st.failures = 0;
    }
    this.breakers.set(provider, st);
  }
}

function rank(m: ApprovedModel): number {
  const pref = PREFERRED_MODELS[m.provider] ?? [];
  const i = pref.indexOf(m.modelId);
  return i === -1 ? 100 : i;
}

function approved(servedBy: string, ids: Set<string>): boolean {
  // Providers may report dated snapshot names; accept exact ids or a prefix match on the registered id.
  return [...ids].some((id) => servedBy === id || servedBy.startsWith(`${id}-`));
}

function addUsage(t: ProviderUsage, u: ProviderUsage) {
  t.inputTokens += u.inputTokens;
  t.outputTokens += u.outputTokens;
  t.cacheReadTokens += u.cacheReadTokens;
  t.cacheWriteTokens += u.cacheWriteTokens;
}

/** Cost from registry prices; null when the price is unknown [U] (never estimated). */
export function cost(m: ApprovedModel, u: ProviderUsage): number | null {
  if (m.inputUsdPerMtok === null || m.outputUsdPerMtok === null) return null;
  return ((u.inputTokens + u.cacheWriteTokens) * m.inputUsdPerMtok + u.outputTokens * m.outputUsdPerMtok) / 1e6 + (u.cacheReadTokens * m.inputUsdPerMtok * 0.1) / 1e6;
}

export { z };
