import { useState } from 'react';
import { api } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';
import { VideoAutomationPanel } from './VideoAutomationPanel.js';
import { VideoGenerationSettings } from './VideoGenerationSettings.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const MEDIA_CALLS = [
  { method: 'GET', path: '/v1/media/providers' },
  { method: 'GET', path: '/v1/connections' },
  { method: 'POST', path: '/v1/media/stock/search' },
  { method: 'POST', path: '/v1/media/stock/import' },
  { method: 'GET', path: '/v1/media/stock/assets' },
  { method: 'POST', path: '/v1/media/stock/assets/:id/revoke' },
  { method: 'POST', path: '/v1/media/images/generate' },
  { method: 'GET', path: '/v1/media/voice' },
  { method: 'POST', path: '/v1/media/voiceovers' },
  { method: 'GET', path: '/v1/media/jobs' },
  { method: 'GET', path: '/v1/media/videos' },
  { method: 'POST', path: '/v1/media/videos' },
  { method: 'GET', path: '/v1/media/videos/:id' },
  { method: 'PUT', path: '/v1/media/videos/:id/storyboard' },
  { method: 'POST', path: '/v1/media/videos/:id/render' },
  { method: 'GET', path: '/v1/assets' },
  { method: 'GET', path: '/v1/assets/:id/download-url' },
  { method: 'GET', path: '/v1/media/video-routing' },
  { method: 'PUT', path: '/v1/media/video-routing' },
  { method: 'POST', path: '/v1/media/video-routing/preview' },
  { method: 'GET', path: '/v1/media/video-generations' },
  { method: 'POST', path: '/v1/media/video-generations/:id/approve' },
  { method: 'POST', path: '/v1/media/video-generations/:id/cancel' },
  { method: 'POST', path: '/v1/media/video-generations/:id/reconcile' },
  { method: 'POST', path: '/v1/media/google-flow/import' },
] as const;

const FORMATS = [
  ['portrait_4x5', 'Portrait 4:5 (1080×1350)'],
  ['square_1x1', 'Square (1080×1080)'],
  ['landscape_191x1', 'Landscape 1.91:1 (1200×628)'],
  ['story_9x16', 'Story 9:16 (1080×1920)'],
] as const;
const PRESETS = [
  ['vertical_9x16', 'Vertical 9:16 — TikTok, Reels, Shorts'],
  ['square_1x1', 'Square 1:1 — feeds'],
  ['landscape_16x9', 'Landscape 16:9 — YouTube'],
] as const;

interface Provider {
  id: string;
  kind: string;
  enabled: boolean;
  reason: string;
  requires: string[];
}
interface Candidate {
  externalId: string;
  mediaType: 'photo' | 'video';
  pageUrl: string;
  width: number;
  height: number;
  author: string;
  attribution: string;
  previewUrl: string;
  durationSeconds: number | null;
  imported: { format: string; assetId: string }[];
}
interface Job {
  id: string;
  kind: string;
  provider: string;
  status: string;
  statusReason: string | null;
  assetId: string | null;
  costUsd: number | null;
  requestedAt: string;
  request: { prompt?: string; externalId?: string; format?: string; text?: string; voice?: string };
}

/**
 * Creative media sources (P3-02/P3-03/P3-04): licensed stock search and import, AI images from
 * an approved model, and the Video Studio. Each source shows whether it is enabled and exactly
 * what is missing; nothing is downloaded or generated until it is.
 */
