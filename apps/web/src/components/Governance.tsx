import { useState } from 'react';
import { api } from '../lib/api.js';
import type { Resource } from '../lib/catalog.js';
import { opts } from '../lib/forms.js';
import { PolicyEditor } from './PolicyEditor.js';
import { ResourcePanel } from './ResourcePanel.js';
import { Badge, DataTable, ErrorNotice, LoadingRows, useApi } from './ui.js';

interface KillSwitch {
  id: string;
  scope: string;
  targetRef: string | null;
  engaged: boolean;
  reason: string;
  engagedBy: string;
  engagedAt: string;
}

const SCOPES = ['tenant', 'connector', 'object', 'model', 'agent'] as const;
const SCOPE_LABELS: Record<(typeof SCOPES)[number], string> = { tenant: 'Everything in this organisation', connector: 'One provider or connection', object: 'One campaign, post or journey', model: 'One AI model', agent: 'One AI agent' };

function KillSwitches() {
  const list = useApi<KillSwitch[]>('/v1/governance/kill-switches');
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('connector');
  const [targetRef, setTargetRef] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const engage = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/governance/kill-switches', { scope, targetRef: scope === 'tenant' ? null : targetRef.trim() || null, reason: reason.trim() });
      setReason('');
      await list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const release = async (id: string) => {
    setError(null);
    try {
      await api('POST', `/v1/governance/kill-switches/${id}/release`, {});
      await list.reload();
    } catch (err) {
      setError(err);
    }
  };
  const engaged = (list.data ?? []).filter((k) => k.engaged);
  return (
    <section className="card" aria-labelledby="ks">
      <header>
        <div>
          <h2 id="ks">Kill switches</h2>
          <p className="small muted desc">An emergency stop. It is checked before every action and again right before every call to a provider; engaging one cancels the queued actions it covers.</p>
        </div>
      </header>
      <div className="ks-grid">
        <div className="field">
          <label htmlFor="ks-scope">Scope</label>
          <select id="ks-scope" value={scope} onChange={(e) => setScope(e.target.value as (typeof SCOPES)[number])}>
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ks-target">Target</label>
          <input
            id="ks-target"
            value={targetRef}
            onChange={(e) => setTargetRef(e.target.value)}
            disabled={scope === 'tenant'}
            placeholder={scope === 'connector' ? 'Provider, e.g. meta' : scope === 'object' ? 'Campaign, post or journey' : scope === 'model' ? 'Model name' : scope === 'agent' ? 'Agent name' : 'Not needed: stops everything'}
          />
        </div>
        <div className="field">
          <label htmlFor="ks-reason">Reason</label>
          <input id="ks-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What happened?" />
        </div>
        <div className="field ks-action">
          <button type="button" className="danger solid" disabled={busy || reason.trim().length < 3} onClick={() => void engage()}>
            Engage
          </button>
        </div>
      </div>
      <ErrorNotice error={list.error ?? error} />
      <DataTable
        rows={(list.data ?? []) as unknown as Record<string, unknown>[]}
        columns={['scope', 'targetRef', 'engaged', 'reason', 'engagedAt', 'releasedAt']}
        loading={list.loading}
        actions={(r) =>
          r.engaged ? (
            <button type="button" className="sm" onClick={() => void release(String(r.id))}>
              Release
            </button>
          ) : null
        }
        empty="No kill switches have been engaged."
      />
      {engaged.length ? (
        <p className="small">
          <Badge value="critical" /> {engaged.length} engaged
        </p>
      ) : null}
    </section>
  );
}

interface AiBudgetView {
  limitUsd: number | null;
  source: 'tenant' | 'platform' | 'none';
  warnAtFraction: number;
  periodStart: string;
  spentUsd: number;
  unpricedCalls: number;
  reservedUsd: number;
  remainingUsd: number | null;
}

const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

