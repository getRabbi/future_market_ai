import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { type ModelProvider, type ProviderCallOptions, type ProviderOutcome, ProviderUnavailableError, type StructuredRequest } from './types.js';

const FALLBACK_BETA = 'server-side-fallback-2026-06-01';

export interface AnthropicProviderOptions {
  apiKey?: string;
  /** Overrides for tests/proxies. */
  baseURL?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Anthropic Messages API adapter (official SDK). Structured output via `output_config.format`;
 * adaptive thinking is always on for Claude Opus 5.5 so `thinking` is omitted and depth is set
 * with `output_config.effort`. Refusals are checked before reading content.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      maxRetries: opts.maxRetries ?? 2,
      timeout: opts.timeoutMs ?? 120_000,
    });
  }

  async generateStructured<T>(req: StructuredRequest<T>, opts: ProviderCallOptions): Promise<ProviderOutcome<T>> {
    const messages: BetaMessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const fallbacks = opts.fallbackModels.length ? { fallbacks: opts.fallbackModels.map((model) => ({ model })), betas: [FALLBACK_BETA] } : {};
    let response: Awaited<ReturnType<typeof this.client.beta.messages.parse>>;
    try {
      response = await this.client.beta.messages.parse(
        {
          model: opts.model,
          max_tokens: req.maxTokens ?? 16000,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages,
          output_config: { format: betaZodOutputFormat(req.outputSchema as never), effort: req.effort ?? 'high' },
          ...fallbacks,
        },
        opts.signal ? { signal: opts.signal } : undefined,
      );
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new ProviderUnavailableError(`anthropic credentials rejected: ${err.message}`, false, err.status ?? null);
      }
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
        throw new ProviderUnavailableError(`anthropic rejected the request: ${err.message}`, false, err.status ?? null);
      }
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
        throw new ProviderUnavailableError(`anthropic unavailable: ${err.message}`, true, err instanceof Anthropic.APIError ? (err.status ?? null) : null);
      }
      if (err instanceof Anthropic.APIError) {
        throw new ProviderUnavailableError(`anthropic error ${err.status}: ${err.message}`, (err.status ?? 0) >= 500, err.status ?? null);
      }
      throw err;
    }
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const base = { servedBy: response.model, usage, requestId: response._request_id ?? null };
    if (response.stop_reason === 'refusal') {
      return { kind: 'refusal', category: response.stop_details?.category ?? null, ...base };
    }
    if (response.stop_reason === 'max_tokens') return { kind: 'truncated', ...base };
    if (response.parsed_output === null || response.parsed_output === undefined) {
      return { kind: 'invalid_output', issues: 'structured output could not be parsed', ...base };
    }
    return { kind: 'ok', output: response.parsed_output as T, stopReason: response.stop_reason, ...base };
  }
}
