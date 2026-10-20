import { useState } from 'react';
import { api } from '../lib/api.js';
import type { Resource } from '../lib/catalog.js';
import { ResourcePanel } from './ResourcePanel.js';
import { Badge, DataTable, ErrorNotice, JsonForm, useApi } from './ui.js';

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
        <h2 id="ks">Kill switches</h2>
        <span className="small muted">Checked at preflight and again immediately before every provider call. Engaging one cancels queued actions in scope.</span>
      </header>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(8rem, 10rem) 1fr 2fr auto', alignItems: 'end' }}>
        <div className="field">
          <label htmlFor="ks-scope">Scope</label>
          <select id="ks-scope" value={scope} onChange={(e) => setScope(e.target.value as (typeof SCOPES)[number])}>
            {SCOPES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ks-target">Target</label>
          <input id="ks-target" value={targetRef} onChange={(e) => setTargetRef(e.target.value)} disabled={scope === 'tenant'} placeholder={scope === 'connector' ? 'connection id or provider' : scope === 'object' ? 'campaign / post / journey id' : scope === 'model' ? 'model id' : scope === 'agent' ? 'agent id' : 'whole tenant'} />
        </div>
        <div className="field">
          <label htmlFor="ks-reason">Reason</label>
          <input id="ks-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What happened?" />
        </div>
        <div className="field">
          <button type="button" className="danger" disabled={busy || reason.trim().length < 3} onClick={() => void engage()}>
            Engage
          </button>
        </div>
      </div>
      <ErrorNotice error={list.error ?? error} />
      <DataTable
        rows={(list.data ?? []) as unknown as Record<string, unknown>[]}
        columns={['scope', 'targetRef', 'engaged', 'reason', 'engagedBy', 'engagedAt', 'releasedAt']}
        actions={(r) => (r.engaged ? <button type="button" onClick={() => void release(String(r.id))}>Release</button> : null)}
        empty="No kill switches have been engaged."
      />
      {engaged.length ? <p className="small"><Badge value="critical" /> {engaged.length} engaged</p> : null}
    </section>
  );
}

function Policy() {
  const policy = useApi<Record<string, unknown>>('/v1/governance/policy');
  return (
    <section className="card" aria-labelledby="pol">
      <header>
        <h2 id="pol">Autonomy policy</h2>
        <span className="small muted">Unconfigured categories always require human approval. Changes need an MFA-enrolled owner/admin and are versioned in the audit log.</span>
      </header>
      <ErrorNotice error={policy.error} />
      {policy.data ? (
        <JsonForm
          key={String(policy.data.version)}
          initial={policy.data}
          submitLabel="Save policy (new version)"
          onSubmit={async (body) => {
            const r = await api('PUT', '/v1/governance/policy', body);
            await policy.reload();
            return r;
          }}
        />
      ) : (
        <p className="muted">Loading…</p>
      )}
    </section>
  );
}

const REGISTRIES: Resource[] = [
  {
    title: 'Sender identity (CAN-SPAM)',
    create: { label: 'Save sender identity', method: 'PUT', path: '/v1/governance/sender-identity', example: { fromName: 'Acme', fromEmail: 'hello@acme.example', replyTo: 'support@acme.example', postalAddress: '1 Market St, San Francisco, CA 94105, USA' } },
  },
  {
    title: 'Alerts',
    list: '/v1/governance/alerts',
    columns: ['severity', 'kind', 'message', 'createdAt'],
    rowActions: [{ label: 'Acknowledge', path: '/v1/governance/alerts/:id/ack' }],
  },
  {
    title: 'Incidents',
    list: '/v1/governance/incidents',
    columns: ['severity', 'status', 'title', 'openedAt', 'resolvedAt'],
    rowActions: [{ label: 'Resolve', path: '/v1/governance/incidents/:id/resolve', prompt: { field: 'resolution', label: 'Resolution' }, when: { field: 'status', values: ['open'] } }],
  },
  { title: 'Model registry', list: '/v1/governance/models', columns: ['provider', 'modelId', 'purposes', 'status', 'approvedForProduction', 'trainingOnCustomerData', 'inputUsdPerMtok', 'outputUsdPerMtok'], note: 'Platform admins approve models (POST /v1/platform/models/approve). Unapproved models are never called.' },
  {
    title: 'Artifact & licence registry',
    list: '/v1/governance/artifacts',
    columns: ['artifactType', 'exactName', 'versionOrCommit', 'licenseIdOrCustomTerms', 'commercialUse', 'approvedForProduction'],
    create: {
      label: 'Register artifact',
      path: '/v1/governance/artifacts',
      example: {
        exactName: 'Inter',
        versionOrCommit: '4.0',
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        artifactType: 'font',
        copyrightOwner: 'The Inter Project Authors',
        licenseIdOrCustomTerms: 'OFL-1.1',
        commercialUse: 'allowed',
        redistribution: 'allowed',
        derivativeUse: 'allowed',
        attributionRequired: 'false',
        geographicOrUseRestrictions: [],
        sourceDataRightsStatus: 'known',
      },
      note: 'Use the SHA-256 of the exact file you will ship.',
    },
    rowActions: [{ label: 'Approve for production', path: '/v1/governance/artifacts/:id/approve', when: { field: 'approvedForProduction', values: [false] } }],
  },
  { title: 'Platform capabilities', list: '/v1/governance/capabilities', columns: ['platform', 'capability', 'apiVersion', 'supported', 'requiredScopes', 'appReviewRequired', 'termsCheckedAt'] },
  { title: 'Cost (30 days)', list: '/v1/governance/costs', columns: ['category', 'provider', 'quantity', 'known_usd', 'unpriced_rows'], note: 'Rows without a registry price are counted, never estimated.' },
];

export function Governance() {
  return (
    <div className="stack">
      <KillSwitches />
      <Policy />
      {REGISTRIES.map((r) => (
        <ResourcePanel key={r.title} resource={r} />
      ))}
    </div>
  );
}
