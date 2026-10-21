import { useState } from 'react';
import { api, type Me, uploadBinary } from '../lib/api.js';
import { authClient } from '../lib/auth.js';
import { ChangePassword } from './ChangePassword.js';
import { Members } from './Members.js';
import { Badge, DataTable, ErrorNotice, Json, useApi } from './ui.js';

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export function Audit() {
  const rows = useApi<Record<string, unknown>[]>('/v1/governance/audit?limit=300');
  const [result, setResult] = useState<{ valid: boolean; checked: number; headSeq: number | null; firstInvalidSeq?: number; reason?: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const verify = async () => {
    setError(null);
    try {
      setResult(await api('GET', '/v1/governance/audit/verify'));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="stack">
      <section className="card">
        <header>
          <h2>Chain verification</h2>
          <button type="button" className="primary" onClick={() => void verify()}>
            Verify chain now
          </button>
        </header>
        <p className="small muted">Each record stores SHA-256(previous hash ‖ canonical record). Verification recomputes every link; any edit, deletion or reordering breaks the chain.</p>
        <ErrorNotice error={error} />
        {result ? <div className={`notice ${result.valid ? 'ok' : 'error'}`}>{result.valid ? `Chain intact: ${result.checked} records verified (head #${result.headSeq ?? '—'}).` : `Chain broken at #${result.firstInvalidSeq}: ${result.reason}`}</div> : null}
      </section>
      <section className="card">
        <header>
          <h2>Recent records</h2>
          <button type="button" onClick={() => void rows.reload()}>
            Refresh
          </button>
        </header>
        <ErrorNotice error={rows.error} />
        <DataTable rows={rows.data ?? []} columns={['seq', 'occurred_at', 'actor_type', 'actor_id', 'action', 'subject_type', 'subject_id']} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export function Overview({ me }: { me: Me }) {
  const approvals = useApi<unknown[]>('/v1/actions?status=APPROVAL_REQUIRED&limit=200');
  const escalated = useApi<unknown[]>('/v1/actions?status=ESCALATED,ROLLBACK_REQUIRED&limit=200');
  const alerts = useApi<Record<string, unknown>[]>('/v1/governance/alerts');
  const incidents = useApi<Record<string, unknown>[]>('/v1/governance/incidents');
  const kill = useApi<Record<string, unknown>[]>('/v1/governance/kill-switches');
  const policy = useApi<{ configured: boolean; version: number }>('/v1/governance/policy');
  const openIncidents = (incidents.data ?? []).filter((i) => i.status === 'open');
  const engaged = (kill.data ?? []).filter((k) => k.engaged);
  return (
    <div className="stack">
      {!me.mfaVerified ? (
        <div className="notice warn">
          Two-factor authentication is not enabled for your account. Approvals, kill switches, policy changes and connections require it. <a href="/app/settings">Enable TOTP</a>.
        </div>
      ) : null}
      {policy.data && !policy.data.configured ? <div className="notice">The autonomy policy is unconfigured, so every consequential action needs human approval. Configure it under Governance.</div> : null}
      <div className="grid">
        <a className="card" href="/app/approvals" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="muted small">Awaiting approval</div>
          <div className="stat">{approvals.data?.length ?? '…'}</div>
        </a>
        <a className="card" href="/app/approvals?tab=attention" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="muted small">Escalated / rollback required</div>
          <div className="stat">{escalated.data?.length ?? '…'}</div>
        </a>
        <a className="card" href="/app/governance" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="muted small">Open incidents</div>
          <div className="stat">{incidents.data ? openIncidents.length : '…'}</div>
        </a>
        <a className="card" href="/app/governance" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="muted small">Kill switches engaged</div>
          <div className="stat">{kill.data ? engaged.length : '…'}</div>
        </a>
      </div>
      <ErrorNotice error={approvals.error ?? alerts.error ?? incidents.error} />
      <section className="card">
        <header>
          <h2>Unacknowledged alerts</h2>
          <a href="/app/governance">Manage</a>
        </header>
        <DataTable rows={(alerts.data ?? []).slice(0, 15)} columns={['severity', 'kind', 'message', 'createdAt']} empty="No open alerts." />
      </section>
      {openIncidents.length ? (
        <section className="card">
          <h2>Open incidents</h2>
          <DataTable rows={openIncidents} columns={['severity', 'title', 'description', 'openedAt']} />
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Account & security                                                  */
/* ------------------------------------------------------------------ */

export function Settings({ me, onTenant }: { me: Me; onTenant: (id: string) => void }) {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [org, setOrg] = useState({ name: '', slug: '' });

  const enable = async () => {
    setError(null);
    const r = await authClient.twoFactor.enable({ password });
    if (r.error) return setError(new Error(r.error.message ?? 'could not start enrolment'));
    if (r.data.method !== 'totp') return setError(new Error('the server did not start TOTP enrolment'));
    const uri = r.data.totpURI;
    setTotp({ uri, secret: new URL(uri).searchParams.get('secret') ?? '', backupCodes: r.data.backupCodes });
    setPassword('');
  };
  const verify = async () => {
    setError(null);
    const r = await authClient.twoFactor.verifyTotp({ code });
    if (r.error) return setError(new Error(r.error.message ?? 'invalid code'));
    setTotp(null);
    setMsg('Two-factor authentication is enabled. Sign out and back in to start a two-factor session.');
  };
  const createOrg = async () => {
    setError(null);
    const r = await authClient.organization.create({ name: org.name, slug: org.slug });
    if (r.error) return setError(new Error(r.error.message ?? 'could not create organization'));
    if (r.data?.id) onTenant(r.data.id);
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>Two-factor authentication (TOTP)</h2>
        <p className="small">
          Status: <Badge value={me.mfaVerified ? 'active' : 'not enabled'} />
        </p>
        {msg ? <div className="notice ok">{msg}</div> : null}
        <ErrorNotice error={error} />
        {!me.mfaVerified && !totp ? (
          <div className="row" style={{ alignItems: 'end' }}>
            <div className="field" style={{ flex: '1 1 16rem' }}>
              <label htmlFor="pw">Confirm your password</label>
              <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="field">
              <button type="button" className="primary" disabled={!password} onClick={() => void enable()}>
                Start enrolment
              </button>
            </div>
          </div>
        ) : null}
        {totp ? (
          <div className="stack">
            <p className="small">Add this account to your authenticator app using the setup key, then enter the 6-digit code.</p>
            <div className="field">
              <p className="small">
                <strong>Setup key</strong>
              </p>
              <code className="mono" style={{ fontSize: '1rem', letterSpacing: '0.08em' }}>
                {totp.secret.replace(/(.{4})/g, '$1 ').trim()}
              </code>
            </div>
            <details className="small">
              <summary>otpauth URI</summary>
              <code>{totp.uri}</code>
            </details>
            <div className="field">
              <p className="small">
                <strong>Backup codes</strong> (store them offline; each works once)
              </p>
              <pre>{totp.backupCodes.join('\n')}</pre>
            </div>
            <div className="row" style={{ alignItems: 'end' }}>
              <div className="field">
                <label htmlFor="code">Code</label>
                <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              </div>
              <div className="field">
                <button type="button" className="primary" disabled={code.length !== 6} onClick={() => void verify()}>
                  Verify and enable
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
      <ChangePassword email={me.email ?? null} passwordChangedAt={me.passwordChangedAt ?? null} />
      <Members tenantId={me.tenantId} canManage={me.roles.some((r) => r === 'owner' || r === 'admin')} />
      <section className="card">
        <h2>Organizations</h2>
        <DataTable
          rows={me.memberships as unknown as Record<string, unknown>[]}
          columns={['name', 'slug', 'role']}
          actions={(r) =>
            r.organizationId === me.tenantId ? (
              <Badge value="active" />
            ) : (
              <button type="button" onClick={() => onTenant(String(r.organizationId))}>
                Switch
              </button>
            )
          }
        />
        <div className="row" style={{ alignItems: 'end', marginTop: '0.75rem' }}>
          <div className="field">
            <label htmlFor="org-name">New organization name</label>
            <input id="org-name" value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="org-slug">Slug</label>
            <input id="org-slug" value={org.slug} onChange={(e) => setOrg({ ...org, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
          </div>
          <div className="field">
            <button type="button" disabled={!org.name || org.slug.length < 3} onClick={() => void createOrg()}>
              Create
            </button>
          </div>
        </div>
      </section>
      <section className="card">
        <h2>Session</h2>
        <p className="small muted">
          Signed in as {me.email ?? me.userId}. Roles in this organization: {me.roles.join(', ') || '—'}.
        </p>
        <button
          type="button"
          onClick={async () => {
            await authClient.signOut();
            window.location.href = '/login';
          }}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Asset upload (M14)                                                  */
/* ------------------------------------------------------------------ */

export function AssetUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [contains, setContains] = useState({ music: false, voice: false, likeness: false, aiGenerated: false });
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const kind = file?.type.startsWith('video/') ? 'video' : file?.type.startsWith('audio/') ? 'audio' : 'image';
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await uploadBinary('/v1/assets/upload', file, { kind, title: title || file.name, contains }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Upload source media</h2>
      <p className="small muted">Uploads are hashed and QA-checked. An asset becomes publish-eligible only after a rights manifest covers every component.</p>
      <div className="row" style={{ alignItems: 'end' }}>
        <div className="field">
          <label htmlFor="asset-file">File</label>
          <input id="asset-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,audio/mpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="field" style={{ flex: '1 1 14rem' }}>
          <label htmlFor="asset-title">Title</label>
          <input id="asset-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <button type="button" className="primary" disabled={!file || busy} onClick={() => void upload()}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
      <fieldset className="row" style={{ border: 0, padding: 0 }}>
        <legend className="small">This file contains (each needs a rights record before publishing):</legend>
        {(['music', 'voice', 'likeness', 'aiGenerated'] as const).map((k) => (
          <label key={k} className="row small" style={{ fontWeight: 400 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={contains[k]} onChange={(e) => setContains({ ...contains, [k]: e.target.checked })} />
            {k === 'aiGenerated' ? 'AI-generated content' : k}
          </label>
        ))}
      </fieldset>
      <ErrorNotice error={error} />
      {result ? <Json value={result} /> : null}
    </section>
  );
}