/** FG-P2-001: month-to-date model spend against the tenant's limit (set in the policy). */
function AiSpending() {
  const b = useApi<AiBudgetView>('/v1/governance/ai-budget');
  const d = b.data;
  const used = d?.limitUsd ? Math.min(1, (d.spentUsd + d.reservedUsd) / d.limitUsd) : 0;
  return (
    <section className="card" aria-labelledby="ai-spend">
      <header>
        <div>
          <h2 id="ai-spend">AI spending this month</h2>
          <p className="small muted desc">Every AI call is checked first; when the limit would be passed, the agent stops and an alert is raised.</p>
        </div>
      </header>
      <ErrorNotice error={b.error} />
      {d ? (
        <div className="stack">
          <p>
            <strong>{money(d.spentUsd)}</strong> spent since {new Date(d.periodStart).toLocaleDateString(undefined, { dateStyle: 'medium' })}
            {d.limitUsd ? (
              <>
                {' '}
                of <strong>{money(d.limitUsd)}</strong> ({d.source === 'tenant' ? 'organisation limit' : 'platform default'}); {money(d.remainingUsd ?? 0)} left.
              </>
            ) : (
              ' with no limit set.'
            )}
          </p>
          {d.limitUsd ? <meter min={0} max={1} low={d.warnAtFraction} high={0.95} optimum={0} value={used} aria-label="Share of the monthly AI limit used" className="meter" /> : null}
          {d.unpricedCalls ? <div className="notice warn">{d.unpricedCalls} AI call(s) this month have no known price, so spending against a limit cannot be measured; calls stop while a limit applies.</div> : null}
          <p className="small muted">Change the limit under “Limits” in the autonomy policy above.</p>
        </div>
      ) : (
        <LoadingRows />
      )}
    </section>
  );
}

const TRI = opts(['allowed', 'Allowed'], ['restricted', 'Restricted'], ['unknown', 'Unknown']);

