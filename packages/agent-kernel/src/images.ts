/**
 * Image-generation providers (P3-02). Like text models, an image model is only ever called by
 * FUTUREGROW code after the model registry approves it for `image_generation` (commercial use
 * allowed, no training on customer data) and the tenant's AI spending limit allows the priced call.
 * Providers own the vendor contract; nothing else talks to image vendors.
 */

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  /** Provider size the caller picked from `sizes(model)`. */
  size: { width: number; height: number };
  quality?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  revisedPrompt: string | null;
  requestId: string | null;
  usage: Record<string, number> | null;
}

export type ImageErrorKind = 'refused' | 'rate_limited' | 'unavailable' | 'invalid_request' | 'auth' | 'quota';

export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ImageErrorKind,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ImageProviderError';
  }
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

export interface ImageModelProvider {
  readonly name: string;
  /** Output sizes the model supports. */
  sizes(model: string): { width: number; height: number }[];
  generate(req: ImageGenerationRequest): Promise<GeneratedImage>;
}

/** Picks the supported size whose aspect ratio is closest to the target (the result is then cover-cropped). */
export function closestSize(sizes: { width: number; height: number }[], target: { width: number; height: number }) {
  const want = target.width / target.height;
  return [...sizes].sort((a, b) => Math.abs(Math.log(a.width / a.height / want)) - Math.abs(Math.log(b.width / b.height / want)))[0] ?? null;
}

const OPENAI_SIZES: Record<string, { width: number; height: number }[]> = {
  'gpt-image-1': [
    { width: 1024, height: 1024 },
    { width: 1536, height: 1024 },
    { width: 1024, height: 1536 },
  ],
  'gpt-image-1-mini': [
    { width: 1024, height: 1024 },
    { width: 1536, height: 1024 },
    { width: 1024, height: 1536 },
  ],
};

/**
 * OpenAI Images API (POST /v1/images/generations). The GPT image models always return base64
 * (`data[].b64_json`); `output_format` selects png/jpeg/webp. A content-policy refusal is a 400
 * with code `moderation_blocked` and is reported as `refused`, never retried.
 */
export class OpenAIImageProvider implements ImageModelProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; baseUrl?: string; name?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.name = opts.name ?? 'openai';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  sizes(model: string) {
    return OPENAI_SIZES[model] ?? OPENAI_SIZES['gpt-image-1']!;
  }

  async generate(req: ImageGenerationRequest): Promise<GeneratedImage> {
    const size = `${req.size.width}x${req.size.height}`;
    if (!this.sizes(req.model).some((s) => s.width === req.size.width && s.height === req.size.height)) throw new ImageProviderError(`size ${size} is not supported by ${req.model}`, 'invalid_request', null);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: req.model, prompt: req.prompt, n: 1, size, quality: req.quality ?? 'medium', output_format: 'png' }),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      throw new ImageProviderError(`image provider unreachable: ${err instanceof Error ? err.message : String(err)}`, 'unavailable', null);
    }
    const requestId = res.headers.get('x-request-id');
    const text = await res.text();
    let body: { data?: { b64_json?: string; revised_prompt?: string }[]; usage?: Record<string, unknown>; error?: { code?: string; message?: string; type?: string } } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    if (!res.ok) {
      const code = body.error?.code ?? body.error?.type ?? '';
      const msg = `${res.status} ${code}: ${body.error?.message ?? text.slice(0, 200)}`;
      if (code === 'moderation_blocked' || code === 'content_policy_violation') throw new ImageProviderError(`the provider refused the prompt (${msg})`, 'refused', res.status);
      if (res.status === 401 || res.status === 403) throw new ImageProviderError(msg, 'auth', res.status);
      if (res.status === 429 && code === 'insufficient_quota') throw new ImageProviderError(msg, 'quota', res.status);
      if (res.status === 429) throw new ImageProviderError(msg, 'rate_limited', res.status);
      if (res.status >= 500) throw new ImageProviderError(msg, 'unavailable', res.status);
      throw new ImageProviderError(msg, 'invalid_request', res.status);
    }
    const b64 = body.data?.[0]?.b64_json;
    if (!b64) throw new ImageProviderError('the provider returned no image', 'unavailable', res.status);
    const usage = body.usage ? Object.fromEntries(Object.entries(body.usage).filter((e): e is [string, number] => typeof e[1] === 'number')) : null;
    return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), mime: 'image/png', width: req.size.width, height: req.size.height, revisedPrompt: body.data?.[0]?.revised_prompt ?? null, requestId, usage };
  }
}
