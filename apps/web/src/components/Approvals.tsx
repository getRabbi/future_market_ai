import { useState } from 'react';
import { api } from '../lib/api.js';
import { formatValue, shortId, statusLabel } from '../lib/format.js';
import { ReadableRecord } from './Form.js';
import { Badge, DataTable, Drawer, ErrorNotice, LoadingRows, useApi } from './ui.js';

const TABS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'review', label: 'Needs approval', statuses: ['APPROVAL_REQUIRED'] },
  { key: 'flight', label: 'In flight', statuses: ['PROPOSED', 'EVIDENCE_READY', 'POLICY_CHECKED', 'APPROVED', 'PREFLIGHT_VERIFIED', 'EXECUTING', 'EXECUTED_UNVERIFIED'] },
  { key: 'attention', label: 'Escalated', statuses: ['ESCALATED', 'ROLLBACK_REQUIRED'] },
  { key: 'verified', label: 'Verified', statuses: ['VERIFIED', 'ROLLED_BACK'] },
  { key: 'stopped', label: 'Failed / denied', statuses: ['FAILED', 'DENIED', 'REJECTED', 'CANCELLED'] },
];

interface ActionView {
  id: string;
  actionType: string;
  status: string;
  statusReason: string | null;
  actionHash: string;
  params: Record<string, unknown>;
  risk: Record<string, unknown>;
  target: Record<string, unknown>;
  evidenceIds: string[];
  proposedBy: { type: string; id: string; modelId: string | null };
  policyDecision: { outcome: string; policyVersion: string; reasons: { rule: string; code: string; message: string; effect: string }[]; approvalGroups?: { name: string; anyOfRoles: string[] }[] } | null;
  createdAt: string;
}

interface Detail {
  action: ActionView;
  transitions: { fromStatus: string | null; toStatus: string; reason: string; actor: string; at: string }[];
  approvals: { approverUserId: string; decision: string; comment: string | null; decidedAt: string; approverRoles: string[] }[];
  executions: { attempt: number; outcome: string; providerObjectId: string | null; receiptSha256: string | null; error: unknown; startedAt: string; finishedAt: string | null }[];
  proofs: { verdict: string; method: string; purpose: string; diff: unknown; notes: string | null; checkedAt: string }[];
  terminal: boolean;
}

