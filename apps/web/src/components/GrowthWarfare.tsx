import { type ReactNode, useState } from 'react';
import { api, type Me, notifyChanged } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const GROWTH_WARFARE_CALLS = [
  { method: 'GET', path: '/v1/growth-warfare/overview' },
  { method: 'PUT', path: '/v1/growth-warfare/settings' },
  { method: 'POST', path: '/v1/growth-warfare/emergency-stop' },
  { method: 'POST', path: '/v1/growth-warfare/emergency-stop/release' },
  { method: 'PUT', path: '/v1/growth-warfare/brands/:id/config' },
  { method: 'POST', path: '/v1/growth-warfare/scan' },
  { method: 'GET', path: '/v1/growth-warfare/opportunities' },
  { method: 'POST', path: '/v1/growth-warfare/opportunities/:id/review' },
  { method: 'POST', path: '/v1/growth-warfare/opportunities/:id/conquest' },
  { method: 'POST', path: '/v1/growth-warfare/opportunities/:id/blitz' },
  { method: 'GET', path: '/v1/growth-warfare/campaigns' },
  { method: 'GET', path: '/v1/growth-warfare/campaigns/:id' },
  { method: 'POST', path: '/v1/growth-warfare/campaigns/:id/approve' },
  { method: 'POST', path: '/v1/growth-warfare/campaigns/:id/tasks' },
  { method: 'POST', path: '/v1/growth-warfare/campaigns/:id/sync' },
  { method: 'POST', path: '/v1/growth-warfare/campaigns/:id/community-replies' },
  { method: 'POST', path: '/v1/growth-warfare/tasks/:id/submit' },
  { method: 'POST', path: '/v1/growth-warfare/tasks/:id/done' },
  { method: 'GET', path: '/v1/growth-warfare/tools' },
  { method: 'POST', path: '/v1/growth-warfare/tools' },
  { method: 'POST', path: '/v1/growth-warfare/tools/:id/:command' },
  { method: 'GET', path: '/v1/growth-warfare/visibility' },
  { method: 'POST', path: '/v1/growth-warfare/visibility/import' },
  { method: 'GET', path: '/v1/growth-warfare/funnel' },
  { method: 'POST', path: '/v1/growth-warfare/rescue' },
  { method: 'GET', path: '/v1/growth-warfare/referrals' },
  { method: 'GET', path: '/v1/growth-warfare/experiments' },
  { method: 'POST', path: '/v1/growth-warfare/experiments' },
  { method: 'POST', path: '/v1/growth-warfare/experiments/:id/approve' },
  { method: 'POST', path: '/v1/growth-warfare/experiments/:id/start' },
  { method: 'GET', path: '/v1/growth-warfare/learning' },
  { method: 'POST', path: '/v1/growth-warfare/learning/sync' },
  { method: 'GET', path: '/v1/growth-warfare/history' },
] as const;

