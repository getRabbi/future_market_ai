import type { z } from 'zod';

export type ModelPurpose = 'planning' | 'critic' | 'generation' | 'extraction' | 'classification' | 'fallback';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StructuredRequest<T> {
  purpose: Exclude<ModelPurpose, 'fallback'>;
  /** Stable, versioned system prompt (cacheable prefix). Never contains secrets or volatile data. */
  system: string;
  messages: ModelMessage[];
  /** Constrains the model output (sent to the provider). Keep it to JSON-schema-friendly constructs. */
  outputSchema: z.ZodType<T>;
  effort?: Effort;
  maxTokens?: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type ProviderOutcome<T> =
  | { kind: 'ok'; output: T; servedBy: string; usage: ProviderUsage; stopReason: string | null; requestId: string | null }
  | { kind: 'refusal'; category: string | null; servedBy: string; usage: ProviderUsage; requestId: string | null }
  | { kind: 'truncated'; servedBy: string; usage: ProviderUsage; requestId: string | null }
  | { kind: 'invalid_output'; issues: string; servedBy: string; usage: ProviderUsage; requestId: string | null };

export interface ProviderCallOptions {
  model: string;
  /** Explicit fallback models (all registry-approved). Empty => no server-side fallback (D-024). */
  fallbackModels: string[];
  signal?: AbortSignal;
}

/** A model provider adapter. Implementations own SDK usage; nothing else talks to vendors. */
export interface ModelProvider {
  readonly name: string;
  generateStructured<T>(req: StructuredRequest<T>, opts: ProviderCallOptions): Promise<ProviderOutcome<T>>;
}

export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export interface ApprovedModel {
  provider: string;
  modelId: string;
  purposes: string[];
  inputUsdPerMtok: number | null;
  outputUsdPerMtok: number | null;
}

/** Abstention is a first-class outcome: the agent declines rather than guessing (product plan). */
export class AbstainError extends Error {
  constructor(
    readonly reason:
      | 'MODEL_UNAVAILABLE'
      | 'NO_APPROVED_MODEL'
      | 'MODEL_REFUSAL'
      | 'OUTPUT_INVALID'
      | 'OUTPUT_TRUNCATED'
      | 'SECRET_IN_OUTPUT'
      | 'CIRCUIT_OPEN'
      | 'UNAPPROVED_SERVING_MODEL'
      | 'INSUFFICIENT_EVIDENCE'
      /** The tenant's AI spending limit would be exceeded by this call. */
      | 'BUDGET_EXCEEDED'
      /** A spending limit applies but the model's price is unknown, so spend cannot be bounded. */
      | 'BUDGET_UNMEASURABLE',
    message: string,
  ) {
    super(message);
    this.name = 'AbstainError';
  }
}
