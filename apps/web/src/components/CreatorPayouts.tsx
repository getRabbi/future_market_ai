import { useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { relativeTime } from '../lib/format.js';
import { EvidencePicker } from './Form.js';
import { Ico } from './Icons.js';
import { Badge, Drawer, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const PAYOUT_CALLS = [
  { method: 'GET', path: '/v1/creators/payouts/overview' },
  { method: 'GET', path: '/v1/creators/:id/payout-readiness' },
  { method: 'GET', path: '/v1/creators/:id/ledger' },
  { method: 'PUT', path: '/v1/creators/:id/payout-profile' },
  { method: 'POST', path: '/v1/creators/:id/payout' },
  { method: 'POST', path: '/v1/creators/payout-requests/:id/dispute' },
] as const;

interface Money {
  currency: string;
  amountMicros: number;
}
interface Balance {
  currency: string;
  accruedMicros: number;
  clawedBackMicros: number;
  paidMicros: number;
  payableMicros: number;
  inRefundWindowMicros: number;
}
interface CreatorRow {
  id: string;
  name: string;
  status: string;
  balance: Balance[];
  profile: { provider: string; receiver: string; kycStatus: string; taxForm: boolean; country: string | null; updatedAt: string } | null;
  openFraudFlags: number;
  readiness: { ready: boolean; failing: string[] };
  lastRequest: { id: string; status: string; createdAt: string } | null;
}
interface RequestRow {
  id: string;
  creatorId: string;
  creator: string | null;
  status: string;
  amounts: Money[];
  blockers: string[];
  actionId: string | null;
  providerBatchId: string | null;
  providerStatus: string | null;
  reconciledAt: string | null;
  dispute: { reason?: string } | null;
  createdAt: string;
}
interface Overview {
  execution: { enabled: boolean; blockerRef: string; legalApproved: boolean; provider: { id: string; displayName: string; status: string } | null; approval: string };
  creators: CreatorRow[];
  requests: RequestRow[];
  reconciliation: { awaitingProvider: number; paid: number; unreconciledPaid: number; note: string };
  payableAfterDays: number;
}

const FINANCE = ['owner', 'admin', 'finance_approver'];
const CHECK_LABELS: Record<string, string> = {
  payable_balance: 'Payable balance (after the refund window and clawbacks)',
  creator_active: 'Creator is active',
  contract: 'Signed creator contract with disclosure terms',
  destination: 'Payout destination recorded',
  identity: 'Identity verified (KYC evidence)',
  tax_form: 'Tax form on file',
  no_open_request: 'No other payout in progress',
  fraud_review: 'No open fraud flags',
  legal_approval: 'Counsel approved creator payouts',
  provider: 'Payout provider connected',
  execution_enabled: 'Payout execution enabled by a platform operator',
};

export const money = (micros: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(micros / 1e6);
  } catch {
    return `${(micros / 1e6).toFixed(2)} ${currency}`;
  }
};
const amounts = (list: { currency: string; micros: number }[]) => (list.length ? list.map((m) => money(m.micros, m.currency)).join(' + ') : '—');

/**
 * Channels › Creator payouts (P2-14): balances, readiness, requests, finance approval and
 * reconciliation. Execution stays off until legal and provider authorization; the screen states
 * exactly what is missing and never shows money as paid before the provider confirms it.
 */
export function CreatorPayouts({ me }: { me: Me }) {
  const overview = useApi<Overview>('/v1/creators/payouts/overview');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [disputing, setDisputing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const finance = me.roles.some((r) => FINANCE.includes(r));
  if (overview.error) return <ErrorNotice error={overview.error} />;
  if (!overview.data) return <LoadingRows label="Loading creator balances…" />;
  const o = overview.data;
  const totals = new Map<string, { payable: number; window: number }>();
  for (const c of o.creators)
    for (const b of c.balance) {
      const t = totals.get(b.currency) ?? { payable: 0, window: 0 };
      t.payable += b.payableMicros;
      t.window += b.inRefundWindowMicros;
      totals.set(b.currency, t);
    }
  const awaiting = o.requests.filter((r) => r.status === 'proposed').length;
  const dispute = async (id: string) => {
    setError(null);
    try {
      await api('POST', `/v1/creators/payout-requests/${id}/dispute`, { reason });
      setDisputing(null);
      setReason('');
      await overview.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="stack">
      {!o.execution.enabled ? (
        <section className="notice" role="status" aria-label="Payout execution status">
          <strong>Payouts are not active ({o.execution.blockerRef}).</strong>
          <div className="small">
            Requests are recorded with every reason they cannot be paid; no money moves. To activate: counsel reviews creator payouts (tax forms, KYC, country restrictions) and records it in <a href="/app/governance">Governance › Legal & licensing readiness</a>, a merchant agreement with the payout provider is signed,
            a PayPal Payouts connection is added in <a href="/app/connections">Connections</a>, and a platform operator enables payout execution. Every payout then still needs a finance approver with two-factor.
          </div>
          <ul className="small tight">
            <li>
              <Badge value={o.execution.legalApproved ? 'approved' : 'missing'} /> Counsel approval
            </li>
            <li>
              <Badge value={o.execution.provider ? 'connected' : 'missing'} /> Payout provider{o.execution.provider ? `: ${o.execution.provider.displayName}` : ''}
            </li>
            <li>
              <Badge value="disabled" /> Payout execution
            </li>
          </ul>
        </section>
      ) : null}

      <div className="glance-grid">
        <div className="glance-tile quiet">
          <span>
            <span className="glance-label">Creators</span>
            <span className="glance-value">{o.creators.length}</span>
          </span>
        </div>
        <div className="glance-tile quiet">
          <span>
            <span className="glance-label">Payable now</span>
            <span className="glance-value">{amounts([...totals].map(([currency, t]) => ({ currency, micros: t.payable })))}</span>
            <span className="glance-note">Per currency; never converted</span>
          </span>
        </div>
        <div className="glance-tile quiet">
          <span>
            <span className="glance-label">In the {o.payableAfterDays}-day refund window</span>
            <span className="glance-value">{amounts([...totals].map(([currency, t]) => ({ currency, micros: t.window })))}</span>
          </span>
        </div>
        <div className={`glance-tile ${awaiting ? 'warn' : 'quiet'}`}>
          <span>
            <span className="glance-label">Waiting for finance approval</span>
            <span className="glance-value">{awaiting}</span>
          </span>
        </div>
      </div>

      <section className="card" aria-labelledby="po-creators">
        <header className="card-head">
          <h2 className="card-title" id="po-creators">
            <Ico name="users" size={19} /> Creator balances
          </h2>
          <span className="small muted">Commission becomes payable {o.payableAfterDays} days after the order, net of refunds and earlier payouts.</span>
        </header>
        {o.creators.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Creator</th>
                  <th scope="col">Payable</th>
                  <th scope="col">In refund window</th>
                  <th scope="col">Paid</th>
                  <th scope="col">Destination</th>
                  <th scope="col">Readiness</th>
                  <th scope="col">Last request</th>
                </tr>
              </thead>
              <tbody>
                {o.creators.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Creator">
                      <button type="button" className="link-btn" onClick={() => setOpen(c.id)}>
                        {c.name}
                      </button>
                      {c.status !== 'active' ? <Badge value={c.status} /> : null}
                    </td>
                    <td data-label="Payable">{amounts(c.balance.map((b) => ({ currency: b.currency, micros: b.payableMicros })))}</td>
                    <td data-label="In refund window">{amounts(c.balance.map((b) => ({ currency: b.currency, micros: b.inRefundWindowMicros })))}</td>
                    <td data-label="Paid">{amounts(c.balance.filter((b) => b.paidMicros).map((b) => ({ currency: b.currency, micros: b.paidMicros })))}</td>
                    <td data-label="Destination">{c.profile ? `${c.profile.provider} ${c.profile.receiver} · KYC ${c.profile.kycStatus.replace('_', ' ')}` : <span className="muted">Not recorded</span>}</td>
                    <td data-label="Readiness">
                      {c.readiness.ready ? (
                        <Badge value="ready" />
                      ) : (
                        <span className="small">
                          {c.readiness.failing.length} condition{c.readiness.failing.length === 1 ? '' : 's'} missing
                        </span>
                      )}
                    </td>
                    <td data-label="Last request">{c.lastRequest ? <Badge value={c.lastRequest.status} /> : <span className="muted">None</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No creators yet"
            action={
              <a className="btn" href="/app/creators">
                Open Creators & referrals
              </a>
            }
          >
            Add creators and their contracts in Creators & referrals; commissions from tracked orders appear here.
          </EmptyState>
        )}
      </section>

      <section className="card" aria-labelledby="po-requests">
        <header className="card-head">
          <h2 className="card-title" id="po-requests">
            Payout requests and reconciliation
          </h2>
          <span className="small muted">
            {o.reconciliation.paid} paid · {o.reconciliation.awaitingProvider} with the provider · {awaiting} awaiting approval
          </span>
        </header>
        <p className="small muted">
          {o.execution.approval} {o.reconciliation.note}
        </p>
        <ErrorNotice error={error} />
        {o.requests.length ? (
          <ul className="row-list">
            {o.requests.map((r) => (
              <li key={r.id} className="row-item">
                <div className="row">
                  <div>
                    <strong>{r.creator ?? 'Creator'}</strong>{' '}
                    <span className="small muted">
                      · {amounts(r.amounts.map((a) => ({ currency: a.currency, micros: a.amountMicros })))} · requested {relativeTime(r.createdAt)}
                    </span>
                    {r.blockers.length ? (
                      <details className="small">
                        <summary>Why it was not paid ({r.blockers.length})</summary>
                        <ul className="tight">
                          {r.blockers.map((b) => (
                            <li key={b}>{CHECK_LABELS[b.split(':')[0]!] ? `${CHECK_LABELS[b.split(':')[0]!]}: ${b.slice(b.indexOf(':') + 1).trim()}` : b}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {r.providerBatchId ? (
                      <div className="small">
                        Provider batch {r.providerBatchId}: {r.providerStatus ?? 'unknown'}
                        {r.reconciledAt ? ` · reconciled ${relativeTime(r.reconciledAt)}` : ''}
                      </div>
                    ) : r.providerStatus ? (
                      <div className="small muted">{r.providerStatus}</div>
                    ) : null}
                    {r.dispute?.reason ? <div className="small">Dispute: {r.dispute.reason}</div> : null}
                    {disputing === r.id ? (
                      <div className="inline-form compact">
                        <label className="sr-only" htmlFor={`dispute-${r.id}`}>
                          Dispute reason
                        </label>
                        <input id={`dispute-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is disputed and by whom" />
                        <button type="button" className="small-btn" disabled={reason.trim().length < 5} onClick={() => void dispute(r.id)}>
                          Record dispute
                        </button>
                        <button type="button" className="small-btn" onClick={() => setDisputing(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    <Badge value={r.status} />
                    {r.actionId ? (
                      <a className="small-btn" href={`/app/approvals?id=${r.actionId}`}>
                        Approval
                      </a>
                    ) : null}
                    {finance && r.status !== 'disputed' && r.status !== 'blocked' && disputing !== r.id ? (
                      <button type="button" className="small-btn" onClick={() => setDisputing(r.id)}>
                        Dispute
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No payout has been requested yet.</p>
        )}
      </section>

      {open ? <CreatorDrawer id={open} me={me} finance={finance} row={o.creators.find((c) => c.id === open)!} onClose={() => setOpen(null)} onChanged={() => void overview.reload()} /> : null}
    </div>
  );
}

function CreatorDrawer({ id, me, finance, row, onClose, onChanged }: { id: string; me: Me; finance: boolean; row: CreatorRow; onClose: () => void; onChanged: () => void }) {
  const readiness = useApi<{ payable: Money[]; checks: { key: string; ok: boolean; detail: string }[] }>(`/v1/creators/${id}/payout-readiness`);
  const ledger = useApi<{ id: string; kind: string; amountMicros: number; currency: string; ref: string; createdAt: string }[]>(`/v1/creators/${id}/ledger`);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);
  const [receiver, setReceiver] = useState('');
  const [kyc, setKyc] = useState(row.profile?.kycStatus ?? 'not_started');
  const [kycEvidence, setKycEvidence] = useState('');
  const [taxEvidence, setTaxEvidence] = useState('');
  const [country, setCountry] = useState(row.profile?.country ?? '');
  const saveProfile = async () => {
    setError(null);
    setResult(null);
    try {
      await api('PUT', `/v1/creators/${id}/payout-profile`, { provider: 'paypal', receiver, kycStatus: kyc, kycEvidenceId: kycEvidence || null, taxFormEvidenceId: taxEvidence || null, country: country ? country.toUpperCase() : null });
      setReceiver('');
      setResult('Payout details saved. The destination is stored only for payout execution and is never shown in full.');
      onChanged();
      await readiness.reload();
    } catch (e) {
      setError(e);
    }
  };
  const request = async () => {
    setError(null);
    setResult(null);
    try {
      const r = await api<{ request: { status: string; blockers: string[] }; action: { id: string } | null }>('POST', `/v1/creators/${id}/payout`);
      setResult(r.request.status === 'blocked' ? `Recorded as blocked: ${r.request.blockers.length} condition(s) are missing. Nothing was paid.` : 'Proposed for finance approval. It is paid only after approval and the provider’s confirmation.');
      onChanged();
      await readiness.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Drawer title={row.name} onClose={onClose}>
      <div className="stack">
        <section aria-labelledby="cd-balance">
          <h3 id="cd-balance">Balance</h3>
          {row.balance.length ? (
            <div className="kv">
              {row.balance.map((b) => (
                <div key={b.currency} className="kv-row">
                  <span>{b.currency}</span>
                  <strong>
                    {money(b.payableMicros, b.currency)} payable · {money(b.inRefundWindowMicros, b.currency)} in refund window · {money(b.accruedMicros, b.currency)} earned · {money(b.clawedBackMicros, b.currency)} clawed back · {money(b.paidMicros, b.currency)} paid
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="small muted">No commission recorded yet.</p>
          )}
        </section>
        <section aria-labelledby="cd-ready">
          <h3 id="cd-ready">Payout readiness</h3>
          {readiness.error ? <ErrorNotice error={readiness.error} /> : null}
          {!readiness.data ? (
            <LoadingRows />
          ) : (
            <ul className="ap-checks">
              {readiness.data.checks.map((c) => (
                <li key={c.key} className="ap-check">
                  <Badge value={c.ok ? 'ok' : 'missing'} /> <strong>{CHECK_LABELS[c.key] ?? c.key}</strong>
                  <span className="small muted"> — {c.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <ErrorNotice error={error} />
        {result ? (
          <p className="notice small" role="status">
            {result}
          </p>
        ) : null}
        {finance ? (
          <>
            <section aria-labelledby="cd-profile">
              <h3 id="cd-profile">Payout details</h3>
              {!me.mfaVerified ? <p className="notice small">Recording payout details needs a two-factor session. Turn on two-factor in Organization & Team, then sign in again.</p> : null}
              <p className="small muted">Current: {row.profile ? `${row.profile.provider} ${row.profile.receiver}, KYC ${row.profile.kycStatus.replace('_', ' ')}, tax form ${row.profile.taxForm ? 'on file' : 'missing'}` : 'none'}. KYC and tax forms are referenced as evidence records.</p>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="cd-recv">PayPal receiver email</label>
                  <input id="cd-recv" type="email" autoComplete="off" value={receiver} onChange={(e) => setReceiver(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="cd-kyc">Identity (KYC)</label>
                  <select id="cd-kyc" value={kyc} onChange={(e) => setKyc(e.target.value)}>
                    {['not_started', 'pending', 'verified', 'rejected'].map((k) => (
                      <option key={k} value={k}>
                        {k.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="cd-country">Country (ISO code)</label>
                  <input id="cd-country" value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
                </div>
              </div>
              <fieldset className="stack-xs">
                <legend className="small">Identity (KYC) evidence {kyc === 'verified' ? '(required when verified)' : '(optional)'}</legend>
                <EvidencePicker id="cd-kycev" field={{ label: 'KYC evidence', multiple: false }} value={kycEvidence} onChange={(v) => setKycEvidence(String(v ?? ''))} />
              </fieldset>
              <fieldset className="stack-xs">
                <legend className="small">Tax form evidence</legend>
                <EvidencePicker id="cd-tax" field={{ label: 'Tax form evidence', multiple: false }} value={taxEvidence} onChange={(v) => setTaxEvidence(String(v ?? ''))} />
              </fieldset>
              <button type="button" className="btn" disabled={!receiver || !me.mfaVerified || (kyc === 'verified' && !kycEvidence)} onClick={() => void saveProfile()}>
                Save payout details
              </button>
            </section>
            <section aria-labelledby="cd-request">
              <h3 id="cd-request">Request a payout</h3>
              <p className="small muted">The request records today’s readiness. With anything missing it is stored as blocked and nothing is proposed; otherwise it goes to a finance approver (not you).</p>
              <button type="button" className="btn" onClick={() => void request()}>
                Request payout
              </button>
            </section>
          </>
        ) : (
          <p className="small muted">Only an owner, admin or finance approver can record payout details or request payouts.</p>
        )}
        <section aria-labelledby="cd-ledger">
          <h3 id="cd-ledger">Ledger</h3>
          {ledger.error ? <ErrorNotice error={ledger.error} /> : null}
          {!ledger.data ? (
            <LoadingRows />
          ) : ledger.data.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Entry</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data.map((l) => (
                    <tr key={l.id}>
                      <td data-label="When">{relativeTime(l.createdAt)}</td>
                      <td data-label="Entry">{l.kind}</td>
                      <td data-label="Amount">{money(l.amountMicros, l.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">No ledger entries.</p>
          )}
        </section>
      </div>
    </Drawer>
  );
}
