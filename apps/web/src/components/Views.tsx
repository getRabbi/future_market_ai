import { useState } from 'react';
import { encode } from 'uqr';
import { api, type Me, uploadBinary } from '../lib/api.js';
import { authClient } from '../lib/auth.js';
import { ChangePassword } from './ChangePassword.js';
import { Notice } from './Form.js';
import { Members } from './Members.js';
import { Badge, DataTable, ErrorNotice, useApi } from './ui.js';

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
/* Account & security                                                  */
/* ------------------------------------------------------------------ */

/** QR code drawn as one SVG path (no inline script or style, so the hashed CSP is unaffected). */
function QrCode({ text, size = 208 }: { text: string; size?: number }) {
  const qr = encode(text, { ecc: 'M', border: 4 });
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.data[y]![x]) d += `M${x} ${y}h1v1h-1z`;
  }
  return (
    <svg role="img" aria-label="QR code for your authenticator app" viewBox={`0 0 ${qr.size} ${qr.size}`} width={size} height={size} shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

export function Settings({ me, onTenant, onChanged }: { me: Me; onTenant: (id: string) => void; onChanged: () => void }) {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [org, setOrg] = useState({ name: '', slug: '' });

  const enable = async () => {
    setError(null);
    const r = await authClient.twoFactor.enable({ password });
    if (r.error) return setError(new Error(r.error.message ?? 'could not turn on two-factor'));
    if (r.data.method !== 'totp') return setError(new Error('the server did not start TOTP enrolment'));
    const uri = r.data.totpURI;
    setTotp({ uri, secret: new URL(uri).searchParams.get('secret') ?? '', backupCodes: r.data.backupCodes });
    setPassword('');
  };
  // Better Auth replaces the session once the code verifies, and the API treats a user with
  // two-factor enabled as MFA-verified, so this session can approve right away (no re-login).
  const verify = async () => {
    setError(null);
    const r = await authClient.twoFactor.verifyTotp({ code });
    if (r.error) return setError(new Error(r.error.message ?? 'invalid code'));
    setTotp(null);
    setMsg('Two-factor is on. From now on, sign-in asks for the code from your app.');
    onChanged();
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
          <div className="stack">
            <p className="small">You will scan a QR code with an authenticator app (Google Authenticator, Microsoft Authenticator or Authy) and type the 6-digit code it shows.</p>
            <div className="row" style={{ alignItems: 'end' }}>
              <div className="field" style={{ flex: '1 1 16rem' }}>
                <label htmlFor="pw">Confirm your password</label>
                <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="field">
                <button type="button" className="primary" disabled={!password} onClick={() => void enable()}>
                  Turn on two-factor
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {totp ? (
          <div className="stack">
            <p className="small">
              <strong>1.</strong> Open your authenticator app, add an account and scan this code.
            </p>
            <QrCode text={totp.uri} />
            <details className="small">
              <summary>Can't scan? Enter a setup key instead</summary>
              <code className="mono" style={{ fontSize: '1rem', letterSpacing: '0.08em' }}>
                {totp.secret.replace(/(.{4})/g, '$1 ').trim()}
              </code>
            </details>
            <div className="row" style={{ alignItems: 'end' }}>
              <div className="field">
                <label htmlFor="code">
                  <strong>2.</strong> Code from the app
                </label>
                <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              </div>
              <div className="field">
                <button type="button" className="primary" disabled={code.length !== 6} onClick={() => void verify()}>
                  Verify and enable
                </button>
              </div>
            </div>
            <div className="field">
              <p className="small">
                <strong>Backup codes</strong>: save them somewhere safe. If you lose your phone, each one signs you in once.
              </p>
              <pre>{totp.backupCodes.join('\n')}</pre>
            </div>
          </div>
        ) : null}
      </section>
      <ChangePassword email={me.email ?? null} passwordChangedAt={me.passwordChangedAt ?? null} />
      <div id="members" />
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
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const kind = file?.type.startsWith('video/') ? 'video' : file?.type.startsWith('audio/') ? 'audio' : 'image';
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await uploadBinary<Record<string, unknown>>('/v1/assets/upload', file, { kind, title: title || file.name, contains }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Upload source media</h2>
      <p className="small muted">Images, video or audio you own or licensed. It can be posted once the rights for every part of it are recorded.</p>
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
            {k === 'aiGenerated' ? 'AI-generated content' : k === 'likeness' ? 'A real person’s face or likeness' : k === 'music' ? 'Music' : 'A voice'}
          </label>
        ))}
      </fieldset>
      <ErrorNotice error={error} />
      {result ? <Notice notice={{ tone: result.publishEligible ? 'ok' : 'warn', title: `“${String(result.title ?? title)}” uploaded.`, text: result.publishEligible ? 'It can be used in posts.' : 'Record the rights for every component (music, voice, likeness, AI content) before it can be posted.' }} /> : null}
    </section>
  );
}
