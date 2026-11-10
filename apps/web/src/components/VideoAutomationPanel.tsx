import { useState } from 'react';
import { api } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, ErrorNotice, LoadingRows, useApi } from './ui.js';

type Preset = 'vertical_9x16' | 'square_1x1' | 'landscape_16x9';
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'vertical_9x16', label: '9:16' },
  { id: 'square_1x1', label: '1:1' },
  { id: 'landscape_16x9', label: '16:9' },
];
const MODES: [string, string][] = [
  ['smart', 'Smart (free-first: templates render with Remotion)'],
  ['remotion', 'Remotion only'],
  ['google_flow', 'Google Flow (prepares a manual task)'],
  ['wan_cloud', 'Wan Cloud (paid: waits for your authorization)'],
  ['higgsfield', 'Higgsfield API (paid: waits for your authorization)'],
];
const RETRYABLE = ['failed', 'skipped', 'waiting', 'manual_task'];

interface BrandCfg {
  brandId: string;
  enabled: boolean;
  dailyQuota: number;
  categories: string[];
  presets: Preset[];
  assetIds: string[];
}
interface Automation {
  brands: BrandCfg[];
  preferredMode: string;
  useAi: boolean;
  maxScriptsPerRun: number;
}
interface Draft {
  dailyAutomation: boolean;
  dailyTarget: number;
  automation: Automation;
}
interface Scene {
  onScreenText: string;
  voiceover: string;
  subtitle: string;
  seconds: number;
  mediaHint: string;
}
interface Script {
  title: string;
  hook: string;
  scenes: Scene[];
  cta: string;
  suggestedMedia: string[];
  platform: string;
  preset: Preset;
  language: string;
}
interface Item {
  id: string;
  brandId: string;
  day: string;
  category: string;
  preset: Preset;
  platform: string;
  status: string;
  statusReason: string | null;
  origin: string | null;
  mode: string | null;
  title: string;
  script: Script | null;
  manualTask: { kind: string; url?: string; prompt?: string; estimateUsd?: number | null; steps?: string[] } | null;
  videoProjectId: string | null;
  attempts: number;
  aiUsd: number;
  scriptNote: string | null;
  updatedAt: string;
  project: { id: string; status: string; outputAssetId: string | null; storyboard: { scenes: { id: string }[] } | null } | null;
}
interface Overview {
  settings: Draft;
  version: number;
  remotionLicensed: boolean;
  brands: { id: string; name: string; slug: string; categories: { key: string; label: string }[]; problem: string | null; config: BrandCfg | null }[];
  blockers: string[];
  brandNotes: { brandId: string; note: string }[];
  today: { day: string; target: number; used: number; manualRenders: number; remaining: number; planned: number; inProgress: number; completed: number; waiting: number; failed: number; skipped: number; aiUsd: number };
  inFlightRenders: number;
  maxInFlight: number;
  pendingApprovals: Item[];
  items: Item[];
  history: { day: string; total: number; rendered: number; approved: number; failed: number; skipped: number; manual: number; aiUsd: number }[];
  paidUsage: { daySpentUsd: number; monthSpentUsd: number; reservedUsd: number; awaitingApproval: number };
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

function ScriptPreview({ script }: { script: Script }) {
  return (
    <div className="stack small">
      <div>
        <strong>{script.title}</strong> · {script.preset.replace('_', ' ')} · {script.platform} · {script.language}
      </div>
      <ol>
        {script.scenes.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: scenes have no ids before they become a storyboard
          <li key={i}>
            <strong>{s.onScreenText}</strong> <span className="muted">({s.seconds}s)</span>
            {s.subtitle ? <div>Subtitle: {s.subtitle}</div> : null}
            {s.voiceover ? <div className="muted">Voiceover: {s.voiceover}</div> : null}
            {s.mediaHint ? <div className="muted">Media: {s.mediaHint}</div> : null}
          </li>
        ))}
      </ol>
      {script.cta ? <div>Call to action: {script.cta}</div> : null}
      {script.suggestedMedia.length ? <div className="muted">Suggested licensed media: {script.suggestedMedia.join(' · ')}</div> : null}
    </div>
  );
}

