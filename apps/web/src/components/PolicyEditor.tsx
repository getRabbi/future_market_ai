import { useState } from 'react';
import { api } from '../lib/api.js';
import { ROLE_OPTIONS } from '../lib/fieldsets.js';
import { opts, type Row } from '../lib/forms.js';
import { Notice } from './Form.js';
import { useJourney } from './Journey.js';
import { Badge, ErrorNotice, LoadingRows, useApi } from './ui.js';

const CATEGORIES: [string, string, string][] = [
  ['SPEND', 'Ad spend changes', 'Budgets and bids on ad accounts'],
  ['PRICING', 'Prices and discounts', 'Offers, discount codes and price changes'],
  ['PUBLIC_PUBLISHING', 'Public posts', 'Anything published on social channels'],
  ['MESSAGING', 'Messages to customers', 'Emails and other lifecycle messages'],
  ['TARGETING', 'Ad audiences', 'Customer lists and targeting sent to ad platforms'],
  ['EXPERIMENT', 'Starting experiments', 'Tests shown to real customers'],
  ['STORE_METADATA', 'App store listings', 'Text pushed to the App Store or Google Play'],
  ['SYNTHETIC_PERSONA', 'AI personas', 'Posts by disclosed virtual characters'],
  ['DATA_EXPORT', 'Sending data out', 'Data shared with other services'],
  ['PAYOUT', 'Creator payouts', 'Paying commissions to creators'],
  ['INTERNAL', 'Internal changes', 'Changes that stay inside FUTUREGROW'],
];
const SPEND_LIKE = new Set(['SPEND', 'PRICING']);
const AUDIENCE_LIKE = new Set(['TARGETING', 'MESSAGING']);
const LEVELS = opts(['', 'Not set: needs approval'], ['approval_required', 'Always needs approval'], ['pre_authorized_within_limits', 'May run on its own within limits'], ['deny', 'Never allowed']);
const defaultRoles = (cat: string) => (SPEND_LIKE.has(cat) || cat === 'PAYOUT' ? ['owner', 'finance_approver'] : ['owner', 'approver']);

interface CatState {
  autonomy: string;
  approverRoles: string[];
  requiresDistinctApprover: boolean;
  perAction: string;
  perDay: string;
  audience: string;
}

const micros = (s: string) => (s.trim() ? Math.round(Number(s) * 1_000_000) : null);
const fromMicros = (n: unknown) => (typeof n === 'number' ? String(n / 1_000_000) : '');
const num = (s: string) => (s.trim() ? Number(s) : null);
const str = (n: unknown) => (n === null || n === undefined ? '' : String(n));

/**
 * The autonomy policy as choices: per kind of action, whether it may run on its own, who
 * approves it and within which limits. Fields the form does not cover are kept as they are;
 * the server validates and versions every save.
 */
export function PolicyEditor() {
  const policy = useApi<Row>('/v1/governance/policy');
  return (
    <section className="card" aria-labelledby="pol">
      <header>
        <div>
          <h2 id="pol">Autonomy policy</h2>
          <p className="small muted desc">Decide what may run without a person, who approves the rest, and the limits. Saving needs an owner or admin with two-factor; every version is kept in the audit trail.</p>
        </div>
        {policy.data ? <Badge value={policy.data.configured ? `Configured · version ${policy.data.version}` : 'Not configured'} /> : null}
      </header>
      <ErrorNotice error={policy.error} />
      {policy.data ? <Editor key={String(policy.data.version)} current={policy.data} onSaved={() => void policy.reload()} /> : <LoadingRows />}
    </section>
  );
}