export const REGISTRIES: Resource[] = [
  {
    title: 'Sender identity',
    description: 'The name, address and postal address on every marketing email (anti-spam law requires them).',
    create: {
      label: 'Save sender identity',
      method: 'PUT',
      path: '/v1/governance/sender-identity',
      form: {
        fields: [
          { key: 'fromName', type: 'text', label: 'From name', required: true, placeholder: 'Acme' },
          { key: 'fromEmail', type: 'email', label: 'From address', required: true, placeholder: 'hello@acme.example' },
          { key: 'replyTo', type: 'email', label: 'Reply-to address', placeholder: 'support@acme.example' },
          { key: 'postalAddress', type: 'textarea', label: 'Postal address', required: true, minLength: 10, rows: 2, placeholder: '1 Market St, San Francisco, CA 94105, USA' },
        ],
      },
      success: () => ({ tone: 'ok', title: 'Sender identity saved.' }),
    },
  },
  {
    title: 'Alerts',
    list: '/v1/governance/alerts',
    columns: ['severity', 'kind', 'message', 'createdAt'],
    empty: 'No open alerts.',
    rowActions: [{ label: 'Acknowledge', path: '/v1/governance/alerts/:id/ack', done: 'Alert acknowledged.' }],
  },
  {
    title: 'Incidents',
    list: '/v1/governance/incidents',
    columns: ['severity', 'status', 'title', 'openedAt', 'resolvedAt'],
    empty: 'No incidents.',
    rowActions: [{ label: 'Resolve', path: '/v1/governance/incidents/:id/resolve', form: { fields: [{ key: 'resolution', type: 'textarea', label: 'What was done', required: true, minLength: 3, rows: 3 }] }, when: { field: 'status', values: ['open'] }, done: 'Incident resolved.' }],
  },
  {
    title: 'AI models',
    description: 'Only models a platform admin approved are ever called, even when a provider account has credit. Approving and withdrawing models are platform-admin tasks.',
    list: '/v1/governance/models',
    columns: ['provider', 'modelId', 'purposes', 'status', 'approvedForProduction', 'trainingOnCustomerData', 'inputUsdPerMtok', 'outputUsdPerMtok'],
    labels: { modelId: 'Model' },
  },
  {
    title: 'Licences for fonts, music and other assets',
    description: 'Third-party files used in creative, with their licence. Only entries approved for production can be used.',
    list: '/v1/governance/artifacts',
    columns: ['exactName', 'artifactType', 'versionOrCommit', 'licenseIdOrCustomTerms', 'commercialUse', 'approvedForProduction'],
    labels: { exactName: 'Name', artifactType: 'Type', versionOrCommit: 'Version', licenseIdOrCustomTerms: 'Licence' },
    empty: 'Nothing registered yet.',
    create: {
      label: 'Register an asset licence',
      path: '/v1/governance/artifacts',
      form: {
        fields: [
          { key: 'exactName', type: 'text', label: 'Name', required: true, placeholder: 'Inter' },
          {
            key: 'artifactType',
            type: 'select',
            label: 'Type',
            required: true,
            initial: 'font',
            options: opts(['font', 'Font'], ['music', 'Music'], ['stock_media', 'Stock photo or video'], ['voice', 'Voice'], ['likeness', 'Likeness'], ['code', 'Code'], ['weights', 'AI model weights'], ['lora', 'AI fine-tune (LoRA)'], ['embedding', 'Embedding model'], ['dataset', 'Dataset'], ['plugin', 'Plugin']),
          },
          { key: 'versionOrCommit', type: 'text', label: 'Version', required: true, placeholder: '4.0' },
          {
            key: 'sha256',
            type: 'text',
            label: 'File fingerprint (SHA-256)',
            required: true,
            case: 'lower',
            pattern: /^[a-f0-9]{64}$/,
            patternHint: 'Use the 64-character SHA-256 of the exact file you will use.',
            help: 'Choose the file and it is computed in your browser; the file is not uploaded.',
            fromFile: { accept: '*/*', hash: true },
          },
          { key: 'licenseIdOrCustomTerms', type: 'text', label: 'Licence', required: true, placeholder: 'OFL-1.1' },
          { key: 'copyrightOwner', type: 'text', label: 'Copyright owner', emptyAsNull: true, placeholder: 'The Inter Project Authors' },
          { key: 'commercialUse', type: 'select', label: 'Commercial use', options: TRI, required: true, initial: 'unknown' },
          { key: 'redistribution', type: 'select', label: 'Redistribution', options: TRI, required: true, initial: 'unknown' },
          { key: 'derivativeUse', type: 'select', label: 'Changes and derivatives', options: TRI, required: true, initial: 'unknown' },
          { key: 'attributionRequired', type: 'select', label: 'Attribution required', options: opts(['false', 'No'], ['true', 'Yes'], ['unknown', 'Unknown']), required: true, initial: 'unknown' },
          { key: 'sourceDataRightsStatus', type: 'select', label: 'Rights in its source data', options: opts(['known', 'Known'], ['unknown', 'Unknown']), required: true, initial: 'unknown' },
          { key: 'geographicOrUseRestrictions', type: 'tags', label: 'Restrictions', advanced: true },
          { key: 'sourceUrl', type: 'url', label: 'Where it was obtained', emptyAsNull: true, advanced: true },
        ],
        transform: (b) => ({ geographicOrUseRestrictions: [], ...b }),
      },
      success: () => ({ tone: 'ok', title: 'Registered.', text: 'Approve it for production once the licence is checked.' }),
    },
    rowActions: [{ label: 'Approve for production', path: '/v1/governance/artifacts/:id/approve', when: { field: 'approvedForProduction', values: [false] }, confirm: 'Approve this licence for production use?', done: 'Approved for production.' }],
  },
  {
    title: 'Provider API versions',
    description: 'Versions past their published end date are blocked automatically.',
    list: '/v1/governance/api-lifecycle',
    pick: 'apis',
    columns: ['provider', 'apiVersion', 'status', 'sunsetAt', 'daysLeft', 'basis'],
  },
  { title: 'AI model end of life', description: 'Approved models past their end-of-life date are no longer called.', list: '/v1/governance/api-lifecycle', pick: 'models', columns: ['provider', 'modelId', 'eolAt', 'daysLeft', 'status'], labels: { modelId: 'Model' } },
  { title: 'Platform capabilities', list: '/v1/governance/capabilities', columns: ['platform', 'capability', 'apiVersion', 'supported', 'requiredScopes', 'appReviewRequired', 'termsCheckedAt'] },
  { title: 'Cost (30 days)', description: 'Rows without a known price are counted, never estimated.', list: '/v1/governance/costs', columns: ['category', 'provider', 'quantity', 'known_usd', 'unpriced_rows'] },
];

export function Governance() {
  return (
    <div className="stack">
      <PolicyEditor />
      <KillSwitches />
      <AiSpending />
      {REGISTRIES.map((r) => (
        <ResourcePanel key={r.title} resource={r} />
      ))}
    </div>
  );
}
