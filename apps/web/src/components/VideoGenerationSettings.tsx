import { useState } from 'react';
import { api, uploadBinary } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, ErrorNotice, LoadingRows, useApi } from './ui.js';

type ModeId = 'remotion' | 'google_flow' | 'wan_cloud' | 'higgsfield';
const MODE_IDS: ModeId[] = ['remotion', 'google_flow', 'wan_cloud', 'higgsfield'];
const LABEL: Record<ModeId, string> = { remotion: 'Remotion', google_flow: 'Google Flow', wan_cloud: 'Wan Cloud', higgsfield: 'Higgsfield API' };

interface Settings {
  enabled: Record<ModeId, boolean>;
  smartMode: boolean;
  defaultProvider: ModeId;
  providerPriority: ModeId[];
  dailyTarget: number;
  dailyAutomation: boolean;
  maxPaidUsdPerVideo: number;
  dailyPaidBudgetUsd: number;
  monthlyPaidBudgetUsd: number;
  requirePaidApproval: boolean;
  paidGenerationDisabled: boolean;
}
interface Mode {
  id: ModeId;
  label: string;
  enabled: boolean;
  ready: boolean;
  state: 'ready' | 'setup_required' | 'disabled';
  kind: 'automatic' | 'manual' | 'paid';
  requires: string[];
  note: string;
  outputs: string[];
  estimatedCost: { usdPerSecond: number | null; basis: string };
  lastSuccessAt: string | null;
  lastError: string | null;
  configure: { label: string; href: string | null; detail: string };
}
interface Usage {
  daySpentUsd: number;
  monthSpentUsd: number;
  reservedUsd: number;
  unreconciledJobs: number;
  awaitingApproval: number;
  awaitingApprovalUsd: number;
}
interface Overview {
  settings: Settings;
  version: number;
  modes: Mode[];
  usage: Usage;
  googleFlowUrl: string;
}
interface Job {
  id: string;
  source: 'media_job' | 'render_job';
  mode: string;
  kind: string;
  status: string;
  statusReason: string | null;
  costUsd: number | null;
  costBasis: string | null;
  billingUnresolved: boolean;
  requestedAt: string;
}
interface Decision {
  mode: ModeId | null;
  execution: string;
  reason: string;
  estimateUsd: number | null;
  setup: string[];
}

const usd = (n: number | null | undefined) => (n == null ? 'unknown' : `$${n.toFixed(2)}`);
const STATE_TEXT = { ready: 'Ready', setup_required: 'Setup required', disabled: 'Disabled' } as const;

/**
 * Video Generation Settings: four independent, persisted switches with honest readiness. A switch
 * changes what the server accepts; turning a mode ON never makes an unconfigured mode work.
 */
