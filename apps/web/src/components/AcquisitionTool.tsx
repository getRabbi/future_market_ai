import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { ErrorNotice, LoadingRows } from './ui.js';

/** Public calls of the acquisition-tool page (no sign-in; checked in catalog.test.ts). */
export const ACQUISITION_TOOL_CALLS = [
  { method: 'GET', path: '/v1/public/tools/:publicId' },
  { method: 'POST', path: '/v1/public/tools/:publicId/evaluate' },
  { method: 'POST', path: '/v1/public/tools/:publicId/events' },
  { method: 'POST', path: '/v1/public/tools/:publicId/lead' },
] as const;

interface View {
  id: string;
  template: string;
  title: string;
  brand: string | null;
  methodology: string;
  dataUpdatedAt: string | null;
  definition: Record<string, any>;
  cta: { label: string; url: string | null };
  consent: { leadCapture: boolean; text: string };
  variant: string | null;
}

const ANON_KEY = 'fg.tool.anon';
const CONSENT_KEY = 'fg.tool.analytics';

function anonId(): string {
  try {
    const v = localStorage.getItem(ANON_KEY);
    if (v) return v;
    const n = `t${crypto.randomUUID().replaceAll('-', '')}`;
    localStorage.setItem(ANON_KEY, n);
    return n;
  } catch {
    return `t${crypto.randomUUID().replaceAll('-', '')}`;
  }
}

function utm(): Record<string, string> {
  const p = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'content']) {
    const v = p.get(`utm_${k}`);
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}

const LABELS: Record<string, string> = {
  zone: 'Delivery zone',
  weightKg: 'Parcel weight (kg)',
  codAmount: 'Cash-on-delivery amount',
  orders: 'Orders',
  avgCodAmount: 'Average COD amount',
  deliveryFee: 'Delivery fee per order',
  codFeePct: 'COD fee (%)',
  returnRatePct: 'Return rate (%)',
  returnFee: 'Return fee per order',
  alreadyReceived: 'Already received',
  sellingPrice: 'Selling price',
  unitCost: 'Product cost',
  shipping: 'Shipping per order',
  packaging: 'Packaging per order',
  platformFeePct: 'Platform fee (%)',
  paymentFeePct: 'Payment fee (%)',
  adSpendPerOrder: 'Ad spend per order',
  returnCost: 'Cost per return',
};

/**
 * A published acquisition tool (F4, D-054). Calculations run on the server from the tool's
 * sourced data and the visitor's own inputs. Analytics events are sent only if the visitor allows
 * them; contact details only with the explicit consent box ticked.
 */
