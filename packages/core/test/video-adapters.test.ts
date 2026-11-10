import { describe, expect, it } from 'vitest';
import type { VideoStartInput } from '../src/modules/media/generative-video.js';
import { createComfyWanProvider, createHiggsfieldProvider, fillTemplate, videoProvidersFromEnv } from '../src/modules/media/video-adapters.js';

const MP4 = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypmp42'), ...new Uint8Array(40)]);
type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A fake fetch: routes by "METHOD path", records every call. No network. */
function fakeFetch(routes: Record<string, (c: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call = { method: init.method ?? 'GET', url: url.toString(), headers, body };
    calls.push(call);
    const key = `${call.method} ${url.host}${url.pathname}`;
    const route = routes[key];
    if (!route) return new Response('not found', { status: 404 });
    return route(call);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const start = (over: Partial<VideoStartInput> = {}): VideoStartInput => ({ modelId: 'm', prompt: 'Teal waves', seconds: 5, width: 720, height: 1280, title: 't', imageAssetId: null, idempotencyKey: 'futuregrow:org_1:3f0c9a', maxCostUsd: 1, signal: AbortSignal.timeout(5000), image: null, ...over });

describe('fillTemplate', () => {
  it('keeps whole-placeholder types and rejects unknown placeholders', () => {
    expect(fillTemplate({ a: '{{seconds}}', b: 'say {{prompt}}', c: ['{{width}}'] }, { seconds: 5, prompt: 'hi', width: 720 })).toEqual({ a: 5, b: 'say hi', c: [720] });
    expect(() => fillTemplate({ a: '{{nope}}' }, {})).toThrow(/unknown template placeholder/);
  });
});

describe('Wan on a remote ComfyUI GPU worker', () => {
  const workflow = { '3': { class_type: 'WanTextToVideo', inputs: { text: '{{prompt}}', length: '{{frames}}', width: '{{width}}', height: '{{height}}', seed: '{{seed}}' } } };
  const host = 'gpu.example.com';

  it('submits the filled workflow with bearer auth, polls, downloads one MP4 and estimates GPU cost from worker timestamps', async () => {
    let historyCalls = 0;
    const f = fakeFetch({
      [`POST ${host}/prompt`]: () => json({ prompt_id: 'p-1', number: 1, node_errors: {} }),
      [`GET ${host}/history/p-1`]: () =>
        ++historyCalls === 1
          ? json({})
          : json({
              'p-1': {
                outputs: { '9': { gifs: [{ filename: 'wan_00001.mp4', subfolder: '', type: 'output' }] } },
                status: {
                  status_str: 'success',
                  completed: true,
                  messages: [
                    ['execution_start', { timestamp: 1_000 }],
                    ['execution_success', { timestamp: 601_000 }],
                  ],
                },
              },
            }),
      [`GET ${host}/queue`]: () => json({ queue_running: [[1, 'p-1', {}, {}, []]], queue_pending: [] }),
      [`GET ${host}/view`]: () => new Response(MP4),
    });
    const wan = createComfyWanProvider({ baseUrl: `https://${host}`, token: 'secret-token-123456', textToVideoWorkflow: workflow, usdPerGpuHour: 1.2, fetchImpl: f.impl });
    expect(wan.replaySafe).toBe(false);
    expect(wan.supports({ modelId: 'm', prompt: 'p', seconds: 5, width: 720, height: 1280, title: 't', imageAssetId: null })).toBe(true);
    expect(wan.supports({ modelId: 'm', prompt: 'p', seconds: 5, width: 1080, height: 1920, title: 't', imageAssetId: null })).toBe(false);
    expect(wan.supports({ modelId: 'm', prompt: 'p', seconds: 5, width: 720, height: 1280, title: 't', imageAssetId: '00000000-0000-4000-8000-000000000000' })).toBe(false);
    const { operationId } = await wan.start(start());
    expect(operationId).toBe('p-1');
    const submit = f.calls[0]!;
    expect(submit.headers.authorization).toBe('Bearer secret-token-123456');
    expect((submit.body as { prompt: typeof workflow }).prompt['3'].inputs).toMatchObject({ text: 'Teal waves', length: 81, width: 720, height: 1280 });
    expect(await wan.poll('p-1', AbortSignal.timeout(5000))).toEqual({ status: 'pending' });
    const done = await wan.poll('p-1', AbortSignal.timeout(5000));
    expect(done).toMatchObject({ status: 'succeeded', actualCostUsd: 0.2, costBasis: 'estimated_compute' });
    expect(f.calls.find((c) => c.url.includes('/view'))!.url).toContain('filename=wan_00001.mp4');
    expect(f.calls.every((c) => c.headers.authorization === 'Bearer secret-token-123456')).toBe(true);
  });

  it('reports workflow errors, rejects node errors, and cancels queued or running prompts', async () => {
    const f = fakeFetch({
      [`POST ${host}/prompt`]: () => json({ prompt_id: 'p-2', node_errors: { '3': { errors: ['bad input'] } } }),
      [`GET ${host}/history/p-3`]: () =>
        json({
          'p-3': {
            outputs: {},
            status: {
              status_str: 'error',
              completed: false,
              messages: [
                ['execution_start', { timestamp: 0 }],
                ['execution_error', { timestamp: 360_000, exception_message: 'CUDA out of memory' }],
              ],
            },
          },
        }),
      [`GET ${host}/history/p-gone`]: () => json({}),
      [`GET ${host}/queue`]: () => json({ queue_running: [[1, 'p-run']], queue_pending: [[2, 'p-wait']] }),
      [`POST ${host}/queue`]: () => json({}),
      [`POST ${host}/interrupt`]: () => json({}),
    });
    const wan = createComfyWanProvider({ baseUrl: `https://${host}`, token: 'secret-token-123456', textToVideoWorkflow: workflow, usdPerGpuHour: 1, fetchImpl: f.impl });
    await expect(wan.start(start())).rejects.toThrow(/rejected the workflow/);
    expect(await wan.poll('p-3', AbortSignal.timeout(5000))).toMatchObject({ status: 'failed', reason: expect.stringMatching(/CUDA out of memory/), actualCostUsd: 0.1, costBasis: 'estimated_compute' });
    expect(await wan.poll('p-gone', AbortSignal.timeout(5000))).toMatchObject({ status: 'failed', actualCostUsd: null });
    expect(await wan.cancel!('p-wait', AbortSignal.timeout(5000))).toEqual({ cancelled: true });
    expect(f.calls.find((c) => c.method === 'POST' && c.url.endsWith('/queue'))!.body).toEqual({ delete: ['p-wait'] });
    expect(await wan.cancel!('p-run', AbortSignal.timeout(5000))).toMatchObject({ cancelled: true });
    expect(await wan.cancel!('p-none', AbortSignal.timeout(5000))).toMatchObject({ cancelled: false });
    expect(() => createComfyWanProvider({ baseUrl: 'http://gpu.example.com', token: 'x'.repeat(16), textToVideoWorkflow: workflow, usdPerGpuHour: 1 })).toThrow(/https/);
  });
});

describe('Higgsfield developer API', () => {
  const api = 'api.higgsfield.ai';
  const models = { 'hf-video': { path: '/vendor/video-model/standard', body: { prompt: '{{prompt}}', duration: '{{seconds}}' }, sizes: [{ width: 720, height: 1280 }], seconds: [5, 10] } };

  it('sends Key auth and the Idempotency-Key, polls status, downloads video.url and reports the charge as unknown', async () => {
    let polls = 0;
    const f = fakeFetch({
      [`POST ${api}/vendor/video-model/standard`]: () => json({ status: 'queued', request_id: 'req_1', status_url: `https://${api}/requests/req_1/status`, cancel_url: `https://${api}/requests/req_1/cancel` }),
      [`GET ${api}/requests/req_1/status`]: () => (++polls === 1 ? json({ status: 'in_progress' }) : json({ status: 'completed', video: { url: 'https://cdn.higgsfield.example.com/out.mp4' } })),
      'GET cdn.higgsfield.example.com/out.mp4': () => new Response(MP4),
    });
    const hf = createHiggsfieldProvider({ keyId: 'kid', keySecret: 'ksecret', models, fetchImpl: f.impl, resolveHost: async () => {} });
    expect(hf.replaySafe).toBe(true);
    expect(hf.supports({ modelId: 'hf-video', prompt: 'p', seconds: 5, width: 720, height: 1280, title: 't', imageAssetId: null })).toBe(true);
    expect(hf.supports({ modelId: 'hf-video', prompt: 'p', seconds: 7, width: 720, height: 1280, title: 't', imageAssetId: null })).toBe(false);
    expect(hf.supports({ modelId: 'other', prompt: 'p', seconds: 5, width: 720, height: 1280, title: 't', imageAssetId: null })).toBe(false);
    const { operationId } = await hf.start(start({ modelId: 'hf-video' }));
    expect(operationId).toBe('req_1');
    expect(f.calls[0]!.headers).toMatchObject({ authorization: 'Key kid:ksecret', 'idempotency-key': 'futuregrow:org_1:3f0c9a' });
    expect(f.calls[0]!.body).toEqual({ prompt: 'Teal waves', duration: 5 });
    expect(await hf.poll('req_1', AbortSignal.timeout(5000))).toEqual({ status: 'pending' });
    expect(await hf.poll('req_1', AbortSignal.timeout(5000))).toMatchObject({ status: 'succeeded', actualCostUsd: null, costBasis: 'unreported' });
  });

  it('maps failed/nsfw/canceled, refuses unsafe output URLs and cancels only queued requests', async () => {
    const f = fakeFetch({
      [`GET ${api}/requests/r-nsfw/status`]: () => json({ status: 'nsfw' }),
      [`GET ${api}/requests/r-local/status`]: () => json({ status: 'completed', video: { url: 'https://127.0.0.1/out.mp4' } }),
      [`GET ${api}/requests/r-http/status`]: () => json({ status: 'completed', video: { url: 'http://cdn.example.com/out.mp4' } }),
      [`POST ${api}/requests/r-q/cancel`]: () => new Response(null, { status: 202 }),
      [`POST ${api}/requests/r-busy/cancel`]: () => json({ detail: 'already processing' }, 400),
      [`POST ${api}/vendor/video-model/standard`]: () => json({ detail: 'Idempotency-Key was already used with different request parameters.' }, 422),
    });
    const hf = createHiggsfieldProvider({ keyId: 'kid', keySecret: 'ksecret', models, fetchImpl: f.impl, resolveHost: async () => {} });
    expect(await hf.poll('r-nsfw', AbortSignal.timeout(5000))).toMatchObject({ status: 'failed', reason: expect.stringMatching(/nsfw/) });
    await expect(hf.poll('r-local', AbortSignal.timeout(5000))).rejects.toThrow(/not public/);
    await expect(hf.poll('r-http', AbortSignal.timeout(5000))).rejects.toThrow(/https/);
    expect(await hf.cancel!('r-q', AbortSignal.timeout(5000))).toEqual({ cancelled: true });
    expect(await hf.cancel!('r-busy', AbortSignal.timeout(5000))).toMatchObject({ cancelled: false });
    await expect(hf.start(start({ modelId: 'hf-video' }))).rejects.toThrow(/HTTP 422/);
    expect(() => createHiggsfieldProvider({ keyId: 'k', keySecret: 's', models: { x: { ...models['hf-video'], path: '/../admin' } } })).toThrow(/invalid Higgsfield model path/);
  });
});

describe('server configuration', () => {
  it('builds an adapter only when every required setting exists; nothing is provisioned', () => {
    const wf = { textToVideo: { a: '{{prompt}}' }, imageToVideo: null };
    expect(videoProvidersFromEnv({}, wf)).toEqual({});
    expect(videoProvidersFromEnv({ FG_WAN_COMFYUI_URL: 'https://gpu.example.com', FG_WAN_COMFYUI_TOKEN: 'x'.repeat(16) }, wf)).toEqual({});
    expect(videoProvidersFromEnv({ HF_API_KEY_ID: 'k', HF_API_KEY_SECRET: 's' }, wf)).toEqual({});
    const all = videoProvidersFromEnv({ FG_WAN_COMFYUI_URL: 'https://gpu.example.com', FG_WAN_COMFYUI_TOKEN: 'x'.repeat(16), FG_WAN_USD_PER_GPU_HOUR: 0.8, FG_WAN_SIZES: '720x1280,1280x720', HF_API_KEY_ID: 'k', HF_API_KEY_SECRET: 's', FG_HIGGSFIELD_MODELS_JSON: JSON.stringify(models) }, wf);
    expect(Object.keys(all).sort()).toEqual(['higgsfield', 'wan_cloud']);
    expect(all.wan_cloud!.sizes).toEqual([
      { width: 720, height: 1280 },
      { width: 1280, height: 720 },
    ]);
  });
});
const models = { 'hf-video': { path: '/vendor/video-model/standard', body: { prompt: '{{prompt}}' }, sizes: [{ width: 720, height: 1280 }], seconds: [5] } };