function Editor({ current, onSaved }: { current: Row; onSaved: () => void }) {
  const j = useJourney();
  const canSave = j ? j.me.mfaVerified && j.me.roles.some((r) => r === 'owner' || r === 'admin') : false;
  const curCats = (current.categories ?? {}) as Record<string, Row>;
  const ai = current.aiSpend as Row | null;
  const msg = current.messaging as Row | null;
  const [configured, setConfigured] = useState(Boolean(current.configured));
  const [cats, setCats] = useState<Record<string, CatState>>(() =>
    Object.fromEntries(
      CATEGORIES.map(([c]) => {
        const p = curCats[c];
        return [
          c,
          { autonomy: str(p?.autonomy), approverRoles: (p?.approverRoles as string[]) ?? defaultRoles(c), requiresDistinctApprover: p?.requiresDistinctApprover !== false, perAction: fromMicros(p?.maxSpendDeltaMicrosPerAction), perDay: fromMicros(p?.maxSpendDeltaMicrosPerDay), audience: str(p?.maxAudienceSize) },
        ];
      }),
    ),
  );
  const [currency, setCurrency] = useState(str(current.currency));
  const [ttl, setTtl] = useState(str(current.approvalTtlHours));
  const [aiLimit, setAiLimit] = useState(str(ai?.monthlyLimitUsd));
  const [aiWarn, setAiWarn] = useState(ai?.warnAtFraction ? String(Math.round(Number(ai.warnAtFraction) * 100)) : '80');
  const [markets, setMarkets] = useState(((current.approvedJurisdictions as string[]) ?? []).join(', '));
  const [evidenceAge, setEvidenceAge] = useState(str(current.evidenceMaxAgeHours));
  const [messaging, setMessaging] = useState(Boolean(msg));
  const [perWeek, setPerWeek] = useState(str(msg?.maxCommercialMessagesPerProfilePerWeek ?? '3'));
  const quiet = (msg?.quietHours ?? {}) as Row;
  const [quietStart, setQuietStart] = useState(str(quiet.startHour ?? '21'));
  const [quietEnd, setQuietEnd] = useState(str(quiet.endHour ?? '8'));
  const [tz, setTz] = useState(str(quiet.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')));
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const setCat = (c: string, patch: Partial<CatState>) => setCats((cur) => ({ ...cur, [c]: { ...cur[c]!, ...patch } }));
  const recommended = () => {
    setConfigured(true);
    setCats((cur) => Object.fromEntries(Object.entries(cur).map(([c, s]) => [c, { ...s, autonomy: 'approval_required', approverRoles: s.approverRoles.length ? s.approverRoles : defaultRoles(c), requiresDistinctApprover: true }])));
  };

  const build = (): { body: Row | null; problems: string[] } => {
    const out: string[] = [];
    const categories: Row = {};
    for (const [c, name] of CATEGORIES) {
      const s = cats[c]!;
      if (!s.autonomy) continue;
      if (!s.approverRoles.length) out.push(`${name}: choose at least one approver role.`);
      const pre = s.autonomy === 'pre_authorized_within_limits';
      if (pre && SPEND_LIKE.has(c) && !currency.trim()) out.push(`${name}: set the policy currency below before allowing it to run on its own.`);
      for (const v of [s.perAction, s.perDay, s.audience]) if (v.trim() && !(Number(v) >= 0)) out.push(`${name}: limits must be positive numbers.`);
      categories[c] = {
        autonomy: s.autonomy,
        approverRoles: s.approverRoles,
        requiresDistinctApprover: s.requiresDistinctApprover,
        maxSpendDeltaMicrosPerAction: pre ? micros(s.perAction) : null,
        maxSpendDeltaMicrosPerDay: pre ? micros(s.perDay) : null,
        maxAudienceSize: pre && s.audience.trim() ? Math.round(Number(s.audience)) : null,
      };
    }
    if (currency.trim() && !/^[A-Za-z]{3}$/.test(currency.trim())) out.push('Currency: use a 3-letter code such as USD.');
    if (aiLimit.trim() && !(Number(aiLimit) > 0)) out.push('AI limit: enter an amount above 0.');
    if (aiLimit.trim() && !(Number(aiWarn) > 0 && Number(aiWarn) < 100)) out.push('AI warning: enter a percentage between 1 and 99.');
    if (ttl.trim() && !(Number(ttl) > 0 && Number(ttl) <= 720)) out.push('Approval expiry: use 1 to 720 hours.');
    if (messaging && !(Number(perWeek) >= 1 && Number.isInteger(Number(perWeek)))) out.push('Messages per week: enter a whole number of at least 1.');
    if (messaging && ![quietStart, quietEnd].every((h) => /^\d{1,2}$/.test(h) && Number(h) <= 23)) out.push('Quiet hours: use hours from 0 to 23.');
    const jur = markets
      .split(/[,\s]+/)
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean);
    const { version: _v, ...rest } = current;
    return {
      problems: out,
      body: out.length
        ? null
        : {
            ...rest,
            configured,
            categories,
            currency: currency.trim() ? currency.trim().toUpperCase() : null,
            approvalTtlHours: num(ttl),
            aiSpend: aiLimit.trim() ? { monthlyLimitUsd: Number(aiLimit), warnAtFraction: Number(aiWarn) / 100 } : null,
            approvedJurisdictions: jur,
            evidenceMaxAgeHours: num(evidenceAge),
            messaging: messaging ? { maxCommercialMessagesPerProfilePerWeek: Number(perWeek), quietHours: { startHour: Number(quietStart), endHour: Number(quietEnd), timezone: tz.trim() || 'UTC' } } : null,
          },
    };
  };

  const save = async () => {
    setSaved(false);
    setError(null);
    const { body, problems: p } = build();
    setProblems(p);
    if (!body) return;
    setBusy(true);
    try {
      await api('PUT', '/v1/governance/policy', body);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (advanced) return <PolicyJson current={current} canSave={canSave} onSaved={onSaved} onBack={() => setAdvanced(false)} />;

  return (
    <div className="stack policy">
      {!configured ? (
        <div className="notice warn">
          <strong>The policy is not switched on yet,</strong> so every consequential action waits for a person. That is safe; switch it on once you have chosen the rules below.{' '}
          <button type="button" className="link" onClick={recommended}>
            Use the recommended setup
          </button>
        </div>
      ) : null}
      <label className="check big">
        <input type="checkbox" checked={configured} onChange={(e) => setConfigured(e.target.checked)} />
        <span>
          <strong>Policy is on</strong>
          <span className="small muted"> Actions follow the rules below. Kinds of action left “Not set” still need approval.</span>
        </span>
      </label>

      <h3>Who approves what</h3>
      <div className="policy-cats">
        {CATEGORIES.map(([c, name, hint]) => {
          const s = cats[c]!;
          const pre = s.autonomy === 'pre_authorized_within_limits';
          return (
            <fieldset key={c} className={`policy-cat${s.autonomy ? ' set' : ''}`}>
              <legend className="sr-only">{name}</legend>
              <div className="policy-cat-head">
                <div>
                  <strong>{name}</strong>
                  <div className="small muted">{hint}</div>
                </div>
                <select aria-label={`${name}: what is allowed`} value={s.autonomy} onChange={(e) => setCat(c, { autonomy: e.target.value })}>
                  {LEVELS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {s.autonomy && s.autonomy !== 'deny' ? (
                <div className="policy-cat-body">
                  <div className="small">Who may approve:</div>
                  <div className="choice-chips">
                    {ROLE_OPTIONS.filter((o) => o.value !== 'viewer' && o.value !== 'analyst').map((o) => (
                      <label key={o.value} className={`chip-check${s.approverRoles.includes(o.value) ? ' on' : ''}`}>
                        <input type="checkbox" checked={s.approverRoles.includes(o.value)} onChange={(e) => setCat(c, { approverRoles: e.target.checked ? [...s.approverRoles, o.value] : s.approverRoles.filter((r) => r !== o.value) })} />
                        {o.label}
                      </label>
                    ))}
                  </div>
                  <label className="check small">
                    <input type="checkbox" checked={s.requiresDistinctApprover} onChange={(e) => setCat(c, { requiresDistinctApprover: e.target.checked })} />
                    <span>The approver must be someone other than the person who proposed it</span>
                  </label>
                  {pre ? (
                    <div className="form-grid">
                      {SPEND_LIKE.has(c) ? (
                        <>
                          <div className="field">
                            <label htmlFor={`${c}-act`}>
                              Most per change <span className="opt">optional</span>
                            </label>
                            <div className="input-unit">
                              <input id={`${c}-act`} inputMode="decimal" value={s.perAction} onChange={(e) => setCat(c, { perAction: e.target.value })} />
                              <span className="unit">{currency || 'currency'}</span>
                            </div>
                          </div>
                          <div className="field">
                            <label htmlFor={`${c}-day`}>
                              Most per day <span className="opt">optional</span>
                            </label>
                            <div className="input-unit">
                              <input id={`${c}-day`} inputMode="decimal" value={s.perDay} onChange={(e) => setCat(c, { perDay: e.target.value })} />
                              <span className="unit">{currency || 'currency'}</span>
                            </div>
                          </div>
                        </>
                      ) : null}
                      {AUDIENCE_LIKE.has(c) ? (
                        <div className="field">
                          <label htmlFor={`${c}-aud`}>
                            Largest audience <span className="opt">optional</span>
                          </label>
                          <div className="input-unit">
                            <input id={`${c}-aud`} inputMode="numeric" value={s.audience} onChange={(e) => setCat(c, { audience: e.target.value })} />
                            <span className="unit">people</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
          );
        })}
      </div>

      <h3>Limits</h3>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pol-ai">
            Monthly AI spending limit <span className="opt">optional</span>
          </label>
          <div className="input-unit">
            <input id="pol-ai" inputMode="decimal" value={aiLimit} placeholder="25" onChange={(e) => setAiLimit(e.target.value)} />
            <span className="unit">USD</span>
          </div>
          <p className="help">Agents stop and an alert is raised before the limit would be passed. Empty uses the platform default.</p>
        </div>
        <div className="field">
          <label htmlFor="pol-warn">Warn when this much is used</label>
          <div className="input-unit">
            <input id="pol-warn" inputMode="numeric" value={aiWarn} onChange={(e) => setAiWarn(e.target.value)} />
            <span className="unit">%</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="pol-cur">
            Currency for spend limits <span className="opt">optional</span>
          </label>
          <input id="pol-cur" value={currency} maxLength={3} placeholder="USD" onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </div>
        <div className="field">
          <label htmlFor="pol-ttl">
            Approvals expire after <span className="opt">optional</span>
          </label>
          <div className="input-unit">
            <input id="pol-ttl" inputMode="numeric" value={ttl} placeholder="72" onChange={(e) => setTtl(e.target.value)} />
            <span className="unit">hours</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="pol-markets">
            Markets approved by legal <span className="opt">optional</span>
          </label>
          <input id="pol-markets" value={markets} placeholder="US, GB, BD" onChange={(e) => setMarkets(e.target.value)} />
          <p className="help">Actions aimed at other markets need a legal approver.</p>
        </div>
        <div className="field">
          <label htmlFor="pol-ev">
            Evidence may be at most <span className="opt">optional</span>
          </label>
          <div className="input-unit">
            <input id="pol-ev" inputMode="numeric" value={evidenceAge} placeholder="720" onChange={(e) => setEvidenceAge(e.target.value)} />
            <span className="unit">hours old</span>
          </div>
        </div>
      </div>

      <h3>Messaging</h3>
      <label className="check">
        <input type="checkbox" checked={messaging} onChange={(e) => setMessaging(e.target.checked)} />
        <span>Limit marketing messages and respect quiet hours</span>
      </label>
      {messaging ? (
        <div className="form-grid">
          <div className="field">
            <label htmlFor="pol-week">Most marketing messages per person per week</label>
            <input id="pol-week" inputMode="numeric" value={perWeek} onChange={(e) => setPerWeek(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pol-qs">Quiet from (hour, 0–23)</label>
            <input id="pol-qs" inputMode="numeric" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pol-qe">Quiet until (hour, 0–23)</label>
            <input id="pol-qe" inputMode="numeric" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pol-tz">Time zone</label>
            <input id="pol-tz" value={tz} onChange={(e) => setTz(e.target.value)} />
          </div>
        </div>
      ) : null}

      {problems.length ? (
        <div className="notice error" role="alert">
          <strong>Fix these before saving:</strong>
          <ul className="small tight">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ErrorNotice error={error} />
      {saved ? <Notice notice={{ tone: 'ok', title: 'Policy saved as a new version.' }} /> : null}
      <div className="form-actions">
        <button type="button" className="primary" onClick={() => void save()} disabled={busy || !canSave} title={canSave ? undefined : 'Needs an owner or admin with two-factor sign-in'}>
          {busy ? 'Saving…' : 'Save policy (new version)'}
        </button>
        <button type="button" className="link" onClick={() => setAdvanced(true)}>
          Advanced: all settings as JSON
        </button>
      </div>
      {!canSave ? <p className="help">Saving needs an owner or admin with two-factor sign-in (Account &amp; security).</p> : null}
    </div>
  );
}

/** Every setting as JSON (quality gates and weights included), for advanced users. */
function PolicyJson({ current, canSave, onSaved, onBack }: { current: Row; canSave: boolean; onSaved: () => void; onBack: () => void }) {
  const { version: _v, ...rest } = current;
  const [text, setText] = useState(() => JSON.stringify(rest, null, 2));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError(null);
    let body: Row;
    try {
      body = JSON.parse(text) as Row;
    } catch (err) {
      return setError(new Error(`The JSON could not be read: ${(err as Error).message}`));
    }
    setBusy(true);
    try {
      await api('PUT', '/v1/governance/policy', body);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="pol-json">Policy (JSON)</label>
        <textarea id="pol-json" className="json" rows={18} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="help">The server checks the whole policy and stores it as a new version.</p>
      </div>
      <ErrorNotice error={error} />
      <div className="form-actions">
        <button type="button" className="primary" onClick={() => void save()} disabled={busy || !canSave}>
          {busy ? 'Saving…' : 'Save policy (new version)'}
        </button>
        <button type="button" className="link" onClick={onBack}>
          Back to the simple editor
        </button>
      </div>
    </div>
  );
}