type Feature = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';
const FEATURES: Feature[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
const CHANNELS = ['facebook', 'instagram', 'email', 'paid_ads', 'owned_site', 'referral', 'partner', 'community', 'creator'] as const;

interface Controls {
  brandIds: string[];
  acquisitionGoal: string | null;
  maxConcurrentCampaigns: number;
  monitoringHours: number;
  dailyAiBudgetUsd: number;
  monthlyAiBudgetUsd: number;
  adSpendLimitMicros: number;
  adCurrency: string;
  channelQuotas: Record<string, number>;
  approvalPreference: 'always_human' | 'policy';
  externalOperations: boolean;
  paidOperations: boolean;
}
interface Settings {
  features: Record<Feature, boolean>;
  aggression: 'balanced' | 'aggressive' | 'maximum_authorized';
  controls: Controls;
  emergencyStop: boolean;
  emergencyReason: string | null;
  lastScanAt: string | null;
  version: number;
  effective: { maxConcurrentCampaigns: number; maxParallelExperiments: number; monitoringHours: number; opportunityThreshold: number; channelQuotas: Record<string, number> };
}
interface Readiness {
  channel: string;
  available: boolean;
  path: string;
  reason: string;
  quota: number;
  usedToday: number;
}
interface Room {
  settings: Settings;
  features: Record<Feature, { name: string; summary: string; external: boolean; on: boolean }>;
  brands: { id: string; name: string; working: boolean }[];
  brandId: string | null;
  brandConfig: { version: number; config: Record<string, unknown> } | null;
  counts: Record<string, Record<string, number> | number>;
  outcomes: { verifiedTasks: number; attributedConversions: number; note: string };
  readiness: { modelGateway: boolean; approvedModels: number; searchConsole: boolean; aiVisibilityProvider: string; channels: Readiness[]; aiBudget: { growthWarfare: { todayUsd: number; monthUsd: number; dailyLimitUsd: number; monthlyLimitUsd: number } }; externalOperations: boolean; paidOperations: boolean };
  priorities: { tactic: string; randomizedTests: number; wins: number; losses: number; posteriorMean: number; declining: string | null; observationalNotes: number }[];
  followUps: { memoryId: string; kind: string; recommendation: string; caution: string }[];
}
interface Opportunity {
  id: string;
  kind: string;
  title: string;
  reason: string;
  score: number;
  urgency: string;
  status: string;
  nextAction: { feature?: string; label?: string };
  expiresAt: string;
  signal: { evidenceIds: string[]; sourceTable: string; observedAt: string; history: unknown[] };
}
interface Campaign {
  id: string;
  kind: string;
  title: string;
  status: string;
  version: number;
  package: Record<string, unknown>;
  approval: { required?: { code: string; why: string }[] };
  goals: { event?: string; metric?: string }[];
  createdAt: string;
  expiresAt: string | null;
}
interface Task {
  id: string;
  channel: string;
  status: string;
  statusReason: string | null;
  content: Record<string, unknown>;
  outcome: Record<string, unknown>;
  refs: Record<string, unknown>;
}

const TABS = [
  ['overview', 'Growth Overview'],
  ['opportunities', 'Market Opportunities'],
  ['conquest', 'Competitor Conquest'],
  ['blitz', 'Growth Blitz'],
  ['tools', 'Search & Acquisition Tools'],
  ['rescue', 'Conversion Rescue'],
  ['experiments', 'Campaign Experiments'],
  ['learning', 'Strategy Learning'],
  ['settings', 'Growth Settings'],
  ['history', 'Execution History'],
] as const;
type Tab = (typeof TABS)[number][0];

const ADMIN = (me: Me) => me.roles.some((r) => r === 'owner' || r === 'admin');
const OPERATOR = (me: Me) => me.roles.some((r) => ['owner', 'admin', 'growth_operator'].includes(r));
const APPROVER = (me: Me) => me.roles.some((r) => ['owner', 'admin', 'approver'].includes(r));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const txt = (s: string) => s.replaceAll('_', ' ');

function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      notifyChanged();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="card stack">
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        {hint ? <p className="small muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Growth Warfare Control Room (D-054): one dashboard for F1–F6. Every switch starts OFF. */
export function GrowthWarfare({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [brand, setBrand] = useState<string | null>(null);
  const room = useApi<Room>(`/v1/growth-warfare/overview${brand ? `?brandId=${brand}` : ''}`);
  if (room.error) return <ErrorNotice error={room.error} />;
  if (!room.data) return <LoadingRows label="Loading the Growth Warfare control room…" />;
  const r = room.data;
  const brandId = r.brandId;
  const reload = () => void room.reload();
  return (
    <div className="stack">
      {r.settings.emergencyStop ? (
        <div className="notice error" role="alert">
          Emergency stop engaged: {r.settings.emergencyReason}. No new Growth Warfare work starts until an admin with two-factor releases it in Growth Settings.
        </div>
      ) : null}
      <div className="toolbar">
        <div className="field">
          <label htmlFor="gw-brand">Brand</label>
          <select id="gw-brand" value={brandId ?? ''} onChange={(e) => setBrand(e.target.value || null)}>
            {r.brands.length ? null : <option value="">No brand yet</option>}
            {r.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.working ? '' : ' (not enabled)'}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          {FEATURES.map((f) => (
            <span key={f} className={`chip ${r.features[f].on ? 'ok' : 'muted'}`} title={r.features[f].summary}>
              {f} {r.features[f].on ? 'on' : 'off'}
            </span>
          ))}
          <span className="chip">{txt(r.settings.aggression)}</span>
        </div>
      </div>
      <div className="seg" role="tablist" aria-label="Growth Warfare sections">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className="seg-btn" onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {!brandId && tab !== 'settings' && tab !== 'history' && tab !== 'overview' ? (
        <EmptyState
          title="Create a brand first"
          action={
            <a className="btn" href="/app/channels">
              Open Channels › Brands
            </a>
          }
        >
          Growth Warfare works per brand: its keywords, competitors, funnel, channels and budgets stay separate.
        </EmptyState>
      ) : tab === 'overview' ? (
        <Overview r={r} />
      ) : tab === 'opportunities' ? (
        <Opportunities me={me} brandId={brandId!} on={r.features.F1.on} onChange={reload} />
      ) : tab === 'conquest' ? (
        <Campaigns me={me} brandId={brandId!} kinds={['conquest']} onChange={reload} />
      ) : tab === 'blitz' ? (
        <Campaigns me={me} brandId={brandId!} kinds={['blitz', 'rescue', 'referral']} onChange={reload} />
      ) : tab === 'tools' ? (
        <Tools me={me} brandId={brandId!} />
      ) : tab === 'rescue' ? (
        <Rescue me={me} brandId={brandId!} />
      ) : tab === 'experiments' ? (
        <Experiments me={me} brandId={brandId!} />
      ) : tab === 'learning' ? (
        <Learning me={me} brandId={brandId!} />
      ) : tab === 'settings' ? (
        <SettingsView me={me} r={r} onChange={reload} />
      ) : (
        <History />
      )}
    </div>
  );
}

function Overview({ r }: { r: Room }) {
  const c = r.counts as Record<string, Record<string, number>>;
  const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  const tiles = [
    ['Active signals', c.signals?.active ?? 0],
    ['Open opportunities', (c.opportunities?.new ?? 0) + (c.opportunities?.reviewing ?? 0) + (c.opportunities?.accepted ?? 0)],
    ['Campaigns', sum(c.campaigns)],
    ['Verified executions', r.outcomes.verifiedTasks],
    ['Attributed conversions', r.outcomes.attributedConversions],
    ['Recorded findings', Number(r.counts.memory ?? 0)],
  ] as const;
  return (
    <div className="stack">
      <div className="glance-grid">
        {tiles.map(([label, v]) => (
          <div key={label} className="glance-tile">
            <span className="glance-label">{label}</span>
            <span className="glance-value">{v}</span>
          </div>
        ))}
      </div>
      <p className="small muted">{r.outcomes.note}</p>
      <Section title="Provider readiness" hint="Only real, connected and approved providers are used. Missing ones are shown as missing.">
        <ul className="row-list">
          <li className="row-item">
            Model gateway: <Badge value={r.readiness.modelGateway ? 'configured' : 'not configured'} /> · {r.readiness.approvedModels} approved model(s) · Growth Warfare AI spend ${r.readiness.aiBudget.growthWarfare.todayUsd.toFixed(2)} today of ${r.readiness.aiBudget.growthWarfare.dailyLimitUsd.toFixed(2)}
          </li>
          <li className="row-item">
            Search Console: <Badge value={r.readiness.searchConsole ? 'connected' : 'not connected'} /> · AI-search visibility: manual imports only (no provider API is configured)
          </li>
          <li className="row-item">
            External operations <Badge value={r.readiness.externalOperations ? 'allowed' : 'off'} /> · Paid operations <Badge value={r.readiness.paidOperations ? 'allowed' : 'off'} />
          </li>
          {r.readiness.channels.map((ch) => (
            <li key={ch.channel} className="row-item">
              <strong>{txt(ch.channel)}</strong> <Badge value={ch.available ? 'available' : 'unavailable'} /> {ch.usedToday}/{ch.quota} today — <span className="small muted">{ch.reason}</span>
            </li>
          ))}
        </ul>
      </Section>
      {r.followUps.length ? (
        <Section title="Evidence-grounded follow-ups" hint="From randomized experiment results only.">
          <ul className="row-list">
            {r.followUps.map((f) => (
              <li key={f.memoryId} className="row-item">
                {f.recommendation} <span className="small muted">{f.caution}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Opportunities({ me, brandId, on, onChange }: { me: Me; brandId: string; on: boolean; onChange: () => void }) {
  const list = useApi<Opportunity[]>(`/v1/growth-warfare/opportunities?brandId=${brandId}&status=new,reviewing,accepted,converted`);
  const act = useAction(() => {
    void list.reload();
    onChange();
  });
  if (list.error) return <ErrorNotice error={list.error} />;
  if (!list.data) return <LoadingRows />;
  return (
    <Section title="Market opportunities" hint="Scored from stored, authorized evidence. The score is a prioritisation aid, not a conversion probability.">
      {OPERATOR(me) ? (
        <div className="row-actions">
          <button type="button" className="btn" disabled={!on || act.busy} onClick={() => act.run(() => api('POST', '/v1/growth-warfare/scan', { brandId }))}>
            Scan now
          </button>
          {on ? null : <span className="small muted">Turn on F1 in Growth Settings to scan.</span>}
        </div>
      ) : null}
      {act.error ? <ErrorNotice error={act.error} /> : null}
      {list.data.length === 0 ? (
        <EmptyState title="No opportunities yet">Signals come from competitor observations, trends, Search Console queries, first-party inquiries and consented app searches that match this brand’s keywords and competitors.</EmptyState>
      ) : (
        <ul className="row-list">
          {list.data.map((o) => (
            <li key={o.id} className="row-item stack-xs">
              <div className="row">
                <strong>{o.title}</strong> <Badge value={o.status} /> <span className="chip">{o.urgency} urgency</span> <span className="chip">score {o.score.toFixed(2)}</span>
              </div>
              <p className="small">{o.reason}</p>
              <p className="small muted">
                Evidence {o.signal.evidenceIds.length} · source {txt(o.signal.sourceTable)} · observed {relativeTime(o.signal.observedAt)} · expires {relativeTime(o.expiresAt)} · next: {o.nextAction.label}
              </p>
              {OPERATOR(me) && o.status !== 'converted' ? (
                <div className="row-actions">
                  <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/opportunities/${o.id}/review`, { decision: 'accepted' }))}>
                    Accept
                  </button>
                  <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/opportunities/${o.id}/review`, { decision: 'dismissed' }))}>
                    Dismiss
                  </button>
                  {o.nextAction.feature === 'F2' ? (
                    <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/opportunities/${o.id}/conquest`))}>
                      Build conquest package
                    </button>
                  ) : (
                    <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/opportunities/${o.id}/blitz`))}>
                      Prepare blitz
                    </button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Campaigns({ me, brandId, kinds, onChange }: { me: Me; brandId: string; kinds: string[]; onChange: () => void }) {
  const list = useApi<Campaign[]>(`/v1/growth-warfare/campaigns?brandId=${brandId}`);
  const [open, setOpen] = useState<string | null>(null);
  if (list.error) return <ErrorNotice error={list.error} />;
  if (!list.data) return <LoadingRows />;
  const rows = list.data.filter((c) => kinds.includes(c.kind));
  return (
    <Section title={kinds.includes('conquest') ? 'Competitor conquest packages' : 'Campaigns and channel tasks'} hint="Approval never publishes: each channel task is submitted separately and external writes still go through the execution gateway (M23).">
      {rows.length === 0 ? (
        <EmptyState title="No campaigns yet">Build one from a market opportunity.</EmptyState>
      ) : (
        <ul className="row-list">
          {rows.map((c) => (
            <li key={c.id} className="row-item stack-xs">
              <div className="row">
                <button type="button" className="link-btn" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
                  {c.title}
                </button>
                <Badge value={c.status} /> <span className="chip">{c.kind}</span>
              </div>
              {open === c.id ? (
                <CampaignDetail
                  me={me}
                  id={c.id}
                  onChange={() => {
                    void list.reload();
                    onChange();
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CampaignDetail({ me, id, onChange }: { me: Me; id: string; onChange: () => void }) {
  const d = useApi<{ campaign: Campaign; tasks: Task[] }>(`/v1/growth-warfare/campaigns/${id}`);
  const [ack, setAck] = useState(false);
  const [url, setUrl] = useState('');
  const [reply, setReply] = useState({ discussionUrl: '', question: '' });
  const act = useAction(() => {
    void d.reload();
    onChange();
  });
  if (d.error) return <ErrorNotice error={d.error} />;
  if (!d.data) return <LoadingRows />;
  const { campaign: c, tasks } = d.data;
  const pkg = c.package as Record<string, any>;
  const needsLegal = (c.approval.required ?? []).some((r) => r.code === 'legal_trademark_review');
  return (
    <div className="card nested stack">
      {pkg.blockers?.length ? <div className="notice warn small">Blocked: {pkg.blockers.join(' ')}</div> : null}
      {pkg.approvedClaims?.length ? (
        <div>
          <h3 className="small">Approved claims used</h3>
          <ul className="small">
            {pkg.approvedClaims.map((x: { claimId: string; text: string }) => (
              <li key={x.claimId}>{x.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {pkg.verifiedCompetitorFacts?.length ? (
        <div>
          <h3 className="small">Verified competitor facts</h3>
          <ul className="small">
            {pkg.verifiedCompetitorFacts.map((f: { observationId: string; summary: string; observedAt: string }) => (
              <li key={f.observationId}>
                {f.summary} <span className="muted">(observed {f.observedAt.slice(0, 10)})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {pkg.comparisonPage?.markdown ? (
        <details>
          <summary className="small">Comparison page draft</summary>
          <pre className="small pre-wrap">{pkg.comparisonPage.markdown}</pre>
        </details>
      ) : null}
      <div>
        <h3 className="small">Approval requirements</h3>
        <ul className="small">
          {(c.approval.required ?? []).map((r) => (
            <li key={r.code}>
              {txt(r.code)} — {r.why}
            </li>
          ))}
        </ul>
        <p className="small muted">Goals: {c.goals.map((g) => g.metric).join('; ') || 'define conversion events in the brand growth profile'}</p>
      </div>
      {act.error ? <ErrorNotice error={act.error} /> : null}
      {APPROVER(me) && c.status === 'ready_for_review' ? (
        <div className="row-actions">
          {needsLegal ? (
            <label className="small">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Legal/trademark review of the comparison content is done
            </label>
          ) : null}
          <button type="button" className="btn primary" disabled={act.busy || (needsLegal && !ack)} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/campaigns/${c.id}/approve`, { expectedVersion: c.version, acknowledge: ack ? ['legal_trademark_review'] : [] }))}>
            Approve package
          </button>
        </div>
      ) : null}
      {OPERATOR(me) ? (
        <div className="row-actions">
          <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/campaigns/${c.id}/tasks`, {}))}>
            Plan channel tasks
          </button>
          <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/campaigns/${c.id}/sync`))}>
            Refresh outcomes
          </button>
        </div>
      ) : null}
      {tasks.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">Outcome</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>{txt(t.channel)}</td>
                  <td>
                    <Badge value={t.status} />
                    {t.statusReason ? <div className="small muted">{t.statusReason}</div> : null}
                  </td>
                  <td className="small">{t.outcome.conversions !== undefined ? `${t.outcome.conversions} conversion(s), observational` : '—'}</td>
                  <td>
                    {OPERATOR(me) && t.status === 'planned' ? (
                      <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/tasks/${t.id}/submit`, {}))}>
                        Submit
                      </button>
                    ) : null}
                    {OPERATOR(me) && t.status === 'ready' ? (
                      <span className="inline-form compact">
                        <label className="sr-only" htmlFor={`done-${t.id}`}>
                          Published link
                        </label>
                        <input id={`done-${t.id}`} type="url" placeholder="https://… where it was published" value={url} onChange={(e) => setUrl(e.target.value)} />
                        <button type="button" className="small-btn" disabled={act.busy || !url} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/tasks/${t.id}/done`, { url }))}>
                          Mark done
                        </button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {OPERATOR(me) ? (
        <details>
          <summary className="small">Draft a disclosed community reply</summary>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={`cr-url-${c.id}`}>Discussion link</label>
              <input id={`cr-url-${c.id}`} type="url" value={reply.discussionUrl} onChange={(e) => setReply({ ...reply, discussionUrl: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`cr-q-${c.id}`}>The question asked</label>
              <textarea id={`cr-q-${c.id}`} rows={2} value={reply.question} onChange={(e) => setReply({ ...reply, question: e.target.value })} />
            </div>
          </div>
          <button type="button" className="small-btn" disabled={act.busy || !reply.discussionUrl || !reply.question} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/campaigns/${c.id}/community-replies`, { ...reply, groupId: null }))}>
            Draft reply
          </button>
          <p className="small muted">A person posts it by hand after reading the group rules. Nothing is posted, joined or messaged automatically.</p>
        </details>
      ) : null}
    </div>
  );
}

function Tools({ me, brandId }: { me: Me; brandId: string }) {
  const tools = useApi<{ id: string; title: string; template: string; status: string; publicId: string; stats: Record<string, number>; info: { methodology: string } }[]>(`/v1/growth-warfare/tools?brandId=${brandId}`);
  const vis = useApi<{ coverage: { trackedQueries: number; engines: string[]; lastObservedAt: string | null }; gaps: unknown[]; recommendations: { query: string; contentImprovement: string; faq: unknown; toolIdea: { template: string } | null }[]; missing: string[]; note: string }>(
    `/v1/growth-warfare/visibility?brandId=${brandId}`,
  );
  const [draft, setDraft] = useState({ template: 'practice_quiz', title: '', config: '{}' });
  const [importText, setImportText] = useState('');
  const act = useAction(() => {
    void tools.reload();
    void vis.reload();
  });
  return (
    <div className="stack">
      <Section title="Acquisition tools" hint="Real calculations; every number is the visitor’s input or operator data with a source and date. Public at /t/?id=… once published.">
        {tools.error ? <ErrorNotice error={tools.error} /> : null}
        {act.error ? <ErrorNotice error={act.error} /> : null}
        {tools.data?.length ? (
          <ul className="row-list">
            {tools.data.map((t) => (
              <li key={t.id} className="row-item">
                <strong>{t.title}</strong> <Badge value={t.status} /> <span className="chip">{txt(t.template)}</span>{' '}
                <span className="small muted">
                  viewed {t.stats.viewed ?? 0} · completed {t.stats.completed ?? 0} · leads {t.stats.lead ?? 0}
                </span>
                {t.status === 'published' ? (
                  <a className="small" href={`/t/?id=${t.publicId}`} target="_blank" rel="noreferrer">
                    {' '}
                    Open public tool
                  </a>
                ) : null}
                {ADMIN(me) ? (
                  <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/tools/${t.id}/${t.status === 'published' ? 'retire' : 'publish'}`))}>
                    {t.status === 'published' ? 'Retire' : 'Publish'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No tools yet.</p>
        )}
        {OPERATOR(me) ? (
          <details>
            <summary className="small">Create a tool</summary>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="gw-tpl">Template</label>
                <select id="gw-tpl" value={draft.template} onChange={(e) => setDraft({ ...draft, template: e.target.value })}>
                  {['courier_comparison', 'cod_reconciliation', 'seller_cost_calculator', 'vocabulary_assessment', 'practice_quiz', 'readiness_assessment'].map((x) => (
                    <option key={x} value={x}>
                      {txt(x)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="gw-tool-title">Title</label>
                <input id="gw-tool-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="gw-tool-config">Configuration (JSON; courier rates need a source URL and verification date each)</label>
                <textarea id="gw-tool-config" rows={4} value={draft.config} onChange={(e) => setDraft({ ...draft, config: e.target.value })} />
              </div>
            </div>
            <button type="button" className="small-btn" disabled={act.busy || draft.title.length < 3} onClick={() => act.run(() => api('POST', '/v1/growth-warfare/tools', { brandId, template: draft.template, title: draft.title, config: JSON.parse(draft.config || '{}') }))}>
              Create draft
            </button>
          </details>
        ) : null}
      </Section>
      <Section title="AI-search visibility" hint="Audited manual observations only; consumer AI assistants are never automated and no ranking is promised.">
        {vis.error ? <ErrorNotice error={vis.error} /> : null}
        {vis.data ? (
          <>
            <p className="small">
              {vis.data.coverage.trackedQueries} tracked question(s) on {vis.data.coverage.engines.join(', ') || 'no engine yet'}; last observed {vis.data.coverage.lastObservedAt ? relativeTime(vis.data.coverage.lastObservedAt) : 'never'}.
            </p>
            {vis.data.missing.map((m) => (
              <p key={m} className="notice small">
                {m}
              </p>
            ))}
            <ul className="row-list">
              {vis.data.recommendations.slice(0, 12).map((x) => (
                <li key={x.query} className="row-item small">
                  <strong>{x.query}</strong>: {x.contentImprovement}
                  {x.toolIdea ? ` Tool idea: ${txt(x.toolIdea.template)}.` : ''}
                </li>
              ))}
            </ul>
            <p className="small muted">{vis.data.note}</p>
          </>
        ) : null}
        {OPERATOR(me) ? (
          <details>
            <summary className="small">Import observations</summary>
            <label className="sr-only" htmlFor="gw-vis-import">
              Observations JSON
            </label>
            <textarea id="gw-vis-import" rows={4} placeholder='{"engine":"assistant","sourceNote":"how it was observed","observations":[{"query":"…","observedAt":"2026-11-01T10:00:00Z","brandMentioned":false,"competitorsMentioned":[]}]}' value={importText} onChange={(e) => setImportText(e.target.value)} />
            <button type="button" className="small-btn" disabled={act.busy || !importText} onClick={() => act.run(() => api('POST', '/v1/growth-warfare/visibility/import', { brandId, ...JSON.parse(importText) }))}>
              Import
            </button>
          </details>
        ) : null}
      </Section>
    </div>
  );
}

function Rescue({ me, brandId }: { me: Me; brandId: string }) {
  const f = useApi<{
    diagnosis: {
      status: string;
      note: string;
      counts: { key: string; label: string; reached: number; conversionFromPrevious: number | null; interval95: [number, number] | null; sufficient: boolean }[];
      bottleneck: { from: string; to: string; rate: number } | null;
      abandoned: { stalled: number; contactable: number; stallDays: number } | null;
    };
    plan: { actions: { kind: string; available: boolean; why: string }[]; note: string };
  }>(`/v1/growth-warfare/funnel?brandId=${brandId}`);
  const loop = useApi<{ inviters: number; invites: number; invitedSignups: number; selfReferralsExcluded: number; kFactor: number | null; note: string }>('/v1/growth-warfare/referrals');
  const act = useAction(() => void f.reload());
  if (f.error) return <ErrorNotice error={f.error} />;
  if (!f.data) return <LoadingRows />;
  const d = f.data.diagnosis;
  return (
    <div className="stack">
      <Section title="Funnel diagnosis" hint={d.note}>
        {d.counts.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">People</th>
                  <th scope="col">From previous</th>
                  <th scope="col">95% interval</th>
                </tr>
              </thead>
              <tbody>
                {d.counts.map((c) => (
                  <tr key={c.key} className={d.bottleneck?.to === c.key ? 'highlight' : undefined}>
                    <td>{c.label}</td>
                    <td>{c.reached}</td>
                    <td>
                      {pct(c.conversionFromPrevious)}
                      {c.sufficient ? '' : ' (too few)'}
                    </td>
                    <td>{c.interval95 ? `${pct(c.interval95[0])} – ${pct(c.interval95[1])}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {d.abandoned ? (
          <p className="small">
            {d.abandoned.stalled} people stalled for {d.abandoned.stallDays}+ days; {d.abandoned.contactable} can be e-mailed (current consent, not suppressed).
          </p>
        ) : null}
        <ul className="row-list">
          {f.data.plan.actions.map((a) => (
            <li key={a.kind} className="row-item small">
              <strong>{txt(a.kind)}</strong> <Badge value={a.available ? 'available' : 'unavailable'} /> {a.why}
            </li>
          ))}
        </ul>
        {act.error ? <ErrorNotice error={act.error} /> : null}
        {OPERATOR(me) && d.bottleneck ? (
          <button type="button" className="btn" disabled={act.busy} onClick={() => act.run(() => api('POST', '/v1/growth-warfare/rescue', { brandId }))}>
            Prepare rescue campaign
          </button>
        ) : null}
      </Section>
      <Section title="Referral loop" hint={loop.data?.note}>
        {loop.data ? (
          <p className="small">
            {loop.data.inviters} inviters sent {loop.data.invites} invites; {loop.data.invitedSignups} invited sign-ups ({loop.data.selfReferralsExcluded} self-referrals excluded); K-factor {loop.data.kFactor ?? '—'}.
          </p>
        ) : (
          <LoadingRows />
        )}
      </Section>
    </div>
  );
}

function Experiments({ me, brandId }: { me: Me; brandId: string }) {
  const list = useApi<{ id: string; area: string; hypothesis: string; status: string; sufficiency: { status: string; reason: string }; experimentId: string | null }[]>(`/v1/growth-warfare/experiments?brandId=${brandId}`);
  const [form, setForm] = useState({ area: 'landing_page', hypothesis: '', control: '', variant: '', metric: '' });
  const act = useAction(() => void list.reload());
  return (
    <Section title="Experiment factory" hint="Each plan has a hypothesis, control, variant, KPI, guardrails, sufficiency check and stop conditions. Approval creates an M10 experiment; starting it is an M23 action.">
      {list.error ? <ErrorNotice error={list.error} /> : null}
      {act.error ? <ErrorNotice error={act.error} /> : null}
      <ul className="row-list">
        {(list.data ?? []).map((p) => (
          <li key={p.id} className="row-item stack-xs">
            <div className="row">
              <strong>{txt(p.area)}</strong> <Badge value={p.status} /> <span className="chip">sufficiency: {p.sufficiency.status}</span>
            </div>
            <p className="small">{p.hypothesis}</p>
            <p className="small muted">{p.sufficiency.reason}</p>
            {ADMIN(me) && p.status === 'proposed' ? (
              <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/experiments/${p.id}/approve`, {}))}>
                Approve plan
              </button>
            ) : null}
            {OPERATOR(me) && p.status === 'approved' ? (
              <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', `/v1/growth-warfare/experiments/${p.id}/start`))}>
                Start (via M23)
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {OPERATOR(me) ? (
        <details>
          <summary className="small">Propose an experiment</summary>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="gw-ex-area">Area</label>
              <select id="gw-ex-area" value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })}>
                {['positioning', 'offer', 'landing_page', 'acquisition_tool', 'onboarding', 'referral', 'campaign_variant'].map((a) => (
                  <option key={a} value={a}>
                    {txt(a)}
                  </option>
                ))}
              </select>
            </div>
            {(
              [
                ['hypothesis', 'Hypothesis'],
                ['control', 'Control (what runs today)'],
                ['variant', 'Variant'],
                ['metric', 'Primary KPI event'],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="field">
                <label htmlFor={`gw-ex-${k}`}>{label}</label>
                <input id={`gw-ex-${k}`} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              </div>
            ))}
          </div>
          <button
            type="button"
            className="small-btn"
            disabled={act.busy || form.hypothesis.length < 10 || !form.metric}
            onClick={() => act.run(() => api('POST', '/v1/growth-warfare/experiments', { brandId, area: form.area, hypothesis: form.hypothesis, control: { description: form.control || 'current version' }, variant: { description: form.variant || 'new version' }, primaryKpi: { metric: form.metric } }))}
          >
            Propose
          </button>
        </details>
      ) : null}
    </Section>
  );
}

function Learning({ me, brandId }: { me: Me; brandId: string }) {
  const l = useApi<{ memory: { id: string; tactic: string; outcome: string; inferenceKind: string; summary: string; createdAt: string; confounders: string[] }[]; priorities: Room['priorities']; brainContext: string[] }>(`/v1/growth-warfare/learning?brandId=${brandId}`);
  const act = useAction(() => void l.reload());
  if (l.error) return <ErrorNotice error={l.error} />;
  if (!l.data) return <LoadingRows />;
  return (
    <div className="stack">
      <Section title="Strategy memory" hint="Only randomized, SRM-clean results count as wins or losses; attribution is stored as observational and never changes priorities.">
        {act.error ? <ErrorNotice error={act.error} /> : null}
        {OPERATOR(me) ? (
          <button type="button" className="small-btn" disabled={act.busy} onClick={() => act.run(() => api('POST', '/v1/growth-warfare/learning/sync', { brandId }))}>
            Sync finished experiments
          </button>
        ) : null}
        <ul className="row-list">
          {l.data.memory.map((m) => (
            <li key={m.id} className="row-item small">
              <Badge value={m.outcome} /> <span className="chip">{m.inferenceKind === 'randomized_test' ? 'randomized' : 'observational'}</span> <strong>{m.tactic}</strong>: {m.summary}
              {m.confounders.length ? <span className="muted"> Confounders: {m.confounders.join('; ')}</span> : null}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Tactic priorities" hint="Beta(1+wins, 1+losses) mean from randomized tests only. Higher priority never raises a budget automatically.">
        <ul className="row-list">
          {l.data.priorities.map((p) => (
            <li key={p.tactic} className="row-item small">
              <strong>{p.tactic}</strong> {p.posteriorMean.toFixed(2)} ({p.wins} won, {p.losses} lost of {p.randomizedTests} tests){p.declining ? ` — declining: ${p.declining}` : ''}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="What the Growth Brain reads" hint="Exactly these lines are given to the Autopilot’s Idea Lab and Growth Brain for this brand.">
        <ul className="small">
          {l.data.brainContext.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function SettingsView({ me, r, onChange }: { me: Me; r: Room; onChange: () => void }) {
  const s = r.settings;
  const [features, setFeatures] = useState(s.features);
  const [aggression, setAggression] = useState(s.aggression);
  const [controls, setControls] = useState(s.controls);
  const [reason, setReason] = useState('');
  const [profile, setProfile] = useState(JSON.stringify(r.brandConfig?.config ?? {}, null, 2));
  const act = useAction(onChange);
  const admin = ADMIN(me);
  const num = (k: keyof Controls, label: string, step = 1) => (
    <div className="field">
      <label htmlFor={`gw-c-${k}`}>{label}</label>
      <input id={`gw-c-${k}`} type="number" min={0} step={step} value={Number(controls[k])} disabled={!admin} onChange={(e) => setControls({ ...controls, [k]: Number(e.target.value) })} />
    </div>
  );
  const flag = (k: 'externalOperations' | 'paidOperations', label: string) => (
    <label className="small">
      <input type="checkbox" checked={controls[k]} disabled={!admin} onChange={(e) => setControls({ ...controls, [k]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <div className="stack">
      <Section title="Emergency stop" hint="Stopping needs no second factor. Releasing needs an admin with two-factor.">
        {act.error ? <ErrorNotice error={act.error} /> : null}
        {s.emergencyStop ? (
          admin ? (
            <button type="button" className="btn" disabled={act.busy || !me.mfaVerified} onClick={() => act.run(() => api('POST', '/v1/growth-warfare/emergency-stop/release', { expectedVersion: s.version }))}>
              Release emergency stop
            </button>
          ) : null
        ) : (
          <div className="inline-form">
            <label className="sr-only" htmlFor="gw-stop-reason">
              Reason
            </label>
            <input id="gw-stop-reason" placeholder="Reason for stopping" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn danger" disabled={act.busy || reason.length < 3} onClick={() => act.run(() => api('POST', '/v1/growth-warfare/emergency-stop', { reason }))}>
              Emergency stop
            </button>
          </div>
        )}
      </Section>
      <Section title="Feature switches and aggression" hint="OFF stops new work server-side, including scheduled jobs. Aggression changes capacity only; it never bypasses consent, permissions, budgets or approvals.">
        {!me.mfaVerified ? <p className="notice warn small">Turning features on or widening limits needs a two-factor session (Settings › Account & security).</p> : null}
        <ul className="row-list">
          {FEATURES.map((f) => (
            <li key={f} className="row-item">
              <label>
                <input type="checkbox" checked={features[f]} disabled={!admin} onChange={(e) => setFeatures({ ...features, [f]: e.target.checked })} /> <strong>{f}</strong> {r.features[f].name}
              </label>
              <span className="small muted"> {r.features[f].summary}</span>
            </li>
          ))}
        </ul>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="gw-aggr">Aggression level</label>
            <select id="gw-aggr" value={aggression} disabled={!admin} onChange={(e) => setAggression(e.target.value as Settings['aggression'])}>
              <option value="balanced">Balanced</option>
              <option value="aggressive">Aggressive</option>
              <option value="maximum_authorized">Maximum authorized</option>
            </select>
          </div>
          {num('maxConcurrentCampaigns', 'Maximum concurrent campaigns')}
          {num('monitoringHours', 'Monitoring frequency (hours)')}
          {num('dailyAiBudgetUsd', 'Daily AI budget (USD)', 0.01)}
          {num('monthlyAiBudgetUsd', 'Monthly AI budget (USD)', 0.01)}
          {num('adSpendLimitMicros', 'Advertising limit (micros)')}
          <div className="field">
            <label htmlFor="gw-approval">Execution approval</label>
            <select id="gw-approval" value={controls.approvalPreference} disabled={!admin} onChange={(e) => setControls({ ...controls, approvalPreference: e.target.value as Controls['approvalPreference'] })}>
              <option value="always_human">A person submits every task</option>
              <option value="policy">M23 policy decides</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="gw-goal">Active acquisition goal</label>
            <input id="gw-goal" value={controls.acquisitionGoal ?? ''} disabled={!admin} onChange={(e) => setControls({ ...controls, acquisitionGoal: e.target.value || null })} />
          </div>
        </div>
        <fieldset className="form-grid">
          <legend className="small">
            Per-channel daily quotas (capped by the aggression level: effective{' '}
            {Object.entries(s.effective.channelQuotas)
              .map(([k, v]) => `${txt(k)} ${v}`)
              .join(', ')}
            )
          </legend>
          {CHANNELS.map((ch) => (
            <div key={ch} className="field">
              <label htmlFor={`gw-q-${ch}`}>{txt(ch)}</label>
              <input id={`gw-q-${ch}`} type="number" min={0} max={50} value={controls.channelQuotas[ch] ?? 0} disabled={!admin} onChange={(e) => setControls({ ...controls, channelQuotas: { ...controls.channelQuotas, [ch]: Number(e.target.value) } })} />
            </div>
          ))}
        </fieldset>
        <div className="row">
          {flag('externalOperations', 'Allow external operations (M23 submissions, public tools)')}
          {flag('paidOperations', 'Allow paid proposals (still never created automatically)')}
        </div>
        {admin ? (
          <button type="button" className="btn primary" disabled={act.busy} onClick={() => act.run(() => api('PUT', '/v1/growth-warfare/settings', { expectedVersion: s.version, features, aggression, controls }))}>
            Save settings (version {s.version})
          </button>
        ) : (
          <p className="small muted">Only an owner or admin can change these settings.</p>
        )}
      </Section>
      {r.brandId && OPERATOR(me) ? (
        <Section title="Brand growth profile" hint="Keywords, competitor ids, market, channels, funnel stages (first-party event names), conversion events, landing URL and per-brand feature overrides.">
          <label className="sr-only" htmlFor="gw-profile">
            Brand profile JSON
          </label>
          <textarea id="gw-profile" rows={10} value={profile} onChange={(e) => setProfile(e.target.value)} />
          <button type="button" className="btn" disabled={act.busy} onClick={() => act.run(() => api('PUT', `/v1/growth-warfare/brands/${r.brandId}/config`, { expectedVersion: r.brandConfig?.version ?? 0, config: JSON.parse(profile) }))}>
            Save brand profile
          </button>
        </Section>
      ) : null}
    </div>
  );
}

function History() {
  const h = useApi<{ audit: { id: number; action: string; actorId: string; occurredAt: string }[]; actions: { id: string; action_type: string; status: string }[]; operations: { id: string; kind: string; status: string; startedAt: string; error: string | null }[] }>('/v1/growth-warfare/history');
  if (h.error) return <ErrorNotice error={h.error} />;
  if (!h.data) return <LoadingRows />;
  return (
    <div className="stack">
      <Section title="Audit trail" hint="Every Growth Warfare change, from the tamper-evident audit log.">
        <ul className="row-list">
          {h.data.audit.map((a) => (
            <li key={a.id} className="row-item small">
              {relativeTime(a.occurredAt)} — {a.action} by {a.actorId}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Execution gateway actions" hint="M23 actions behind Growth Warfare posts, with their verified status.">
        <ul className="row-list">
          {h.data.actions.map((a) => (
            <li key={a.id} className="row-item small">
              {a.action_type} <Badge value={a.status} />
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Background operations" hint="Scans, preparations and syncs with their durable state.">
        <ul className="row-list">
          {h.data.operations.map((o) => (
            <li key={o.id} className="row-item small">
              {relativeTime(o.startedAt)} — {o.kind} <Badge value={o.status} /> {o.error ? <span className="muted">{o.error}</span> : null}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