/**
 * Daily Video Automation (D-053): topics, scripts and storyboards are prepared from each selected
 * brand's verified material; Remotion renders them; Google Flow and paid modes become tasks for a
 * person. Rendered videos wait here for review; publishing still goes through M23.
 */
export function VideoAutomationPanel() {
  const ov = useApi<Overview>('/v1/media/video-automation');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const d = draft ?? ov.data?.settings ?? null;
  const brandName = (id: string) => ov.data?.brands.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  const edit = (patch: Partial<Draft>) => d && setDraft({ ...d, ...patch });
  const editAutomation = (patch: Partial<Automation>) => d && setDraft({ ...d, automation: { ...d.automation, ...patch } });
  const editBrand = (brandId: string, patch: Partial<BrandCfg> | null) => {
    if (!d) return;
    const rest = d.automation.brands.filter((b) => b.brandId !== brandId);
    const cur = d.automation.brands.find((b) => b.brandId === brandId) ?? { brandId, enabled: true, dailyQuota: 2, categories: [], presets: ['vertical_9x16' as Preset], assetIds: [] };
    editAutomation({ brands: patch === null ? rest : [...rest, { ...cur, ...patch }] });
  };
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      await ov.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    d &&
    ov.data &&
    run(async () => {
      await api('PUT', '/v1/media/video-automation/settings', { ...d, expectedVersion: ov.data!.version });
      setDraft(null);
    }, 'Saved. The worker uses these settings on its next run.');

  return (
    <section className="card">
      <header className="card-head">
        <h2 className="card-title">Daily Video Automation</h2>
        <span className="row-actions">
          <button type="button" className="small-btn" disabled={busy} onClick={() => void run(() => api('POST', '/v1/media/video-automation/run'), 'Run finished.')}>
            Run now
          </button>
          <button type="button" className="small-btn" onClick={() => void ov.reload()}>
            Refresh
          </button>
        </span>
      </header>
      <p className="small muted">
        Prepares scripts and storyboards from each selected brand's verified content (curriculum units, approved Content Studio posts, approved claims; AI only through the approved gateway), renders them with Remotion, and queues the result for your review. It never enables a mode, spends paid budget or publishes.
      </p>
      <ErrorNotice error={ov.error ?? error} />
      {notice ? <p className="small">{notice}</p> : null}
      {!ov.data || !d ? (
        <LoadingRows />
      ) : (
        <>
          {ov.data.blockers.length || ov.data.brandNotes.length ? (
            <ul className="small findings">
              {ov.data.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
              {ov.data.brandNotes.map((n) => (
                <li key={n.brandId + n.note}>
                  {brandName(n.brandId)}: {n.note}
                </li>
              ))}
            </ul>
          ) : null}

          <h3>Today ({ov.data.today.day})</h3>
          <span className="ai-kpis">
            {[
              ['Target', `${ov.data.today.used}/${ov.data.today.target}`, `${ov.data.today.remaining} left`],
              ['Ready for review', String(ov.data.today.completed), `${ov.data.pendingApprovals.length} pending`],
              ['In progress', String(ov.data.today.inProgress + ov.data.today.planned), `${ov.data.inFlightRenders}/${ov.data.maxInFlight} renders`],
              ['Waiting', String(ov.data.today.waiting), 'manual or paid tasks'],
              ['Failed / skipped', `${ov.data.today.failed} / ${ov.data.today.skipped}`, 'retry below'],
              ['AI cost today', usd(ov.data.today.aiUsd), `paid video ${usd(ov.data.paidUsage.daySpentUsd)} (reserved ${usd(ov.data.paidUsage.reservedUsd)})`],
            ].map(([label, value, sub]) => (
              <span key={label} className="ai-kpi">
                <span className="small muted">{label}</span>
                <span className="ai-kpi-value">{value}</span>
                <span className="small muted">{sub}</span>
              </span>
            ))}
          </span>

          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <h3>Settings</h3>
            <label className="small">
              <input type="checkbox" checked={d.dailyAutomation} onChange={(e) => edit({ dailyAutomation: e.target.checked })} /> Daily automation ON
            </label>
            <label>
              Daily target (videos per day, 1–10) <input type="number" min={1} max={10} value={d.dailyTarget} onChange={(e) => edit({ dailyTarget: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
            </label>
            <label>
              Preferred video mode{' '}
              <select value={d.automation.preferredMode} onChange={(e) => editAutomation({ preferredMode: e.target.value })}>
                {MODES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="small">
              <input type="checkbox" checked={d.automation.useAi} onChange={(e) => editAutomation({ useAi: e.target.checked })} /> Use the approved AI model for scripts (OFF = curriculum and approved-content templates only, no AI spend)
            </label>
            <label>
              Scripts per run (1–5) <input type="number" min={1} max={5} value={d.automation.maxScriptsPerRun} onChange={(e) => editAutomation({ maxScriptsPerRun: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })} />
            </label>
            <h4>Brands</h4>
            <ul className="row-list">
              {ov.data.brands.map((b) => {
                const cfg = d.automation.brands.find((x) => x.brandId === b.id) ?? null;
                return (
                  <li key={b.id} className="row-item">
                    <div className="stack">
                      <label>
                        <input type="checkbox" checked={Boolean(cfg?.enabled)} disabled={Boolean(b.problem) && !cfg} onChange={(e) => editBrand(b.id, e.target.checked ? { enabled: true } : null)} /> <strong>{b.name}</strong>
                        {b.problem ? <span className="small muted"> — {b.problem}</span> : null}
                      </label>
                      {cfg ? (
                        <>
                          <label className="small">
                            Videos per day for this brand <input type="number" min={1} max={10} value={cfg.dailyQuota} onChange={(e) => editBrand(b.id, { dailyQuota: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
                          </label>
                          <div className="choice-chips">
                            {PRESETS.map((p) => {
                              const on = cfg.presets.includes(p.id);
                              return (
                                <label key={p.id} className={`chip-check${on ? ' on' : ''}`}>
                                  <input type="checkbox" checked={on} disabled={on && cfg.presets.length === 1} onChange={() => editBrand(b.id, { presets: on ? cfg.presets.filter((x) => x !== p.id) : [...cfg.presets, p.id] })} />
                                  {p.label}
                                </label>
                              );
                            })}
                          </div>
                          <div className="small muted">Content categories (none selected = all):</div>
                          <div className="choice-chips">
                            {b.categories.map((c) => {
                              const on = cfg.categories.includes(c.key);
                              return (
                                <label key={c.key} className={`chip-check${on ? ' on' : ''}`}>
                                  <input type="checkbox" checked={on} onChange={() => editBrand(b.id, { categories: on ? cfg.categories.filter((x) => x !== c.key) : [...cfg.categories, c.key] })} />
                                  {c.label}
                                </label>
                              );
                            })}
                          </div>
                          <label className="small">
                            Library asset ids this brand's scenes may use (comma-separated; rights are checked){' '}
                            <input
                              value={cfg.assetIds.join(',')}
                              onChange={(e) =>
                                editBrand(b.id, {
                                  assetIds: e.target.value
                                    .split(',')
                                    .map((x) => x.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          </label>
                        </>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="form-actions">
              <button type="submit" className="btn" disabled={busy || !draft}>
                Save automation settings
              </button>
              {draft ? (
                <button type="button" className="small-btn" onClick={() => setDraft(null)}>
                  Discard changes
                </button>
              ) : null}
            </div>
            {!ov.data.remotionLicensed ? <p className="small muted">Remotion renders need the licence eligibility recorded in Governance.</p> : null}
          </form>

          <h3>Pending approvals</h3>
          {ov.data.pendingApprovals.length ? (
            <ul className="row-list">
              {ov.data.pendingApprovals.map((i) => (
                <li key={i.id} className="row-item">
                  <div className="row">
                    <div>
                      <strong>{i.title}</strong>{' '}
                      <span className="small muted">
                        · {brandName(i.brandId)} · {i.preset}
                      </span>
                      {i.script ? <ScriptPreview script={i.script} /> : null}
                    </div>
                    <div className="row-actions">
                      <button type="button" className="small-btn" disabled={busy} onClick={() => void run(() => api('POST', `/v1/media/video-automation/items/${i.id}/review`, { decision: 'approve' }), 'Approved. Publish it from the Video Studio; M23 policy applies.')}>
                        Approve
                      </button>
                      <button type="button" className="small-btn" disabled={busy} onClick={() => void run(() => api('POST', `/v1/media/video-automation/items/${i.id}/review`, { decision: 'reject', note: 'Rejected in review' }), 'Rejected.')}>
                        Reject
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">Nothing is waiting for review.</p>
          )}

          <h3>Recent videos</h3>
          {ov.data.items.length ? (
            <ul className="row-list">
              {ov.data.items.map((i) => (
                <li key={i.id} className="row-item">
                  <div className="row">
                    <div>
                      <strong>{i.title}</strong> <Badge value={i.status} />{' '}
                      <span className="small muted">
                        {i.day} · {brandName(i.brandId)} · {i.category} · {i.preset} · {i.origin ?? 'no script yet'}
                        {i.mode ? ` · ${i.mode}` : ''} · {relativeTime(i.updatedAt)}
                      </span>
                      {i.statusReason ? <div className="small">{i.statusReason}</div> : null}
                      {i.scriptNote ? <div className="small muted">{i.scriptNote}</div> : null}
                      {i.manualTask?.prompt ? (
                        <div className="small stack">
                          {i.manualTask.url ? (
                            <a href={i.manualTask.url} target="_blank" rel="noreferrer">
                              Open Google Flow
                            </a>
                          ) : null}
                          {i.manualTask.estimateUsd != null ? <span>Maximum charge if you authorize it: {usd(i.manualTask.estimateUsd)}</span> : null}
                          <textarea readOnly rows={3} value={i.manualTask.prompt} aria-label="Prepared generation prompt" />
                        </div>
                      ) : null}
                      {open === i.id && i.script ? <ScriptPreview script={i.script} /> : null}
                    </div>
                    <div className="row-actions">
                      {i.script ? (
                        <button type="button" className="small-btn" onClick={() => setOpen(open === i.id ? null : i.id)}>
                          {open === i.id ? 'Hide' : 'Preview'}
                        </button>
                      ) : null}
                      {RETRYABLE.includes(i.status) ? (
                        <button type="button" className="small-btn" disabled={busy} onClick={() => void run(() => api('POST', `/v1/media/video-automation/items/${i.id}/retry`), 'Queued for the next run.')}>
                          Retry
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No automated videos yet.</p>
          )}

          <h3>History (14 days)</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Planned</th>
                  <th>Rendered</th>
                  <th>Approved</th>
                  <th>Manual/paid tasks</th>
                  <th>Failed</th>
                  <th>Skipped</th>
                  <th>AI cost</th>
                </tr>
              </thead>
              <tbody>
                {ov.data.history.map((r) => (
                  <tr key={r.day}>
                    <td>{r.day}</td>
                    <td>{r.total}</td>
                    <td>{r.rendered}</td>
                    <td>{r.approved}</td>
                    <td>{r.manual}</td>
                    <td>{r.failed}</td>
                    <td>{r.skipped}</td>
                    <td>{usd(r.aiUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
