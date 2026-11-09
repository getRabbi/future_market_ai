/**
 * Speech (text-to-speech) providers (P3-04 voiceover). Like image models, a speech model is only
 * called by FUTUREGROW code after the model registry approves it for `speech_generation`
 * (commercial use allowed, no training on customer data, a per-character price) and the tenant's
 * AI spending limit allows the priced call. Every result is a synthetic voice and is labelled as
 * AI-generated wherever it is used. Providers own the vendor contract.
 */

export interface SpeechRequest {
  model: string;
  voice: string;
  text: string;
  /** Spoken speed, 0.5–2.0 (provider default 1). */
  speed?: number;
  signal?: AbortSignal;
}

export interface GeneratedSpeech {
  bytes: Uint8Array;
  mime: 'audio/mpeg';
  /** Characters billed (the input length). */
  characters: number;
  requestId: string | null;
}

export type SpeechErrorKind = 'refused' | 'rate_limited' | 'unavailable' | 'invalid_request' | 'auth' | 'quota';

export class SpeechProviderError extends Error {
  constructor(
    message: string,
    readonly kind: SpeechErrorKind,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'SpeechProviderError';
  }
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

export interface SpeechModelProvider {
  readonly name: string;
  /** Voices the model offers (all synthetic; none imitates a real person). */
  voices(model: string): string[];
  /** Longest input one request accepts, in characters. */
  maxCharacters(model: string): number;
  synthesize(req: SpeechRequest): Promise<GeneratedSpeech>;
}

const OPENAI_VOICES: Record<string, string[]> = {
  'tts-1': ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
  'tts-1-hd': ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
};

/**
 * OpenAI Audio API (POST /v1/audio/speech), MP3 output. The input limit is 4096 characters; a
 * content-policy refusal is reported as `refused` and never retried.
 */
export class OpenAISpeechProvider implements SpeechModelProvider {
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

  voices(model: string) {
    return OPENAI_VOICES[model] ?? OPENAI_VOICES['tts-1']!;
  }

  maxCharacters() {
    return 4096;
  }

  async synthesize(req: SpeechRequest): Promise<GeneratedSpeech> {
    if (!this.voices(req.model).includes(req.voice)) throw new SpeechProviderError(`voice ${req.voice} is not offered by ${req.model}`, 'invalid_request', null);
    if (!req.text.trim() || req.text.length > this.maxCharacters()) throw new SpeechProviderError(`text must be 1–${this.maxCharacters()} characters`, 'invalid_request', null);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: req.model, voice: req.voice, input: req.text, response_format: 'mp3', ...(req.speed ? { speed: req.speed } : {}) }),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      throw new SpeechProviderError(`speech provider unreachable: ${err instanceof Error ? err.message : String(err)}`, 'unavailable', null);
    }
    const requestId = res.headers.get('x-request-id');
    if (!res.ok) {
      const text = await res.text();
      let body: { error?: { code?: string; message?: string; type?: string } } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      const code = body.error?.code ?? body.error?.type ?? '';
      const msg = `${res.status} ${code}: ${body.error?.message ?? text.slice(0, 200)}`;
      if (code === 'moderation_blocked' || code === 'content_policy_violation') throw new SpeechProviderError(`the provider refused the text (${msg})`, 'refused', res.status);
      if (res.status === 401 || res.status === 403) throw new SpeechProviderError(msg, 'auth', res.status);
      if (res.status === 429 && code === 'insufficient_quota') throw new SpeechProviderError(msg, 'quota', res.status);
      if (res.status === 429) throw new SpeechProviderError(msg, 'rate_limited', res.status);
      if (res.status >= 500) throw new SpeechProviderError(msg, 'unavailable', res.status);
      throw new SpeechProviderError(msg, 'invalid_request', res.status);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // MP3 frames start with 0xFFE.. or an ID3 tag; anything else is not audio we can use.
    const isMp3 = bytes.length > 3 && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0));
    if (!isMp3) throw new SpeechProviderError('the provider returned something that is not MP3 audio', 'unavailable', res.status);
    return { bytes, mime: 'audio/mpeg', characters: req.text.length, requestId };
  }
}
