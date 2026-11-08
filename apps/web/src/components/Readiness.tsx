import { useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { Badge, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call these screens make (checked against the API's routes in catalog.test.ts). */
export const READINESS_CALLS = [
  { method: 'GET', path: '/v1/governance/compliance' },
  { method: 'PUT', path: '/v1/governance/compliance/:key' },
  { method: 'GET', path: '/v1/competitors/research' },
  { method: 'POST', path: '/v1/competitors/research/targets' },
  { method: 'POST', path: '/v1/competitors/research/targets/:id/revoke' },
  { method: 'POST', path: '/v1/competitors/research/jobs' },
  { method: 'POST', path: '/v1/competitors/research/jobs/:id/approve' },
  { method: 'POST', path: '/v1/competitors/research/jobs/:id/terminate' },
] as const;

interface Item {
  key: string;
  title: string;
  area: string;
  question: string;
  gates: string[];
  enforcedBy: string[];
  status: string;
  reviewerName: string | null;
  reviewerRole: string | null;
  reviewedAt: string | null;
  documentRef: string | null;
  expiresAt: string | null;
}

/**
 * Legal, policy and licensing readiness (P2-15): what counsel or the owner has reviewed, what each
 * review unlocks and where FUTUREGROW enforces it. Approving records the reviewer, the document
 * and its evidence; it needs owner or legal approver with two-factor.
 */
export function ComplianceChecklist({ me }: { me: Me }) {
  const list = useApi<{ items: Item[]; approved: number; total: number; note: string }>('/v1/governance/compliance');
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ reviewerName: '', reviewerRole: 'external_counsel', reviewedAt: '', documentRef: '', evidenceId: '', contentSha256: '' });
  const [error, setError] = useState<unknown>(null);
  const canReview = me.roles.some((r) => r === 'owner' || r === 'legal_approver');
  const save = async (key: string) => {
    setError(null);
    try {
      await api('PUT', `/v1/governance/compliance/${key}`, { status: 'approved', ...form });
      setOpen(null);
      await list.reload();
    } catch (e) {
      setError(e);
    }
  };
  if (!list.data) return <LoadingRows label="Loading legal readiness…" />;
  return (
    <section className="card" aria-labelledby="compliance-title">
      <header className="card-head">
        <h2 className="card-title" id="compliance-title">
          Legal & licensing readiness
        </h2>
        <span className="small muted">
          {list.data.approved} of {list.data.total} approved
        </span>
      </header>
      <p className="small muted">{list.data.note}</p>
      <ErrorNotice error={error ?? list.error} />
      <ul className="row-list">
        {list.data.items.map((i) => (
          <li key={i.key} className="row-item">
            <div className="row">
              <div>
                <strong>{i.title}</strong>
                <div className="small">{i.question}</div>
                <div className="small muted">
                  Gates: {i.gates.join('; ')}. Enforced by: {i.enforcedBy.join('; ')}.
                </div>
                {i.reviewerName ? (
                  <div className="small">
                    Reviewed by {i.reviewerName} ({i.reviewerRole?.replaceAll('_', ' ')}) on {i.reviewedAt?.slice(0, 10)}, {i.documentRef}; expires {i.expiresAt?.slice(0, 10)}.
                  </div>
                ) : null}
              </div>
              <div className="row-actions">
                <Badge value={i.status} />
                {canReview ? (
                  <button type="button" className="small-btn" onClick={() => setOpen(open === i.key ? null : i.key)}>
                    {open === i.key ? 'Close' : 'Record review'}
                  </button>
                ) : null}
              </div>
            </div>
            {open === i.key ? (
              <div className="form-grid">
                {(
                  [
                    ['reviewerName', 'Reviewer'],
                    ['reviewedAt', 'Review date (YYYY-MM-DD)'],
                    ['documentRef', 'Document reference'],
                    ['evidenceId', 'Evidence id of the review document'],
                    ['contentSha256', 'SHA-256 of the reviewed document'],
                  ] as const
                ).map(([k, label]) => (
                  <div className="field" key={k}>
                    <label htmlFor={`cr-${i.key}-${k}`}>{label}</label>
                    <input id={`cr-${i.key}-${k}`} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                  </div>
                ))}
                <div className="field">
                  <label htmlFor={`cr-${i.key}-role`}>Reviewer role</label>
                  <select id={`cr-${i.key}-role`} value={form.reviewerRole} onChange={(e) => setForm({ ...form, reviewerRole: e.target.value })}>
                    <option value="external_counsel">External counsel</option>
                    <option value="in_house_counsel">In-house counsel</option>
                    <option value="licensor_confirmation">Licensor confirmation</option>
                    <option value="owner">Owner</option>
                  </select>
                </div>
                <button type="button" className="btn primary" onClick={() => void save(i.key)}>
                  Approve
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Research {
  runner: { id: string; isolation: string; ok: boolean; reason: string };
  hardLimits: { cpuSeconds: number; memoryMb: number; wallSeconds: number; outputMb: number };
  targets: { id: string; kind: string; value: string; description: string; ownership: string; status: string; expiresAt: string }[];
  jobs: { id: string; artifactRef: string; purpose: string | null; status: string; statusReason: string | null; createdAt: string }[];
}

/**
 * Authorized research sandbox (P3-09): allowlisted targets, job requests with hard limits and a
 * second legal approval. Jobs run only on a microVM-class isolated runner; this deployment has
 * none (B-012), which the panel states.
 */
export function ResearchSandbox({ me }: { me: Me }) {
  const data = useApi<Research>('/v1/competitors/research');
  const [error, setError] = useState<unknown>(null);
  const [purpose, setPurpose] = useState('');
  const [targetId, setTargetId] = useState('');
  const isLegal = me.roles.some((r) => r === 'owner' || r === 'legal_approver');
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await data.reload();
    } catch (e) {
      setError(e);
    }
  };
  if (!data.data) return <LoadingRows label="Loading research sandbox…" />;
  const d = data.data;
  return (
    <section className="card" aria-labelledby="research-title">
      <header className="card-head">
        <h2 className="card-title" id="research-title">
          Authorized research sandbox
        </h2>
        <Badge value={d.runner.ok ? 'ready' : 'disabled'} />
      </header>
      <p className="small">{d.runner.ok ? `Runner ${d.runner.id} (${d.runner.isolation}).` : d.runner.reason}</p>
      <p className="small muted">
        Only targets you own, license for analysis or have written authorization for. Limits: {d.hardLimits.cpuSeconds}s CPU, {d.hardLimits.memoryMb} MB memory, {d.hardLimits.wallSeconds}s, network off unless the target allows specific hosts, no credentials.
      </p>
      <ErrorNotice error={error ?? data.error} />
      <h3 className="small">Allowlisted targets</h3>
      <ul className="row-list">
        {d.targets.map((t) => (
          <li key={t.id} className="row-item row">
            <span className="small">
              {t.kind}: <code>{t.value}</code> — {t.description} ({t.ownership.replaceAll('_', ' ')}, until {t.expiresAt.slice(0, 10)})
            </span>
            <span className="row-actions">
              <Badge value={t.status} />
              {isLegal && t.status === 'active' ? (
                <button type="button" className="small-btn" onClick={() => void act(() => api('POST', `/v1/competitors/research/targets/${t.id}/revoke`))}>
                  Revoke
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {d.targets.some((t) => t.status === 'active') ? (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="rs-target">Target</label>
            <select id="rs-target" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">Choose</option>
              {d.targets
                .filter((t) => t.status === 'active')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.value}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="rs-purpose">Purpose</label>
            <input id="rs-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </div>
          <button type="button" className="btn" disabled={!targetId || purpose.length < 20} onClick={() => void act(() => api('POST', '/v1/competitors/research/jobs', { targetId, purpose, limits: { cpuSeconds: 120, memoryMb: 512, wallSeconds: 300 } }))}>
            Request job
          </button>
        </div>
      ) : null}
      <h3 className="small">Jobs</h3>
      <ul className="row-list">
        {d.jobs.map((j) => (
          <li key={j.id} className="row-item">
            <div className="row">
              <span className="small">
                <code>{j.artifactRef}</code> — {j.purpose ?? 'legacy registration'} · {relativeTime(j.createdAt)}
                {j.statusReason ? <div className="muted">{j.statusReason}</div> : null}
              </span>
              <span className="row-actions">
                <Badge value={j.status} />
                {isLegal && j.status === 'pending_approval' ? (
                  <button type="button" className="small-btn" onClick={() => void act(() => api('POST', `/v1/competitors/research/jobs/${j.id}/approve`))}>
                    Approve
                  </button>
                ) : null}
                {['pending_approval', 'approved', 'running'].includes(j.status) ? (
                  <button type="button" className="small-btn" onClick={() => void act(() => api('POST', `/v1/competitors/research/jobs/${j.id}/terminate`, { reason: 'stopped from the control plane' }))}>
                    Terminate
                  </button>
                ) : null}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
