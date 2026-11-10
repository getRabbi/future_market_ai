import { lookup } from 'node:dns/promises';
import { assertFetchableUrl, isBlockedAddress } from '@futuregrow/connectors';
import type { GenerativeVideoProvider, VideoPollResult, VideoRequest, VideoStartInput } from './generative-video.js';

/**
 * Generative-video adapters for the switchboard. Neither is bundled as "on": each is built only
 * when its server configuration exists, and even then a tenant needs an approved, priced model,
 * an output licence, budgets and an explicit per-request authorization before anything is sent.
 *
 * Contracts used (and nothing beyond them):
 *  - ComfyUI server (open source, operator-hosted Wan workflow): POST /prompt {prompt, client_id}
 *    → {prompt_id}; GET /history/{id}; GET /queue; GET /view?filename&subfolder&type; POST /queue
 *    {delete:[id]}; POST /interrupt; POST /upload/image (multipart). ComfyUI has no idempotency
 *    keys, so the adapter is NOT replay-safe and an ambiguous submission is never retried.
 *  - Higgsfield developer API (docs.higgsfield.ai): POST to the model path with header
 *    `Authorization: Key <id>:<secret>` and `Idempotency-Key`; response {request_id, status_url,
 *    cancel_url}; GET /requests/{id}/status → queued | in_progress | completed | failed | nsfw |
 *    canceled, with `video.url` on completion; POST /requests/{id}/cancel works only while queued
 *    (202, else 400). The API returns no charge, so cost is reported as unknown and reconciled.
 *    Per-model request bodies are operator-configured templates, never guessed here.
 */

type Fetch = typeof fetch;

/** Resolves a provider-supplied download host and refuses private, loopback or link-local addresses. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const list = await lookup(hostname, { all: true });
  if (!list.length || list.some((a) => isBlockedAddress(a.address))) throw new VideoAdapterError(`output host ${hostname} does not resolve to a public address`);
}
export type Size = { width: number; height: number };

export class VideoAdapterError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'VideoAdapterError';
  }
}

/** Replaces "{{name}}" placeholders: a whole-string placeholder keeps the value's type (numbers stay numbers). */
export function fillTemplate(template: unknown, vars: Record<string, string | number | null>): unknown {
  if (typeof template === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(template);
    if (whole) {
      if (!(whole[1]! in vars)) throw new VideoAdapterError(`unknown template placeholder ${template}`);
      return vars[whole[1]!];
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
      if (!(k in vars)) throw new VideoAdapterError(`unknown template placeholder {{${k}}}`);
      return String(vars[k] ?? '');
    });
  }
  if (Array.isArray(template)) return template.map((x) => fillTemplate(x, vars));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillTemplate(v, vars)]));
  return template;
}

async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new VideoAdapterError(`response exceeds ${maxBytes} bytes`);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new VideoAdapterError(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function jsonOf(res: Response): Promise<unknown> {
  const text = new TextDecoder().decode(await readBounded(res, 2_000_000));
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new VideoAdapterError(`provider returned invalid JSON (HTTP ${res.status})`, res.status);
  }
}

const sizeOk = (sizes: readonly Size[], w: number, h: number) => sizes.some((s) => s.width === w && s.height === h);

/* ------------------------------------------------------------------ */
/* Wan on an operator-hosted ComfyUI GPU worker                        */
/* ------------------------------------------------------------------ */