export function MediaStudio() {
  const providers = useApi<Provider[]>('/v1/media/providers');
  const jobs = useApi<Job[]>('/v1/media/jobs');
  const stock = providers.data?.find((p) => p.id === 'stock-library');
  const ai = providers.data?.find((p) => p.id === 'ai-image-model');
  const voice = providers.data?.find((p) => p.id === 'ai-voice-model');
  return (
    <div className="stack">
      <section className="card">
        <header className="card-head">
          <h2 className="card-title">Media sources</h2>
        </header>
        {!providers.data ? (
          <LoadingRows />
        ) : (
          <ul className="row-list">
            {providers.data.map((p) => (
              <li key={p.id} className="row-item">
                <div className="row">
                  <div>
                    <strong>{p.id}</strong> <span className="small muted">{p.kind.replaceAll('_', ' ')}</span>
                    <div className="small">{p.reason}</div>
                    {p.requires.length ? <div className="small muted">Needs: {p.requires.join('; ')}</div> : null}
                  </div>
                  <Badge value={p.enabled ? 'ready' : 'disabled'} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <ErrorNotice error={providers.error} />
      </section>
      {stock?.enabled ? <StockSearch onImported={() => void jobs.reload()} /> : null}
      {ai?.enabled ? <ImageRequest onQueued={() => void jobs.reload()} /> : null}
      {voice?.enabled ? <VoiceoverRequest onQueued={() => void jobs.reload()} /> : null}
      <JobList jobs={jobs.data} onReload={() => void jobs.reload()} />
      <VideoStudio />
    </div>
  );
}

function StockSearch({ onImported }: { onImported: () => void }) {
  const conns = useApi<{ id: string; provider: string; displayName: string; status: string }[]>('/v1/connections');
  const pexels = (conns.data ?? []).filter((c) => c.provider === 'pexels' && c.status === 'active');
  const [query, setQuery] = useState('');
  const [mediaType, setMediaType] = useState<'photo' | 'video'>('photo');
  const [format, setFormat] = useState<string>('portrait_4x5');
  const [result, setResult] = useState<{ items: Candidate[]; totalResults: number; licence: { name: string; url: string; restrictions: string[] } } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const search = async () => {
    setError(null);
    try {
      setResult(await api('POST', '/v1/media/stock/search', { connectionId: pexels[0]!.id, mediaType, query }));
    } catch (e) {
      setError(e);
    }
  };
  const importItem = async (c: Candidate) => {
    setError(null);
    try {
      const r = await api<{ duplicate: boolean; assetId: string | null }>('POST', '/v1/media/stock/import', { connectionId: pexels[0]!.id, mediaType: c.mediaType, externalId: c.externalId, format: c.mediaType === 'video' ? 'original' : format });
      setNote(r.duplicate ? 'Already imported (or importing); nothing was downloaded again.' : 'Import queued; it appears in your assets in a minute with its attribution and licence.');
      onImported();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="card">
      <header className="card-head">
        <h2 className="card-title">Licensed stock (Pexels)</h2>
      </header>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="st-q">Search</label>
          <input id="st-q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="coffee beans" />
        </div>
        <div className="field">
          <label htmlFor="st-t">Type</label>
          <select id="st-t" value={mediaType} onChange={(e) => setMediaType(e.target.value as 'photo' | 'video')}>
            <option value="photo">Photos</option>
            <option value="video">Videos</option>
          </select>
        </div>
        {mediaType === 'photo' ? (
          <div className="field">
            <label htmlFor="st-f">Import as</label>
            <select id="st-f" value={format} onChange={(e) => setFormat(e.target.value)}>
              {FORMATS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <button type="button" className="btn primary" disabled={query.trim().length < 2 || !pexels.length} onClick={() => void search()}>
        Search
      </button>
      <ErrorNotice error={error} />
      {note ? <p className="small">{note}</p> : null}
      {result ? (
        <>
          <p className="small muted">
            {result.totalResults} results · {result.licence.name}: {result.licence.restrictions.join('; ')}.
          </p>
          <ul className="grid-3">
            {result.items.map((c) => (
              <li key={c.externalId} className="card">
                {/* The app's CSP allows images only from FUTUREGROW itself, so previews open on Pexels instead of being hotlinked. */}
                <a className="small" href={c.pageUrl} target="_blank" rel="noreferrer noopener">
                  Preview on Pexels
                </a>
                <p className="small">
                  {c.attribution} · {c.width}×{c.height}
                  {c.durationSeconds ? ` · ${c.durationSeconds}s` : ''}
                </p>
                {c.imported.length ? (
                  <Badge value="imported" />
                ) : (
                  <button type="button" className="small-btn" onClick={() => void importItem(c)}>
                    Import
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function ImageRequest({ onQueued }: { onQueued: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [format, setFormat] = useState<string>('portrait_4x5');
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const go = async () => {
    setError(null);
    try {
      await api('POST', '/v1/media/images/generate', { prompt, format });
      setNote('Queued. The image is labelled AI-generated and its cost counts toward your AI spending limit.');
      onQueued();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="card">
      <header className="card-head">
        <h2 className="card-title">AI image</h2>
      </header>
      <div className="field">
        <label htmlFor="ai-p">Describe the image</label>
        <textarea id="ai-p" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A cup of coffee on a wooden table, morning light" />
      </div>
      <div className="field">
        <label htmlFor="ai-f">Format</label>
        <select id="ai-f" value={format} onChange={(e) => setFormat(e.target.value)}>
          {FORMATS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <p className="small muted">No people’s likenesses, children, logos or named artists’ styles. The provider’s own safety system also applies.</p>
      <ErrorNotice error={error} />
      {note ? <p className="small">{note}</p> : null}
      <button type="button" className="btn primary" disabled={prompt.trim().length < 10} onClick={() => void go()}>
        Generate
      </button>
    </section>
  );
}

/**
 * AI voiceover (P3-04): a script read by one of the approved model's synthetic stock voices. The
 * result is an audio asset labelled AI-generated, usable as a Video Studio soundtrack.
 */
function VoiceoverRequest({ onQueued }: { onQueued: () => void }) {
  const ready = useApi<{ model: { provider: string; modelId: string; usdPerMillionChars: number | null } | null; voices: string[]; maxCharacters: number | null }>('/v1/media/voice');
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const r = ready.data;
  const chosen = voice || r?.voices[0] || '';
  const est = r?.model?.usdPerMillionChars ? (text.length / 1_000_000) * r.model.usdPerMillionChars : null;
  const go = async () => {
    setError(null);
    try {
      await api('POST', '/v1/media/voiceovers', { text, voice: chosen });
      setNote('Queued. The voiceover is labelled AI-generated; it appears under Media jobs and then as an audio asset for the Video Studio.');
      setText('');
      onQueued();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="card">
      <header className="card-head">
        <h2 className="card-title">AI voiceover</h2>
        {r?.model ? (
          <span className="small muted">
            {r.model.provider}/{r.model.modelId}
          </span>
        ) : null}
      </header>
      {ready.error ? <ErrorNotice error={ready.error} /> : null}
      {!r ? (
        <LoadingRows />
      ) : (
        <>
          <div className="field">
            <label htmlFor="vo-text">Script</label>
            <textarea id="vo-text" rows={4} maxLength={r.maxCharacters ?? 4096} value={text} onChange={(e) => setText(e.target.value)} />
            <span className="help">
              {text.length} / {r.maxCharacters ?? 4096} characters{est !== null ? ` · about $${est.toFixed(4)}` : ''}
            </span>
          </div>
          <div className="field">
            <label htmlFor="vo-voice">Voice (synthetic)</label>
            <select id="vo-voice" value={chosen} onChange={(e) => setVoice(e.target.value)}>
              {r.voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <p className="small muted">Only the provider’s synthetic stock voices are offered: no voice cloning and no imitation of a real person. Publish it with the “AI-generated voice” disclosure.</p>
          <ErrorNotice error={error} />
          {note ? <p className="small">{note}</p> : null}
          <button type="button" className="btn primary" disabled={!text.trim() || !chosen} onClick={() => void go()}>
            Generate voiceover
          </button>
        </>
      )}
    </section>
  );
}

function JobList({ jobs, onReload }: { jobs: Job[] | null; onReload: () => void }) {
  if (!jobs?.length) return null;
  return (
    <section className="card">
      <header className="card-head">
        <h2 className="card-title">Media jobs</h2>
        <button type="button" className="small-btn" onClick={onReload}>
          Refresh
        </button>
      </header>
      <ul className="row-list">
        {jobs.slice(0, 20).map((j) => (
          <li key={j.id} className="row-item">
            <div className="row">
              <div className="small">
                {j.kind === 'ai_image' ? `AI image: ${j.request.prompt ?? ''}` : j.kind === 'voiceover' ? `AI voiceover (${j.request.voice ?? ''}): ${(j.request.text ?? '').slice(0, 80)}` : `Stock ${j.request.externalId} (${j.request.format})`} · {relativeTime(j.requestedAt)}
                {j.costUsd !== null ? ` · $${j.costUsd.toFixed(2)}` : ''}
                {j.statusReason ? <div className="muted">{j.statusReason}</div> : null}
              </div>
              <Badge value={j.status} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Video Studio                                                        */
/* ------------------------------------------------------------------ */

interface SceneDraft {
  id: string;
  durationSeconds: number;
  text: string;
  subtitle: string;
  assetId: string | null;
  transition: 'cut' | 'fade' | 'slide';
  textPosition: 'top' | 'center' | 'bottom';
}
interface VideoRow {
  id: string;
  title: string;
  status: string;
  statusReason: string | null;
  preset: string;
  version: number;
  storyboard: { preset: string; scenes: SceneDraft[]; cta: string; disclosureText: string; brandColor: string };
  qa: { storyboard?: { passed: boolean; problems: string[] }; render?: { passed?: boolean; problems?: string[] } | null };
  outputAssetId: string | null;
  updatedAt: string;
}

const newScene = (n: number): SceneDraft => ({ id: `scene-${n}`, durationSeconds: 3, text: '', subtitle: '', assetId: null, transition: 'fade', textPosition: 'center' });

function GenerativeVideo() {
  const ready = useApi<{ model: { modelId: string; usdPerVideoSecond: number } | null; missing: string[] }>('/v1/media/generative-video/readiness');
  const jobs = useApi<{ id: string; kind: string; status: string; statusReason: string | null; assetId: string | null }[]>('/v1/media/jobs');
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState(5);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const enabled = ready.data?.missing.length === 0;
  return (
    <details>
      <summary>Generative AI clips</summary>
      <p className="small muted">Silent generated clips enter the asset library after technical QA. Review their content and record likeness rights before use. Existing storyboard rendering is separate.</p>
      <ErrorNotice error={ready.error ?? jobs.error ?? error} />
      {ready.data?.missing.map((m) => (
        <p key={m} className="small">
          Required: {m}
        </p>
      ))}
      {enabled ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            void api('POST', '/v1/media/generative-video', { modelId: ready.data!.model!.modelId, prompt, seconds, width: 1080, height: 1920, title: prompt.slice(0, 100) })
              .then(() => jobs.reload())
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Describe the clip
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} required minLength={5} maxLength={2000} />
          </label>
          <label>
            Duration in seconds
            <input type="number" min={1} max={15} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
          </label>
          <p className="small">Maximum charge: ${(seconds * (ready.data?.model?.usdPerVideoSecond ?? 0)).toFixed(2)}. Format: vertical 1080 × 1920.</p>
          <button type="submit" className="small-btn" disabled={busy}>
            Queue generation
          </button>
        </form>
      ) : null}
      <button type="button" className="small-btn" onClick={() => void jobs.reload()}>
        Refresh generation jobs
      </button>
      {(jobs.data ?? [])
        .filter((j) => j.kind === 'ai_video')
        .map((j) => (
          <p key={j.id} className="small">
            <Badge value={j.status} /> {j.statusReason ?? (j.assetId ? `Asset ${j.assetId}; review in Assets.` : j.id)}
          </p>
        ))}
    </details>
  );
}

function VideoStudio() {
  const list = useApi<VideoRow[]>('/v1/media/videos');
  const media = useApi<{ id: string; kind: string; title: string; publishEligible: boolean }[]>('/v1/assets');
  const [editing, setEditing] = useState<VideoRow | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const usable = (media.data ?? []).filter((a) => (a.kind === 'image' || a.kind === 'video') && a.publishEligible);
  const render = async (v: VideoRow) => {
    setError(null);
    try {
      await api('POST', `/v1/media/videos/${v.id}/render`);
      await list.reload();
    } catch (e) {
      setError(e);
    }
  };
  const show = async (v: VideoRow) => {
    setError(null);
    try {
      await api('GET', `/v1/media/videos/${v.id}`);
      const r = await api<{ url: string }>('GET', `/v1/assets/${v.outputAssetId}/download-url`);
      setPreview({ id: v.id, url: r.url });
      await list.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <VideoGenerationSettings />
      <VideoAutomationPanel />
      <section className="card">
        <header className="card-head">
          <h2 className="card-title">Video Studio</h2>
          <button type="button" className="btn" onClick={() => setEditing(editing ? null : 'new')}>
            {editing ? 'Close' : 'New video'}
          </button>
        </header>
        <GenerativeVideo />
        <p className="small muted">Short branded videos from scenes: on-screen text, subtitles, your cleared images or clips and transitions, rendered to MP4 with a thumbnail and SRT subtitles. Publish them to TikTok or YouTube from the studio; every upload still goes through your publishing policy.</p>
        <ErrorNotice error={error} />
        {editing ? (
          <StoryboardEditor
            video={editing === 'new' ? null : editing}
            assets={usable}
            onSaved={() => {
              setEditing(null);
              void list.reload();
            }}
          />
        ) : null}
        {!list.data ? (
          <LoadingRows />
        ) : list.data.length ? (
          <ul className="row-list">
            {list.data.map((v) => (
              <li key={v.id} className="row-item">
                <div className="row">
                  <div>
                    <strong>{v.title}</strong>{' '}
                    <span className="small muted">
                      {v.storyboard.scenes.length} scenes · {v.storyboard.scenes.reduce((a, s) => a + s.durationSeconds, 0)}s · {v.preset.replaceAll('_', ' ')} · {relativeTime(v.updatedAt)}
                    </span>
                    {v.statusReason ? <div className="small muted">{v.statusReason}</div> : null}
                    {v.qa.storyboard?.problems.length ? (
                      <ul className="small findings">
                        {v.qa.storyboard.problems.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    <Badge value={v.status} />
                    {v.status === 'storyboard' || v.status === 'failed' || v.status === 'qa_failed' ? (
                      <>
                        <button type="button" className="small-btn" onClick={() => setEditing(v)}>
                          Edit
                        </button>
                        <button type="button" className="small-btn" disabled={!v.qa.storyboard?.passed} onClick={() => void render(v)}>
                          Render
                        </button>
                      </>
                    ) : null}
                    {v.status === 'rendering' ? (
                      <button type="button" className="small-btn" onClick={() => void list.reload()}>
                        Check progress
                      </button>
                    ) : null}
                    {v.status === 'ready' && v.outputAssetId ? (
                      <button type="button" className="small-btn" onClick={() => void show(v)}>
                        Preview
                      </button>
                    ) : null}
                  </div>
                </div>
                {preview?.id === v.id ? (
                  // A signed object-storage link (15 minutes); opened in a new tab because the app's CSP does not embed media from storage.
                  <a className="small" href={preview.url} target="_blank" rel="noreferrer noopener">
                    Open the MP4 (link valid for 15 minutes)
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No videos yet">Create a storyboard with a few scenes, then render it.</EmptyState>
        )}
      </section>
    </>
  );
}

function StoryboardEditor({ video, assets, onSaved }: { video: VideoRow | null; assets: { id: string; title: string; kind: string }[]; onSaved: () => void }) {
  const [title, setTitle] = useState(video?.title ?? '');
  const [preset, setPreset] = useState(video?.storyboard.preset ?? 'vertical_9x16');
  const [scenes, setScenes] = useState<SceneDraft[]>(video?.storyboard.scenes ?? [newScene(1), newScene(2)]);
  const [cta, setCta] = useState(video?.storyboard.cta ?? '');
  const [disclosure, setDisclosure] = useState(video?.storyboard.disclosureText ?? '');
  const [brandColor, setBrandColor] = useState(video?.storyboard.brandColor ?? '#0f766e');
  const [error, setError] = useState<unknown>(null);
  const set = (i: number, patch: Partial<SceneDraft>) => setScenes(scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const save = async () => {
    setError(null);
    const storyboard = { preset, scenes, cta, disclosureText: disclosure, brandColor };
    try {
      if (video) await api('PUT', `/v1/media/videos/${video.id}/storyboard`, { storyboard, expectedVersion: video.version, title });
      else await api('POST', '/v1/media/videos', { title, storyboard });
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  const total = scenes.reduce((a, s) => a + s.durationSeconds, 0);
  return (
    <div className="stack-xs">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="vs-title">Title</label>
          <input id="vs-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="vs-preset">Format</label>
          <select id="vs-preset" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {PRESETS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="vs-color">Brand colour</label>
          <input id="vs-color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} />
        </div>
      </div>
      <ol className="stack-xs">
        {scenes.map((s, i) => (
          <li key={s.id} className="card">
            <div className="form-grid">
              <div className="field">
                <label htmlFor={`sc-t-${i}`}>On-screen text</label>
                <input id={`sc-t-${i}`} value={s.text} onChange={(e) => set(i, { text: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`sc-s-${i}`}>Subtitle</label>
                <input id={`sc-s-${i}`} value={s.subtitle} onChange={(e) => set(i, { subtitle: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`sc-d-${i}`}>Seconds</label>
                <input id={`sc-d-${i}`} type="number" min={1} max={15} value={s.durationSeconds} onChange={(e) => set(i, { durationSeconds: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label htmlFor={`sc-a-${i}`}>Image or clip</label>
                <select id={`sc-a-${i}`} value={s.assetId ?? ''} onChange={(e) => set(i, { assetId: e.target.value || null })}>
                  <option value="">Brand colour only</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.kind}: {a.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`sc-x-${i}`}>Transition</label>
                <select id={`sc-x-${i}`} value={s.transition} onChange={(e) => set(i, { transition: e.target.value as SceneDraft['transition'] })}>
                  <option value="fade">Fade</option>
                  <option value="slide">Slide</option>
                  <option value="cut">Cut</option>
                </select>
              </div>
            </div>
            <button type="button" className="small-btn" disabled={scenes.length <= 1} onClick={() => setScenes(scenes.filter((_, j) => j !== i))}>
              Remove scene
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="small-btn" disabled={scenes.length >= 20} onClick={() => setScenes([...scenes, newScene(Math.max(0, ...scenes.map((s) => Number(s.id.split('-')[1]) || 0)) + 1)])}>
        Add scene
      </button>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="vs-cta">End card text</label>
          <input id="vs-cta" value={cta} onChange={(e) => setCta(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="vs-disc">Disclosure (required with AI media)</label>
          <input id="vs-disc" value={disclosure} onChange={(e) => setDisclosure(e.target.value)} placeholder="Made with AI" />
        </div>
      </div>
      <p className="small muted">{total} seconds (at most 90).</p>
      <ErrorNotice error={error} />
      <button type="button" className="btn primary" disabled={!title || total > 90} onClick={() => void save()}>
        Save storyboard
      </button>
    </div>
  );
}