export function VideoGenerationSettings() {
  const ov = useApi<Overview>('/v1/media/video-routing');
  const history = useApi<{ jobs: Job[]; usage: Usage }>('/v1/media/video-generations');
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = draft ?? ov.data?.settings ?? null;

  const save = async (next: Settings) => {
    if (!ov.data) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('PUT', '/v1/media/video-routing', { settings: next, expectedVersion: ov.data.version });
      setDraft(null);
      setNotice('Saved. The server now enforces these settings.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      await ov.reload();
    }
  };
  const edit = (patch: Partial<Settings>) => s && setDraft({ ...s, ...patch });
  const move = (i: number, d: -1 | 1) => {
    if (!s) return;
    const p = [...s.providerPriority];
    const j = i + d;
    if (j < 0 || j >= p.length) return;
    [p[i], p[j]] = [p[j]!, p[i]!];
    edit({ providerPriority: p });
  };
  const act = async (path: string, body?: unknown) => {
    setError(null);
    try {
      await api('POST', path, body);
      await Promise.all([history.reload(), ov.reload()]);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section className="card">
      <header className="card-head">
        <h2 className="card-title">Video Generation Settings</h2>
        <button type="button" className="small-btn" onClick={() => void Promise.all([ov.reload(), history.reload()])}>
          Refresh
        </button>
      </header>
      <p className="small muted">Four independent modes. Free-first by default: Remotion renders templates on the CPU, Google Flow is manual, and paid providers stay off with a $0 budget until you configure and approve them.</p>
      <ErrorNotice error={ov.error ?? error} />
      {notice ? <p className="small">{notice}</p> : null}
      {!ov.data || !s ? (
        <LoadingRows />
      ) : (
        <>
          <ul className="row-list">
            {ov.data.modes.map((m) => (
              <li key={m.id} className="row-item">
                <div className="row">
                  <div>
                    <strong>{m.label}</strong> <Badge value={m.state} /> <span className="small muted">{STATE_TEXT[m.state]}</span>
                    <div className="small muted">{m.note}</div>
                    <div className="small">
                      Outputs: {m.outputs.join(', ')} · Estimated cost: {m.estimatedCost.usdPerSecond === null ? 'unknown' : `${usd(m.estimatedCost.usdPerSecond)}/s`} ({m.estimatedCost.basis}) · Last success: {m.lastSuccessAt ? relativeTime(m.lastSuccessAt) : 'never'}
                    </div>
                    {m.lastError ? <div className="small">Last error: {m.lastError}</div> : null}
                    {m.requires.length ? (
                      <ul className="small findings">
                        {m.requires.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="small">
                      {m.configure.href ? (
                        <a href={m.configure.href} target={m.configure.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
                          {m.configure.label}
                        </a>
                      ) : (
                        m.configure.label
                      )}{' '}
                      — <span className="muted">{m.configure.detail}</span>
                    </div>
                  </div>
                  <div className="row-actions">
                    <label className="small">
                      <input
                        type="checkbox"
                        checked={s.enabled[m.id]}
                        disabled={busy}
                        onChange={(e) => {
                          const next = { ...s, enabled: { ...s.enabled, [m.id]: e.target.checked } };
                          if (draft) setDraft(next);
                          else void save(next);
                        }}
                      />{' '}
                      {s.enabled[m.id] ? 'ON' : 'OFF'}
                    </label>
                  </div>
                </div>
                {m.id === 'google_flow' && m.enabled ? <FlowImport flowUrl={ov.data!.googleFlowUrl} onDone={() => void history.reload()} /> : null}
              </li>
            ))}
          </ul>

          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void save(s);
            }}
          >
            <h3>Global controls</h3>
            <label className="small">
              <input type="checkbox" checked={s.smartMode} onChange={(e) => edit({ smartMode: e.target.checked })} /> Smart Mode (pick the best eligible mode per video)
            </label>
            <label>
              Default provider (used when Smart Mode is OFF)
              <select value={s.defaultProvider} onChange={(e) => edit({ defaultProvider: e.target.value as ModeId })}>
                {MODE_IDS.map((id) => (
                  <option key={id} value={id}>
                    {LABEL[id]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Daily video target (a goal, not a guarantee)
              <input type="number" min={1} max={10} value={s.dailyTarget} onChange={(e) => edit({ dailyTarget: Number(e.target.value) })} />
            </label>
            <label className="small">
              <input type="checkbox" checked={s.dailyAutomation} onChange={(e) => edit({ dailyAutomation: e.target.checked })} /> Daily automation: render QA-passed, non-duplicate storyboards with Remotion up to the target
            </label>
            <label className="small">
              <input type="checkbox" checked={s.paidGenerationDisabled} onChange={(e) => edit({ paidGenerationDisabled: e.target.checked })} /> Disable all paid generation
            </label>
            <label className="small">
              <input type="checkbox" checked={s.requirePaidApproval} onChange={(e) => edit({ requirePaidApproval: e.target.checked })} /> Paid jobs need an owner/admin approval before submission
            </label>
            <label>
              Maximum paid cost per video (USD)
              <input type="number" min={0} step="0.01" value={s.maxPaidUsdPerVideo} onChange={(e) => edit({ maxPaidUsdPerVideo: Number(e.target.value) })} />
            </label>
            <label>
              Daily paid budget (USD)
              <input type="number" min={0} step="0.01" value={s.dailyPaidBudgetUsd} onChange={(e) => edit({ dailyPaidBudgetUsd: Number(e.target.value) })} />
            </label>
            <label>
              Monthly paid budget (USD)
              <input type="number" min={0} step="0.01" value={s.monthlyPaidBudgetUsd} onChange={(e) => edit({ monthlyPaidBudgetUsd: Number(e.target.value) })} />
            </label>
            <fieldset>
              <legend className="small">Provider priority (free modes always come before paid ones)</legend>
              <ol className="small">
                {s.providerPriority.map((id, i) => (
                  <li key={id}>
                    {LABEL[id]}{' '}
                    <button type="button" className="small-btn" aria-label={`Move ${LABEL[id]} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>{' '}
                    <button type="button" className="small-btn" aria-label={`Move ${LABEL[id]} down`} disabled={i === s.providerPriority.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                  </li>
                ))}
              </ol>
            </fieldset>
            <div className="row">
              <button type="submit" className="btn" disabled={busy || !draft}>
                Save settings
              </button>
              {draft ? (
                <button type="button" className="small-btn" onClick={() => setDraft(null)}>
                  Discard changes
                </button>
              ) : null}
            </div>
          </form>

          <h3>Usage and cost</h3>
          <p className="small">
            Paid spend today {usd(ov.data.usage.daySpentUsd)} of {usd(s.dailyPaidBudgetUsd)} · this month {usd(ov.data.usage.monthSpentUsd)} of {usd(s.monthlyPaidBudgetUsd)} · reserved {usd(ov.data.usage.reservedUsd)} · awaiting approval {ov.data.usage.awaitingApproval} ({usd(ov.data.usage.awaitingApprovalUsd)}) ·
            charges to reconcile {ov.data.usage.unreconciledJobs}
          </p>
          <RoutePreview />
          <h3>Job history</h3>
          {!history.data ? (
            <LoadingRows />
          ) : history.data.jobs.length ? (
            <ul className="row-list">
              {history.data.jobs.map((j) => (
                <li key={`${j.source}:${j.id}`} className="row-item">
                  <div className="row">
                    <div>
                      <Badge value={j.status} /> <strong>{LABEL[j.mode as ModeId] ?? j.mode}</strong>{' '}
                      <span className="small muted">
                        {j.kind.replaceAll('_', ' ')} · {relativeTime(j.requestedAt)} · cost {usd(j.costUsd)}
                        {j.costBasis ? ` (${j.costBasis.replaceAll('_', ' ')})` : ''}
                      </span>
                      {j.statusReason ? <div className="small muted">{j.statusReason}</div> : null}
                      {j.billingUnresolved ? <div className="small">Provider charge not reconciled: the reservation is held.</div> : null}
                    </div>
                    <div className="row-actions">
                      {j.source === 'media_job' && j.status === 'awaiting_approval' ? (
                        <button type="button" className="small-btn" onClick={() => void act(`/v1/media/video-generations/${j.id}/approve`)}>
                          Approve
                        </button>
                      ) : null}
                      {j.source === 'media_job' && ['awaiting_approval', 'queued', 'running'].includes(j.status) ? (
                        <button type="button" className="small-btn" onClick={() => void act(`/v1/media/video-generations/${j.id}/cancel`)}>
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {j.billingUnresolved && !['awaiting_approval', 'queued', 'running'].includes(j.status) ? <Reconcile onSubmit={(body) => act(`/v1/media/video-generations/${j.id}/reconcile`, body)} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No video jobs yet.</p>
          )}
        </>
      )}
    </section>
  );
}

function RoutePreview() {
  const [quality, setQuality] = useState<'template' | 'cinematic'>('template');
  const [seconds, setSeconds] = useState(8);
  const [allowPaid, setAllowPaid] = useState(false);
  const [result, setResult] = useState<Decision | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <details>
      <summary>Preview the Smart routing decision</summary>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api<Decision>('POST', '/v1/media/video-routing/preview', { quality, seconds, allowPaid }).then(setResult).catch(setError);
        }}
      >
        <label>
          Video type
          <select value={quality} onChange={(e) => setQuality(e.target.value as 'template' | 'cinematic')}>
            <option value="template">Template (branded scenes)</option>
            <option value="cinematic">Cinematic AI clip</option>
          </select>
        </label>
        <label>
          Seconds
          <input type="number" min={1} max={90} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
        </label>
        <label className="small">
          <input type="checkbox" checked={allowPaid} onChange={(e) => setAllowPaid(e.target.checked)} /> Consider paid providers
        </label>
        <button type="submit" className="small-btn">
          Preview
        </button>
      </form>
      <ErrorNotice error={error} />
      {result ? (
        <div className="small">
          <Badge value={result.execution} /> {result.mode ? LABEL[result.mode] : 'No mode'} — {result.reason} {result.estimateUsd ? `Estimated maximum ${usd(result.estimateUsd)}.` : ''}
          {result.setup.length ? (
            <ul className="findings">
              {result.setup.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function Reconcile({ onSubmit }: { onSubmit: (body: { actualCostUsd: number; invoiceRef: string }) => Promise<void> }) {
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  return (
    <form
      className="row small"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({ actualCostUsd: Number(amount), invoiceRef: ref });
      }}
    >
      <label>
        Actual charge (USD)
        <input type="number" min={0} step="0.0001" required value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        Invoice / billing reference
        <input required minLength={2} maxLength={200} value={ref} onChange={(e) => setRef(e.target.value)} />
      </label>
      <button type="submit" className="small-btn">
        Reconcile
      </button>
    </form>
  );
}

function FlowImport({ flowUrl, onDone }: { flowUrl: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [preset, setPreset] = useState('');
  const [prompt, setPrompt] = useState('');
  const [att, setAtt] = useState({ commercialUseConfirmed: false, containsPeople: false, containsMusic: false, containsVoice: false, containsThirdPartyBrands: false, confirmed: false });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const flag = (k: keyof typeof att, text: string) => (
    <label className="small">
      <input type="checkbox" checked={att[k]} onChange={(e) => setAtt({ ...att, [k]: e.target.checked })} /> {text}
    </label>
  );
  return (
    <details>
      <summary>Import from Google Flow</summary>
      <p className="small">
        Manual generation — no automated free API.{' '}
        <a href={flowUrl} target="_blank" rel="noreferrer">
          Open Google Flow
        </a>
        , generate with your own Google account, download the MP4 and import it here. Technical QA, provenance and your rights answers are recorded; clips with people stay unpublishable until likeness rights are recorded.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) return;
          setError(null);
          setDone(null);
          const { confirmed: _c, ...rest } = att;
          void uploadBinary('/v1/media/google-flow/import', file, { title, preset: preset || null, prompt, attestation: { generatedWithGoogleFlow: true, ownAccount: true, ...rest } })
            .then(() => {
              setDone('Imported. The media worker runs technical QA; the clip appears in Assets when it passes.');
              onDone();
            })
            .catch(setError);
        }}
      >
        <label>
          MP4 file
          <input type="file" accept="video/mp4" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label>
          Title
          <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Expected format
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="">Any</option>
            <option value="vertical_9x16">Vertical 9:16</option>
            <option value="square_1x1">Square 1:1</option>
            <option value="landscape_16x9">Landscape 16:9</option>
          </select>
        </label>
        <label>
          Prompt used in Flow (provenance)
          <textarea maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        {flag('confirmed', 'I generated this clip in Google Flow with our own Google account.')}
        {flag('commercialUseConfirmed', 'Our Google plan terms permit commercial use of this output.')}
        {flag('containsPeople', 'It shows people or realistic faces.')}
        {flag('containsMusic', 'It contains music.')}
        {flag('containsVoice', 'It contains speech or a voice.')}
        {flag('containsThirdPartyBrands', 'It shows third-party brands or logos.')}
        <button type="submit" className="small-btn" disabled={!att.confirmed || !file}>
          Import clip
        </button>
      </form>
      <ErrorNotice error={error} />
      {done ? <p className="small">{done}</p> : null}
    </details>
  );
}