export interface ComfyWanConfig {
  /** https base URL of the ComfyUI server (behind the operator's authenticating proxy). */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>`; ComfyUI itself has no authentication. */
  token: string;
  /** API-format workflow JSON with placeholders {{prompt}}, {{seconds}}, {{frames}}, {{fps}}, {{width}}, {{height}}, {{seed}}. */
  textToVideoWorkflow: Record<string, unknown>;
  /** Optional image-to-video workflow; additionally receives {{image}} (the uploaded input name). */
  imageToVideoWorkflow?: Record<string, unknown> | null;
  /** Output sizes the workflows produce exactly (Wan 2.x: 832×480, 480×832, 1280×720, 720×1280). */
  sizes?: Size[];
  /** Frames per second the workflow renders at; frames = seconds × fps + 1 (Wan uses 4n+1 frames at 16 fps). */
  fps?: number;
  maxSeconds?: number;
  /** GPU price used for the compute estimate (estimated_compute, never an invoice). */
  usdPerGpuHour: number;
  maxRunSeconds?: number;
  maxOutputBytes?: number;
  fetchImpl?: Fetch;
}

const DEFAULT_WAN_SIZES: Size[] = [
  { width: 832, height: 480 },
  { width: 480, height: 832 },
  { width: 1280, height: 720 },
  { width: 720, height: 1280 },
];

type ComfyHistoryEntry = {
  outputs?: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, { timestamp?: number; exception_message?: string }][] };
};

export function createComfyWanProvider(cfg: ComfyWanConfig): GenerativeVideoProvider {
  const base = new URL(cfg.baseUrl);
  if (base.protocol !== 'https:') throw new Error('FG_WAN_COMFYUI_URL must be https');
  const root = base.toString().replace(/\/$/, '');
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const sizes = cfg.sizes?.length ? cfg.sizes : DEFAULT_WAN_SIZES;
  const fps = cfg.fps ?? 16;
  const maxSeconds = cfg.maxSeconds ?? 10;
  const maxOutputBytes = cfg.maxOutputBytes ?? 100_000_000;
  const auth = { authorization: `Bearer ${cfg.token}` };
  const call = async (path: string, init: RequestInit & { signal: AbortSignal }) => {
    const res = await fetchImpl(`${root}${path}`, { ...init, redirect: 'error', headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new VideoAdapterError(`ComfyUI ${init.method ?? 'GET'} ${path.split('?')[0]} returned HTTP ${res.status}`, res.status);
    }
    return res;
  };
  const queueState = async (id: string, signal: AbortSignal) => {
    const q = (await jsonOf(await call('/queue', { method: 'GET', signal }))) as { queue_running?: unknown[][]; queue_pending?: unknown[][] } | null;
    const has = (list?: unknown[][]) => (list ?? []).some((item) => Array.isArray(item) && item[1] === id);
    return has(q?.queue_running) ? 'running' : has(q?.queue_pending) ? 'pending' : 'absent';
  };
  const estimate = (entry: ComfyHistoryEntry): number | null => {
    const msgs = entry.status?.messages ?? [];
    const start = msgs.find((m) => m[0] === 'execution_start')?.[1]?.timestamp;
    const end = [...msgs].reverse().find((m) => m[0] === 'execution_success' || m[0] === 'execution_error' || m[0] === 'execution_interrupted')?.[1]?.timestamp;
    if (typeof start !== 'number' || typeof end !== 'number' || end < start) return null;
    return Math.round(((end - start) / 3_600_000) * cfg.usdPerGpuHour * 10_000) / 10_000;
  };
  return {
    replaySafe: false,
    imageToVideo: Boolean(cfg.imageToVideoWorkflow),
    sizes,
    maxRunSeconds: cfg.maxRunSeconds ?? 1800,
    supports(input: VideoRequest) {
      if (input.imageAssetId && !cfg.imageToVideoWorkflow) return false;
      return input.seconds <= maxSeconds && sizeOk(sizes, input.width, input.height);
    },
    async start(input: VideoStartInput) {
      let imageName: string | null = null;
      if (input.imageAssetId) {
        if (!input.image || !cfg.imageToVideoWorkflow) throw new VideoAdapterError('image-to-video is not configured');
        const form = new FormData();
        const ext = input.image.mime === 'image/png' ? 'png' : input.image.mime === 'image/webp' ? 'webp' : 'jpg';
        form.append('image', new Blob([Uint8Array.from(input.image.bytes)], { type: input.image.mime }), `futuregrow-${input.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '-').slice(-60)}.${ext}`);
        form.append('overwrite', 'true');
        form.append('type', 'input');
        const up = (await jsonOf(await call('/upload/image', { method: 'POST', body: form, signal: input.signal }))) as { name?: unknown } | null;
        if (typeof up?.name !== 'string' || !up.name) throw new VideoAdapterError('ComfyUI did not return the uploaded image name');
        imageName = up.name;
      }
      const workflow = fillTemplate(imageName ? cfg.imageToVideoWorkflow : cfg.textToVideoWorkflow, {
        prompt: input.prompt,
        seconds: input.seconds,
        fps,
        frames: input.seconds * fps + 1,
        width: input.width,
        height: input.height,
        // Deterministic per job, so a manual resubmission reproduces the same clip.
        seed: Number.parseInt(input.idempotencyKey.replace(/[^0-9a-f]/gi, '').slice(-12) || '1', 16) % 2 ** 31,
        image: imageName,
      });
      const res = (await jsonOf(await call('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: 'futuregrow' }), signal: input.signal }))) as { prompt_id?: unknown; node_errors?: Record<string, unknown> } | null;
      if (res?.node_errors && Object.keys(res.node_errors).length) throw new VideoAdapterError(`ComfyUI rejected the workflow: ${JSON.stringify(res.node_errors).slice(0, 300)}`);
      if (typeof res?.prompt_id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(res.prompt_id)) throw new VideoAdapterError('ComfyUI returned no prompt_id');
      return { operationId: res.prompt_id };
    },
    async poll(id: string, signal: AbortSignal): Promise<VideoPollResult> {
      const history = (await jsonOf(await call(`/history/${encodeURIComponent(id)}`, { method: 'GET', signal }))) as Record<string, ComfyHistoryEntry> | null;
      const entry = history?.[id];
      if (!entry) {
        const state = await queueState(id, signal);
        if (state !== 'absent') return { status: 'pending' };
        return { status: 'failed', reason: 'The prompt is no longer known to the GPU worker (restarted or cleared); reconcile any GPU time.', actualCostUsd: null };
      }
      const cost = estimate(entry);
      const basis = cost === null ? ('unreported' as const) : ('estimated_compute' as const);
      if (entry.status?.status_str === 'error') {
        const msg = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message ?? 'workflow error';
        return { status: 'failed', reason: `GPU workflow failed: ${String(msg).slice(0, 300)}`, actualCostUsd: cost, costBasis: basis };
      }
      if (!entry.status?.completed) return { status: 'pending' };
      const files = Object.values(entry.outputs ?? {})
        .flatMap((o) => Object.values(o).filter(Array.isArray).flat() as { filename?: unknown; subfolder?: unknown; type?: unknown }[])
        .filter((f) => typeof f?.filename === 'string' && /\.mp4$/i.test(f.filename as string));
      if (files.length !== 1) return { status: 'failed', reason: `Expected exactly one MP4 output, found ${files.length}`, actualCostUsd: cost, costBasis: basis };
      const f = files[0]!;
      const q = new URLSearchParams({ filename: String(f.filename), subfolder: typeof f.subfolder === 'string' ? f.subfolder : '', type: typeof f.type === 'string' ? f.type : 'output' });
      const bytes = await readBounded(await call(`/view?${q}`, { method: 'GET', signal }), maxOutputBytes);
      return { status: 'succeeded', bytes, actualCostUsd: cost, costBasis: basis };
    },
    async cancel(id: string, signal: AbortSignal) {
      const state = await queueState(id, signal);
      if (state === 'pending') {
        await call('/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [id] }), signal });
        return { cancelled: true };
      }
      if (state === 'running') {
        await call('/interrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt_id: id }), signal });
        return { cancelled: true, reason: 'interrupted while running; GPU time already used is billed by the host' };
      }
      return { cancelled: false, reason: 'the prompt is not queued or running' };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Higgsfield developer API                                            */
/* ------------------------------------------------------------------ */

export interface HiggsfieldModelConfig {
  /** Model endpoint path from the Higgsfield API reference, e.g. "/<vendor>/<model>/<variant>". */
  path: string;
  /** Request body template from the model's API reference; placeholders {{prompt}}, {{seconds}}, {{width}}, {{height}}, {{image_url}}. */
  body: Record<string, unknown>;
  /** Exact output sizes and durations the operator verified for this model. */
  sizes: Size[];
  seconds: number[];
  imageToVideo?: boolean;
}

export interface HiggsfieldConfig {
  baseUrl?: string;
  keyId: string;
  keySecret: string;
  models: Record<string, HiggsfieldModelConfig>;
  /** Optional allowlist of output download hosts; downloads are https-only and SSRF-guarded regardless. */
  outputHosts?: string[];
  maxOutputBytes?: number;
  fetchImpl?: Fetch;
  /** DNS check for output hosts (tests inject a stub). */
  resolveHost?: (hostname: string) => Promise<void>;
}

const HF_FINAL_FAILURES = new Set(['failed', 'nsfw', 'canceled']);

export function createHiggsfieldProvider(cfg: HiggsfieldConfig): GenerativeVideoProvider {
  const root = new URL(cfg.baseUrl ?? 'https://api.higgsfield.ai');
  if (root.protocol !== 'https:') throw new Error('Higgsfield base URL must be https');
  const base = root.toString().replace(/\/$/, '');
  for (const [id, m] of Object.entries(cfg.models)) if (!/^\/[A-Za-z0-9._/-]+$/.test(m.path) || m.path.includes('..')) throw new Error(`invalid Higgsfield model path for ${id}`);
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const maxOutputBytes = cfg.maxOutputBytes ?? 100_000_000;
  const headers = { authorization: `Key ${cfg.keyId}:${cfg.keySecret}`, accept: 'application/json' };
  const call = async (url: string, init: RequestInit & { signal: AbortSignal }) => fetchImpl(url, { ...init, redirect: 'error', headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  const download = async (raw: string, signal: AbortSignal) => {
    let url = assertFetchableUrl(raw);
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== 'https:') throw new VideoAdapterError('output URL must be https');
      if (cfg.outputHosts?.length && !cfg.outputHosts.includes(url.hostname)) throw new VideoAdapterError(`output host ${url.hostname} is not allowlisted`);
      await (cfg.resolveHost ?? assertPublicHost)(url.hostname);
      const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new VideoAdapterError('redirect without location');
        url = assertFetchableUrl(new URL(loc, url).toString());
        continue;
      }
      if (!res.ok) throw new VideoAdapterError(`output download returned HTTP ${res.status}`, res.status);
      return readBounded(res, maxOutputBytes);
    }
    throw new VideoAdapterError('too many redirects');
  };
  return {
    // Documented: a replay with the same Idempotency-Key and parameters returns the original request without a new charge.
    replaySafe: true,
    imageToVideo: Object.values(cfg.models).some((m) => m.imageToVideo),
    sizes: [
      ...new Map(
        Object.values(cfg.models)
          .flatMap((m) => m.sizes)
          .map((s) => [`${s.width}x${s.height}`, s]),
      ).values(),
    ],
    maxRunSeconds: 6 * 3600,
    supports(input: VideoRequest) {
      const m = cfg.models[input.modelId];
      if (!m) return false;
      if (input.imageAssetId && !m.imageToVideo) return false;
      return m.seconds.includes(input.seconds) && sizeOk(m.sizes, input.width, input.height);
    },
    async start(input: VideoStartInput) {
      const m = cfg.models[input.modelId];
      if (!m) throw new VideoAdapterError(`model ${input.modelId} is not configured`);
      if (input.imageAssetId && !input.image?.url) throw new VideoAdapterError('image-to-video needs a presigned input URL (R2 object storage)');
      const body = fillTemplate(m.body, { prompt: input.prompt, seconds: input.seconds, width: input.width, height: input.height, image_url: input.image?.url ?? null });
      const res = await call(`${base}${m.path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey }, body: JSON.stringify(body), signal: input.signal });
      const data = (await jsonOf(res)) as { request_id?: unknown; detail?: unknown; message?: unknown } | null;
      if (!res.ok) throw new VideoAdapterError(`Higgsfield submission returned HTTP ${res.status}: ${String(data?.detail ?? data?.message ?? '').slice(0, 300)}`, res.status);
      if (typeof data?.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.request_id)) throw new VideoAdapterError('Higgsfield returned no request_id');
      return { operationId: data.request_id };
    },
    async poll(id: string, signal: AbortSignal): Promise<VideoPollResult> {
      const res = await call(`${base}/requests/${encodeURIComponent(id)}/status`, { method: 'GET', signal });
      const data = (await jsonOf(res)) as { status?: unknown; video?: { url?: unknown }; error?: unknown } | null;
      if (!res.ok) throw new VideoAdapterError(`Higgsfield status returned HTTP ${res.status}`, res.status);
      const status = String(data?.status ?? '');
      if (status === 'queued' || status === 'in_progress') return { status: 'pending' };
      if (HF_FINAL_FAILURES.has(status)) return { status: 'failed', reason: `Higgsfield request ${status}${data?.error ? `: ${String(data.error).slice(0, 300)}` : ''}`, actualCostUsd: null, costBasis: 'unreported' };
      if (status !== 'completed') throw new VideoAdapterError(`unexpected Higgsfield status "${status.slice(0, 40)}"`);
      if (typeof data?.video?.url !== 'string') return { status: 'failed', reason: 'Higgsfield completed without a video URL', actualCostUsd: null, costBasis: 'unreported' };
      return { status: 'succeeded', bytes: await download(data.video.url, signal), actualCostUsd: null, costBasis: 'unreported' };
    },
    async cancel(id: string, signal: AbortSignal) {
      const res = await call(`${base}/requests/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal });
      await res.body?.cancel().catch(() => {});
      if (res.status === 202) return { cancelled: true };
      if (res.status === 400) return { cancelled: false, reason: 'processing already started; Higgsfield cancels only queued requests' };
      throw new VideoAdapterError(`Higgsfield cancel returned HTTP ${res.status}`, res.status);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Server configuration                                                */
/* ------------------------------------------------------------------ */

const parseSizes = (v: string | undefined): Size[] | undefined =>
  v
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d{3,4})x(\d{3,4})$/.exec(s);
      if (!m) throw new Error(`invalid size "${s}" (use WIDTHxHEIGHT)`);
      return { width: Number(m[1]), height: Number(m[2]) };
    });

export interface VideoAdapterEnv {
  FG_WAN_COMFYUI_URL?: string;
  FG_WAN_COMFYUI_TOKEN?: string;
  FG_WAN_USD_PER_GPU_HOUR?: number;
  FG_WAN_SIZES?: string;
  FG_WAN_MAX_RUN_SECONDS?: number;
  HF_API_KEY_ID?: string;
  HF_API_KEY_SECRET?: string;
  FG_HIGGSFIELD_MODELS_JSON?: string;
  FG_HIGGSFIELD_OUTPUT_HOSTS?: string;
}

/**
 * Builds only fully configured adapters. Missing pieces leave the mode "Setup required"; nothing
 * is provisioned, rented or started. Workflow JSON is read by the caller (files stay outside env).
 */
export function videoProvidersFromEnv(env: VideoAdapterEnv, workflows: { textToVideo: Record<string, unknown> | null; imageToVideo: Record<string, unknown> | null }, fetchImpl?: Fetch): Record<string, GenerativeVideoProvider> {
  const out: Record<string, GenerativeVideoProvider> = {};
  if (env.FG_WAN_COMFYUI_URL && env.FG_WAN_COMFYUI_TOKEN && workflows.textToVideo && env.FG_WAN_USD_PER_GPU_HOUR !== undefined) {
    out.wan_cloud = createComfyWanProvider({
      baseUrl: env.FG_WAN_COMFYUI_URL,
      token: env.FG_WAN_COMFYUI_TOKEN,
      textToVideoWorkflow: workflows.textToVideo,
      imageToVideoWorkflow: workflows.imageToVideo,
      usdPerGpuHour: env.FG_WAN_USD_PER_GPU_HOUR,
      ...(env.FG_WAN_SIZES ? { sizes: parseSizes(env.FG_WAN_SIZES)! } : {}),
      ...(env.FG_WAN_MAX_RUN_SECONDS ? { maxRunSeconds: env.FG_WAN_MAX_RUN_SECONDS } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  if (env.HF_API_KEY_ID && env.HF_API_KEY_SECRET && env.FG_HIGGSFIELD_MODELS_JSON) {
    const models = JSON.parse(env.FG_HIGGSFIELD_MODELS_JSON) as Record<string, HiggsfieldModelConfig>;
    if (Object.keys(models).length)
      out.higgsfield = createHiggsfieldProvider({
        keyId: env.HF_API_KEY_ID,
        keySecret: env.HF_API_KEY_SECRET,
        models,
        ...(env.FG_HIGGSFIELD_OUTPUT_HOSTS
          ? {
              outputHosts: env.FG_HIGGSFIELD_OUTPUT_HOSTS.split(',')
                .map((h) => h.trim())
                .filter(Boolean),
            }
          : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
  }
  return out;
}
