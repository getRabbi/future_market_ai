import { z } from 'zod';
import { type ModelProvider, type ProviderCallOptions, type ProviderOutcome, ProviderUnavailableError, type StructuredRequest } from './types.js';

/**
 * Adapter for a self-hosted OpenAI-compatible inference server (e.g. vLLM serving Qwen3 under
 * Apache-2.0 - product plan OS-QW/OS-VLLM). Not used by default: there is no GPU in the Sandbox
 * tier (B-003). The model's weights must still be registered and approved in the model registry.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai_compatible';
  constructor(private readonly cfg: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {}

  async generateStructured<T>(req: StructuredRequest<T>, opts: ProviderCallOptions): Promise<ProviderOutcome<T>> {
    const f = this.cfg.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await f(`${this.cfg.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: req.maxTokens ?? 8000,
          messages: [{ role: 'system', content: req.system }, ...req.messages],
          response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: z.toJSONSchema(req.outputSchema) } },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderUnavailableError(`inference server unreachable: ${err instanceof Error ? err.message : String(err)}`, true, null);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new ProviderUnavailableError(`inference server responded ${res.status}`, res.status >= 500 || res.status === 429, res.status);
    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const servedBy = body.model ?? opts.model;
    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'length') return { kind: 'truncated', servedBy, usage, requestId: null };
    try {
      return { kind: 'ok', output: JSON.parse(choice?.message?.content ?? '') as T, servedBy, usage, stopReason: choice?.finish_reason ?? null, requestId: null };
    } catch {
      return { kind: 'invalid_output', issues: 'response was not valid JSON', servedBy, usage, requestId: null };
    }
  }
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