export function AcquisitionTool() {
  const id = typeof window !== 'undefined' ? (new URLSearchParams(window.location.search).get('id') ?? '') : '';
  const anon = useMemo(() => (typeof window !== 'undefined' ? anonId() : ''), []);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [analytics, setAnalytics] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(CONSENT_KEY);
      return v === null ? null : v === 'yes';
    } catch {
      return null;
    }
  });
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [lead, setLead] = useState<string | null>(null);

  useEffect(() => {
    if (!/^[a-z0-9]{12,40}$/.test(id)) {
      setError(new Error('This tool link is not valid.'));
      return;
    }
    api<View>('GET', `/v1/public/tools/${id}?anon=${anon}`).then(setView, setError);
  }, [id, anon]);
  useEffect(() => {
    if (view && analytics) void api('POST', `/v1/public/tools/${id}/events`, { anonymousId: anon, analyticsConsent: true, event: 'viewed', utm: utm() }).catch(() => {});
  }, [view, analytics, id, anon]);

  if (error) return <ErrorNotice error={error} />;
  if (!view) return <LoadingRows label="Loading tool…" />;
  const d = view.definition;
  const quiz = Array.isArray(d.questions) && d.questions.length && typeof d.questions[0].prompt === 'string';
  const readiness = Array.isArray(d.questions) && !quiz;
  const chooseAnalytics = (v: boolean) => {
    setAnalytics(v);
    try {
      localStorage.setItem(CONSENT_KEY, v ? 'yes' : 'no');
    } catch {
      /* not stored */
    }
  };
  const evaluate = async () => {
    setError(null);
    try {
      const r = await api<{ result: Record<string, any> }>('POST', `/v1/public/tools/${id}/evaluate`, { anonymousId: anon, analyticsConsent: analytics === true, utm: utm(), inputs: quiz || readiness ? { answers } : inputs });
      setResult(r.result);
    } catch (err) {
      setError(err);
    }
  };
  const submitLead = async () => {
    try {
      const r = await api<{ duplicate: boolean }>('POST', `/v1/public/tools/${id}/lead`, { anonymousId: anon, email, marketingConsent: true, consentText: view.consent.text, utm: utm() });
      setLead(r.duplicate ? 'You are already signed up.' : 'Thanks — you are signed up. You can unsubscribe at any time.');
    } catch (err) {
      setError(err);
    }
  };
  return (
    <main className="tool-page stack">
      <header className="stack-xs">
        <p className="small muted">{view.brand}</p>
        <h1>{view.title}</h1>
      </header>
      {analytics === null ? (
        <section className="notice small">
          May we count how this tool is used (no contact details)?{' '}
          <button type="button" className="small-btn" onClick={() => chooseAnalytics(true)}>
            Yes
          </button>{' '}
          <button type="button" className="small-btn" onClick={() => chooseAnalytics(false)}>
            No
          </button>
        </section>
      ) : null}
      <section className="card stack">
        {quiz || readiness ? (
          (d.questions as { id: string; prompt?: string; text?: string; options: string[] }[]).map((q) => (
            <fieldset key={q.id} className="stack-xs">
              <legend>{q.prompt ?? q.text}</legend>
              {q.options.map((o, i) => (
                <label key={o} className="small">
                  <input type="radio" name={q.id} checked={answers[q.id] === i} onChange={() => setAnswers({ ...answers, [q.id]: i })} /> {o}
                </label>
              ))}
            </fieldset>
          ))
        ) : (
          <div className="form-grid">
            {(d.inputs as string[]).map((k) =>
              k === 'zone' ? (
                <div key={k} className="field">
                  <label htmlFor={`in-${k}`}>{LABELS[k]}</label>
                  <select id={`in-${k}`} value={String(inputs[k] ?? '')} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })}>
                    <option value="">Choose…</option>
                    {(d.zones as string[]).map((z) => (
                      <option key={z} value={z}>
                        {z.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div key={k} className="field">
                  <label htmlFor={`in-${k}`}>{LABELS[k] ?? k}</label>
                  <input id={`in-${k}`} type="number" min={0} step="any" value={String(inputs[k] ?? '')} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} />
                </div>
              ),
            )}
          </div>
        )}
        <button type="button" className="btn primary" onClick={evaluate}>
          Calculate
        </button>
      </section>
      {result ? (
        <section className="card stack" aria-live="polite">
          <h2>Result</h2>
          {Array.isArray(result.couriers) ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Courier</th>
                    <th scope="col">Delivery</th>
                    <th scope="col">COD fee</th>
                    <th scope="col">Total</th>
                    <th scope="col">Rate card</th>
                  </tr>
                </thead>
                <tbody>
                  {(result.couriers as { courier: string; deliveryFee: number | null; codFee: number | null; total: number | null; source: string; verifiedAt: string; missing: string[] }[]).map((c) => (
                    <tr key={c.courier}>
                      <td>{c.courier}</td>
                      <td>{c.deliveryFee ?? 'not published'}</td>
                      <td>{c.codFee ?? (c.missing.length ? 'not published' : '—')}</td>
                      <td>{c.total ?? '—'}</td>
                      <td className="small">
                        <a href={c.source} rel="noreferrer nofollow" target="_blank">
                          source
                        </a>{' '}
                        (checked {c.verifiedAt})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="kv">
              {Object.entries(result)
                .filter(([k, v]) => k !== 'graded' && typeof v !== 'object')
                .map(([k, v]) => (
                  <li key={k} className="kv-row">
                    <span>{LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span> <strong>{String(v)}</strong>
                  </li>
                ))}
            </ul>
          )}
          {result.note ? <p className="small muted">{String(result.note)}</p> : null}
          {view.cta.url ? (
            <a className="btn" href={view.cta.url} onClick={() => (analytics ? void api('POST', `/v1/public/tools/${id}/events`, { anonymousId: anon, analyticsConsent: true, event: 'cta_clicked', utm: utm() }).catch(() => {}) : undefined)}>
              {view.cta.label}
            </a>
          ) : null}
        </section>
      ) : null}
      {view.consent.leadCapture ? (
        <section className="card stack">
          <div className="field">
            <label htmlFor="lead-email">E-mail</label>
            <input id="lead-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <label className="small">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> {view.consent.text}
          </label>
          <button type="button" className="btn" disabled={!agreed || !email} onClick={submitLead}>
            Sign up
          </button>
          {lead ? <p className="small">{lead}</p> : null}
        </section>
      ) : null}
      <footer className="small muted stack-xs">
        <p>How it works: {view.methodology}</p>
        {view.dataUpdatedAt ? <p>Data last updated {view.dataUpdatedAt.slice(0, 10)}.</p> : null}
      </footer>
    </main>
  );
}
