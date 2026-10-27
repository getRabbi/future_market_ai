import { useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { PROVIDER_FORMS, type ProviderForm, providerForm } from '../lib/providers.js';
import { Badge, DataTable, Drawer, ErrorNotice, useApi } from './ui.js';

type Row = Record<string, unknown>;
interface Health {
  healthy: boolean;
  status: 'healthy' | 'degraded' | 'failing';
  grantedScopes: string[] | null;
  details: Record<string, unknown>;
}
interface Setup {
  providers: { provider: string; requiredScopes: string[] }[];
  webhooks: { provider: string; url: string; envVar: string; secretConfigured: boolean; verifyTokenConfigured?: boolean }[];
}

/** Every API call this screen makes (checked against the API routes in apps/web/test). */
export const CONNECTION_CALLS = [
  { method: 'GET', path: '/v1/connections' },
  { method: 'GET', path: '/v1/connections/setup' },
  { method: 'POST', path: '/v1/connections' },
  { method: 'POST', path: '/v1/connections/test' },
  { method: 'POST', path: '/v1/connections/:id/health-check' },
  { method: 'POST', path: '/v1/connections/:id/credentials' },
  { method: 'POST', path: '/v1/connections/:id/status' },
] as const;

/**
 * External accounts (B-005…B-009): connect with a form per provider, test credentials with a
 * read-only call before saving, and health-check saved connections. Saving or replacing
 * credentials needs an owner/admin with a two-factor session; testing needs owner/admin.
 */
export function Connections({ me }: { me: Me }) {
  const list = useApi<Row[]>('/v1/connections');
  const setup = useApi<Setup>('/v1/connections/setup');
  const [form, setForm] = useState<{ p: ProviderForm; connection?: Row } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ id: string; health: Health } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const isAdmin = me.roles.some((r) => r === 'owner' || r === 'admin');
  const rows = list.data ?? [];
  const required = (provider: string) => setup.data?.providers.find((x) => x.provider === provider)?.requiredScopes ?? [];

  const healthCheck = async (id: string) => {
    setError(null);
    setChecking(id);
    try {
      const r = await api<{ connection: Row; result: Health }>('POST', `/v1/connections/${id}/health-check`);
      setChecked({ id, health: r.result });
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setChecking(null);
    }
  };
  const setStatus = async (id: string, status: 'active' | 'disabled') => {
    setError(null);
    try {
      await api('POST', `/v1/connections/${id}/status`, { status });
      await list.reload();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <section className="card" aria-labelledby="connect-heading">
        <header>
          <h2 id="connect-heading">Connect an account</h2>
          <span className="small muted">Credentials are encrypted at rest and never shown again. Test them before saving.</span>
        </header>
        {!isAdmin ? <div className="notice warn">Only owners and admins can connect accounts.</div> : null}
        {isAdmin && !me.mfaVerified ? (
          <div className="notice warn">
            You can test credentials now. Saving them needs two-factor sign-in: turn it on under <a href="/app/settings">Account &amp; security</a> by scanning a QR code with an authenticator app.
          </div>
        ) : null}
        <div className="grid">
          {PROVIDER_FORMS.map((p) => {
            const mine = rows.filter((r) => r.provider === p.provider);
            const bad = mine.filter((r) => r.status !== 'active' || r.healthStatus === 'failing').length;
            return (
              <div key={p.provider} className="card" style={{ margin: 0 }}>
                <h3 style={{ marginTop: 0 }}>{p.name}</h3>
                <p className="small muted">{p.enables}</p>
                <p className="small">{mine.length ? <Badge value={bad ? `${mine.length} connected, ${bad} need attention` : `${mine.length} connected`} /> : <span className="muted">Not connected</span>}</p>
                <button type="button" className="primary" disabled={!isAdmin} onClick={() => setForm({ p })}>
                  Connect
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card" aria-labelledby="connected-heading">
        <header>
          <h2 id="connected-heading">Connected accounts</h2>
          <span className="small muted">“Test connection” makes a read-only call. A rejected credential moves the connection to reauth_required; queued actions wait.</span>
        </header>
        <ErrorNotice error={error ?? list.error} />
        <DataTable
          rows={rows.map((r) => ({ ...r, scopes: Array.isArray(r.grantedScopes) ? (r.grantedScopes as string[]).length : 0 }))}
          columns={['displayName', 'provider', 'externalAccountId', 'status', 'healthStatus', 'lastHealthCheckAt', 'scopes']}
          empty="No accounts connected yet."
          actions={(r) => {
            const id = String(r.id);
            const p = providerForm(String(r.provider));
            return (
              <div className="row" style={{ gap: '0.25rem', flexWrap: 'nowrap' }}>
                <button type="button" disabled={checking === id || !p} onClick={() => void healthCheck(id)}>
                  {checking === id ? 'Testing…' : 'Test connection'}
                </button>
                {p && isAdmin ? (
                  <button type="button" onClick={() => setForm({ p, connection: r })}>
                    Update credentials
                  </button>
                ) : null}
                {isAdmin && r.status === 'disabled' ? (
                  <button type="button" onClick={() => void setStatus(id, 'active')}>
                    Enable
                  </button>
                ) : isAdmin ? (
                  <button type="button" className="danger" onClick={() => void setStatus(id, 'disabled')}>
                    Disable
                  </button>
                ) : null}
              </div>
            );
          }}
        />
        {checked ? <HealthResult health={checked.health} required={required(String(rows.find((r) => r.id === checked.id)?.provider ?? ''))} /> : null}
      </section>

      <section className="card" aria-labelledby="webhook-heading">
        <header>
          <h2 id="webhook-heading">Webhooks</h2>
          <span className="small muted">Register these URLs with each provider. The signing secrets are server settings (Northflank secret group), shown here only as set or missing.</span>
        </header>
        <ErrorNotice error={setup.error} />
        <DataTable
          rows={(setup.data?.webhooks ?? []).map((w) => ({ provider: w.provider, url: w.url, secret: w.secretConfigured ? 'configured' : `missing (${w.envVar})`, ...(w.verifyTokenConfigured === undefined ? {} : { verifyToken: w.verifyTokenConfigured ? 'configured' : 'missing (META_WEBHOOK_VERIFY_TOKEN)' }) }))}
          columns={['provider', 'url', 'secret', 'verifyToken']}
        />
      </section>

      {form ? (
        <Drawer title={form.connection ? `Update credentials: ${String(form.connection.displayName)}` : `Connect ${form.p.name}`} onClose={() => setForm(null)}>
          <ConnectForm
            p={form.p}
            connection={form.connection}
            requiredScopes={required(form.p.provider)}
            canSave={me.mfaVerified}
            onSaved={async () => {
              await list.reload();
            }}
          />
        </Drawer>
      ) : null}
    </>
  );
}

function HealthResult({ health, required }: { health: Health; required: string[] }) {
  const missing = health.grantedScopes ? required.filter((s) => !health.grantedScopes!.includes(s)) : [];
  const err = typeof health.details?.error === 'string' ? health.details.error : null;
  return (
    <div className={`notice ${health.healthy ? 'ok' : health.status === 'degraded' ? 'warn' : 'error'}`} role="status" style={{ marginTop: '0.75rem' }}>
      <strong>{health.healthy ? 'Connection works.' : health.status === 'degraded' ? 'The provider answered with a problem.' : 'The provider rejected these credentials.'}</strong>
      {err ? <div className="small">{err}</div> : null}
      {health.healthy && Object.keys(health.details ?? {}).length ? (
        <div className="small muted">
          Account:{' '}
          {Object.entries(health.details)
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(', ')}
        </div>
      ) : null}
      {health.grantedScopes ? <div className="small">Granted permissions: {health.grantedScopes.length ? health.grantedScopes.join(', ') : 'none reported'}</div> : null}
      {missing.length ? <div className="small">Missing for full use: {missing.join(', ')}</div> : null}
    </div>
  );
}

function ConnectForm({ p, connection, requiredScopes, canSave, onSaved }: { p: ProviderForm; connection?: Row; requiredScopes: string[]; canSave: boolean; onSaved: () => Promise<void> }) {
  const rotating = Boolean(connection);
  const [account, setAccount] = useState(rotating ? String(connection!.externalAccountId) : '');
  const [displayName, setDisplayName] = useState(rotating ? String(connection!.displayName) : '');
  // Metadata (e.g. an ad account ID) stays editable when credentials are replaced, so ads can be added to a Page-only connection.
  const [values, setValues] = useState<Record<string, string>>(() =>
    rotating ? Object.fromEntries(p.fields.filter((f) => f.target === 'metadata' && connection!.metadata && typeof (connection!.metadata as Record<string, unknown>)[f.key] === 'string').map((f) => [f.key, (connection!.metadata as Record<string, string>)[f.key]!])) : {},
  );
  const [scopes, setScopes] = useState<string[]>(rotating && Array.isArray(connection!.grantedScopes) ? (connection!.grantedScopes as string[]) : requiredScopes);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const field = (key: string) => values[key]?.trim() ?? '';
  const missing = p.fields.filter((f) => !f.optional && !field(f.key)).map((f) => f.label);
  const accountOk = rotating || (account.trim() !== '' && (!p.account.pattern || p.account.pattern.test(account.trim())));
  const ready = accountOk && missing.length === 0;
  const body = () => {
    const credentials: Record<string, string> = {};
    const metadata: Record<string, string> = {};
    for (const f of p.fields) if (field(f.key)) (f.target === 'metadata' ? metadata : credentials)[f.key] = field(f.key);
    if (p.account.alsoCredential) credentials[p.account.alsoCredential] = account.trim();
    return { provider: p.provider, externalAccountId: account.trim(), metadata: rotating ? { ...((connection!.metadata as Record<string, unknown>) ?? {}), ...metadata } : metadata, credentials };
  };

  const test = async () => {
    setError(null);
    setHealth(null);
    setBusy('test');
    try {
      setHealth(await api<Health>('POST', '/v1/connections/test', body()));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setError(null);
    setBusy('save');
    try {
      const b = body();
      const id = rotating ? String(connection!.id) : (await api<Row>('POST', '/v1/connections', { ...b, displayName: displayName.trim() || `${p.name} ${b.externalAccountId}`, grantedScopes: scopes })).id;
      if (rotating) await api('POST', `/v1/connections/${id}/credentials`, { credentials: b.credentials, metadata: b.metadata });
      const r = await api<{ result: Health }>('POST', `/v1/connections/${id}/health-check`);
      setHealth(r.result);
      setValues({});
      setSaved(true);
      await onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (saved) {
    return (
      <div className="stack">
        <div className="notice ok">{rotating ? 'New credentials saved.' : 'Connection saved.'} Result of the first check:</div>
        {health ? <HealthResult health={health} required={requiredScopes} /> : null}
      </div>
    );
  }

  return (
    <form
      className="stack"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        void test();
      }}
    >
      <p className="small muted">
        {p.enables}{' '}
        <a href={p.docsUrl} target="_blank" rel="noreferrer noopener">
          Where to find these values
        </a>
      </p>
      {!rotating ? (
        <>
          <div className="field">
            <label htmlFor="c-account">{p.account.label}</label>
            <input id="c-account" value={account} placeholder={p.account.placeholder} onChange={(e) => setAccount(e.target.value)} />
            {p.account.help ? <span className="small muted">{p.account.help}</span> : null}
            {account.trim() && !accountOk ? <span className="small">Expected format: {p.account.patternHint}</span> : null}
          </div>
          <div className="field">
            <label htmlFor="c-name">Name in FUTUREGROW</label>
            <input id="c-name" value={displayName} placeholder={`${p.name} – main account`} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
        </>
      ) : null}
      {p.fields.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={`c-${f.key}`}>
            {f.label}
            {f.optional ? <span className="muted small"> (optional)</span> : null}
          </label>
          {f.multiline ? (
            <textarea id={`c-${f.key}`} rows={5} spellCheck={false} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          ) : (
            <input id={`c-${f.key}`} type={f.secret ? 'password' : 'text'} autoComplete={f.secret ? 'new-password' : 'off'} spellCheck={false} value={values[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          )}
          {f.help ? <span className="small muted">{f.help}</span> : null}
        </div>
      ))}
      {!rotating && requiredScopes.length ? (
        <fieldset className="field">
          <legend>Permissions granted to this token</legend>
          {requiredScopes.map((s) => (
            <label key={s} className="small" style={{ display: 'block' }}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {s}
            </label>
          ))}
          <span className="small muted">Actions that need an unticked permission are refused by policy. Meta reports the real permissions on the first check.</span>
        </fieldset>
      ) : null}
      <ErrorNotice error={error} />
      {health ? <HealthResult health={health} required={requiredScopes} /> : null}
      <div className="row">
        <button type="submit" disabled={!ready || busy !== null}>
          {busy === 'test' ? 'Testing…' : 'Test credentials'}
        </button>
        <button type="button" className="primary" disabled={!ready || busy !== null || !canSave} onClick={() => void save()} title={canSave ? undefined : 'Needs a two-factor session'}>
          {busy === 'save' ? 'Saving…' : rotating ? 'Save new credentials' : 'Save connection'}
        </button>
      </div>
      {!ready && missing.length ? <span className="small muted">Still needed: {missing.join(', ')}</span> : null}
    </form>
  );
}
