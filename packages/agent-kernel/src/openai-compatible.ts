import { z } from 'zod';
import { type ModelProvider, type ProviderCallOptions, type ProviderOutcome, ProviderUnavailableError, type StructuredRequest } from './types.js';

export interface OpenAICompatibleConfig {
  /** Provider id used in the model registry (default `openai_compatible`). */
  name?: string;
  /** Server root; the adapter appends `/v1/chat/completions` unless `chatUrl` is given. */
  baseUrl?: string;
  /** Full chat-completions URL for hosts with a different path (e.g. Gemini's `/v1beta/openai`). */
  chatUrl?: string;
  apiKey?: string;
  /** Newer OpenAI models reject `max_tokens` and require `max_completion_tokens`. */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  /** Provider-specific request fields (e.g. OpenRouter routing and data-collection preferences). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Hosted OpenAI-compatible APIs the runtime can enable with one API key each (B-003). Models are
 * still called only after they are registered and approved in the model registry (D-002).
 */
export const HOSTED_PROVIDERS = {
  openai: { chatUrl: 'https://api.openai.com/v1/chat/completions', tokenParam: 'max_completion_tokens' },
  groq: { chatUrl: 'https://api.groq.com/openai/v1/chat/completions', tokenParam: 'max_completion_tokens' },
  gemini: { chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', tokenParam: 'max_completion_tokens' },
  // Only upstream providers that honour the JSON schema and do not collect prompts (no training).
  openrouter: { chatUrl: 'https://openrouter.ai/api/v1/chat/completions', tokenParam: 'max_tokens', extraBody: { provider: { require_parameters: true, data_collection: 'deny' } }, headers: { 'x-title': 'FUTUREGROW' } },
} as const satisfies Record<string, Omit<OpenAICompatibleConfig, 'apiKey' | 'name'>>;

export type HostedProvider = keyof typeof HOSTED_PROVIDERS;

/** JSON Schema for structured output; the `$schema` keyword makes some models echo the schema back. */
export function structuredOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * Adapter for OpenAI-compatible chat-completions APIs: a self-hosted inference server (e.g. vLLM
 * serving Qwen3 under Apache-2.0 - product plan OS-QW/OS-VLLM) or a hosted API from
 * HOSTED_PROVIDERS. The model must still be registered and approved in the model registry.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  private readonly chatUrl: string;
  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.name = cfg.name ?? 'openai_compatible';
    if (!cfg.chatUrl && !cfg.baseUrl) throw new Error('OpenAICompatibleProvider needs baseUrl or chatUrl');
    this.chatUrl = cfg.chatUrl ?? `${cfg.baseUrl!.replace(/\/$/, '')}/v1/chat/completions`;
  }

  async generateStructured<T>(req: StructuredRequest<T>, opts: ProviderCallOptions): Promise<ProviderOutcome<T>> {
    const f = this.cfg.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await f(this.chatUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.cfg.headers, ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          ...this.cfg.extraBody,
          model: opts.model,
          [this.cfg.tokenParam ?? 'max_tokens']: req.maxTokens ?? 8000,
          messages: [{ role: 'system', content: req.system }, ...req.messages],
          response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: structuredOutputSchema(req.outputSchema) } },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderUnavailableError(`${this.name} unreachable: ${err instanceof Error ? err.message : String(err)}`, true, null);
    } finally {
      clearTimeout(timer);
    }
    // 429 covers both rate limits and exhausted credit; either way this provider cannot answer now.
    if (!res.ok) throw new ProviderUnavailableError(`${this.name} responded ${res.status}${await errorCode(res)}`, res.status >= 500 || res.status === 429, res.status);
    const body = (await res.json()) as {
      id?: string;
      model?: string;
      choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const servedBy = body.model ?? opts.model;
    const requestId = body.id ?? null;
    const choice = body.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') return { kind: 'refusal', category: choice.message?.refusal ? 'refusal' : 'content_filter', servedBy, usage, requestId };
    if (choice?.finish_reason === 'length') return { kind: 'truncated', servedBy, usage, requestId };
    try {
      return { kind: 'ok', output: JSON.parse(choice?.message?.content ?? '') as T, servedBy, usage, stopReason: choice?.finish_reason ?? null, requestId };
    } catch {
      return { kind: 'invalid_output', issues: 'response was not valid JSON', servedBy, usage, requestId };
    }
  }
}

/** Short machine-readable reason from an error body (e.g. `insufficient_quota`); never the message text. */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; type?: unknown; status?: unknown } } | [{ error?: { status?: unknown } }] | null;
  const err = Array.isArray(body) ? body[0]?.error : body?.error;
  const code = [err && 'code' in err ? err.code : undefined, err && 'type' in err ? err.type : undefined, err?.status].find((v) => typeof v === 'string' && /^[\w.-]{1,64}$/.test(v));
  return code ? ` (${code})` : '';
}

/** OpenAI-compatible embeddings endpoint (vLLM/TEI/hosted). Optional, D-007. */
export class OpenAICompatibleEmbedder {
  constructor(private readonly cfg: { baseUrl: string; apiKey?: string; model: string; fetchImpl?: typeof fetch }) {}
  get model() {
    return this.cfg.model;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const f = this.cfg.fetchImpl ?? fetch;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await f(`${this.cfg.baseUrl.replace(/\/$/, '')}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.cfg.model, input: texts.slice(i, i + 64) }),
      });
      if (!res.ok) throw new Error(`embeddings endpoint responded ${res.status}`);
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      out.push(...body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}