export function Approvals({ initialId }: { initialId?: string | null }) {
  const [tab, setTab] = useState(TABS[0]!);
  const list = useApi<ActionView[]>(`/v1/actions?status=${tab.statuses.join(',')}&limit=200`);
  const [open, setOpen] = useState<string | null>(initialId ?? null);
  return (
    <>
      <div className="row tabs" role="tablist" aria-label="Action status">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === tab.key} className={t.key === tab.key ? 'primary' : undefined} onClick={() => setTab(t)}>
            {t.label}
          </button>
        ))}
        <button type="button" className="ghost" onClick={() => void list.reload()}>
          Refresh
        </button>
      </div>
      <ErrorNotice error={list.error} />
      <section className="card">
        <DataTable
          rows={(list.data ?? []).map((a) => ({ ...a, proposer: `${a.proposedBy.type}:${shortId(a.proposedBy.id)}`, outcome: a.policyDecision?.outcome ?? null }))}
          columns={['actionType', 'status', 'outcome', 'statusReason', 'proposer', 'createdAt']}
          onRowClick={(r) => setOpen(String(r.id))}
          loading={list.loading}
          empty="No actions in this state."
        />
      </section>
      {open ? (
        <ActionDetail
          id={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            void list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function ActionDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const d = useApi<Detail>(`/v1/actions/${id}`);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const a = d.data?.action;

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!a) return;
    setBusy(true);
    setError(null);
    try {
      // The approval binds to the hash the reviewer saw (D-020); a changed payload invalidates it.
      await api('POST', `/v1/actions/${a.id}/decision`, { decision, expectedActionHash: a.actionHash, ...(comment.trim() ? { comment: comment.trim() } : {}) });
      await d.reload();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!a) return;
    const reason = comment.trim();
    if (reason.length < 3) return setError(new Error('Enter a reason (at least 3 characters) in the comment box to cancel.'));
    setBusy(true);
    try {
      await api('POST', `/v1/actions/${a.id}/cancel`, { reason });
      await d.reload();
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={a ? a.actionType : 'Action'} onClose={onClose}>
      <ErrorNotice error={d.error ?? error} />
      {a && d.data ? (
        <div className="stack">
          <div className="row">
            <Badge value={a.status} />
            <span className="small muted">
              proposed by {a.proposedBy.type}:{a.proposedBy.id}
              {a.proposedBy.modelId ? ` (${a.proposedBy.modelId})` : ''} · {formatValue('createdAt', a.createdAt)}
            </span>
          </div>
          {a.statusReason ? <p className="small">{a.statusReason}</p> : null}

          {a.policyDecision ? (
            <section>
              <h3>
                Policy {a.policyDecision.policyVersion}: <Badge value={a.policyDecision.outcome} />
              </h3>
              <ul className="small">
                {a.policyDecision.reasons.map((r) => (
                  <li key={`${r.rule}:${r.code}:${r.effect}`}>
                    <Badge value={r.effect === 'DENY' ? 'DENIED' : r.effect === 'REQUIRE_APPROVAL' ? 'APPROVAL_REQUIRED' : 'ok'} /> <code>{r.rule}</code> {r.code}: {r.message}
                  </li>
                ))}
              </ul>
              {a.policyDecision.approvalGroups?.length ? <p className="small muted">Approval groups: {a.policyDecision.approvalGroups.map((g) => `${g.name} (${g.anyOfRoles.join(' / ')})`).join(' + ')}. Each group needs a different person; the proposer cannot approve.</p> : null}
            </section>
          ) : null}

          <section>
            <h3>What will happen</h3>
            <ReadableRecord value={{ params: a.params, target: a.target, risk: a.risk, evidenceIds: a.evidenceIds }} />
            <p className="small muted mono">action hash {a.actionHash}</p>
          </section>

          {a.status === 'APPROVAL_REQUIRED' || (!d.data.terminal && ['PROPOSED', 'EVIDENCE_READY', 'POLICY_CHECKED', 'APPROVED'].includes(a.status)) ? (
            <section className="card">
              <div className="field">
                <label htmlFor="decision-comment">Comment / cancellation reason</label>
                <input id="decision-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
              </div>
              <div className="row">
                {a.status === 'APPROVAL_REQUIRED' ? (
                  <>
                    <button type="button" className="primary" disabled={busy} onClick={() => void decide('approved')}>
                      Approve exactly this action
                    </button>
                    <button type="button" className="danger" disabled={busy} onClick={() => void decide('rejected')}>
                      Reject
                    </button>
                  </>
                ) : null}
                <button type="button" disabled={busy} onClick={() => void cancel()}>
                  Cancel action
                </button>
              </div>
            </section>
          ) : null}

          <section>
            <h3>Approvals</h3>
            {d.data.approvals.length === 0 ? (
              <p className="small muted">None yet.</p>
            ) : (
              <ul className="small">
                {d.data.approvals.map((x) => (
                  <li key={`${x.approverUserId}:${x.decidedAt}`}>
                    <Badge value={x.decision} /> {x.approverUserId} ({x.approverRoles.join(', ')}) · {formatValue('decidedAt', x.decidedAt)}
                    {x.comment ? ` — ${x.comment}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>Executions & proofs</h3>
            {d.data.executions.map((x) => (
              <p key={x.attempt} className="small">
                Attempt {x.attempt}: <Badge value={x.outcome} /> {x.providerObjectId ? <code>{x.providerObjectId}</code> : null}
                {x.receiptSha256 ? <span className="muted mono"> receipt {x.receiptSha256.slice(0, 16)}…</span> : null}
              </p>
            ))}
            {d.data.proofs.map((p) => (
              <div key={`${p.purpose}:${p.checkedAt}:${p.verdict}`} className="small">
                <Badge value={p.verdict} /> {p.purpose} via {p.method} · {formatValue('checkedAt', p.checkedAt)} {p.notes ? `— ${p.notes}` : ''}
                {Array.isArray(p.diff) && p.diff.length ? <ReadableRecord value={p.diff} depth={1} /> : null}
              </div>
            ))}
            {d.data.executions.length === 0 ? <p className="small muted">Not executed.</p> : null}
          </section>

          <section>
            <h3>State history</h3>
            <ol className="timeline small">
              {d.data.transitions.map((t) => (
                <li key={`${t.at}:${t.toStatus}`}>
                  <strong>{statusLabel(t.toStatus)}</strong>{' '}
                  <span className="muted">
                    · {formatValue('at', t.at)} · {t.actor}
                  </span>
                  <div>{t.reason}</div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : (
        <LoadingRows />
      )}
    </Drawer>
  );
}
