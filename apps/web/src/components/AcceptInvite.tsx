import { type FormEvent, useEffect, useState } from 'react';
import { setTenant } from '../lib/api.js';
import { authClient } from '../lib/auth.js';
import { Logo } from './ui.js';

/** Invitation landing: create an account for the invited address (if needed), then join. */
export function AcceptInvite() {
  const [id] = useState(() => new URLSearchParams(window.location.search).get('id') ?? '');
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void authClient.getSession().then((s) => setSignedIn(Boolean(s.data)));
  }, []);

  const accept = async () => {
    const r = await authClient.organization.acceptInvitation({ invitationId: id });
    if (r.error) throw new Error(r.error.message ?? 'could not accept the invitation');
    const orgId = (r.data as { invitation?: { organizationId?: string } } | null)?.invitation?.organizationId;
    if (orgId) setTenant(orgId);
    // Enrol two-factor authentication next; approvals and governance actions require it.
    window.location.href = '/app/settings';
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!signedIn) {
        const r = await authClient.signUp.email({ name: form.name, email: form.email, password: form.password });
        if (r.error) throw new Error(r.error.message ?? 'could not create the account');
      }
      await accept();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!id) {
    return (
      <main className="auth-box" id="content">
        <h1>Invitation link incomplete</h1>
        <p className="small">Ask the person who invited you to share the full link.</p>
      </main>
    );
  }

  return (
    <main className="auth-box" id="content">
      <div className="auth-brand">
        <Logo /> FUTUREGROW
      </div>
      <h1>Join FUTUREGROW</h1>
      {signedIn === null ? <p className="muted">Checking your session…</p> : null}
      <form onSubmit={submit}>
        {signedIn === false ? (
          <>
            <p className="small">Create your account with the email address the invitation was sent to.</p>
            <div className="field">
              <label htmlFor="n">Name</label>
              <input id="n" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="e">Email</label>
              <input id="e" type="email" autoComplete="username" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="p">Password (12+ characters)</label>
              <input id="p" type="password" autoComplete="new-password" minLength={12} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
          </>
        ) : null}
        {signedIn ? <p className="small">You are signed in. Accept the invitation to join the organization.</p> : null}
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
        <button type="submit" className="primary" disabled={busy || signedIn === null}>
          {busy ? 'Working…' : signedIn ? 'Accept invitation' : 'Create account and join'}
        </button>
      </form>
    </main>
  );
}
