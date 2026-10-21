import { z } from 'zod';
import { findSecrets } from './safety.js';
import { AbstainError, type ApprovedModel, type ModelProvider, type ProviderOutcome, ProviderUnavailableError, type ProviderUsage, type StructuredRequest } from './types.js';

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

/** One provider attempt, announced before the call (spending limits, FG-P2-001). */
export interface PlannedCall {
  provider: string;
  modelId: string;
  purpose: string;
  /** Upper bound for this attempt from registry prices; null when a price is unknown [U]. */
  maxCostUsd: number | null;
}

export interface ProviderFailure {
  provider: string;
  modelId: string;
  message: string;
  status: number | null;
}

export interface GatewayOptions {
  providers: Record<string, ModelProvider>;
  /** Registry lookup of approved models (cached by the caller if needed). */
  approvedModels: () => Promise<ApprovedModel[]>;
  recordUsage?: (u: UsageRecord) => Promise<void>;
  knownSecrets?: readonly string[];
  now?: () => number;
  breaker?: { failureThreshold: number; cooldownMs: number };
  /**
   * Fail over to the next registry-approved model of another provider when a provider is down or
   * its circuit is open (default true). Never to an unapproved model.
   */
  failover?: boolean;
  /** Called before every provider attempt; throw (e.g. AbstainError BUDGET_EXCEEDED) to stop it. */
  beforeCall?: (call: PlannedCall) => Promise<void>;
  /** Called after an attempt finished (released reservations etc.), successful or not. */
  afterCall?: (call: PlannedCall) => void;
  onProviderFailure?: (f: ProviderFailure) => void;
}

export interface GenerateResult<T> {
  output: T;
  provider: string;
  modelId: string;
  servedBy: string;
  usage: ProviderUsage;
  attempts: number;
  costUsd: number | null;
  /** Providers that failed before this one served the request (failover), in order. */
  failedOver: ProviderFailure[];
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
    const [first] = await this.plan(purpose);
    return first!;
  }

  /**
   * Candidates for a purpose in preference order: every registry-approved model whose provider is
   * configured, each with the approved refusal fallbacks of its own provider (D-024).
   */
  async plan(purpose: string): Promise<{ primary: ApprovedModel; fallbacks: ApprovedModel[] }[]> {
    const approved = (await this.opts.approvedModels()).filter((m) => this.opts.providers[m.provider]);
    const eligible = approved.filter((m) => m.purposes.includes(purpose));
    if (!eligible.length) throw new AbstainError('NO_APPROVED_MODEL', `no approved model for purpose ${purpose} (B-003)`);
    // Stable sort: preference rank first, registry order second.
    const ranked = eligible.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i);
    return ranked.map(({ m }) => ({ primary: m, fallbacks: approved.filter((f) => f.provider === m.provider && f.purposes.includes('fallback') && f.modelId !== m.modelId) }));
  }

  /**
   * Provider failover (FG-P2-001): a provider that is unavailable (or whose circuit is open) is
   * skipped for the next approved candidate of a different provider. Refusals, invalid output and
   * budget stops never fail over: they are answers, not outages.
   */
  async generate<T>(req: StructuredRequest<T>, opts: { validate?: z.ZodType<T>; repair?: boolean } = {}): Promise<GenerateResult<T>> {
    const candidates = await this.plan(req.purpose);
    const failures: ProviderFailure[] = [];
    const tried = new Set<string>();
    let open = 0;
    for (const c of candidates) {
      if (tried.has(c.primary.provider)) continue;
      tried.add(c.primary.provider);
      const br = this.breakers.get(c.primary.provider);
      if (br && br.openUntil > this.now()) {
        open += 1;
        failures.push({ provider: c.primary.provider, modelId: c.primary.modelId, message: 'circuit open after repeated failures', status: null });
        if (this.opts.failover === false) break;
        continue;
      }
      try {
        const r = await this.generateWith(c.primary, c.fallbacks, req, opts);
        return { ...r, failedOver: failures };
      } catch (err) {
        if (!(err instanceof ProviderUnavailableError)) throw err;
        this.trip(c.primary.provider);
        const failure = { provider: c.primary.provider, modelId: c.primary.modelId, message: err.message, status: err.status };
        failures.push(failure);
        this.opts.onProviderFailure?.(failure);
        if (this.opts.failover === false) break;
      }
    }
    const summary = failures.map((f) => `${f.provider}/${f.modelId}: ${f.message}`).join('; ');
    if (open === failures.length) throw new AbstainError('CIRCUIT_OPEN', summary);
    throw new AbstainError('MODEL_UNAVAILABLE', summary);
  }

  private async generateWith<T>(primary: ApprovedModel, fallbacks: ApprovedModel[], req: StructuredRequest<T>, opts: { validate?: z.ZodType<T>; repair?: boolean }): Promise<Omit<GenerateResult<T>, 'failedOver'>> {
    const provider = this.opts.providers[primary.provider]!;
    const approvedIds = new Set([primary.modelId, ...fallbacks.map((f) => f.modelId)]);
    const totals: ProviderUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let messages = [...req.messages];
    let lastIssues = '';
    const maxAttempts = opts.repair === false ? 1 : 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const planned: PlannedCall = { provider: primary.provider, modelId: primary.modelId, purpose: req.purpose, maxCostUsd: maxCost([primary, ...fallbacks], req.system, messages, req.maxTokens ?? DEFAULT_MAX_TOKENS) };
      await this.opts.beforeCall?.(planned);
      let outcome: ProviderOutcome<T>;
      try {
        outcome = await provider.generateStructured({ ...req, messages, effort: req.effort ?? EFFORT_BY_PURPOSE[req.purpose] }, { model: primary.modelId, fallbackModels: fallbacks.map((f) => f.modelId) });
      } catch (err) {
        this.opts.afterCall?.(planned);
        throw err;
      }
      this.breakers.set(primary.provider, { failures: 0, openUntil: 0 });
      addUsage(totals, outcome.usage);
      const served = approved(outcome.servedBy, approvedIds);
      try {
        await this.opts.recordUsage?.({
          provider: primary.provider,
          modelId: outcome.servedBy,
          purpose: req.purpose,
          usage: outcome.usage,
          costUsd: cost(served ? (fallbacks.find((f) => outcome.servedBy.startsWith(f.modelId)) ?? primary) : primary, outcome.usage),
          requestId: outcome.requestId,
          outcome: outcome.kind,
        });
      } finally {
        this.opts.afterCall?.(planned);
      }
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
        messages = [...messages, { role: 'assistant', content: serialized }, { role: 'user', content: `That JSON failed validation: ${lastIssues}. Return a corrected JSON object that satisfies every constraint.` }];
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

/** Provider default when a request sets no maxTokens (anthropic.ts uses the same). */
const DEFAULT_MAX_TOKENS = 16_000;

/**
 * Upper bound of one attempt: input estimated at 3 characters per token (conservative for English
 * and JSON), output at the full max_tokens, priced at the most expensive model that may serve it.
 */
export function maxCost(models: ApprovedModel[], system: string, messages: { content: string }[], maxTokens: number): number | null {
  const inputTokens = Math.ceil((system.length + messages.reduce((n, m) => n + m.content.length, 0)) / 3);
  let worst = 0;
  for (const m of models) {
    const c = cost(m, { inputTokens, outputTokens: maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
    if (c === null) return null;
    worst = Math.max(worst, c);
  }
  return worst;
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
